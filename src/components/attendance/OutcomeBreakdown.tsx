import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount, type AttendanceSummary } from "@/lib/attendanceReport";
import { OutcomeBar } from "./OutcomeBar";
import { OUTCOMES } from "./outcomes";

interface OutcomeBreakdownProps {
    summary: AttendanceSummary | undefined;
    idleHours: number;
    isLoading: boolean;
}

export function OutcomeBreakdown({ summary: s, idleHours, isLoading }: OutcomeBreakdownProps) {
    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Como os atendimentos terminaram</CardTitle>
                <CardDescription>
                    Resolvido = {idleHours}h sem mensagens depois da resposta da equipe, ou conversa encerrada no Echo.
                    Por isso os atendimentos das últimas {idleHours}h ainda aparecem em aberto.
                </CardDescription>
            </CardHeader>
            <CardContent>
                {isLoading || !s ? (
                    <Skeleton className="h-16 w-full" />
                ) : (
                    <div className="space-y-4">
                        <OutcomeBar counts={s} />
                        {/* Legenda = rótulo direto: ícone + nome + número, nunca só a cor. Só a
                            contagem: o % de "mesmo dia" que vale é o do indicador (sobre os
                            concluídos); aqui ele seria sobre o total e os dois brigariam. O %
                            sobre o total fica no tooltip da barra. */}
                        <ul className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3">
                            {OUTCOMES.map((o) => (
                                <li key={o.key} className="flex items-start gap-2 min-w-0">
                                    <span
                                        className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm"
                                        style={{ backgroundColor: o.color }}
                                        aria-hidden="true"
                                    />
                                    <div className="min-w-0">
                                        <div className="flex items-start gap-1 text-xs leading-tight text-muted-foreground">
                                            <o.icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                            <span>{o.label}</span>
                                        </div>
                                        <div className="text-sm font-semibold mt-0.5">{formatCount(s[o.key])}</div>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
