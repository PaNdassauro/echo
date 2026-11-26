import { useState } from "react";
import { TEMPLATE_COST } from "@/lib/analyticsCost";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LayoutTemplate } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { TemplateStats } from "@/hooks/useAnalytics";
import { Skeleton } from "@/components/ui/skeleton";

interface TemplatesTableProps {
    data: TemplateStats[];
    isLoading: boolean;
}

export function TemplatesTable({ data, isLoading }: TemplatesTableProps) {
    const [hideZeroSent, setHideZeroSent] = useState(true);

    if (isLoading) {
        return (
            <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 rounded-lg" />
                ))}
            </div>
        );
    }

    const filteredData = hideZeroSent
        ? data.filter(item => item.sent > 0)
        : data;

    if (!data || data.length === 0) {
        return (
            <Card>
                <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <LayoutTemplate className="h-10 w-10 mb-4 opacity-20" />
                    <p>Nenhum dado de template encontrado no período.</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-lg font-medium flex items-center gap-2">
                    <LayoutTemplate className="h-5 w-5" />
                    Desempenho de Templates
                </CardTitle>
                <div className="flex items-center gap-2">
                    <Checkbox
                        id="hide-zero"
                        checked={hideZeroSent}
                        onCheckedChange={(checked) => setHideZeroSent(checked === true)}
                    />
                    <Label htmlFor="hide-zero" className="text-sm font-normal text-muted-foreground cursor-pointer">
                        Mostrar só templates já enviados
                    </Label>
                </div>
            </CardHeader>
            <CardContent>
                <div className="overflow-x-auto">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Nome do template</TableHead>
                            <TableHead className="text-right">Enviadas</TableHead>
                            <TableHead className="text-right">Entregues</TableHead>
                            <TableHead className="text-right">Lidas (%)</TableHead>
                            <TableHead className="text-right">Clicadas (%)</TableHead>
                            <TableHead className="text-right">Custo estimado (R$)</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {filteredData.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                                    Nenhum template com envios no período. Desmarque o filtro acima para ver todos.
                                </TableCell>
                            </TableRow>
                        ) : (
                            filteredData.map((item, index) => {
                                const readRate = item.delivered > 0
                                    ? Math.round((item.read / item.delivered) * 100)
                                    : 0;

                                // Click Rate based on delivered messages usually, or sent?
                                // Let's use Delivered as denominator for consistency with Read Rate
                                const clickRate = item.delivered > 0
                                    ? Math.round((item.clicked / item.delivered) * 100)
                                    : 0;

                                // Custo estimado por template entregue (a franquia grátis vale só para API)
                                const estimatedCost = item.delivered * TEMPLATE_COST;

                                return (
                                    <TableRow key={`${item.template_name}-${index}`}>
                                        <TableCell className="font-medium">{item.template_name}</TableCell>
                                        <TableCell className="text-right tabular-nums">{item.sent}</TableCell>
                                        <TableCell className="text-right tabular-nums">{item.delivered}</TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {item.read} <span className="text-muted-foreground text-xs">({readRate}%)</span>
                                        </TableCell>
                                        <TableCell className="text-right font-medium text-primary tabular-nums">
                                            {item.clicked} <span className="text-primary/70 text-xs">({clickRate}%)</span>
                                        </TableCell>
                                        <TableCell className="text-right text-muted-foreground tabular-nums">
                                            {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(estimatedCost)}
                                        </TableCell>
                                    </TableRow>
                                );
                            })
                        )}
                    </TableBody>
                </Table>
                </div>
            </CardContent>
        </Card>
    );
}
