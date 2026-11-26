import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface KpiItem {
    label: string;
    value: number | string;
    hint: string;
    tone?: "default" | "bad" | "good";
}

export function OpsKpis({ items, isLoading }: { items: KpiItem[]; isLoading: boolean }) {
    return (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            {items.map((item) => (
                <Card key={item.label} className="border-border bg-card shadow-sm">
                    <CardContent className="p-4">
                        <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
                        {isLoading ? (
                            <Skeleton className="mt-2 h-8 w-16" />
                        ) : (
                            <p
                                className={cn(
                                    "mt-1 text-2xl font-semibold tabular-nums tracking-tight",
                                    item.tone === "bad" && "text-red-600 dark:text-red-400",
                                    item.tone === "good" && "text-emerald-600 dark:text-emerald-400",
                                )}
                            >
                                {item.value}
                            </p>
                        )}
                        <p className="mt-1 text-xs text-muted-foreground">{item.hint}</p>
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
