import { cn } from "@/lib/utils";
import type { LineRisk, RiskLevel } from "@/lib/connectionRisk";

const STYLES: Record<RiskLevel, string> = {
    banned: "bg-destructive text-destructive-foreground",
    down: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
    penalized: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
    ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
};

const DOT: Record<RiskLevel, string> = {
    banned: "bg-destructive-foreground",
    down: "bg-red-600 dark:bg-red-400",
    penalized: "bg-orange-600 dark:bg-orange-400",
    warn: "bg-amber-600 dark:bg-amber-400",
    ok: "bg-emerald-600 dark:bg-emerald-400",
};

export function RiskBadge({ risk, className }: { risk: LineRisk; className?: string }) {
    return (
        <span
            title={risk.reason}
            className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap",
                STYLES[risk.level],
                className,
            )}
        >
            <span className={cn("h-1.5 w-1.5 rounded-full", DOT[risk.level])} aria-hidden />
            {risk.label}
        </span>
    );
}
