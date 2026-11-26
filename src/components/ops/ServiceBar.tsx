import type { ComponentType, ReactNode } from "react";
import { AlertTriangle, RotateCw, ServerCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { QrServiceHealth } from "@/hooks/useQrServiceHealth";
import { formatUptime } from "./opsFormat";

/** Serviço que subiu há pouco = todas as sessões reconectaram agora. É sinal, não detalhe (sem sessão nenhuma, não há o que reconectar). */
const RESTART_WINDOW_S = 15 * 60;
/** Arquivo em disco há mais que isto = fila que não está drenando, não só pós-restart. */
const DISK_QUEUE_STUCK_AGE_S = 60 * 60;

interface ServiceBarProps {
    health: QrServiceHealth | undefined;
    error: Error | null;
    isLoading: boolean;
    onRetry: () => void;
}

function Chip({ tone, icon: Icon = AlertTriangle, children }: { tone: "bad" | "warn"; icon?: ComponentType<{ className?: string }>; children: ReactNode }) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap",
                tone === "bad" && "bg-destructive text-destructive-foreground",
                tone === "warn" && "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
            )}
        >
            <Icon className="h-3 w-3 shrink-0" aria-hidden />
            {children}
        </span>
    );
}

/**
 * Estado do qr-service em si — não das linhas. `outbox_stalled` e a fila de
 * webhooks são o alarme de perda de mensagem: chegavam no payload e não eram
 * mostrados em lugar nenhum.
 */
export function ServiceBar({ health, error, isLoading, onRetry }: ServiceBarProps) {
    if (isLoading && !health && !error) {
        return <Skeleton className="h-12 w-full" />;
    }

    if (error) {
        return (
            <Card className="border-destructive/40">
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                        <ServerCog className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
                        <span className="min-w-0">
                            Serviço QR não respondeu: {error.message}
                            <span className="block text-xs text-muted-foreground">
                                As colunas Serviço e Cota caem para o log de conexão, que atrasa.
                            </span>
                        </span>
                    </span>
                    <Button size="sm" variant="outline" onClick={onRetry}>Tentar de novo</Button>
                </CardContent>
            </Card>
        );
    }

    if (!health) return null;

    const { service } = health;
    const stalled = service.outbox_stalled === true;
    const queued = service.pending_webhooks ?? 0;
    const onDisk = service.outbox_disk ?? 0;
    const oldestDiskAge = service.outbox_oldest_disk_age_s ?? null;
    const diskStuck = onDisk > 0 && oldestDiskAge !== null && oldestDiskAge > DISK_QUEUE_STUCK_AGE_S;
    const restarted = service.uptime_s !== null && service.uptime_s < RESTART_WINDOW_S && service.total_sessions > 0;
    const bad = stalled || diskStuck;
    const warn = !bad && (restarted || queued > 0 || onDisk > 0);

    return (
        <Card className={cn("shadow-sm", bad && "border-destructive/50", warn && "border-amber-500/40")}>
            <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 text-sm">
                <span className="flex items-center gap-2">
                    <span
                        className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            bad ? "bg-destructive" : warn ? "bg-amber-500" : "bg-emerald-500",
                        )}
                        aria-hidden
                    />
                    <span className="font-medium">qr-service {service.version ?? "?"}</span>
                </span>
                {service.commit && (
                    <span className="font-mono text-xs text-muted-foreground" title="commit da imagem em produção">
                        {service.commit.slice(0, 7)}
                    </span>
                )}
                <span className="text-xs text-muted-foreground tabular-nums">
                    no ar há {formatUptime(service.uptime_s)}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                    {service.total_sessions} {service.total_sessions === 1 ? "sessão" : "sessões"}
                </span>
                {service.rss_mb !== null && (
                    <span className="text-xs text-muted-foreground tabular-nums" title="memória residente do processo">
                        {Math.round(service.rss_mb)} MB
                    </span>
                )}
                <span className="flex flex-wrap items-center gap-2 sm:ml-auto">
                    {stalled && <Chip tone="bad">outbox travado — mensagem pode estar se perdendo</Chip>}
                    {onDisk > 0 && (
                        <Chip tone={diskStuck ? "bad" : "warn"}>
                            {onDisk} {onDisk === 1 ? "arquivo" : "arquivos"} na fila em disco
                            {oldestDiskAge !== null && ` · o mais antigo há ${formatUptime(oldestDiskAge)}`}
                        </Chip>
                    )}
                    {queued > 0 && <Chip tone="warn">{queued} {queued === 1 ? "webhook" : "webhooks"} na fila</Chip>}
                    {restarted && (
                        <Chip tone="warn" icon={RotateCw}>reiniciou há {formatUptime(service.uptime_s)}</Chip>
                    )}
                </span>
            </CardContent>
        </Card>
    );
}
