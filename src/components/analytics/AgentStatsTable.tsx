import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import type { AgentStats } from "@/hooks/useAnalytics";

interface AgentStatsTableProps {
    data: AgentStats[];
    isLoading: boolean;
}

function formatResponseTime(seconds: number): string {
    if (seconds === 0) return "—";

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);

    if (minutes === 0) {
        return `${remainingSeconds}s`;
    } else if (minutes < 60) {
        return `${minutes}m`;
    } else {
        const hours = Math.floor(minutes / 60);
        return `${hours}h`;
    }
}

function getInitials(name: string): string {
    return name
        .split(" ")
        .map((n) => n[0])
        .slice(0, 2)
        .join("")
        .toUpperCase();
}

function getLoadBadgeVariant(load: number): "default" | "secondary" | "destructive" | "outline" {
    if (load === 0) return "outline";
    if (load <= 5) return "secondary";
    if (load <= 10) return "default";
    return "destructive";
}

export function AgentStatsTable({ data, isLoading }: AgentStatsTableProps) {
    return (
        <Card className="border-border bg-card shadow-sm">
            <CardHeader>
                <CardTitle className="text-base font-semibold">
                    Ranking de atendentes
                </CardTitle>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <div className="space-y-3">
                        {[1, 2, 3, 4, 5].map((i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </div>
                ) : data.length === 0 ? (
                    <div className="h-[200px] flex items-center justify-center text-muted-foreground border-2 border-dashed rounded-lg">
                        Nenhum atendente com atividade no período
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="w-[40px]">#</TableHead>
                                    <TableHead>Atendente</TableHead>
                                    <TableHead className="text-center">Setor</TableHead>
                                    <TableHead className="text-right">Mensagens</TableHead>
                                    <TableHead className="text-right">Conversas</TableHead>
                                    <TableHead className="text-right">Tempo de resposta</TableHead>
                                    <TableHead className="text-center">Carga atual</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {data.map((agent, index) => (
                                    <TableRow
                                        key={agent.agent_id}
                                        className="transition-colors hover:bg-muted/50"
                                    >
                                        <TableCell className="font-medium text-muted-foreground">
                                            {index + 1}
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-center gap-3">
                                                <Avatar className="h-8 w-8">
                                                    <AvatarFallback className="text-xs bg-primary/10 text-primary">
                                                        {getInitials(agent.agent_name || "NN")}
                                                    </AvatarFallback>
                                                </Avatar>
                                                <div className="flex flex-col">
                                                    <span className="font-medium text-sm">
                                                        {agent.agent_name || "Sem nome"}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground">
                                                        {agent.agent_email}
                                                    </span>
                                                </div>
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-center">
                                            {agent.sector_name ? (
                                                <Badge variant="outline" className="text-xs">
                                                    {agent.sector_name}
                                                </Badge>
                                            ) : (
                                                <span className="text-muted-foreground text-xs">—</span>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right font-medium tabular-nums">
                                            {agent.messages_sent.toLocaleString()}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {agent.conversations_handled.toLocaleString()}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {formatResponseTime(agent.avg_response_time_seconds)}
                                        </TableCell>
                                        <TableCell className="text-center">
                                            <Badge variant={getLoadBadgeVariant(agent.current_open_conversations)}>
                                                {agent.current_open_conversations}
                                            </Badge>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
