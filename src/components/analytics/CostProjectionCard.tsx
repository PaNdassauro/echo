import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp } from "lucide-react";
import type { AnalyticsStats } from "@/hooks/useAnalytics";
import { computeCost } from "@/lib/analyticsCost";

interface CostProjectionCardProps {
    stats: AnalyticsStats | null;
    startDate: string; // ISO
    endDate: string; // ISO
    isLoading: boolean;
}

const formatCurrency = (value: number) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);

/**
 * Projeta o custo do mês por run-rate (custo até aqui / dias decorridos × dias do mês).
 * Só aparece quando o período selecionado corresponde ao mês corrente — caso contrário
 * a projeção não faz sentido e o card é ocultado.
 */
export function CostProjectionCard({ stats, startDate, endDate, isLoading }: CostProjectionCardProps) {
    const now = new Date();
    const start = new Date(startDate);
    const end = new Date(endDate);

    const isCurrentMonthRange =
        start.getDate() === 1 &&
        start.getMonth() === now.getMonth() &&
        start.getFullYear() === now.getFullYear() &&
        end.getMonth() === now.getMonth() &&
        end.getFullYear() === now.getFullYear();

    if (isLoading || !stats || !isCurrentMonthRange) return null;

    const templateMessages = stats.total_template_messages || 0;
    const apiMessages = stats.total_api_messages || 0;
    const currentCost = computeCost(templateMessages, apiMessages).totalCost;

    const daysElapsed = Math.max(now.getDate(), 1);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    // Projeta o VOLUME e só então aplica a franquia: projetar o custo já descontado
    // subestimaria o mês enquanto a franquia ainda não acabou.
    const scale = daysInMonth / daysElapsed;
    const projected = computeCost(templateMessages * scale, apiMessages * scale).totalCost;

    return (
        <Card className="border-border bg-card shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Projeção de custo do mês</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold tabular-nums">{formatCurrency(projected)}</div>
                <p className="text-xs text-muted-foreground">
                    {formatCurrency(currentCost)} em {daysElapsed} {daysElapsed === 1 ? "dia" : "dias"} • estimado para {daysInMonth} dias
                </p>
            </CardContent>
        </Card>
    );
}
