import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { RefreshCw, Eye, ClipboardList } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface SurveyAnswer {
    questionId: string;
    question: string;
    answer: string;
    selectionId: string | null;
    answeredAt: string;
}

interface SurveyResult {
    executionId: string;
    contactPhone: string | null;
    completedAt: string | null;
    label: string;
    questions: Array<{ id: string; message: string; type: string }>;
    answers: SurveyAnswer[];
}

interface SurveyResultsPanelProps {
    flowId: string;
}

export function SurveyResultsPanel({ flowId }: SurveyResultsPanelProps) {
    const { currentOrganization } = useOrganization();
    const [results, setResults] = useState<SurveyResult[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedResult, setSelectedResult] = useState<SurveyResult | null>(null);

    const fetchResults = useCallback(async () => {
        if (!currentOrganization?.id) return;

        setLoading(true);
        const { data, error } = await supabase
            .from('automation_executions')
            .select('id, contact_phone, completed_at, execution_log')
            .eq('organization_id', currentOrganization.id)
            .eq('flow_id', flowId)
            .eq('status', 'completed')
            .order('completed_at', { ascending: false })
            .limit(200);

        if (error) {
            console.error('Failed to fetch survey results:', error);
            setLoading(false);
            return;
        }

        const surveyResults: SurveyResult[] = [];
        for (const execution of data || []) {
            const logs = (execution.execution_log as Array<Record<string, unknown>>) || [];
            for (const entry of logs) {
                const surveyCompleted = entry.survey_completed as {
                    label?: string;
                    questions?: Array<{ id: string; message: string; type: string }>;
                    answers?: SurveyAnswer[];
                } | undefined;

                if (surveyCompleted?.answers) {
                    surveyResults.push({
                        executionId: execution.id,
                        contactPhone: execution.contact_phone,
                        completedAt: execution.completed_at,
                        label: surveyCompleted.label || 'Pesquisa',
                        questions: surveyCompleted.questions || [],
                        answers: surveyCompleted.answers,
                    });
                }
            }
        }

        setResults(surveyResults);
        setLoading(false);
    }, [currentOrganization?.id, flowId]);

    useEffect(() => {
        fetchResults();
    }, [fetchResults]);

    return (
        <Card>
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-lg flex items-center gap-2">
                        <ClipboardList className="h-5 w-5" />
                        Resultados da Pesquisa
                    </CardTitle>
                    <Button variant="outline" size="sm" onClick={fetchResults} disabled={loading}>
                        <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                        Atualizar
                    </Button>
                </div>
            </CardHeader>
            <CardContent>
                {loading ? (
                    <div className="space-y-2">
                        {Array.from({ length: 5 }).map((_, i) => (
                            <Skeleton key={i} className="h-10 w-full" />
                        ))}
                    </div>
                ) : results.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                        <ClipboardList className="h-10 w-10 mx-auto mb-3 opacity-50" />
                        <p>Nenhuma resposta recebida ainda.</p>
                        <p className="text-sm mt-1">As respostas aparecerão aqui quando clientes completarem a pesquisa.</p>
                    </div>
                ) : (
                    <ScrollArea className="h-[500px]">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Contato</TableHead>
                                    <TableHead>Data</TableHead>
                                    <TableHead>Respostas</TableHead>
                                    <TableHead className="w-[50px]"></TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {results.map((result) => (
                                    <TableRow key={result.executionId}>
                                        <TableCell className="font-mono text-sm">
                                            {result.contactPhone || '—'}
                                        </TableCell>
                                        <TableCell className="text-sm">
                                            {result.completedAt ? (
                                                <span title={format(new Date(result.completedAt), "dd/MM/yyyy HH:mm:ss", { locale: ptBR })}>
                                                    {formatDistanceToNow(new Date(result.completedAt), { addSuffix: true, locale: ptBR })}
                                                </span>
                                            ) : '—'}
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="secondary">
                                                {result.answers.length} {result.answers.length === 1 ? 'resposta' : 'respostas'}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => setSelectedResult(result)}
                                                title="Ver respostas"
                                            >
                                                <Eye className="h-4 w-4" />
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </ScrollArea>
                )}
            </CardContent>

            <Dialog open={!!selectedResult} onOpenChange={() => setSelectedResult(null)}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <ClipboardList className="h-5 w-5" />
                            {selectedResult?.label || 'Pesquisa'}
                        </DialogTitle>
                    </DialogHeader>

                    {selectedResult && (
                        <div className="space-y-4">
                            <div className="flex items-center gap-4 text-sm text-muted-foreground">
                                <span>Contato: <strong className="text-foreground">{selectedResult.contactPhone || '—'}</strong></span>
                                {selectedResult.completedAt && (
                                    <span>{format(new Date(selectedResult.completedAt), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}</span>
                                )}
                            </div>

                            <ScrollArea className="max-h-[400px]">
                                <div className="space-y-3">
                                    {selectedResult.answers.map((answer, index) => (
                                        <div key={answer.questionId} className="p-3 border rounded-lg space-y-1">
                                            <p className="text-sm font-medium text-muted-foreground">
                                                {index + 1}. {answer.question}
                                            </p>
                                            <p className="text-sm">
                                                {answer.answer}
                                                {answer.selectionId && (
                                                    <span className="text-xs text-muted-foreground ml-2">
                                                        (ID: {answer.selectionId})
                                                    </span>
                                                )}
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            </ScrollArea>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </Card>
    );
}
