import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Timer, Gauge, CheckCheck, ListChecks, Inbox, MessageSquareX } from "lucide-react";
import { type ServiceMetrics, SLA_SECONDS } from "@/hooks/useAnalytics";
import { Skeleton } from "@/components/ui/skeleton";

interface ServiceMetricsCardsProps {
    metrics: ServiceMetrics | null;
    isLoading: boolean;
}

/** Formata segundos de forma legível: "—", "45s", "12m", "1h 20m". */
function formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return "—";
    const total = Math.round(seconds);
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) {
        const s = total % 60;
        return s > 0 ? `${minutes}m ${s}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${hours}h ${m}m` : `${hours}h`;
}

function slaLabel(): string {
    const m = Math.round(SLA_SECONDS / 60);
    return m >= 1 ? `≤ ${m} min` : `≤ ${SLA_SECONDS}s`;
}

export function ServiceMetricsCards({ metrics, isLoading }: ServiceMetricsCardsProps) {
    const cards = [
        {
            title: "1ª resposta (mediana)",
            value: formatDuration(metrics?.first_response_p50_seconds || 0),
            icon: Timer,
            description: `90% respondidas em até ${formatDuration(metrics?.first_response_p90_seconds || 0)}`,
        },
        {
            title: "Dentro do SLA",
            value: `${Math.round(metrics?.pct_within_sla || 0)}%`,
            icon: Gauge,
            description: `1ª resposta ${slaLabel()}`,
        },
        {
            title: "Tempo de resolução",
            value: formatDuration(metrics?.avg_resolution_seconds || 0),
            icon: CheckCheck,
            description: "Média (abertura → fechamento)",
        },
        {
            title: "Taxa de resolução",
            value: `${Math.round(metrics?.resolution_rate || 0)}%`,
            icon: ListChecks,
            description: `${(metrics?.conversations_closed || 0).toLocaleString()} fechadas • ${(metrics?.conversations_opened || 0).toLocaleString()} abertas`,
        },
        {
            title: "Conversas em aberto",
            value: (metrics?.open_backlog || 0).toLocaleString(),
            icon: Inbox,
            description: "Ainda sem encerramento (agora)",
        },
        {
            title: "Não respondidas",
            value: (metrics?.unanswered_count || 0).toLocaleString(),
            icon: MessageSquareX,
            description: "Receberam mensagem, sem resposta",
        },
    ];

    if (isLoading) {
        return (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {[1, 2, 3, 4, 5, 6].map((i) => (
                    <Card key={`skel-svc-${i}`}>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <Skeleton className="h-4 w-24" />
                        </CardHeader>
                        <CardContent>
                            <Skeleton className="mb-2 h-8 w-16" />
                        </CardContent>
                    </Card>
                ))}
            </div>
        );
    }

    return (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {cards.map((card, i) => (
                <Card key={`svc-${i}`}>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
                        <card.icon className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold tabular-nums">{card.value}</div>
                        <p className="text-xs text-muted-foreground">{card.description}</p>
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
