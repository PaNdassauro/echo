import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig,
} from "@/components/ui/chart";
import { Area, AreaChart, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from "recharts";
import type { DailyVolume } from "@/hooks/useAnalytics";

interface MessageVolumeChartProps {
    data: DailyVolume[];
    isLoading: boolean;
}

const chartConfig: ChartConfig = {
    inbound: {
        label: "Recebidas",
        color: "hsl(var(--chart-1))",
    },
    outbound: {
        label: "Enviadas",
        color: "hsl(var(--chart-2))",
    },
};

export function MessageVolumeChart({ data, isLoading }: MessageVolumeChartProps) {
    const formattedData = data.map((item) => ({
        ...item,
        dateFormatted: format(new Date(item.date), "dd/MM", { locale: ptBR }),
        dateFull: format(new Date(item.date), "dd 'de' MMMM", { locale: ptBR }),
    }));

    return (
        <Card className="border-border bg-card shadow-sm">
            <CardHeader>
                <CardTitle className="text-base font-semibold">
                    Volume de Mensagens
                </CardTitle>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <div className="h-[300px] flex items-center justify-center">
                        <Skeleton className="w-full h-full" />
                    </div>
                ) : data.length === 0 ? (
                    <div className="h-[300px] flex items-center justify-center text-center text-sm text-muted-foreground text-pretty border-2 border-dashed rounded-lg px-4">
                        Nenhuma mensagem neste período. Amplie o intervalo de datas.
                    </div>
                ) : (
                    <ChartContainer config={chartConfig} className="h-[300px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart
                                data={formattedData}
                                margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                            >
                                <defs>
                                    <linearGradient id="fillInbound" x1="0" y1="0" x2="0" y2="1">
                                        <stop
                                            offset="5%"
                                            stopColor="var(--color-inbound)"
                                            stopOpacity={0.3}
                                        />
                                        <stop
                                            offset="95%"
                                            stopColor="var(--color-inbound)"
                                            stopOpacity={0}
                                        />
                                    </linearGradient>
                                    <linearGradient id="fillOutbound" x1="0" y1="0" x2="0" y2="1">
                                        <stop
                                            offset="5%"
                                            stopColor="var(--color-outbound)"
                                            stopOpacity={0.3}
                                        />
                                        <stop
                                            offset="95%"
                                            stopColor="var(--color-outbound)"
                                            stopOpacity={0}
                                        />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid
                                    strokeDasharray="3 3"
                                    vertical={false}
                                    stroke="hsl(var(--border))"
                                />
                                <XAxis
                                    dataKey="dateFormatted"
                                    tickLine={false}
                                    axisLine={false}
                                    tickMargin={8}
                                    tick={{ fontSize: 12 }}
                                    interval="preserveStartEnd"
                                />
                                <YAxis
                                    tickLine={false}
                                    axisLine={false}
                                    tickMargin={8}
                                    tick={{ fontSize: 12 }}
                                    width={40}
                                />
                                <ChartTooltip
                                    content={
                                        <ChartTooltipContent
                                            labelFormatter={(_, payload) => {
                                                if (payload && payload[0]) {
                                                    return payload[0].payload.dateFull;
                                                }
                                                return "";
                                            }}
                                        />
                                    }
                                />
                                <Area
                                    type="monotone"
                                    dataKey="inbound"
                                    stroke="var(--color-inbound)"
                                    strokeWidth={2}
                                    fill="url(#fillInbound)"
                                    name="Recebidas"
                                    isAnimationActive={false}
                                />
                                <Area
                                    type="monotone"
                                    dataKey="outbound"
                                    stroke="var(--color-outbound)"
                                    strokeWidth={2}
                                    fill="url(#fillOutbound)"
                                    name="Enviadas"
                                    isAnimationActive={false}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </ChartContainer>
                )}
            </CardContent>
        </Card>
    );
}
