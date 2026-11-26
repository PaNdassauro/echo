import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    ChartLegend,
    ChartLegendContent,
    type ChartConfig,
} from "@/components/ui/chart";
import { Bar, BarChart, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from "recharts";
import type { ChannelVolume } from "@/hooks/useAnalytics";

interface ChannelVolumeChartProps {
    data: ChannelVolume[];
    isLoading: boolean;
}

const CHANNEL_LABELS: Record<string, string> = {
    business_api: "API Oficial",
    qr: "QR (não oficial)",
};

const chartConfig: ChartConfig = {
    inbound: { label: "Recebidas", color: "hsl(var(--chart-1))" },
    outbound: { label: "Enviadas", color: "hsl(var(--chart-2))" },
};

export function ChannelVolumeChart({ data, isLoading }: ChannelVolumeChartProps) {
    const formattedData = data.map((d) => ({
        ...d,
        label: CHANNEL_LABELS[d.connection_type] || d.connection_type,
    }));

    return (
        <Card className="border-border bg-card shadow-sm">
            <CardHeader>
                <CardTitle className="text-base font-semibold">Volume por número</CardTitle>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <div className="h-[280px] flex items-center justify-center">
                        <Skeleton className="w-full h-full" />
                    </div>
                ) : formattedData.length === 0 ? (
                    <div className="h-[200px] flex items-center justify-center text-center text-sm text-muted-foreground text-pretty border-2 border-dashed rounded-lg px-4">
                        Nenhuma mensagem neste período. Amplie o intervalo de datas.
                    </div>
                ) : (
                    <ChartContainer config={chartConfig} className="h-[280px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={formattedData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 12 }} />
                                <YAxis tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 12 }} width={40} />
                                <ChartTooltip content={<ChartTooltipContent />} />
                                <ChartLegend content={<ChartLegendContent />} />
                                <Bar dataKey="inbound" fill="var(--color-inbound)" radius={[4, 4, 0, 0]} name="Recebidas" isAnimationActive={false} />
                                <Bar dataKey="outbound" fill="var(--color-outbound)" radius={[4, 4, 0, 0]} name="Enviadas" isAnimationActive={false} />
                            </BarChart>
                        </ResponsiveContainer>
                    </ChartContainer>
                )}
            </CardContent>
        </Card>
    );
}
