import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
    ChartContainer,
    ChartLegend,
    ChartLegendContent,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig,
} from "@/components/ui/chart";
import type { Bucket, SeriesPoint } from "@/lib/attendanceReport";
import { OUTCOMES } from "./outcomes";

interface AttendanceTrendChartProps {
    series: SeriesPoint[];
    bucket: Bucket;
}

// Sem `icon`: com ele o ChartLegend troca o quadrado de cor pelo ícone e a
// legenda perde a cor — a única ligação com as barras.
const chartConfig: ChartConfig = Object.fromEntries(OUTCOMES.map((o) => [o.key, { label: o.short, color: o.color }]));

const BUCKET_TITLE: Record<Bucket, string> = {
    day: "Atendimentos por dia",
    week: "Atendimentos por semana",
    month: "Atendimentos por mês",
};

/** Colunas empilhadas por desfecho, pela data em que o atendimento começou. */
export function AttendanceTrendChart({ series, bucket }: AttendanceTrendChartProps) {
    const last = OUTCOMES[OUTCOMES.length - 1].key;

    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold">{BUCKET_TITLE[bucket]}</CardTitle>
                <CardDescription>Pela data de início, separados por como terminaram</CardDescription>
            </CardHeader>
            <CardContent>
                <ChartContainer config={chartConfig} className="aspect-auto h-[280px] w-full">
                    <BarChart data={series} margin={{ top: 8, right: 4, left: -16, bottom: 0 }} barCategoryGap="20%">
                        <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                        <XAxis
                            dataKey="label"
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            minTickGap={16}
                            tick={{ fontSize: 11 }}
                        />
                        <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={44} tick={{ fontSize: 11 }} />
                        <ChartTooltip
                            cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }}
                            content={
                                <ChartTooltipContent
                                    labelFormatter={(_, payload) => {
                                        const point = payload?.[0]?.payload as SeriesPoint | undefined;
                                        return point ? `${point.tooltipLabel} · ${point.total} atendimentos` : "";
                                    }}
                                />
                            }
                        />
                        <ChartLegend content={<ChartLegendContent />} />
                        {OUTCOMES.map((o) => (
                            <Bar
                                key={o.key}
                                dataKey={o.key}
                                stackId="outcome"
                                fill={`var(--color-${o.key})`}
                                // vão de 2px na cor do card entre segmentos empilhados
                                stroke="hsl(var(--card))"
                                strokeWidth={1}
                                radius={o.key === last ? [4, 4, 0, 0] : 0}
                                maxBarSize={36}
                            />
                        ))}
                    </BarChart>
                </ChartContainer>
            </CardContent>
        </Card>
    );
}
