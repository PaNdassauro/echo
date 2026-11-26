import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig,
} from "@/components/ui/chart";
import { Bar, BarChart, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from "recharts";
import type { CloseReasonStat } from "@/hooks/useAnalytics";

interface CloseReasonsChartProps {
    data: CloseReasonStat[];
    isLoading: boolean;
}

const chartConfig: ChartConfig = {
    count: {
        label: "Conversas",
        color: "hsl(var(--chart-1))",
    },
};

export function CloseReasonsChart({ data, isLoading }: CloseReasonsChartProps) {
    const total = data.reduce((sum, d) => sum + d.count, 0);
    // Top 8 motivos para não estourar a altura.
    const formattedData = data.slice(0, 8).map((d) => ({
        ...d,
        pct: total > 0 ? Math.round((d.count / total) * 100) : 0,
    }));

    const height = Math.max(formattedData.length * 44, 160);

    return (
        <Card className="border-border bg-card shadow-sm">
            <CardHeader>
                <CardTitle className="text-base font-semibold">Motivos de fechamento</CardTitle>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <div className="h-[240px] flex items-center justify-center">
                        <Skeleton className="w-full h-full" />
                    </div>
                ) : formattedData.length === 0 ? (
                    <div className="h-[200px] flex items-center justify-center text-muted-foreground border-2 border-dashed rounded-lg">
                        Nenhuma conversa fechada no período
                    </div>
                ) : (
                    <ChartContainer config={chartConfig} className="w-full" style={{ height }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart
                                data={formattedData}
                                layout="vertical"
                                margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
                            >
                                <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                                <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
                                <YAxis
                                    type="category"
                                    dataKey="reason"
                                    tickLine={false}
                                    axisLine={false}
                                    width={140}
                                    tick={{ fontSize: 12 }}
                                />
                                <ChartTooltip
                                    content={
                                        <ChartTooltipContent
                                            formatter={(value, _name, item) => {
                                                const pct = item?.payload?.pct ?? 0;
                                                return `${Number(value).toLocaleString()} conversas (${pct}%)`;
                                            }}
                                        />
                                    }
                                />
                                <Bar dataKey="count" fill="var(--color-count)" radius={[0, 4, 4, 0]} isAnimationActive={false} />
                            </BarChart>
                        </ResponsiveContainer>
                    </ChartContainer>
                )}
            </CardContent>
        </Card>
    );
}
