import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useVoiceCallCapability } from "@/hooks/useVoiceCallCapability";
import { useVoiceCallsEnabled } from "@/hooks/useVoiceCallsEnabled";
import { setCallActive } from "@/lib/callActivity";
import { formatParticipantPhone } from "@/lib/phone";
import { deriveCallState } from "@/lib/voiceCallState";
import {
    CallAudioBridge,
    acceptVoiceCall,
    callEventsMessageSchema,
    callEventsUrl,
    callPeerDigits,
    friendlyCallError,
    startVoiceCall,
    type CallUpdate,
} from "@/lib/voiceCall";

export type CallPhase = "starting" | "live" | "ended" | "error";

export interface ActiveCall {
    /** null enquanto o `start` não respondeu (discagem de saída). */
    callId: string | null;
    phoneNumberId: string;
    direction: "outgoing" | "incoming";
    contactName: string;
    to: string;
    phase: CallPhase;
    error: string | null;
    muted: boolean;
    /** Último estado vindo do serviço (pelo WebSocket de áudio). */
    update: CallUpdate | null;
}

export interface IncomingRing {
    call: CallUpdate;
    digits: string;
    /** Nome do contato quando existe conversa; senão null (mostra o telefone). */
    name: string | null;
}

interface VoiceCallContextValue {
    /** Linha em foco. Chamado pelo Dashboard; não é limpo ao sair da tela. */
    setLine: (phoneNumberId: string | null, isQr: boolean, userId: string | null) => void;
    /** A linha sabe ligar (capability do serviço). */
    canCall: boolean;
    /** Ligação em curso de OUTRO atendente: aqui não se liga nem se atende. */
    busyByOther: boolean;
    /** Estou em ligação AGORA (o card de "encerrada" não conta). */
    inCall: boolean;
    activeCall: ActiveCall | null;
    ringing: IncomingRing | null;
    /** Entrantes além da que está no aviso. */
    pendingCount: number;
    startCall: (to: string, contactName: string) => void;
    answerCall: () => void;
    ignoreCall: () => void;
    hangUp: () => void;
    toggleMute: () => void;
    closeActiveCall: () => void;
}

const noop = () => undefined;

/**
 * Fora do provider a ligação simplesmente não existe: nenhuma tela quebra, só
 * não há botão nem aviso. Preferido a lançar, porque o provider é detalhe de
 * montagem do App e um throw transformaria isso em tela branca.
 */
const FALLBACK: VoiceCallContextValue = {
    setLine: noop,
    canCall: false,
    busyByOther: false,
    inCall: false,
    activeCall: null,
    ringing: null,
    pendingCount: 0,
    startCall: noop,
    answerCall: noop,
    ignoreCall: noop,
    hangUp: noop,
    toggleMute: noop,
    closeActiveCall: noop,
};

const VoiceCallContext = createContext<VoiceCallContextValue>(FALLBACK);

export const useVoiceCalls = () => useContext(VoiceCallContext);

interface Line {
    phoneNumberId: string | null;
    isQr: boolean;
    userId: string | null;
}

async function resolveContactName(phoneNumberId: string, digits: string): Promise<string | null> {
    if (!/^\d{8,15}$/.test(digits)) return null;
    const { data } = await supabase
        .from("conversations")
        .select("contact_name")
        .eq("phone_number_id", phoneNumberId)
        .eq("is_group", false)
        .eq("contact_phone", digits)
        .limit(1)
        .maybeSingle();
    return data?.contact_name && data.contact_name !== digits ? data.contact_name : null;
}

/**
 * Dono ÚNICO da ligação de voz, montado uma vez no App — acima das rotas, do
 * breakpoint mobile/desktop e da conversa aberta.
 *
 * É essa posição que é a trava: antes, a ligação vivia dentro do ChatArea e do
 * Dashboard, então trocar de conversa, trocar de linha, cruzar 768 px ou ir para
 * Configurações desmontava o diálogo — e desmontar fecha o WebSocket de áudio,
 * que é o que o serviço usa como sinal para desligar. Aqui nada disso desmonta,
 * e só `hangUp` encerra.
 */
export function VoiceCallProvider({ children }: { children: ReactNode }) {
    const [line, setLineState] = useState<Line>({ phoneNumberId: null, isQr: false, userId: null });
    const [calls, setCalls] = useState<Map<string, CallUpdate>>(() => new Map());
    const [names, setNames] = useState<Record<string, string>>({});
    const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
    const [myCallId, setMyCallId] = useState<string | null>(null);
    const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);

    const bridgeRef = useRef<CallAudioBridge | null>(null);
    const ringtoneRef = useRef<{ stop: () => void } | null>(null);
    const nameRequestedRef = useRef<Set<string>>(new Set());

    /**
     * Dois portões, e eles dizem coisas diferentes: `voice_calls_enabled` é a
     * linha QUERER ligação (decisão de quem administra, desligada por padrão) e a
     * capability é a linha CONSEGUIR (zapo + plugin na imagem). Sem o primeiro
     * nem se pergunta ao serviço — e sem pergunta não há SSE aberto.
     */
    const { data: lineVoiceEnabled } = useQuery({
        queryKey: ["phone-voice-calls-enabled", line.phoneNumberId],
        queryFn: async () => {
            const { data } = await supabase
                .from("phone_numbers")
                .select("voice_calls_enabled")
                .eq("id", line.phoneNumberId!)
                .maybeSingle();
            return data?.voice_calls_enabled ?? false;
        },
        enabled: Boolean(line.phoneNumberId) && line.isQr,
        staleTime: 5 * 60_000,
    });
    const { data: hasCapability } = useVoiceCallCapability(line.phoneNumberId, line.isQr && lineVoiceEnabled === true);
    const hasVoiceCall = Boolean(lineVoiceEnabled && hasCapability);
    const [receiveEnabled] = useVoiceCallsEnabled(line.userId);

    const setLine = useCallback((phoneNumberId: string | null, isQr: boolean, userId: string | null) => {
        setLineState((prev) =>
            prev.phoneNumberId === phoneNumberId && prev.isQr === isQr && prev.userId === userId
                ? prev
                : { phoneNumberId, isQr, userId },
        );
    }, []);

    // ---- SSE da linha: é daqui que sai tanto o aviso quanto a ocupação --------
    useEffect(() => {
        const { phoneNumberId, isQr } = line;
        if (!phoneNumberId || !isQr || !hasVoiceCall) {
            setCalls(new Map());
            return;
        }
        let source: EventSource | null = null;
        let cancelled = false;

        void (async () => {
            const url = await callEventsUrl(phoneNumberId);
            if (cancelled) return;
            source = new EventSource(url);
            source.onmessage = (event: MessageEvent<string>) => {
                let raw: unknown;
                try {
                    raw = JSON.parse(event.data);
                } catch {
                    return; // heartbeat ou frame truncado: ignora
                }
                const parsed = callEventsMessageSchema.safeParse(raw);
                if (!parsed.success) return;
                if (parsed.data.type === "calls") {
                    setCalls(new Map(parsed.data.calls.filter((c) => c.state !== "ended").map((c) => [c.callId, c])));
                    return;
                }
                const update = parsed.data.call;
                setCalls((prev) => {
                    const next = new Map(prev);
                    if (update.state === "ended") next.delete(update.callId);
                    else next.set(update.callId, update);
                    return next;
                });
            };
            source.onerror = () => { /* EventSource reconecta sozinho */ };
        })();

        return () => {
            cancelled = true;
            source?.close();
            // A ligação ativa não depende disto: o estado dela continua chegando
            // pelo WebSocket de áudio, que é de outra linha de vida.
            setCalls(new Map());
        };
    }, [line, hasVoiceCall]);

    const { busyByOther, incoming } = useMemo(() => deriveCallState(calls.values(), myCallId), [calls, myCallId]);

    const inCall = activeCall !== null && (activeCall.phase === "starting" || activeCall.phase === "live");

    // Enquanto eu estou em ligação, ou a linha está ocupada por outro, não existe
    // aviso: nos dois casos esta entrante não pode ser atendida aqui.
    const visible = useMemo(
        () => (receiveEnabled && !busyByOther && !inCall ? incoming.find((c) => !dismissed.has(c.callId)) ?? null : null),
        [receiveEnabled, busyByOther, inCall, incoming, dismissed],
    );

    const ringing = useMemo<IncomingRing | null>(() => {
        if (!visible) return null;
        const digits = callPeerDigits(visible);
        const name = names[visible.callId];
        return { call: visible, digits, name: name ? name : null };
    }, [visible, names]);

    // Nome do contato para o aviso: uma consulta por ligação, no máximo.
    useEffect(() => {
        const phoneNumberId = line.phoneNumberId;
        if (!phoneNumberId) return;
        let cancelled = false;
        for (const call of incoming) {
            if (nameRequestedRef.current.has(call.callId)) continue;
            nameRequestedRef.current.add(call.callId);
            void resolveContactName(phoneNumberId, callPeerDigits(call)).then((name) => {
                if (cancelled || !name) return;
                setNames((prev) => ({ ...prev, [call.callId]: name }));
            });
        }
        return () => { cancelled = true; };
    }, [incoming, line.phoneNumberId]);

    // Ligação que já saiu do ar não precisa continuar na lista de ignoradas.
    useEffect(() => {
        setDismissed((prev) => {
            const next = new Set([...prev].filter((id) => calls.has(id)));
            return next.size === prev.size ? prev : next;
        });
    }, [calls]);

    // ---- toque ---------------------------------------------------------------
    const stopRingtone = useCallback(() => {
        ringtoneRef.current?.stop();
        ringtoneRef.current = null;
    }, []);

    // Dois bipes a cada segundo e meio, gerados no AudioContext (sem arquivo).
    // Falha silenciosa se a aba nunca teve interação — o card aparece do mesmo jeito.
    const startRingtone = useCallback(() => {
        if (ringtoneRef.current) return;
        try {
            const ctx = new AudioContext();
            const gain = ctx.createGain();
            gain.gain.value = 0.08;
            gain.connect(ctx.destination);
            let alive = true;
            const beep = (at: number) => {
                const osc = ctx.createOscillator();
                osc.type = "sine";
                osc.frequency.value = 880;
                osc.connect(gain);
                osc.start(at);
                osc.stop(at + 0.18);
            };
            const loop = () => {
                if (!alive) return;
                const now = ctx.currentTime;
                beep(now);
                beep(now + 0.3);
                window.setTimeout(loop, 1500);
            };
            loop();
            ringtoneRef.current = { stop: () => { alive = false; void ctx.close().catch(() => undefined); } };
        } catch {
            /* sem áudio: só o card */
        }
    }, []);

    useEffect(() => {
        if (ringing) startRingtone();
        else stopRingtone();
    }, [ringing, startRingtone, stopRingtone]);

    useEffect(() => stopRingtone, [stopRingtone]);

    // O reload do service worker mataria a ligação: avisa o main.tsx.
    useEffect(() => {
        setCallActive(inCall);
        return () => setCallActive(false);
    }, [inCall]);

    // ---- ações ---------------------------------------------------------------
    const beginCall = useCallback((options: {
        phoneNumberId: string;
        to: string;
        contactName: string;
        incomingCallId?: string;
    }) => {
        bridgeRef.current?.stop();
        setActiveCall({
            callId: options.incomingCallId ?? null,
            phoneNumberId: options.phoneNumberId,
            direction: options.incomingCallId ? "incoming" : "outgoing",
            contactName: options.contactName,
            to: options.to,
            phase: "starting",
            error: null,
            muted: false,
            update: null,
        });
        if (options.incomingCallId) setMyCallId(options.incomingCallId);

        const bridge = new CallAudioBridge({
            onState: (update) => {
                setActiveCall((prev) => (prev ? { ...prev, update, phase: update.state === "ended" ? "ended" : prev.phase } : prev));
            },
            onClose: (code, reason) => {
                setActiveCall((prev) => {
                    if (!prev) return prev;
                    // 4xxx = o serviço recusou a ponte (ligação sumiu, linha sem voz…)
                    if (code >= 4000) return { ...prev, phase: "error", error: reason || "O serviço encerrou a conexão de áudio." };
                    return { ...prev, phase: "ended" };
                });
            },
            onError: (error) => {
                setActiveCall((prev) => (prev ? { ...prev, phase: "error", error: error.message } : prev));
            },
        });
        bridgeRef.current = bridge;

        void (async () => {
            try {
                let callId: string;
                if (options.incomingCallId) {
                    await acceptVoiceCall(options.phoneNumberId, options.incomingCallId);
                    callId = options.incomingCallId;
                } else {
                    callId = (await startVoiceCall(options.phoneNumberId, options.to)).callId;
                    if (bridgeRef.current !== bridge) return;
                    setMyCallId(callId);
                    setActiveCall((prev) => (prev ? { ...prev, callId } : prev));
                }
                if (bridgeRef.current !== bridge) return; // desligou antes de o serviço responder
                await bridge.start(options.phoneNumberId, callId);
                if (bridgeRef.current !== bridge) return;
                setActiveCall((prev) => (prev && prev.phase === "starting" ? { ...prev, phase: "live" } : prev));
            } catch (error) {
                if (bridgeRef.current !== bridge) return;
                console.error("[VoiceCall] falha ao ligar", error);
                setActiveCall((prev) => (prev ? { ...prev, phase: "error", error: friendlyCallError(error) } : prev));
                bridge.stop();
                bridgeRef.current = null;
            }
        })();
    }, []);

    const startCall = useCallback((to: string, contactName: string) => {
        if (!line.phoneNumberId || busyByOther || inCall) return;
        beginCall({ phoneNumberId: line.phoneNumberId, to, contactName });
    }, [line.phoneNumberId, busyByOther, inCall, beginCall]);

    const answerCall = useCallback(() => {
        if (!ringing || !line.phoneNumberId) return;
        stopRingtone();
        beginCall({
            phoneNumberId: line.phoneNumberId,
            to: ringing.digits,
            contactName: ringing.name ?? formatParticipantPhone(ringing.digits),
            incomingCallId: ringing.call.callId,
        });
    }, [ringing, line.phoneNumberId, beginCall, stopRingtone]);

    /**
     * Não existe recusar, de propósito.
     *
     * Recusar chamava `endVoiceCall`, que encerra a ligação NO WHATSAPP — ou
     * seja, um atendente tirava a ligação de todos os outros e do celular de
     * quem ligou. Como a ligação é da LINHA e não de uma pessoa, um atendente só
     * pode fazer duas coisas: atender, ou deixar tocar. Ignorar tira o aviso
     * daqui e nada mais: quem ligou continua chamando, os outros atendentes
     * continuam podendo atender, e a chamada perdida fica registrada como
     * qualquer outra.
     */
    const ignoreCall = useCallback(() => {
        if (!ringing) return;
        setDismissed((prev) => new Set(prev).add(ringing.call.callId));
    }, [ringing]);

    const hangUp = useCallback(() => {
        bridgeRef.current?.hangUp();
        bridgeRef.current = null;
        setActiveCall((prev) => (prev ? { ...prev, phase: "ended" } : prev));
    }, []);

    const toggleMute = useCallback(() => {
        if (!activeCall) return;
        const muted = !activeCall.muted;
        bridgeRef.current?.setMuted(muted);
        setActiveCall((prev) => (prev ? { ...prev, muted } : prev));
    }, [activeCall]);

    const closeActiveCall = useCallback(() => {
        bridgeRef.current?.stop();
        bridgeRef.current = null;
        setActiveCall(null);
        setMyCallId(null);
    }, []);

    const value = useMemo<VoiceCallContextValue>(() => ({
        setLine,
        canCall: hasVoiceCall,
        busyByOther,
        inCall,
        activeCall,
        ringing,
        pendingCount: Math.max(0, incoming.filter((c) => !dismissed.has(c.callId)).length - 1),
        startCall,
        answerCall,
        ignoreCall,
        hangUp,
        toggleMute,
        closeActiveCall,
    }), [
        setLine, hasVoiceCall, busyByOther, inCall, activeCall, ringing, incoming, dismissed,
        startCall, answerCall, ignoreCall, hangUp, toggleMute, closeActiveCall,
    ]);

    return <VoiceCallContext.Provider value={value}>{children}</VoiceCallContext.Provider>;
}
