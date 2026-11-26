import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MousePointerClick } from "lucide-react";
import { ButtonStats } from "@/hooks/useAnalytics";
import { Skeleton } from "@/components/ui/skeleton";

interface ButtonClicksTableProps {
    data: ButtonStats[];
    isLoading: boolean;
}

export function ButtonClicksTable({ data, isLoading }: ButtonClicksTableProps) {
    if (isLoading) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg font-medium flex items-center gap-2">
                        <MousePointerClick className="h-5 w-5" />
                        Cliques no botão
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="space-y-2">
                        {[1, 2, 3].map((i) => (
                            <Skeleton key={i} className="h-10 rounded" />
                        ))}
                    </div>
                </CardContent>
            </Card>
        );
    }

    if (!data || data.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg font-medium flex items-center gap-2">
                        <MousePointerClick className="h-5 w-5" />
                        Cliques no botão
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="text-center py-8 text-muted-foreground text-sm">
                        Nenhum clique registrado no período selecionado.
                    </div>
                </CardContent>
            </Card>
        );
    }

    // Calculate percentages
    const totalClicks = data.reduce((acc, item) => acc + item.count, 0);

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-lg font-medium flex items-center gap-2">
                    <MousePointerClick className="h-5 w-5" />
                    Cliques no botão
                </CardTitle>
                <div className="text-sm text-muted-foreground">
                    Total: <span className="font-medium text-foreground">{totalClicks}</span>
                </div>
            </CardHeader>
            <CardContent>
                <div className="overflow-x-auto">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Rótulo</TableHead>
                            <TableHead>Tipo</TableHead>
                            <TableHead className="text-right">Total de cliques</TableHead>
                            <TableHead className="text-right">Taxa (do total)</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {data.map((item, index) => {
                            const percentage = totalClicks > 0
                                ? Math.round((item.count / totalClicks) * 100)
                                : 0;

                            return (
                                <TableRow key={`${item.label}-${index}`}>
                                    <TableCell className="font-medium">{item.label}</TableCell>
                                    <TableCell>
                                        <span className={`px-2 py-0.5 rounded text-xs border ${item.type === 'Botão'
                                                ? 'bg-primary/10 border-primary/20 text-primary'
                                                : 'bg-muted border-border text-muted-foreground'
                                            }`}>
                                            {item.type}
                                        </span>
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">{item.count}</TableCell>
                                    <TableCell className="text-right text-muted-foreground tabular-nums">
                                        {percentage}%
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
                </div>
            </CardContent>
        </Card>
    );
}
