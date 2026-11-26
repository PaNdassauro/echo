import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnalyticsStats } from "@/hooks/useAnalytics";
import { DollarSign, Activity, Send, CheckCircle2, Eye, MessageSquareReply, LayoutTemplate, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { computeCost, FREE_API_MESSAGES } from "@/lib/analyticsCost";

interface AnalyticsKPICardsProps {
    stats: AnalyticsStats | null;
    previous?: AnalyticsStats | null;
    isLoading: boolean;
}

function DeltaBadge({ current, previous, higherIsBetter }: { current: number; previous: number | null | undefined; higherIsBetter: boolean }) {
    // Sem base de comparação: não mostra badge.
    if (previous === null || previous === undefined || previous === 0) return null;

    const pct = ((current - previous) / previous) * 100;
    const rounded = Math.round(pct);

    // Variação irrelevante → neutro.
    if (Math.abs(rounded) < 1) {
        return (
            <span className="inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground">
                <Minus className="h-3 w-3" /> 0%
            </span>
        );
    }

    const isUp = rounded > 0;
    const isGood = higherIsBetter ? isUp : !isUp;
    const colorClass = isGood ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
    const Icon = isUp ? TrendingUp : TrendingDown;

    return (
        <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${colorClass}`}>
            <Icon className="h-3 w-3" />
            {isUp ? "+" : ""}{rounded}%
        </span>
    );
}

export function AnalyticsKPICards({ stats, previous, isLoading }: AnalyticsKPICardsProps) {

    const formatCurrency = (value: number) => {
        return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
    };

    const templateMessages = stats?.total_template_messages || 0;
    // Mensagens não-template enviadas apenas por números API oficiais (business_api)
    const apiMessages = stats?.total_api_messages || 0;

    const { apiCost, totalCost, billableApiMessages } = computeCost(templateMessages, apiMessages);

    // Equivalentes do período anterior (para comparação)
    const prevTemplateMessages = previous?.total_template_messages ?? null;
    const prevApiMessages = previous?.total_api_messages ?? null;
    const prevCost = previous
        ? computeCost(previous.total_template_messages || 0, previous.total_api_messages || 0)
        : null;
    const prevTotalCost = prevCost?.totalCost ?? null;
    const prevApiCost = prevCost?.apiCost ?? null;

    const cards = [
        // ROW 1: COSTS (custo maior = pior → higherIsBetter false)
        {
            title: "Valor usado",
            value: formatCurrency(totalCost),
            icon: DollarSign,
            description: "Custo total estimado (templates + API)",
            current: totalCost,
            previous: prevTotalCost,
            higherIsBetter: false,
        },
        {
            title: "Custo de API",
            value: formatCurrency(apiCost),
            icon: Activity,
            description: `${apiMessages.toLocaleString()} fora de template • ${billableApiMessages.toLocaleString()} cobradas a R$ 0,04 (${FREE_API_MESSAGES.toLocaleString()} grátis)`,
            current: apiCost,
            previous: prevApiCost,
            higherIsBetter: false,
        },
        {
            title: "Mensagens de template",
            value: templateMessages.toLocaleString(),
            icon: LayoutTemplate,
            description: "Entregues • R$ 0,31 cada",
            current: templateMessages,
            previous: prevTemplateMessages,
            higherIsBetter: false,
        },
        // ROW 2: PERFORMANCE (mais = melhor)
        {
            title: "Mensagens enviadas",
            value: stats?.total_sent?.toLocaleString() || "0",
            icon: Send,
            description: "Total enviado",
            current: stats?.total_sent || 0,
            previous: previous?.total_sent ?? null,
            higherIsBetter: true,
        },
        {
            title: "Mensagens entregues",
            value: stats?.total_delivered?.toLocaleString() || "0",
            icon: CheckCircle2,
            description: "Confirmadas",
            current: stats?.total_delivered || 0,
            previous: previous?.total_delivered ?? null,
            higherIsBetter: true,
        },
        {
            title: "Mensagens lidas",
            value: `${stats?.total_read?.toLocaleString() || "0"} (${stats?.total_delivered && stats.total_delivered > 0
                ? Math.round((stats.total_read / stats.total_delivered) * 100)
                : 0
                }%)`,
            icon: Eye,
            description: "Taxa de leitura",
            current: stats?.total_read || 0,
            previous: previous?.total_read ?? null,
            higherIsBetter: true,
        },
        {
            title: "Respostas únicas",
            value: stats?.unique_responses?.toLocaleString() || "0",
            icon: MessageSquareReply,
            description: "Conversas com resposta",
            current: stats?.unique_responses || 0,
            previous: previous?.unique_responses ?? null,
            higherIsBetter: true,
        },
    ];

    if (isLoading) {
        return (
            <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {[1, 2, 3].map((i) => (
                        <Card key={`skel-row1-${i}`}>
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <Skeleton className="h-4 w-24" />
                            </CardHeader>
                            <CardContent>
                                <Skeleton className="mb-2 h-8 w-16" />
                            </CardContent>
                        </Card>
                    ))}
                </div>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                    {[1, 2, 3, 4].map((i) => (
                        <Card key={`skel-row2-${i}`}>
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <Skeleton className="h-4 w-24" />
                            </CardHeader>
                            <CardContent>
                                <Skeleton className="mb-2 h-8 w-16" />
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Cost Row */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3">
                {cards.slice(0, 3).map((card, i) => (
                    <Card key={`cost-${i}`}>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
                            <card.icon className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-baseline gap-2">
                                <div className="text-2xl font-bold tabular-nums">{card.value}</div>
                                <DeltaBadge current={card.current} previous={card.previous} higherIsBetter={card.higherIsBetter} />
                            </div>
                            <p className="text-xs text-muted-foreground">{card.description}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* Performance Row */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {cards.slice(3).map((card, i) => (
                    <Card key={`perf-${i}`}>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
                            <card.icon className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-baseline gap-2">
                                <div className="text-2xl font-bold tabular-nums">{card.value}</div>
                                <DeltaBadge current={card.current} previous={card.previous} higherIsBetter={card.higherIsBetter} />
                            </div>
                            <p className="text-xs text-muted-foreground">{card.description}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}
