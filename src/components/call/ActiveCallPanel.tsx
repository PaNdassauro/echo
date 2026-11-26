import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Mic, MicOff, PhoneOff } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconSwap } from "@/components/ui/icon-swap";
import { cn } from "@/lib/utils";
import { describeCallState } from "@/lib/voiceCall";
import { useVoiceCalls, type ActiveCall } from "@/contexts/VoiceCallContext";

function formatDuration(totalSeconds: number): string {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Painel da ligação em curso. Também é card, não diálogo: durante uma ligação o
 * atendente continua trabalhando — procurando o pedido, abrindo outra conversa.
 *
 * Nada aqui desliga por acidente: não há ✕ que encerre, Esc não faz nada (não é
 * um Dialog) e recolher só encolhe o card. Desligar exige o botão vermelho.
 */
export default function ActiveCallPanel({ call: activeCall }: { call: ActiveCall }) {
    // Por prop, e não do contexto, para o painel sobreviver à animação de saída.
    const { hangUp, toggleMute, closeActiveCall } = useVoiceCalls();
    const [collapsed, setCollapsed] = useState(false);
    const [elapsed, setElapsed] = useState(0);

    const update = activeCall.update;
    const isActive = update?.state === "active";
    const connectedAt = update?.connectedAt;

    useEffect(() => {
        if (!isActive) {
            setElapsed(0);
            return;
        }
        const startedAt = connectedAt ?? Date.now();
        const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
        tick();
        const id = window.setInterval(tick, 1000);
        return () => window.clearInterval(id);
    }, [isActive, connectedAt]);

    // Ligação que aconteceu não fica de enfeite no canto. Mas a que NÃO conectou
    // (recusada, não atendida) é justamente a que precisa ser lida: essa fica até
    // o atendente fechar, como o erro.
    const { phase, contactName, to, muted, error, direction } = activeCall;
    const connected = Boolean(update?.connectedAt);
    useEffect(() => {
        if (phase !== "ended" || !connected) return;
        const id = window.setTimeout(closeActiveCall, 5000);
        return () => window.clearTimeout(id);
    }, [phase, connected, closeActiveCall]);

    const finished = phase === "ended" || phase === "error";
    const initial = contactName.trim().charAt(0).toUpperCase() || "?";
    const status = phase === "starting" && !update
        ? (direction === "incoming" ? "Atendendo…" : "Chamando…")
        : phase === "error"
            ? "Não foi possível ligar"
            : isActive
                ? formatDuration(elapsed)
                : phase === "ended" && !update
                    ? "Ligação encerrada" // socket caiu sem nenhum frame de estado
                    : describeCallState(update);

    if (collapsed && !finished) {
        return (
            <Card className="flex items-center gap-2 rounded-full py-1.5 pl-3 pr-1.5 shadow-lg">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm">{contactName}</span>
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{status}</span>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 rounded-full"
                    onClick={() => setCollapsed(false)}
                    aria-label="Expandir ligação"
                    title="Expandir"
                >
                    <ChevronUp className="h-4 w-4" />
                </Button>
                <Button
                    variant="destructive"
                    size="icon"
                    className="h-7 w-7 shrink-0 rounded-full"
                    onClick={hangUp}
                    aria-label="Desligar"
                    title="Desligar"
                >
                    <PhoneOff className="h-3.5 w-3.5" />
                </Button>
            </Card>
        );
    }

    return (
        <Card className="relative shadow-lg">
            {!finished && (
                <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1 h-7 w-7 text-muted-foreground"
                    onClick={() => setCollapsed(true)}
                    aria-label="Recolher ligação"
                    title="Recolher (não desliga)"
                >
                    <ChevronDown className="h-4 w-4" />
                </Button>
            )}

            <div className="flex items-center gap-3 px-4 pb-3 pt-4">
                <Avatar className={cn("h-11 w-11 shrink-0", isActive && "ring-2 ring-emerald-500/40")}>
                    <AvatarFallback>{initial}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 pr-6">
                    <p className="truncate font-medium leading-tight">{contactName}</p>
                    <p className="truncate text-xs text-muted-foreground tabular-nums">{to.replace(/@.*$/, "")}</p>
                    <p
                        className={cn(
                            "mt-0.5 flex items-center gap-1.5 text-xs tabular-nums",
                            isActive ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                            phase === "error" && "text-destructive",
                        )}
                        aria-live="polite"
                    >
                        {phase === "starting" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                        {status}
                    </p>
                </div>
            </div>

            {error && <p className="px-4 pb-3 text-xs text-muted-foreground">{error}</p>}

            <div className="flex items-center gap-2 border-t bg-muted/40 px-4 py-3">
                {finished ? (
                    <Button variant="outline" className="flex-1" onClick={closeActiveCall}>
                        Fechar
                    </Button>
                ) : (
                    <>
                        <Button
                            variant={muted ? "secondary" : "outline"}
                            className="flex-1"
                            onClick={toggleMute}
                            disabled={phase !== "live"}
                            aria-pressed={muted}
                        >
                            <IconSwap
                                className="mr-2 h-4 w-4"
                                active={muted ? "muted" : "open"}
                                icons={{ open: <Mic className="h-4 w-4" />, muted: <MicOff className="h-4 w-4" /> }}
                            />
                            {muted ? "Ativar som" : "Silenciar"}
                        </Button>
                        <Button variant="destructive" onClick={hangUp}>
                            <PhoneOff className="mr-2 h-4 w-4" />
                            Desligar
                        </Button>
                    </>
                )}
            </div>
        </Card>
    );
}
