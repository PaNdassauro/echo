import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatCount, percent } from "@/lib/attendanceReport";
import { OUTCOMES, type OutcomeCounts } from "./outcomes";

interface OutcomeBarProps {
    counts: OutcomeCounts;
    /** "lg" no card de desfecho, "sm" na linha da tabela de atendentes */
    size?: "sm" | "lg";
    className?: string;
}

/**
 * Barra única de parte-do-todo. HTML em vez de gráfico: são no máximo quatro
 * segmentos e o vão de 2px entre eles é um `gap` — mais simples e mais nítido
 * que um BarChart de uma barra só.
 */
export function OutcomeBar({ counts, size = "lg", className }: OutcomeBarProps) {
    const total = OUTCOMES.reduce((sum, o) => sum + counts[o.key], 0);

    if (total === 0) {
        return <div className={cn("w-full rounded bg-muted", size === "lg" ? "h-3" : "h-2", className)} aria-hidden="true" />;
    }

    const description = OUTCOMES.filter((o) => counts[o.key] > 0)
        .map((o) => `${o.short}: ${counts[o.key]} (${percent(counts[o.key], total)}%)`)
        .join(", ");

    return (
        <div
            role="img"
            aria-label={description}
            className={cn("flex w-full gap-0.5", size === "lg" ? "h-3" : "h-2", className)}
        >
            {OUTCOMES.filter((o) => counts[o.key] > 0).map((o) => (
                <Tooltip key={o.key}>
                    <TooltipTrigger asChild>
                        <div
                            className="h-full first:rounded-l last:rounded-r min-w-[3px] transition-[flex-grow] duration-300 ease-out"
                            style={{ flexGrow: counts[o.key], flexBasis: 0, backgroundColor: o.color }}
                        />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                        <span className="font-medium">{o.label}</span>
                        <span className="ml-2 tabular-nums text-muted-foreground">
                            {formatCount(counts[o.key])} · {percent(counts[o.key], total)}%
                        </span>
                    </TooltipContent>
                </Tooltip>
            ))}
        </div>
    );
}
