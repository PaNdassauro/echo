import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, Mic, MicOff, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { IconSwap } from "@/components/ui/icon-swap";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { validateAudioBlob } from "@/lib/audioValidation";
import {
    MicErrorInfo,
    SILENCE_LEVEL,
    buildAudioConstraints,
    describeMicError,
    getMicUnavailableReason,
    getPreferredMicId,
    rmsLevel,
    setPreferredMicId,
} from "@/lib/microphone";
import { cn } from "@/lib/utils";

/** Radix Select com value="" fica não controlado: o padrão do sistema usa sentinela. */
const DEFAULT_DEVICE = "__default__";
/** Sem nenhum som acima do limiar nesse tempo, avisamos que o microfone parece mudo. */
const SILENCE_WARNING_MS = 4000;
const SAMPLE_SECONDS = 3;
/** O RMS de fala fica bem abaixo de 1: amplifica para a barra andar de verdade. */
const METER_GAIN = 4;

type Phase = "idle" | "requesting" | "listening";
type PermissionLabel = PermissionState | "unknown";

interface Sample {
    url: string;
    bytes: number;
    mimeType: string;
}

const PERMISSION_TEXT: Record<PermissionLabel, string> = {
    granted: "Permitido",
    denied: "Bloqueado",
    prompt: "Ainda não perguntado",
    unknown: "Desconhecido",
};

function pickRecorderMime(): string {
    if (typeof MediaRecorder === "undefined") return "";
    if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) return "audio/ogg;codecs=opus";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
    return "";
}

const MicrophoneSettings = () => {
    const [phase, setPhase] = useState<Phase>("idle");
    const [error, setError] = useState<MicErrorInfo | null>(() => getMicUnavailableReason());
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
    const [selectedId, setSelectedId] = useState<string>(() => getPreferredMicId() ?? DEFAULT_DEVICE);
    const [permission, setPermission] = useState<PermissionLabel>("unknown");
    const [trackInfo, setTrackInfo] = useState<{ label: string; sampleRate?: number } | null>(null);
    const [hasSignal, setHasSignal] = useState(false);
    const [silent, setSilent] = useState(false);
    const [recordingSample, setRecordingSample] = useState(false);
    const [sample, setSample] = useState<Sample | null>(null);
    const [sampleProblem, setSampleProblem] = useState(false);
    const [copied, setCopied] = useState(false);

    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const rafRef = useRef<number | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const sampleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const meterRef = useRef<HTMLDivElement | null>(null);
    // Token de geração: um "Parar" (ou troca de microfone) durante o await do
    // getUserMedia invalida o stream que ainda vai chegar.
    const generationRef = useRef(0);
    const sampleUrlRef = useRef<string | null>(null);

    const refreshDevices = useCallback(async () => {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        try {
            const all = await navigator.mediaDevices.enumerateDevices();
            // Sem permissão o navegador devolve entradas sem deviceId/label: não servem para escolher.
            setDevices(all.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default"));
        } catch (err) {
            console.error("[MicrophoneSettings] enumerateDevices falhou:", err);
        }
    }, []);

    const releaseAudio = useCallback(() => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        if (sampleTimerRef.current) clearTimeout(sampleTimerRef.current);
        sampleTimerRef.current = null;
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
            recorderRef.current.onstop = null;
            recorderRef.current.stop();
        }
        recorderRef.current = null;
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        audioContextRef.current?.close().catch(() => {});
        audioContextRef.current = null;
        if (meterRef.current) meterRef.current.style.transform = "scaleX(0)";
        setRecordingSample(false);
    }, []);

    const stopTest = useCallback(() => {
        generationRef.current += 1;
        releaseAudio();
        setPhase("idle");
        setHasSignal(false);
        setSilent(false);
    }, [releaseAudio]);

    const startTest = useCallback(async (deviceId: string) => {
        const unavailable = getMicUnavailableReason();
        if (unavailable) {
            setError(unavailable);
            return;
        }

        const generation = ++generationRef.current;
        releaseAudio();
        setError(null);
        setHasSignal(false);
        setSilent(false);
        setPhase("requesting");

        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: buildAudioConstraints(deviceId === DEFAULT_DEVICE ? null : deviceId),
            });
        } catch (err) {
            if (generation !== generationRef.current) return;
            console.error("[MicrophoneSettings] getUserMedia falhou:", err);
            setError(describeMicError(err));
            setPhase("idle");
            return;
        }
        if (generation !== generationRef.current) {
            stream.getTracks().forEach((track) => track.stop());
            return;
        }

        streamRef.current = stream;
        const track = stream.getAudioTracks()[0];
        const settings = track?.getSettings?.() ?? {};
        setTrackInfo({ label: track?.label || "Microfone padrão", sampleRate: settings.sampleRate });
        track?.addEventListener("ended", () => {
            if (generation !== generationRef.current) return;
            stopTest();
            setError({
                kind: "not-found",
                title: "O microfone foi desconectado",
                description: "Conecte o microfone de novo e repita o teste.",
            });
        });
        // Com a permissão dada, os nomes dos microfones passam a aparecer.
        void refreshDevices();

        try {
            const AudioCtx = window.AudioContext
                || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            const audioContext = new AudioCtx();
            audioContextRef.current = audioContext;
            if (audioContext.state === "suspended") await audioContext.resume();
            if (generation !== generationRef.current) return;

            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 1024;
            audioContext.createMediaStreamSource(stream).connect(analyser);
            const buffer = new Uint8Array(analyser.fftSize);
            const startedAt = performance.now();
            let peak = 0;
            let shown = 0;
            let signalFlag = false;
            let silentFlag = false;

            const tick = () => {
                analyser.getByteTimeDomainData(buffer);
                const level = rmsLevel(buffer);
                peak = Math.max(peak, level);
                // Sobe na hora, desce devagar: a barra não pisca entre sílabas.
                shown = Math.max(Math.min(1, level * METER_GAIN), shown * 0.9);
                if (meterRef.current) meterRef.current.style.transform = `scaleX(${shown})`;

                const nowSignal = peak > SILENCE_LEVEL;
                if (nowSignal !== signalFlag) {
                    signalFlag = nowSignal;
                    setHasSignal(nowSignal);
                }
                const nowSilent = !nowSignal && performance.now() - startedAt > SILENCE_WARNING_MS;
                if (nowSilent !== silentFlag) {
                    silentFlag = nowSilent;
                    setSilent(nowSilent);
                }
                rafRef.current = requestAnimationFrame(tick);
            };
            rafRef.current = requestAnimationFrame(tick);
            setPhase("listening");
        } catch (err) {
            if (generation !== generationRef.current) return;
            console.error("[MicrophoneSettings] AudioContext falhou:", err);
            stopTest();
            setError(describeMicError(err));
        }
    }, [refreshDevices, releaseAudio, stopTest]);

    const recordSample = useCallback(() => {
        const stream = streamRef.current;
        if (!stream || typeof MediaRecorder === "undefined") return;

        const mimeType = pickRecorderMime();
        let recorder: MediaRecorder;
        try {
            recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        } catch (err) {
            console.error("[MicrophoneSettings] MediaRecorder falhou:", err);
            setError(describeMicError(err));
            return;
        }

        const chunks: Blob[] = [];
        recorder.ondataavailable = (event) => {
            if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onstop = () => {
            setRecordingSample(false);
            const type = recorder.mimeType || mimeType || "audio/webm";
            const blob = new Blob(chunks, { type });
            if (sampleUrlRef.current) URL.revokeObjectURL(sampleUrlRef.current);
            const url = URL.createObjectURL(blob);
            sampleUrlRef.current = url;
            setSample({ url, bytes: blob.size, mimeType: type });
            setSampleProblem(!validateAudioBlob(blob).valid);
        };

        recorderRef.current = recorder;
        recorder.start(250);
        setRecordingSample(true);
        sampleTimerRef.current = setTimeout(() => {
            sampleTimerRef.current = null;
            if (recorder.state !== "inactive") recorder.stop();
        }, SAMPLE_SECONDS * 1000);
    }, []);

    const handleDeviceChange = (value: string) => {
        setSelectedId(value);
        setPreferredMicId(value === DEFAULT_DEVICE ? null : value);
        if (phase !== "idle") void startTest(value);
    };

    const handleCopyDiagnostics = async () => {
        const lines = [
            `Navegador: ${navigator.userAgent}`,
            `Endereço seguro: ${window.isSecureContext ? "sim" : "não"}`,
            `Permissão: ${PERMISSION_TEXT[permission]}`,
            `Microfones encontrados: ${devices.length}`,
            `Microfone escolhido: ${selectedId === DEFAULT_DEVICE ? "padrão do sistema" : devices.find((d) => d.deviceId === selectedId)?.label || selectedId}`,
            `Microfone em uso: ${trackInfo?.label ?? "teste não iniciado"}`,
            `Taxa de amostragem: ${trackInfo?.sampleRate ? `${trackInfo.sampleRate} Hz` : "—"}`,
            `Sinal captado: ${phase === "listening" ? (hasSignal ? "sim" : "não") : "teste não iniciado"}`,
            `Gravação nativa: ${pickRecorderMime() || "formato padrão do navegador"}`,
            `Amostra: ${sample ? `${sample.bytes} bytes (${sample.mimeType})` : "não gravada"}`,
            `Último erro: ${error ? error.title : "nenhum"}`,
        ];
        try {
            await navigator.clipboard.writeText(lines.join("\n"));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error("[MicrophoneSettings] Não foi possível copiar o diagnóstico:", err);
        }
    };

    useEffect(() => {
        void refreshDevices();
        const mediaDevices = navigator.mediaDevices;
        mediaDevices?.addEventListener?.("devicechange", refreshDevices);

        let permissionStatus: PermissionStatus | null = null;
        let disposed = false;
        const onPermissionChange = () => {
            if (permissionStatus) setPermission(permissionStatus.state);
            void refreshDevices();
        };
        // O Firefox e o Safari antigo não conhecem "microphone" na Permissions API.
        navigator.permissions
            ?.query({ name: "microphone" as PermissionName })
            .then((status) => {
                if (disposed) return;
                permissionStatus = status;
                setPermission(status.state);
                status.addEventListener("change", onPermissionChange);
            })
            .catch(() => {});

        return () => {
            disposed = true;
            mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
            permissionStatus?.removeEventListener("change", onPermissionChange);
        };
    }, [refreshDevices]);

    useEffect(() => () => {
        generationRef.current += 1;
        releaseAudio();
        if (sampleUrlRef.current) URL.revokeObjectURL(sampleUrlRef.current);
    }, [releaseAudio]);

    const listening = phase === "listening";
    const selectValue = selectedId === DEFAULT_DEVICE || devices.some((d) => d.deviceId === selectedId)
        ? selectedId
        : DEFAULT_DEVICE;

    let statusText = "Clique em Testar microfone e fale algo.";
    if (phase === "requesting") statusText = "Aguardando a permissão do navegador…";
    else if (listening && silent) statusText = "";
    else if (listening) statusText = hasSignal ? "Captando som. O microfone está funcionando." : "Fale algo. A barra deve se mexer.";

    return (
        <div className="max-w-3xl space-y-8">
            <div>
                <h2 className="text-2xl font-semibold tracking-tight">Microfone</h2>
                <p className="text-sm text-muted-foreground">
                    Teste o microfone usado para gravar áudios no chat
                </p>
            </div>

            <div className="bg-card border rounded-xl p-6 space-y-6">
                <div className="space-y-2">
                    <Label htmlFor="mic-device">Microfone</Label>
                    <Select value={selectValue} onValueChange={handleDeviceChange}>
                        <SelectTrigger id="mic-device" className="max-w-md">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={DEFAULT_DEVICE}>Padrão do sistema</SelectItem>
                            {devices.map((device, index) => (
                                <SelectItem key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Microfone ${index + 1}`}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        A escolha vale para a gravação de áudios neste navegador.
                    </p>
                </div>

                <div className="space-y-3">
                    <div className="flex items-center gap-3">
                        <div
                            aria-hidden="true"
                            className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted"
                        >
                            <div
                                ref={meterRef}
                                className={cn(
                                    "h-full w-full origin-left rounded-full",
                                    hasSignal ? "bg-success" : "bg-primary",
                                )}
                                style={{ transform: "scaleX(0)" }}
                            />
                        </div>
                        <Button
                            onClick={() => (phase === "idle" ? void startTest(selectedId) : stopTest())}
                            variant={phase === "idle" ? "default" : "outline"}
                            className="gap-2 shrink-0"
                            disabled={error?.kind === "insecure" || error?.kind === "unsupported"}
                        >
                            <IconSwap
                                active={phase}
                                icons={{
                                    idle: <Mic className="h-4 w-4" />,
                                    requesting: <Loader2 className="h-4 w-4 animate-spin" />,
                                    listening: <Square className="h-4 w-4" />,
                                }}
                            />
                            {phase === "idle" ? "Testar microfone" : "Parar teste"}
                        </Button>
                    </div>

                    <p className="text-sm text-muted-foreground min-h-5" aria-live="polite">
                        {statusText}
                    </p>

                    {listening && silent && (
                        <div className="flex gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3" role="status">
                            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
                            <div className="space-y-1">
                                <p className="text-sm font-medium">Nenhum som captado</p>
                                <p className="text-xs text-muted-foreground">
                                    O navegador liberou o microfone, mas ele está mudo. Confira o botão de mudo do headset,
                                    escolha outro microfone acima ou veja o volume de entrada nas configurações de som do computador.
                                </p>
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3" role="alert">
                            <MicOff className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                            <div className="space-y-1">
                                <p className="text-sm font-medium">{error.title}</p>
                                <p className="text-xs text-muted-foreground">{error.description}</p>
                            </div>
                        </div>
                    )}
                </div>

                <div className="space-y-3 border-t pt-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h3 className="font-medium">Gravar e ouvir</h3>
                            <p className="text-sm text-muted-foreground">
                                Grava {SAMPLE_SECONDS} segundos para você ouvir como o áudio vai chegar.
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            className="gap-2"
                            onClick={recordSample}
                            disabled={!listening || recordingSample}
                        >
                            {recordingSample && <Loader2 className="h-4 w-4 animate-spin" />}
                            {recordingSample ? "Gravando…" : "Gravar amostra"}
                        </Button>
                    </div>
                    {sample && (
                        <audio controls src={sample.url} className="w-full max-w-md" aria-label="Amostra gravada" />
                    )}
                    {sample && sampleProblem && (
                        <p className="text-sm text-destructive" role="alert">
                            A amostra saiu vazia. O navegador não está entregando o áudio do microfone.
                        </p>
                    )}
                </div>
            </div>

            <div className="bg-card border rounded-xl p-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="space-y-1">
                        <h3 className="font-medium">Diagnóstico</h3>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                            <dt className="text-muted-foreground">Permissão</dt>
                            <dd>{PERMISSION_TEXT[permission]}</dd>
                            <dt className="text-muted-foreground">Microfones</dt>
                            <dd>{devices.length > 0 ? devices.length : "—"}</dd>
                            <dt className="text-muted-foreground">Em uso</dt>
                            <dd className="truncate">{trackInfo?.label ?? "—"}</dd>
                        </dl>
                    </div>
                    <Button variant="outline" className="gap-2" onClick={handleCopyDiagnostics}>
                        <IconSwap
                            active={copied ? "check" : "copy"}
                            icons={{
                                copy: <Copy className="h-4 w-4" />,
                                check: <Check className="h-4 w-4 text-success" />,
                            }}
                        />
                        {copied ? "Copiado" : "Copiar diagnóstico"}
                    </Button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                    Se o problema continuar, mande o diagnóstico para o suporte.
                </p>
            </div>
        </div>
    );
};

export default MicrophoneSettings;
