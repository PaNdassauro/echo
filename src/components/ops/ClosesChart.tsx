import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import type { DailyRow } from "@/hooks/useConnectionHealth";

const BASE_CONFIG: ChartConfig = {
    forbidden: { label: "403 (ban)", color: "hsl(var(--destructive))" },
    conflicts: { label: "Conflict 401/440", color: "hsl(var(--chart-3))" },
};

const FLAPS_CONFIG: ChartConfig = {
    flaps: { label: "Flap pairing_pending", color: "hsl(var(--muted-foreground) / 0.35)" },
};

interface ClosesChartProps {
    daily: DailyRow[];
    isLoading: boolean;
    selectedId: string | null;
    selectedName: string | null;
}

export function ClosesChart({ daily, isLoading, selectedId, selectedName }: ClosesChartProps) {
    // Flap dá dezenas por dia em toda linha e governa o eixo Y: empilhado, ele
    // reduz conflict e 403 — o que importa — a um fio de 1px. Fica fora por padrão.
    const [showFlaps, setShowFlaps] = useState(false);

    const { data, flapsTotal, relevantTotal } = useMemo(() => {
        const byDay = new Map<string, { day: string; forbidden: number; conflicts: number; flaps: number }>();
        for (const row of daily) {
            if (selectedId && row.phone_number_id !== selectedId) continue;
            const acc = byDay.get(row.day) ?? { day: row.day, forbidden: 0, conflicts: 0, flaps: 0 };
            acc.forbidden += row.forbidden;
            acc.conflicts += row.conflicts;
            acc.flaps += row.flaps;
            byDay.set(row.day, acc);
        }
        const rows = [...byDay.values()]
            .sort((a, b) => a.day.localeCompare(b.day))
            .map((d) => ({
                ...d,
                dayShort: format(parseISO(d.day), "dd/MM", { locale: ptBR }),
                dayFull: format(parseISO(d.day), "EEEE, dd 'de' MMMM", { locale: ptBR }),
            }));
        return {
            data: rows,
            flapsTotal: rows.reduce((n, d) => n + d.flaps, 0),
            relevantTotal: rows.reduce((n, d) => n + d.conflicts + d.forbidden, 0),
        };
    }, [daily, selectedId]);

    const chartConfig = showFlaps ? { ...BASE_CONFIG, ...FLAPS_CONFIG } : BASE_CONFIG;
    const empty = data.length === 0 || (!showFlaps && relevantTotal === 0);

    return (
        <Card className="border-border bg-card shadow-sm">
            <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <CardTitle className="text-base font-semibold">
                        Quedas por dia{selectedName ? ` · ${selectedName}` : " · todas as linhas"}
                    </CardTitle>
                    {flapsTotal > 0 && (
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowFlaps((v) => !v)}>
                            {showFlaps ? "Ocultar flaps" : `Mostrar flaps (${flapsTotal})`}
                        </Button>
                    )}
                </div>
                <p className="text-xs text-muted-foreground">
                    Flaps de pairing_pending acontecem em todas as linhas e reconectam em segundos: ruído do serviço, escondido por padrão para não achatar o eixo.
                </p>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <Skeleton className="h-[260px] w-full" />
                ) : empty ? (
                    <div className="flex h-[260px] flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 text-center text-muted-foreground">
                        <span>Sem quedas relevantes na janela</span>
                        {flapsTotal > 0 && !showFlaps && (
                            <span className="text-xs">só {flapsTotal} {flapsTotal === 1 ? "flap" : "flaps"} de pairing_pending</span>
                        )}
                    </div>
                ) : (
                    <ChartContainer config={chartConfig} className="h-[260px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                                <XAxis dataKey="dayShort" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 12 }} interval="preserveStartEnd" />
                                <YAxis tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 12 }} width={32} allowDecimals={false} />
                                <ChartTooltip
                                    content={
                                        <ChartTooltipContent
                                            labelFormatter={(_, payload) => (payload && payload[0] ? String(payload[0].payload.dayFull) : "")}
                                        />
                                    }
                                />
                                <ChartLegend content={<ChartLegendContent />} />
                                {showFlaps && <Bar dataKey="flaps" stackId="a" fill="var(--color-flaps)" isAnimationActive={false} />}
                                <Bar dataKey="conflicts" stackId="a" fill="var(--color-conflicts)" isAnimationActive={false} />
                                <Bar dataKey="forbidden" stackId="a" fill="var(--color-forbidden)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                            </BarChart>
                        </ResponsiveContainer>
                    </ChartContainer>
                )}
            </CardContent>
        </Card>
    );
}
