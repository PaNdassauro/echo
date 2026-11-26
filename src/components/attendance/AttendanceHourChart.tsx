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
import { BUSINESS_HOURS, type AttendanceHourRow } from "@/lib/attendanceReport";

interface AttendanceHourChartProps {
    hours: AttendanceHourRow[];
}

// Ênfase: o que importa aqui é o fora do horário (cor de destaque); o resto é
// contexto e fica no cinza recessivo.
const chartConfig: ChartConfig = {
    business_hours: { label: "No horário", color: "hsl(var(--muted-foreground) / 0.35)" },
    off_hours: { label: "Fora do horário", color: "hsl(var(--primary))" },
};

export function AttendanceHourChart({ hours }: AttendanceHourChartProps) {
    const data = hours.map((h) => ({ ...h, label: `${h.hour}h` }));

    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold">Quando os atendimentos começam</CardTitle>
                <CardDescription>
                    Hora de início (Brasília) · horário comercial {BUSINESS_HOURS.label}; fim de semana conta como fora
                </CardDescription>
            </CardHeader>
            <CardContent>
                <ChartContainer config={chartConfig} className="aspect-auto h-[240px] w-full">
                    <BarChart data={data} margin={{ top: 8, right: 4, left: -16, bottom: 0 }} barCategoryGap="15%">
                        <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={2} tick={{ fontSize: 11 }} />
                        <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={44} tick={{ fontSize: 11 }} />
                        <ChartTooltip
                            cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }}
                            content={
                                <ChartTooltipContent
                                    labelFormatter={(_, payload) => {
                                        const hour = (payload?.[0]?.payload as AttendanceHourRow | undefined)?.hour;
                                        return hour === undefined ? "" : `Das ${hour}h às ${hour}h59`;
                                    }}
                                />
                            }
                        />
                        <ChartLegend content={<ChartLegendContent />} />
                        <Bar dataKey="business_hours" stackId="h" fill="var(--color-business_hours)" stroke="hsl(var(--card))" strokeWidth={1} maxBarSize={28} />
                        <Bar
                            dataKey="off_hours"
                            stackId="h"
                            fill="var(--color-off_hours)"
                            stroke="hsl(var(--card))"
                            strokeWidth={1}
                            radius={[4, 4, 0, 0]}
                            maxBarSize={28}
                        />
                    </BarChart>
                </ChartContainer>
            </CardContent>
        </Card>
    );
}
