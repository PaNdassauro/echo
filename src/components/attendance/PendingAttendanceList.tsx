import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatDistanceToNowStrict, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Users, ChevronRight } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PENDING_STATE_LABEL, agentLabel, type AttendancePendingRow, type PendingState } from "@/lib/attendanceReport";
import { OUTCOMES } from "./outcomes";

interface PendingAttendanceListProps {
    rows: AttendancePendingRow[];
    isLoading: boolean;
}

const COLLAPSED = 8;

const outcomeFor = (state: PendingState) => OUTCOMES.find((o) => o.key === (state === "unanswered" ? "unanswered" : "open"))!;

/**
 * Atendimentos do período que ainda pedem atenção, os mais urgentes primeiro
 * (cliente esperando → sem resposta → esperando o cliente). Clicar abre a conversa.
 */
export function PendingAttendanceList({ rows, isLoading }: PendingAttendanceListProps) {
    const navigate = useNavigate();
    const [expanded, setExpanded] = useState(false);
    const visible = expanded ? rows : rows.slice(0, COLLAPSED);

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Pedem atenção</CardTitle>
                <CardDescription>Em aberto e sem resposta, dos atendimentos do período</CardDescription>
            </CardHeader>
            <CardContent className="px-2 sm:px-6">
                {isLoading ? (
                    <div className="space-y-2">
                        {Array.from({ length: 3 }, (_, i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </div>
                ) : rows.length === 0 ? (
                    <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nada pendente neste período.</p>
                ) : (
                    <>
                        <ul className="divide-y">
                            {visible.map((row) => {
                                const outcome = outcomeFor(row.state);
                                return (
                                    <li key={`${row.conversation_id}-${row.started_at}`}>
                                        <button
                                            type="button"
                                            onClick={() => navigate(`/dashboard/${row.conversation_id}`)}
                                            className="w-full flex items-center gap-3 px-2 py-2.5 text-left rounded-md hover:bg-muted/50 transition-colors"
                                        >
                                            <outcome.icon
                                                className="h-4 w-4 shrink-0"
                                                style={{ color: outcome.color }}
                                                aria-hidden="true"
                                            />
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-1.5 text-sm font-medium">
                                                    {row.is_group && (
                                                        <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Grupo" />
                                                    )}
                                                    <span className="truncate">{row.contact_name}</span>
                                                </div>
                                                <div className="text-xs text-muted-foreground truncate">
                                                    <span className={cn(row.state === "waiting_agent" && "font-medium text-foreground")}>
                                                        {PENDING_STATE_LABEL[row.state]}
                                                    </span>
                                                    {" · "}
                                                    {agentLabel(row)}
                                                </div>
                                            </div>
                                            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                                {formatDistanceToNowStrict(parseISO(row.last_message_at), { locale: ptBR, addSuffix: true })}
                                            </span>
                                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                        {rows.length > COLLAPSED && (
                            <Button variant="ghost" size="sm" className="mt-2 w-full text-xs" onClick={() => setExpanded((v) => !v)}>
                                {expanded ? "Mostrar menos" : `Mostrar todos (${rows.length})`}
                            </Button>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
