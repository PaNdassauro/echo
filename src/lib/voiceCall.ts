import { z } from "zod";
import { qrEventSourceUrl, qrFetch } from "@/lib/qrService";

/**
 * Ligação de voz pelo qr-service (capability 'voice_call' — zapo com o plugin
 * @zapo-js/voip carregado, imagem `Dockerfile.voip`). Contrato: docs do serviço,
 * `src/routes/call.ts`. Áudio nos dois sentidos por WebSocket em PCM Float32
 * mono 16 kHz; fechar o socket encerra a ligação.
 */

export const CALL_SAMPLE_RATE = 16_000;
/** 60 ms — o mesmo quadro do codec MLow do WhatsApp. */
const FRAME_SAMPLES = 960;

export const callUpdateSchema = z.object({
    callId: z.string(),
    peerJid: z.string(),
    peerPn: z.string().optional(),
    direction: z.enum(["outgoing", "incoming"]),
    isVideo: z.boolean(),
    state: z.enum(["initiating", "ringing", "incoming_ringing", "connecting", "active", "on_hold", "ended"]),
    endReason: z.string().optional(),
    startedAt: z.number(),
    connectedAt: z.number().optional(),
    endedAt: z.number().optional(),
    durationSecs: z.number().optional(),
    muted: z.boolean(),
});
export type CallUpdate = z.infer<typeof callUpdateSchema>;

const startSchema = z.object({ success: z.literal(true), callId: z.string(), to: z.string() });
const failureSchema = z.object({ error: z.string(), code: z.string().optional() });
const capabilitySchema = z.object({ voice_call: z.boolean() });

const socketMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("state"), call: callUpdateSchema }),
    z.object({ type: z.literal("buffer"), ms: z.number() }),
]);

export class VoiceCallError extends Error {
    constructor(message: string, readonly code: string | undefined, readonly status: number) {
        super(message);
        this.name = "VoiceCallError";
    }
}

/** Erro de ligação no vocabulário de quem atende, não no do protocolo. */
export function friendlyCallError(error: unknown): string {
    if (error instanceof VoiceCallError) {
        if (error.code === "unsupported_by_provider" || error.status === 501) {
            return "Esta linha não faz ligação: o provider não tem suporte ou a imagem do serviço não tem o plugin de voz.";
        }
        if (error.code === "blocked" || error.status === 423) return error.message;
        if (error.status === 409) return "A linha não está conectada.";
        return error.message;
    }
    if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
        return "Permissão de microfone negada. Libere o microfone para este site e tente de novo.";
    }
    if (error instanceof DOMException && error.name === "NotFoundError") return "Nenhum microfone encontrado.";
    return error instanceof Error ? error.message : "Falha ao ligar.";
}

async function failureOf(response: Response): Promise<VoiceCallError> {
    const body: unknown = await response.json().catch(() => null);
    const parsed = failureSchema.safeParse(body);
    const message = parsed.success ? parsed.data.error : `Serviço respondeu ${response.status}`;
    return new VoiceCallError(message, parsed.success ? parsed.data.code : undefined, response.status);
}

export async function voiceCallCapability(phoneNumberId: string): Promise<boolean> {
    const response = await qrFetch(`/call/${phoneNumberId}/capability`);
    if (!response.ok) return false;
    const parsed = capabilitySchema.safeParse(await response.json().catch(() => null));
    return parsed.success && parsed.data.voice_call;
}

export async function startVoiceCall(phoneNumberId: string, to: string): Promise<{ callId: string; to: string }> {
    const response = await qrFetch(`/call/${phoneNumberId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
    });
    if (!response.ok) throw await failureOf(response);
    const parsed = startSchema.safeParse(await response.json());
    if (!parsed.success) throw new VoiceCallError("Resposta do serviço fora do formato esperado", "bad_response", 500);
    return { callId: parsed.data.callId, to: parsed.data.to };
}

/**
 * Encerra a ligação NO WHATSAPP — para quem ligou e para todos os atendentes.
 *
 * NÃO use no aviso de ligação recebida: a ligação é da linha, não de uma pessoa,
 * e um atendente que "recusa" estaria decidindo pelos outros. Ali existem só
 * atender e deixar tocar (ver `IncomingCallCard`). Quem já está na ligação
 * desliga pelo próprio socket de áudio (`CallAudioBridge.hangUp`), não por aqui.
 */
export async function endVoiceCall(phoneNumberId: string, callId: string, reason?: "user_ended" | "declined" | "busy"): Promise<void> {
    const response = await qrFetch(`/call/${phoneNumberId}/${encodeURIComponent(callId)}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reason ? { reason } : {}),
    });
    if (!response.ok && response.status !== 404) throw await failureOf(response);
}

export async function acceptVoiceCall(phoneNumberId: string, callId: string): Promise<void> {
    const response = await qrFetch(`/call/${phoneNumberId}/${encodeURIComponent(callId)}/accept`, { method: "POST" });
    if (!response.ok) throw await failureOf(response);
}

/** SSE com o estado das ligações da linha (é como uma ligação ENTRANDO chega ao front). */
export function callEventsUrl(phoneNumberId: string): Promise<string> {
    return qrEventSourceUrl(`/call/${phoneNumberId}/events`);
}

export const callEventsMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("calls"), calls: z.array(callUpdateSchema), voice_call: z.boolean() }),
    z.object({ type: z.literal("state"), call: callUpdateSchema }),
]);

/** Dígitos do telefone do outro lado, quando a lib entregou; senão o LID cru. */
export function callPeerDigits(call: CallUpdate): string {
    return (call.peerPn ?? call.peerJid).replace(/@.*$/, "").replace(/:.*$/, "");
}

/** Mensagem legível para o estado da ligação, no vocabulário do WhatsApp. */
export function describeCallState(call: CallUpdate | null): string {
    if (!call) return "Preparando…";
    switch (call.state) {
        case "initiating": return "Chamando…";
        case "ringing": return "Tocando…";
        case "incoming_ringing": return "Recebendo ligação…";
        case "connecting": return "Conectando…";
        case "active": return "Em ligação";
        case "on_hold": return "Em espera";
        case "ended": {
            // O plugin de voz IGNORA o motivo que vem no stanza de término e
            // carimba `user_ended` em tudo (WaCallManager.handleCallTerminate),
            // então "recusou" e "desliguei" chegam idênticos. O que o dado
            // sustenta é se a ligação chegou a conectar — e é isso que se diz.
            // Motivo explícito (recusa feita por nós, falha, DND) continua valendo.
            if (!call.connectedAt && (call.endReason === "user_ended" || call.endReason === undefined)) {
                return call.direction === "outgoing" ? "Não atendida" : "Chamada perdida";
            }
            return describeEndReason(call.endReason);
        }
    }
}

export function describeEndReason(reason: string | undefined): string {
    switch (reason) {
        case "declined": return "Ligação recusada";
        case "timeout": return "Sem resposta";
        case "busy": return "Ocupado";
        case "cancelled": return "Ligação cancelada";
        case "failed": return "Falha na ligação";
        case "do_not_disturb": return "Contato em modo não perturbe";
        case "user_ended":
        case undefined:
            return "Ligação encerrada";
        default: return `Encerrada (${reason.replace(/_/g, " ")})`;
    }
}

// Reamostra o microfone (taxa do AudioContext, geralmente 48 kHz) para 16 kHz
// por interpolação linear e entrega quadros de 960 amostras. Roda na thread de
// áudio: nada de alocação por quadro além do buffer de saída, que é reciclado.
const WORKLET_SOURCE = `
class EchoDown16k extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ratio = sampleRate / ${CALL_SAMPLE_RATE};
        this.pos = 0;
        this.carry = new Float32Array(0);
        this.out = new Float32Array(${FRAME_SAMPLES});
        this.outLen = 0;
    }
    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (!ch) return true;
        const buf = new Float32Array(this.carry.length + ch.length);
        buf.set(this.carry);
        buf.set(ch, this.carry.length);
        let i = this.pos;
        while (i + 1 < buf.length) {
            const i0 = Math.floor(i);
            const frac = i - i0;
            this.out[this.outLen++] = buf[i0] + (buf[i0 + 1] - buf[i0]) * frac;
            if (this.outLen === ${FRAME_SAMPLES}) {
                this.port.postMessage(this.out.buffer.slice(0));
                this.outLen = 0;
            }
            i += this.ratio;
        }
        const consumed = Math.floor(i);
        this.carry = buf.slice(consumed);
        this.pos = i - consumed;
        return true;
    }
}
registerProcessor('echo-down16k', EchoDown16k);
`;

export interface AudioBridgeHandlers {
    onState: (call: CallUpdate) => void;
    onClose: (code: number, reason: string) => void;
    onError: (error: Error) => void;
}

/**
 * Ponte entre o navegador e o serviço para UMA ligação: microfone → WS (16 kHz)
 * e WS → alto-falante. `stop()` fecha tudo; o serviço encerra a ligação ao ver
 * o socket cair, então não é preciso chamar `endVoiceCall` separadamente.
 */
export class CallAudioBridge {
    private ws: WebSocket | null = null;
    private ctx: AudioContext | null = null;
    private stream: MediaStream | null = null;
    private nextPlayAt = 0;
    private stopped = false;
    private paused = false;

    constructor(private readonly handlers: AudioBridgeHandlers) {}

    async start(phoneNumberId: string, callId: string): Promise<void> {
        const httpUrl = await qrEventSourceUrl(`/call/${phoneNumberId}/${encodeURIComponent(callId)}/audio`);
        const ws = new WebSocket(httpUrl.replace(/^http/, "ws"));
        ws.binaryType = "arraybuffer";
        this.ws = ws;

        ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
            if (typeof event.data === "string") {
                const parsed = socketMessageSchema.safeParse(JSON.parse(event.data));
                if (!parsed.success) return;
                if (parsed.data.type === "state") this.handlers.onState(parsed.data.call);
                // Fila de envio no serviço acima de ~1 s: segura o microfone até esvaziar.
                else this.paused = parsed.data.ms > 1000 ? true : parsed.data.ms < 300 ? false : this.paused;
                return;
            }
            this.play(new Float32Array(event.data));
        };
        ws.onclose = (event) => { if (!this.stopped) this.handlers.onClose(event.code, event.reason); };
        ws.onerror = () => { if (!this.stopped) this.handlers.onError(new Error("Conexão de áudio falhou")); };

        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            const failEarly = (event: CloseEvent) => reject(new Error(event.reason || `Conexão de áudio recusada (${event.code})`));
            ws.addEventListener("close", failEarly, { once: true });
            ws.addEventListener("open", () => ws.removeEventListener("close", failEarly), { once: true });
        });

        try {
            await this.startMicrophone(ws);
        } catch (error) {
            this.stop();
            throw error instanceof Error ? error : new Error("Microfone indisponível");
        }
    }

    private async startMicrophone(ws: WebSocket): Promise<void> {
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            video: false,
        });
        const ctx = new AudioContext();
        this.ctx = ctx;
        const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
        try {
            await ctx.audioWorklet.addModule(moduleUrl);
        } finally {
            URL.revokeObjectURL(moduleUrl);
        }
        const source = ctx.createMediaStreamSource(this.stream);
        const worklet = new AudioWorkletNode(ctx, "echo-down16k", { numberOfInputs: 1, numberOfOutputs: 0 });
        worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
            if (this.paused || ws.readyState !== WebSocket.OPEN) return;
            ws.send(event.data);
        };
        source.connect(worklet);
        if (ctx.state === "suspended") await ctx.resume();
    }

    private play(pcm: Float32Array): void {
        const ctx = this.ctx;
        if (!ctx || pcm.length === 0) return;
        const buffer = ctx.createBuffer(1, pcm.length, CALL_SAMPLE_RATE);
        buffer.copyToChannel(pcm, 0);
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        // Agenda em sequência com 50 ms de folga; se a fila secou, recomeça do "agora".
        const startAt = Math.max(ctx.currentTime + 0.05, this.nextPlayAt);
        node.start(startAt);
        this.nextPlayAt = startAt + buffer.duration;
    }

    setMuted(muted: boolean): void {
        this.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "mute", muted }));
    }

    /** Pede ao serviço para desligar e fecha a ponte. */
    hangUp(): void {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "end" }));
        this.stop();
    }

    stop(): void {
        this.stopped = true;
        this.ws?.close(1000, "closed by user");
        this.ws = null;
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
        void this.ctx?.close().catch(() => undefined);
        this.ctx = null;
    }
}
