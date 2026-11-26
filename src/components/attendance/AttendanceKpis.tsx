import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Headphones, CheckCheck, Hourglass, MessageSquareX, MoonStar, Timer, Clock3, Activity } from "lucide-react";
import {
    BUSINESS_HOURS,
    formatCount,
    formatDuration,
    formatHours,
    formatPercent,
    percent,
    type AttendanceSummary,
} from "@/lib/attendanceReport";

interface AttendanceKpisProps {
    summary: AttendanceSummary | undefined;
    idleHours: number;
    unansweredHours: number;
    isLoading: boolean;
}

interface Kpi {
    title: string;
    value: string;
    description: string;
    icon: typeof Headphones;
}

export function AttendanceKpis({ summary: s, idleHours, unansweredHours, isLoading }: AttendanceKpisProps) {
    if (isLoading || !s) {
        return (
            <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="h-[108px] rounded-lg" />
                ))}
            </div>
        );
    }

    const concluded = s.same_day + s.other_day;
    const kpis: Kpi[] = [
        {
            title: "Atendimentos",
            value: formatCount(s.total),
            description: `${formatCount(s.started_by_client)} pelo cliente · ${formatCount(s.total - s.started_by_client)} pela equipe`,
            icon: Headphones,
        },
        {
            title: "Resolvidos no mesmo dia",
            // % sobre os concluídos: aberto ainda pode terminar em qualquer dia
            value: formatPercent(percent(s.same_day, concluded)),
            description:
                concluded > 0
                    ? `${formatCount(s.same_day)} de ${formatCount(concluded)} concluídos`
                    : `Conclui após ${idleHours}h sem mensagens`,
            icon: CheckCheck,
        },
        {
            title: "Em aberto",
            value: formatCount(s.open),
            description: `${formatCount(s.waiting_agent)} aguardando atendente · ${formatCount(s.waiting_client)} aguardando cliente`,
            icon: Hourglass,
        },
        {
            title: "Sem resposta",
            value: formatCount(s.unanswered),
            description: `Cliente sem retorno em ${unansweredHours}h`,
            icon: MessageSquareX,
        },
        {
            title: "Fora do horário",
            value: formatCount(s.off_hours),
            description: `${formatPercent(percent(s.off_hours, s.total))} dos atendimentos · fora de ${BUSINESS_HOURS.label}`,
            icon: MoonStar,
        },
        {
            title: "1ª resposta (mediana)",
            value: formatDuration(s.first_response_median_seconds),
            description:
                s.first_response_p90_seconds !== null
                    ? `Em horário comercial · 90% em até ${formatDuration(s.first_response_p90_seconds)}`
                    : "Em horário comercial",
            icon: Timer,
        },
        {
            title: "Duração (mediana)",
            value: formatDuration(s.duration_median_seconds),
            description:
                s.messages_per_attendance_avg !== null
                    ? `Do início à última mensagem · ${Math.round(s.messages_per_attendance_avg)} msgs em média`
                    : "Do início à última mensagem",
            icon: Clock3,
        },
        {
            title: "Tempo ativo da equipe",
            value: formatHours(s.active_seconds),
            description: `Estimado · ${formatCount(s.messages_out)} mensagens enviadas`,
            icon: Activity,
        },
    ];

    return (
        <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4">
            {kpis.map((kpi) => (
                <Card key={kpi.title}>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-1">
                        <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground">{kpi.title}</CardTitle>
                        <kpi.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </CardHeader>
                    <CardContent className="p-4 pt-0">
                        <div className="text-2xl font-bold">{kpi.value}</div>
                        <p className="text-xs text-muted-foreground mt-0.5">{kpi.description}</p>
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
