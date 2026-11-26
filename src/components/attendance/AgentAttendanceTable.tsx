import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Smartphone, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
    activePerDay,
    agentLabel,
    formatCount,
    formatDuration,
    formatHours,
    formatPercent,
    percent,
    phoneShare,
    type AttendanceAgentRow,
} from "@/lib/attendanceReport";
import { OutcomeBar } from "./OutcomeBar";

interface AgentAttendanceTableProps {
    rows: AttendanceAgentRow[];
    isLoading: boolean;
    selectedAgentId: string | null;
    onSelectAgent: (agentId: string | null) => void;
}

/** Acima disso os números da atendente dependem da atribuição pela conversa. */
const PHONE_SHARE_WARNING = 50;

export function AgentAttendanceTable({ rows, isLoading, selectedAgentId, onSelectAgent }: AgentAttendanceTableProps) {
    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Por atendente</CardTitle>
                <CardDescription>
                    Clique numa atendente para filtrar o painel inteiro por ela. Mensagens, mensagens fora do horário e
                    tempo ativo contam pela data da mensagem.
                </CardDescription>
            </CardHeader>
            <CardContent className="px-0 sm:px-6">
                {isLoading ? (
                    <div className="space-y-2 px-4 sm:px-0">
                        {Array.from({ length: 4 }, (_, i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </div>
                ) : rows.length === 0 ? (
                    <div className="mx-4 sm:mx-0 h-[120px] flex items-center justify-center text-sm text-muted-foreground border-2 border-dashed rounded-lg">
                        Nenhuma atendente com atividade no período
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <Table className="min-w-[880px] [&_td]:px-2.5 [&_th]:px-2.5">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Atendente</TableHead>
                                    <TableHead className="text-right">Atendimentos</TableHead>
                                    <TableHead className="w-[110px]">Desfecho</TableHead>
                                    <TableHead className="text-right">Mesmo dia</TableHead>
                                    <TableHead className="text-right">Em aberto</TableHead>
                                    <TableHead className="text-right">Sem resposta</TableHead>
                                    <TableHead className="text-right">Fora do horário</TableHead>
                                    <TableHead className="text-right">1ª resposta</TableHead>
                                    <TableHead className="text-right">Duração</TableHead>
                                    <TableHead className="text-right">Mensagens</TableHead>
                                    <TableHead className="text-right">Tempo ativo</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((row) => {
                                    const isUnidentified = row.agent_id === null;
                                    const isSelected = row.agent_id !== null && row.agent_id === selectedAgentId;
                                    const concluded = row.same_day + row.other_day;
                                    const share = phoneShare(row);
                                    const perDay = activePerDay(row);
                                    const select = () => {
                                        if (isUnidentified) return;
                                        onSelectAgent(isSelected ? null : row.agent_id);
                                    };
                                    return (
                                        <TableRow
                                            key={row.agent_id ?? "unidentified"}
                                            onClick={select}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter" || e.key === " ") {
                                                    e.preventDefault();
                                                    select();
                                                }
                                            }}
                                            tabIndex={isUnidentified ? undefined : 0}
                                            aria-selected={isSelected}
                                            className={cn(
                                                "tabular-nums whitespace-nowrap",
                                                !isUnidentified && "cursor-pointer",
                                                isSelected && "bg-primary/5 hover:bg-primary/10",
                                                isUnidentified && "text-muted-foreground",
                                            )}
                                        >
                                            <TableCell className="font-medium">
                                                <div className="flex items-center gap-1.5">
                                                    <span className="truncate max-w-[200px]">{agentLabel(row)}</span>
                                                    {isUnidentified && (
                                                        <Tooltip>
                                                            <TooltipTrigger asChild>
                                                                <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-label="O que é" />
                                                            </TooltipTrigger>
                                                            <TooltipContent className="max-w-[260px] text-xs">
                                                                Ninguém respondeu pelo Echo e a conversa não tem responsável — quase
                                                                sempre respostas dadas direto pelo celular. Atribuir a conversa a
                                                                alguém resolve.
                                                            </TooltipContent>
                                                        </Tooltip>
                                                    )}
                                                    {!isUnidentified && share !== null && share > PHONE_SHARE_WARNING && (
                                                        <Tooltip>
                                                            <TooltipTrigger asChild>
                                                                <Smartphone
                                                                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                                                    aria-label={`${share}% pelo celular`}
                                                                />
                                                            </TooltipTrigger>
                                                            <TooltipContent className="max-w-[260px] text-xs">
                                                                {share}% das mensagens saíram pelo celular, sem autor no Echo. Elas
                                                                contam para ela porque ela é a responsável pela conversa — respostas
                                                                pelo Echo dão números mais precisos.
                                                            </TooltipContent>
                                                        </Tooltip>
                                                    )}
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-right font-semibold">{formatCount(row.total)}</TableCell>
                                            <TableCell>
                                                <OutcomeBar size="sm" counts={row} />
                                            </TableCell>
                                            <TableCell className="text-right">
                                                {formatPercent(percent(row.same_day, concluded))}
                                            </TableCell>
                                            <TableCell className="text-right">{formatCount(row.open)}</TableCell>
                                            <TableCell className="text-right">{formatCount(row.unanswered)}</TableCell>
                                            {/* Tudo de fora do horário junto: atendimentos que começaram fora e
                                                mensagens que ela mandou fora */}
                                            <TableCell className="text-right">
                                                {formatCount(row.off_hours)}
                                                {row.messages_out_off_hours > 0 && (
                                                    <div className="text-xs text-muted-foreground">
                                                        {formatCount(row.messages_out_off_hours)} msgs
                                                    </div>
                                                )}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                {formatDuration(row.first_response_median_seconds)}
                                            </TableCell>
                                            <TableCell className="text-right">{formatDuration(row.duration_median_seconds)}</TableCell>
                                            <TableCell className="text-right">{formatCount(row.messages_out)}</TableCell>
                                            <TableCell
                                                className="text-right"
                                                title={`${row.active_days} ${row.active_days === 1 ? "dia" : "dias"} com mensagens enviadas`}
                                            >
                                                {formatHours(row.active_seconds)}
                                                {perDay !== null && (
                                                    <div className="text-xs text-muted-foreground">{formatHours(perDay)}/dia</div>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
