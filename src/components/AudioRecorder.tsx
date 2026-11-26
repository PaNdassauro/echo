import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Mic, Square, X, Send, Play, Pause, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { buildAudioConstraints, describeMicError } from "@/lib/microphone";
import {
    MIN_AUDIO_BYTES,
    MIN_AUDIO_DURATION_S,
    isValidAudioBlob,
} from "@/lib/audioValidation";
// @ts-ignore
import Recorder from "opus-recorder";

interface AudioRecorderProps {
    /** Retornar false (ou rejeitar) mantém o preview com o blob intacto para reenvio. */
    onSend: (audioBlob: Blob) => Promise<boolean> | boolean | void;
    onStateChange?: (state: RecordingState) => void;
    disabled?: boolean;
}

export type RecordingState = "idle" | "recording" | "preview" | "sending";

interface OpusRecorderInstance {
    start: () => Promise<void>;
    stop: () => Promise<void> | void;
    close: () => Promise<void> | void;
    ondataavailable?: (data: Uint8Array) => void;
    onerror?: (err: unknown) => void;
    state?: string;
}

type ActiveRecorder = OpusRecorderInstance | MediaRecorder;

function isOpusRecorder(recorder: ActiveRecorder): recorder is OpusRecorderInstance {
    return "close" in recorder && typeof recorder.close === "function";
}

export default function AudioRecorder({ onSend, onStateChange, disabled }: AudioRecorderProps) {
    const [state, setState] = useState<RecordingState>("idle");
    const [recordingTime, setRecordingTime] = useState(0);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentPlayTime, setCurrentPlayTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isSeeking, setIsSeeking] = useState(false);

    const { toast } = useToast();
    const recorderRef = useRef<ActiveRecorder | null>(null);
    const audioBlobRef = useRef<Blob | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    // MediaRecorder.stop() dispara onstop de forma ASSÍNCRONA: sem esta guarda,
    // cancelar no fallback nativo (Safari/iOS) "ressuscitava" o áudio em preview.
    const isCancelledRef = useRef(false);
    const isStartingRef = useRef(false);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            isCancelledRef.current = true;
            isStartingRef.current = false;
            if (timerRef.current) clearInterval(timerRef.current);
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
            }
            if (audioContextRef.current && audioContextRef.current.state !== "closed") {
                audioContextRef.current.close().catch(() => {});
            }
            if (recorderRef.current && isOpusRecorder(recorderRef.current)) {
                recorderRef.current.close();
            }
        };
    }, []); // Only once on mount

    const formatTime = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    };

    const handleStateChange = useCallback((newState: RecordingState) => {
        setState(newState);
        onStateChange?.(newState);
    }, [onStateChange]);

    const cancelRecording = useCallback(() => {
        isCancelledRef.current = true;
        isStartingRef.current = false;
        if (recorderRef.current) {
            try {
                if (state === "recording" && typeof recorderRef.current.stop === "function") {
                    recorderRef.current.stop();
                }
                // Only call close if it's an opus-recorder instance
                if (isOpusRecorder(recorderRef.current)) {
                    recorderRef.current.close();
                }
            } catch (e) {
                console.warn("[AudioRecorder] Error during recorder cleanup:", e);
            }
            recorderRef.current = null;
        }

        if (audioContextRef.current) {
            if (audioContextRef.current.state !== "closed") {
                try {
                    audioContextRef.current.close().catch(() => {});
                } catch (e) {
                    console.warn("[AudioRecorder] Error closing audioContext:", e);
                }
            }
            audioContextRef.current = null;
        }

        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }

        if (audioUrl) {
            URL.revokeObjectURL(audioUrl);
        }

        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }

        setAudioUrl(null);
        audioBlobRef.current = null;
        setRecordingTime(0);
        setIsPlaying(false);
        setDuration(0);
        setCurrentPlayTime(0);
        handleStateChange("idle");
    }, [state, audioUrl, handleStateChange]);

    const startNativeRecording = useCallback((stream: MediaStream) => {
        try {
            const mimeType = MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
                ? "audio/ogg;codecs=opus"
                : MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                    ? "audio/webm;codecs=opus"
                    : "audio/webm";

            console.log("[AudioRecorder] Starting native recording with mimeType:", mimeType);
            const nativeRecorder = new MediaRecorder(stream, { mimeType });
            const chunks: Blob[] = [];

            nativeRecorder.ondataavailable = (e: BlobEvent) => {
                if (e.data && e.data.size > 0) chunks.push(e.data);
            };

            nativeRecorder.onstop = () => {
                if (isCancelledRef.current) {
                    chunks.length = 0;
                    return;
                }
                const audioBlob = new Blob(chunks, { type: mimeType });
                chunks.length = 0;

                if (!isValidAudioBlob(audioBlob)) {
                    console.error("[AudioRecorder] Native recording produced empty audio:", audioBlob.size, "bytes");
                    cancelRecording();
                    toast({
                        title: "Gravação vazia",
                        description: "Não foi possível capturar o áudio do microfone. Tente gravar novamente.",
                        variant: "destructive",
                    });
                    return;
                }

                audioBlobRef.current = audioBlob;
                const url = URL.createObjectURL(audioBlob);
                setAudioUrl(url);
                handleStateChange("preview");
            };

            nativeRecorder.onerror = (err: Event) => {
                console.error("[AudioRecorder] Native recorder error:", err);
                cancelRecording();
                toast({
                    title: "Erro na gravação",
                    description: "Ocorreu um erro durante a gravação nativa de áudio.",
                    variant: "destructive",
                });
            };

            recorderRef.current = nativeRecorder;
            nativeRecorder.start(250);

            // Set state ONLY after successful start
            handleStateChange("recording");
            setRecordingTime(0);
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = setInterval(() => {
                setRecordingTime(prev => prev + 1);
            }, 1000);

        } catch (err) {
            console.error("[AudioRecorder] Native recording failed to start:", err);
            cancelRecording();
            toast({
                title: "Não foi possível iniciar gravação",
                description: "Não foi possível iniciar a gravação de áudio neste navegador.",
                variant: "destructive",
            });
        }
    }, [handleStateChange, cancelRecording, toast]);

    const startRecording = useCallback(async () => {
        isCancelledRef.current = false;
        isStartingRef.current = true;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: buildAudioConstraints()
            });

            if (isCancelledRef.current) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }

            streamRef.current = stream;

            // TRY opus-recorder library FIRST for strict Ogg/Opus support (WhatsApp preferred)
            try {
                console.log("[AudioRecorder] Attempting Ogg/Opus recording with library");
                const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
                if (!AudioCtx) {
                    throw new Error("AudioContext not supported");
                }

                const audioContext = new AudioCtx();
                audioContextRef.current = audioContext;

                if (audioContext.state === "suspended") {
                    await audioContext.resume();
                }

                const sourceNode = audioContext.createMediaStreamSource(stream);

                const recorder: OpusRecorderInstance = new Recorder({
                    encoderPath: "/encoderWorker.min.js",
                    numberOfChannels: 1,
                    encoderSampleRate: 48000,
                    maxDuration: 600,
                    sourceNode,
                });

                recorder.ondataavailable = (typedArray: Uint8Array) => {
                    if (isCancelledRef.current) return;

                    const audioBlob = new Blob([typedArray], { type: "audio/ogg" });
                    if (!isValidAudioBlob(audioBlob)) {
                        console.error("[AudioRecorder] Opus recorder emitted empty audio:", audioBlob.size, "bytes");
                        cancelRecording();
                        toast({
                            title: "Gravação vazia",
                            description: "Não foi possível capturar o áudio do microfone. Tente gravar novamente.",
                            variant: "destructive",
                        });
                        return;
                    }

                    audioBlobRef.current = audioBlob;
                    setAudioUrl(URL.createObjectURL(audioBlob));
                    handleStateChange("preview");
                };

                recorder.onerror = (err: unknown) => {
                    console.error("[AudioRecorder] Opus recorder library error, falling back to native:", err);
                    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
                        audioContextRef.current.close().catch(() => {});
                        audioContextRef.current = null;
                    }
                    startNativeRecording(stream);
                };

                recorderRef.current = recorder;

                // Await start() do opus-recorder: só transiciona quando o áudio começar de verdade!
                await recorder.start();

                if (isCancelledRef.current) {
                    cancelRecording();
                    return;
                }

                isStartingRef.current = false;
                handleStateChange("recording");
                setRecordingTime(0);
                if (timerRef.current) clearInterval(timerRef.current);
                timerRef.current = setInterval(() => {
                    setRecordingTime(prev => prev + 1);
                }, 1000);

            } catch (libError) {
                console.warn("[AudioRecorder] Opus library failed init, falling back to native", libError);
                if (audioContextRef.current && audioContextRef.current.state !== "closed") {
                    audioContextRef.current.close().catch(() => {});
                    audioContextRef.current = null;
                }
                if (isCancelledRef.current) {
                    cancelRecording();
                    return;
                }
                isStartingRef.current = false;
                startNativeRecording(stream);
            }

        } catch (error) {
            console.error("[AudioRecorder] Mic access error:", error);
            isStartingRef.current = false;
            cancelRecording();
            const { title, description } = describeMicError(error);
            toast({ title, description, variant: "destructive" });
        }
    }, [handleStateChange, startNativeRecording, cancelRecording, toast]);

    const stopRecording = useCallback(() => {
        if (isStartingRef.current) {
            cancelRecording();
            toast({
                title: "Gravação muito curta",
                description: "Grave por pelo menos 1 segundo.",
                variant: "destructive",
            });
            return;
        }

        if (recordingTime < 1) {
            cancelRecording();
            toast({
                title: "Gravação muito curta",
                description: "Grave por pelo menos 1 segundo.",
                variant: "destructive",
            });
            return;
        }

        const currentRecorder = recorderRef.current;

        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }

        if (!currentRecorder) {
            console.warn("[AudioRecorder] stopRecording called but no recorder exists. Resetting to idle.");
            cancelRecording();
            return;
        }

        try {
            if (typeof currentRecorder.stop === "function") {
                currentRecorder.stop();
            } else {
                console.error("[AudioRecorder] Recorder has no stop method", currentRecorder);
                cancelRecording();
            }
        } catch (e) {
            console.error("[AudioRecorder] Error stopping recorder:", e);
            cancelRecording();
        }
    }, [recordingTime, cancelRecording, toast]);

    const handleSeek = (value: number[]) => {
        setCurrentPlayTime(value[0]);
    };

    const handleSeekEnd = (value: number[]) => {
        if (audioRef.current) {
            audioRef.current.currentTime = value[0];
            setCurrentPlayTime(value[0]);
            setIsSeeking(false);
        }
    };

    // Só descartar a gravação DEPOIS de o upload confirmar: falha de envio
    // mantém o preview com o blob intacto (era gravar tudo de novo).
    const handleSend = useCallback(async () => {
        const blob = audioBlobRef.current;
        if (!blob || state === "sending") return;

        if (!isValidAudioBlob(blob, duration)) {
            toast({
                title: "Áudio inválido",
                description: "O áudio gravado está vazio ou incompleto. Tente gravar novamente.",
                variant: "destructive",
            });
            cancelRecording();
            return;
        }

        handleStateChange("sending");
        try {
            const result = await Promise.resolve(onSend(blob));
            if (result === false) {
                handleStateChange("preview");
                return;
            }
            cancelRecording();
        } catch {
            handleStateChange("preview");
        }
    }, [onSend, cancelRecording, handleStateChange, state, duration, toast]);

    const togglePlayback = useCallback(() => {
        if (!audioRef.current || !audioUrl) return;

        if (isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            audioRef.current.play();
            setIsPlaying(true);
        }
    }, [isPlaying, audioUrl]);

    // Handle audio events
    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const handleEnded = () => {
            setIsPlaying(false);
            setCurrentPlayTime(0);
        };

        const handleTimeUpdate = () => {
            if (!isSeeking) {
                setCurrentPlayTime(audio.currentTime);
            }
        };

        const handleLoadedMetadata = () => {
            const dur = audioRef.current?.duration ?? 0;
            if (!Number.isFinite(dur) || Number.isNaN(dur) || dur <= 0) {
                setDuration(0);
            } else {
                setDuration(dur);
            }
        };

        audio.addEventListener("ended", handleEnded);
        audio.addEventListener("timeupdate", handleTimeUpdate);
        audio.addEventListener("loadedmetadata", handleLoadedMetadata);

        return () => {
            audio.removeEventListener("ended", handleEnded);
            audio.removeEventListener("timeupdate", handleTimeUpdate);
            audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
        };
    }, [audioUrl]);

    // Idle state - just show mic button
    if (state === "idle") {
        return (
            <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={startRecording}
                disabled={disabled}
                className="text-muted-foreground hover:text-primary"
                title="Gravar áudio"
                aria-label="Gravar áudio"
            >
                <Mic className="w-5 h-5" />
            </Button>
        );
    }

    // Recording state
    if (state === "recording") {
        return (
            <div className="flex items-center gap-4 md:gap-2 px-3 py-1.5 bg-destructive/10 rounded-full">
                <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
                <span className="text-sm font-medium tabular-nums text-destructive">
                    {formatTime(recordingTime)}
                </span>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={cancelRecording}
                    className="h-11 w-11 md:h-7 md:w-7 p-0 text-muted-foreground hover:text-destructive"
                    title="Cancelar"
                    aria-label="Cancelar gravação"
                >
                    <X className="w-4 h-4" />
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        stopRecording();
                    }}
                    className="h-11 w-11 md:h-7 md:w-7 p-0 bg-destructive text-destructive-foreground hover:bg-destructive/90 rounded-full"
                    title="Parar gravação"
                    aria-label="Parar gravação"
                >
                    <Square className="w-3 h-3" />
                </Button>
            </div>
        );
    }

    // Preview state (inclui "sending": mesmo layout com o botão em progresso)
    if (state === "preview" || state === "sending") {
        const isSendDisabled =
            state === "sending" ||
            !duration ||
            duration < MIN_AUDIO_DURATION_S ||
            !audioBlobRef.current ||
            audioBlobRef.current.size < MIN_AUDIO_BYTES;

        return (
            <div className="flex items-center gap-3 px-4 py-2 bg-muted rounded-full w-full max-w-xl shadow-sm">
                {audioUrl && (
                    <audio ref={audioRef} src={audioUrl} className="hidden" />
                )}

                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={togglePlayback}
                    className="h-8 w-8 shrink-0 text-primary hover:bg-primary/10"
                    title={isPlaying ? "Pausar" : "Reproduzir"}
                    aria-label={isPlaying ? "Pausar" : "Reproduzir"}
                >
                    {isPlaying ? (
                        <Pause className="w-5 h-5" />
                    ) : (
                        <Play className="w-5 h-5 ml-0.5" />
                    )}
                </Button>

                <div className="flex items-center flex-1 gap-2 mx-1">
                    <span className="text-2xs text-muted-foreground font-mono w-7 shrink-0">
                        {formatTime(Math.floor(currentPlayTime))}
                    </span>
                    <Slider
                        value={[currentPlayTime]}
                        max={duration || 1}
                        step={0.01}
                        onValueChange={(val) => {
                            setIsSeeking(true);
                            handleSeek(val);
                        }}
                        onValueCommit={handleSeekEnd}
                        trackClassName="h-1"
                        thumbClassName="h-3 w-3"
                        className="flex-1"
                    />
                    <span className="text-2xs text-muted-foreground font-mono w-7 shrink-0 text-right">
                        {formatTime(Math.floor(duration))}
                    </span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={cancelRecording}
                        disabled={state === "sending"}
                        className="h-11 w-11 md:h-8 md:w-8 p-0 text-muted-foreground hover:text-destructive"
                        title="Descartar"
                        aria-label="Descartar gravação"
                    >
                        <X className="w-4 h-4" />
                    </Button>
                    <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={handleSend}
                        disabled={isSendDisabled}
                        className="h-11 md:h-8 px-4 rounded-full bg-primary text-white shadow-sm disabled:opacity-50"
                        title={isSendDisabled && state !== "sending" ? "Áudio inválido ou sem som gravado" : "Enviar áudio"}
                    >
                        {state === "sending" ? (
                            <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                        ) : (
                            <Send className="w-3.5 h-3.5 mr-2" />
                        )}
                        <span className="text-xs font-semibold">
                            {state === "sending" ? "Enviando…" : "Enviar"}
                        </span>
                    </Button>
                </div>
            </div>
        );
    }

    return null;
}
