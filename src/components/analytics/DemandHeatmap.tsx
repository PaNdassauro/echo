import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { HeatmapCell } from "@/hooks/useAnalytics";

interface DemandHeatmapProps {
    data: HeatmapCell[];
    isLoading: boolean;
}

// Postgres EXTRACT(DOW): 0=Domingo .. 6=Sábado. Exibimos com segunda primeiro.
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DOW_LABELS: Record<number, string> = {
    0: "Dom",
    1: "Seg",
    2: "Ter",
    3: "Qua",
    4: "Qui",
    5: "Sex",
    6: "Sáb",
};
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function DemandHeatmap({ data, isLoading }: DemandHeatmapProps) {
    // lookup[dow][hour] = count
    const lookup = new Map<string, number>();
    let max = 0;
    for (const cell of data) {
        lookup.set(`${cell.dow}-${cell.hour}`, cell.count);
        if (cell.count > max) max = cell.count;
    }

    const cellStyle = (count: number) => {
        if (count <= 0) return { backgroundColor: "hsl(var(--muted))" };
        const alpha = 0.15 + 0.85 * (count / max);
        return { backgroundColor: `hsl(var(--primary) / ${alpha.toFixed(3)})` };
    };

    return (
        <Card className="border-border bg-card shadow-sm">
            <CardHeader>
                <CardTitle className="text-base font-semibold">
                    Demanda por hora e dia da semana
                </CardTitle>
                <p className="text-xs text-muted-foreground">Mensagens recebidas • horário de Brasília</p>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <div className="h-[220px] flex items-center justify-center">
                        <Skeleton className="w-full h-full" />
                    </div>
                ) : max === 0 ? (
                    <div className="h-[200px] flex items-center justify-center text-muted-foreground border-2 border-dashed rounded-lg">
                        Sem mensagens recebidas no período
                    </div>
                ) : (
                    <TooltipProvider delayDuration={0}>
                    <div className="overflow-x-auto">
                        <div className="min-w-[640px]">
                            {/* Header: horas */}
                            <div className="flex items-center gap-1 mb-1 pl-9">
                                {HOURS.map((h) => (
                                    <div key={`h-${h}`} className="flex-1 text-center text-xs tabular-nums text-muted-foreground">
                                        {h % 3 === 0 ? h : ""}
                                    </div>
                                ))}
                            </div>
                            {/* Linhas: dias */}
                            {DOW_ORDER.map((dow) => (
                                <div key={`d-${dow}`} className="flex items-center gap-1 mb-1">
                                    <div className="w-8 text-xs text-muted-foreground text-right pr-1">
                                        {DOW_LABELS[dow]}
                                    </div>
                                    {HOURS.map((h) => {
                                        const count = lookup.get(`${dow}-${h}`) || 0;
                                        return (
                                            <Tooltip key={`c-${dow}-${h}`}>
                                                <TooltipTrigger asChild>
                                                    <div
                                                        className="flex-1 aspect-square rounded-sm transition-[box-shadow] duration-150 ease-out hover:ring-2 hover:ring-ring hover:ring-offset-1 hover:ring-offset-background"
                                                        style={cellStyle(count)}
                                                    />
                                                </TooltipTrigger>
                                                <TooltipContent>
                                                    <div className="text-center">
                                                        <div className="font-medium">
                                                            {DOW_LABELS[dow]} {String(h).padStart(2, "0")}h
                                                        </div>
                                                        <div className="text-muted-foreground">
                                                            {count.toLocaleString("pt-BR")} {count === 1 ? "mensagem" : "mensagens"}
                                                        </div>
                                                    </div>
                                                </TooltipContent>
                                            </Tooltip>
                                        );
                                    })}
                                </div>
                            ))}
                            {/* Legenda */}
                            <div className="flex items-center justify-end gap-2 mt-3">
                                <span className="text-xs text-muted-foreground">menos</span>
                                <div className="flex gap-0.5">
                                    {[0.2, 0.4, 0.6, 0.8, 1].map((a) => (
                                        <div
                                            key={`leg-${a}`}
                                            className="h-3 w-3 rounded-sm"
                                            style={{ backgroundColor: `hsl(var(--primary) / ${a})` }}
                                        />
                                    ))}
                                </div>
                                <span className="text-xs text-muted-foreground">mais</span>
                            </div>
                        </div>
                    </div>
                    </TooltipProvider>
                )}
            </CardContent>
        </Card>
    );
}
