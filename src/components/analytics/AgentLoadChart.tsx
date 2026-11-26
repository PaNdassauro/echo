import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig,
} from "@/components/ui/chart";
import { Bar, BarChart, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from "recharts";
import type { AgentStats } from "@/hooks/useAnalytics";

interface AgentLoadChartProps {
    data: AgentStats[];
    isLoading: boolean;
}

const chartConfig: ChartConfig = {
    current_open_conversations: {
        label: "Conversas abertas",
        color: "hsl(var(--chart-3))",
    },
};

export function AgentLoadChart({ data, isLoading }: AgentLoadChartProps) {
    // Só agentes com carga > 0, do mais carregado ao menos.
    const formattedData = data
        .filter((a) => a.current_open_conversations > 0)
        .sort((a, b) => b.current_open_conversations - a.current_open_conversations)
        .slice(0, 10)
        .map((a) => ({
            name: (a.agent_name || "Sem nome").split(" ")[0],
            current_open_conversations: a.current_open_conversations,
        }));

    const height = Math.max(formattedData.length * 40, 160);

    return (
        <Card className="border-border bg-card shadow-sm">
            <CardHeader>
                <CardTitle className="text-base font-semibold">Balanceamento de carga</CardTitle>
                <p className="text-xs text-muted-foreground">Conversas abertas por atendente (agora)</p>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <div className="h-[220px] flex items-center justify-center">
                        <Skeleton className="w-full h-full" />
                    </div>
                ) : formattedData.length === 0 ? (
                    <div className="h-[200px] flex items-center justify-center text-muted-foreground border-2 border-dashed rounded-lg">
                        Nenhuma conversa aberta atribuída
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
                                <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 12 }} allowDecimals={false} />
                                <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={90} tick={{ fontSize: 12 }} />
                                <ChartTooltip content={<ChartTooltipContent />} />
                                <Bar dataKey="current_open_conversations" fill="var(--color-current_open_conversations)" radius={[0, 4, 4, 0]} name="Conversas abertas" isAnimationActive={false} />
                            </BarChart>
                        </ResponsiveContainer>
                    </ChartContainer>
                )}
            </CardContent>
        </Card>
    );
}
