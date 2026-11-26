import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Users } from "lucide-react";
import type { ConnectionEvent } from "@/hooks/useConnectionHealth";
import { closeLabel, secondsBetween, shortDateTime } from "./opsFormat";

interface EventsFeedProps {
    events: ConnectionEvent[];
    lineNames: Map<string, string>;
    isLoading: boolean;
    selectedId: string | null;
}

function toneFor(e: ConnectionEvent): string {
    if (e.status_code === 403) return "bg-destructive";
    if (e.reason === "conflict") return "bg-orange-500";
    if (e.reason === "fatal") return "bg-red-500";
    return "bg-muted-foreground/50";
}

export function EventsFeed({ events, lineNames, isLoading, selectedId }: EventsFeedProps) {
    const visible = selectedId ? events.filter((e) => e.phone_number_id === selectedId) : events;

    return (
        <Card className="border-border bg-card shadow-sm">
            <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Eventos críticos</CardTitle>
                <p className="text-xs text-muted-foreground">
                    Closes com 401/403/440, conflict, fatal ou reconnect. Quando um "adicionou" em grupo precede o conflict em até 10 min, ele aparece embaixo: é a penalidade do WhatsApp.
                </p>
            </CardHeader>
            <CardContent className="p-0">
                {isLoading ? (
                    <div className="space-y-2 p-4">
                        {Array.from({ length: 5 }).map((_, i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </div>
                ) : visible.length === 0 ? (
                    <p className="px-4 pb-4 text-sm text-muted-foreground">Nenhum evento crítico na janela.</p>
                ) : (
                    <ol className="max-h-[520px] overflow-y-auto divide-y divide-border">
                        {visible.map((e) => (
                            <li key={e.id} className="flex gap-3 px-4 py-3">
                                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", toneFor(e))} aria-hidden />
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                                        <span className="font-medium">{lineNames.get(e.phone_number_id) ?? "linha removida"}</span>
                                        <span className="font-mono text-xs">{closeLabel(e.status_code, e.reason)}</span>
                                        {e.reconnect_attempts !== null && e.reconnect_attempts > 0 && (
                                            <span
                                                className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums"
                                                title="tentativas de reconexão acumuladas quando o evento foi gravado"
                                            >
                                                tentativa {e.reconnect_attempts}
                                            </span>
                                        )}
                                        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{shortDateTime(e.created_at)}</span>
                                    </div>
                                    {e.error_message && <div className="truncate text-xs text-muted-foreground">{e.error_message}</div>}
                                    {e.group_action && e.group_action_at && (
                                        <div className="mt-1 flex items-start gap-1.5 rounded-md bg-orange-50 px-2 py-1 text-xs text-orange-900 dark:bg-orange-950/40 dark:text-orange-200">
                                            <Users className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                                            <span className="min-w-0">
                                                {e.group_action}
                                                {e.group_name ? ` · ${e.group_name}` : ""}
                                                <span className="text-orange-700/80 dark:text-orange-300/80"> · {secondsBetween(e.created_at, e.group_action_at)}s antes</span>
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ol>
                )}
            </CardContent>
        </Card>
    );
}
