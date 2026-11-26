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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { RefreshCw, Eye, Clock, CheckCircle, XCircle, AlertCircle, Ban } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface ExecutionLogEntry {
    step: number;
    timestamp: string;
    type: 'info' | 'success' | 'error' | 'node' | 'trigger';
    message: string;
    node_id?: string;
    node_type?: string;
    details?: Record<string, unknown>;
}

interface AutomationExecution {
    id: string;
    flow_id: string | null;
    session_id: string | null;
    conversation_id: string | null;
    organization_id: string;
    status: 'running' | 'completed' | 'failed' | 'stopped' | 'no_match' | 'cancelled';
    trigger_message: {
        content: string;
        type: string;
        selectionId?: string | null;
    } | null;
    trigger_type: string | null;
    matched_by: string | null;
    // Opcional: a LISTA não traz esta coluna (é o passo-a-passo inteiro da
    // execução em jsonb, × 100 linhas). Ela é carregada sob demanda quando o
    // drawer de uma execução é aberto — ver openExecution().
    execution_log?: ExecutionLogEntry[];
    stop_reason: string | null;
    error: string | null;
    started_at: string;
    completed_at: string | null;
    phone_number_id: string | null;
    contact_phone: string | null;
}

interface ExecutionsPanelProps {
    flowId: string;
}

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: typeof CheckCircle }> = {
    running: { label: 'Em execução', variant: 'default', icon: Clock },
    completed: { label: 'Concluída', variant: 'secondary', icon: CheckCircle },
    failed: { label: 'Falhou', variant: 'destructive', icon: XCircle },
    stopped: { label: 'Parada', variant: 'outline', icon: Ban },
    no_match: { label: 'Sem correspondência', variant: 'outline', icon: AlertCircle },
    cancelled: { label: 'Cancelado', variant: 'outline', icon: Ban },
};

// Rótulos dos enums do motor (automation-execute) — os mesmos nomes que o
// NodePropertiesPanel mostra; sem isso a tela imprimia `keyword`, `messageNode`.
const NODE_TYPE_LABELS: Record<string, string> = {
    triggerNode: "Gatilho",
    messageNode: "Mensagem",
    mediaNode: "Arquivo",
    listNode: "Lista",
    buttonNode: "Botões",
    conditionNode: "Condição",
    delayNode: "Aguardar",
    businessHoursNode: "Horário",
    webhookNode: "Webhook",
    surveyNode: "Pesquisa",
};

const TRIGGER_TYPE_LABELS: Record<string, string> = {
    keyword: "Palavra-chave",
    message_received: "Qualquer mensagem recebida",
    message_sent: "Mensagem enviada",
    conversation_created: "Nova conversa",
};

const STOP_REASON_LABELS: Record<string, string> = {
    completed: "Fluxo concluído",
    no_match: "Nenhum gatilho correspondeu",
    cancelled: "Cancelada",
    failed: "Falhou",
    refusal: "Recusada pelo contato",
    stopped: "Interrompida",
};

const formatTriggerType = (value: string | null): string =>
    value ? TRIGGER_TYPE_LABELS[value] ?? value : "-";

// matched_by chega como texto livre do motor: `keyword "oi" (contains)`,
// `message_received (any message)`. Traduz o que reconhece, repassa o resto.
const formatMatchedBy = (value: string | null): string | null => {
    if (!value) return null;
    const keyword = /^keyword "(.+)"/.exec(value);
    if (keyword) return `Palavra-chave “${keyword[1]}”`;
    const head = value.split(" ")[0];
    return TRIGGER_TYPE_LABELS[head] ?? value;
};

const formatStopReason = (value: string | null): string | null =>
    value ? STOP_REASON_LABELS[value] ?? value : null;

export function ExecutionsPanel({ flowId }: ExecutionsPanelProps) {
    const { currentOrganization } = useOrganization();
    const [executions, setExecutions] = useState<AutomationExecution[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState<string>('all');
    const [selectedExecution, setSelectedExecution] = useState<AutomationExecution | null>(null);

    const fetchExecutions = useCallback(async () => {
        if (!currentOrganization?.id) return;

        setIsLoading(true);
        try {
            // execution_log fica FORA da lista: é o passo-a-passo completo da
            // execução em jsonb, multiplicado pelas 100 linhas da página, e só o
            // drawer o lê (:304). Carregado sob demanda em openExecution().
            let query = supabase
                .from('automation_executions')
                .select(
                    'id, flow_id, session_id, conversation_id, organization_id, status, ' +
                    'trigger_message, trigger_type, matched_by, stop_reason, error, ' +
                    'started_at, completed_at, phone_number_id, contact_phone'
                )
                .eq('organization_id', currentOrganization.id)
                .order('started_at', { ascending: false })
                .limit(100);

            // Filter by flow_id if provided (not 'all')
            if (flowId && flowId !== 'all') {
                query = query.eq('flow_id', flowId);
            }

            // Filter by status if not 'all'
            if (statusFilter !== 'all') {
                query = query.eq('status', statusFilter);
            }

            const { data, error } = await query;

            if (error) {
                console.error('Error fetching executions:', error);
                return;
            }

            setExecutions((data as unknown as AutomationExecution[]) || []);
        } finally {
            setIsLoading(false);
        }
    }, [currentOrganization?.id, flowId, statusFilter]);

    useEffect(() => {
        fetchExecutions();
    }, [fetchExecutions]);

    /**
     * Abre o drawer e busca o execution_log daquela execução — a lista não o
     * traz. Mostra o drawer na hora (com o resto dos dados, que já estão em
     * mãos) e preenche o log quando chega; o `prev?.id === execution.id` evita
     * que uma resposta atrasada sobrescreva um drawer já trocado.
     */
    const openExecution = useCallback(async (execution: AutomationExecution) => {
        setSelectedExecution(execution);
        if (execution.execution_log) return;

        const { data, error } = await supabase
            .from('automation_executions')
            .select('execution_log')
            .eq('id', execution.id)
            .maybeSingle();

        if (error) {
            console.error('Error fetching execution log:', error);
            return;
        }

        setSelectedExecution(prev =>
            prev?.id === execution.id
                ? { ...prev, execution_log: (data?.execution_log as unknown as ExecutionLogEntry[]) ?? [] }
                : prev
        );
    }, []);

    const getStatusBadge = (status: string) => {
        const config = statusConfig[status] || statusConfig.stopped;
        const Icon = config.icon;
        return (
            <Badge variant={config.variant} className="flex items-center gap-1">
                <Icon className="h-3 w-3" />
                {config.label}
            </Badge>
        );
    };

    const getLogEntryIcon = (type: ExecutionLogEntry['type']) => {
        switch (type) {
            case 'success':
                return <CheckCircle className="h-4 w-4 text-green-500" />;
            case 'error':
                return <XCircle className="h-4 w-4 text-red-500" />;
            case 'node':
                return <div className="h-4 w-4 rounded-full bg-blue-500" />;
            case 'trigger':
                return <div className="h-4 w-4 rounded-full bg-purple-500" />;
            default:
                return <div className="h-4 w-4 rounded-full bg-muted-foreground/30" />;
        }
    };

    if (isLoading) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">Execuções</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="space-y-3">
                        {[1, 2, 3, 4, 5].map((i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </div>
                </CardContent>
            </Card>
        );
    }

    return (
        <>
            <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-4">
                    <CardTitle className="text-lg">Execuções</CardTitle>
                    <div className="flex items-center gap-2">
                        <Select value={statusFilter} onValueChange={setStatusFilter}>
                            <SelectTrigger className="w-[140px]">
                                <SelectValue placeholder="Status" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">Todas</SelectItem>
                                <SelectItem value="completed">Concluídas</SelectItem>
                                <SelectItem value="failed">Falhas</SelectItem>
                                <SelectItem value="stopped">Paradas</SelectItem>
                                <SelectItem value="no_match">Sem correspondência</SelectItem>
                            </SelectContent>
                        </Select>
                        <Button variant="outline" size="icon" onClick={fetchExecutions} aria-label="Atualizar execuções">
                            <RefreshCw className="h-4 w-4" />
                        </Button>
                    </div>
                </CardHeader>
                <CardContent>
                    {executions.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                            <Clock className="h-10 w-10 mb-4 opacity-20" />
                            <p className="text-center text-pretty">Nenhuma execução ainda. Cada gatilho acionado aparece aqui.</p>
                        </div>
                    ) : (
                        <ScrollArea className="h-[500px]">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Hora</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead>Mensagem que acionou</TableHead>
                                        <TableHead>Correspondência</TableHead>
                                        <TableHead>Contato</TableHead>
                                        <TableHead className="w-[50px]"></TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {executions.map((execution) => (
                                        <TableRow key={execution.id}>
                                            <TableCell className="font-mono text-sm">
                                                <div className="flex flex-col">
                                                    <span>
                                                        {format(new Date(execution.started_at), 'dd/MM HH:mm:ss')}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground">
                                                        {formatDistanceToNow(new Date(execution.started_at), {
                                                            addSuffix: true,
                                                            locale: ptBR,
                                                        })}
                                                    </span>
                                                </div>
                                            </TableCell>
                                            <TableCell>{getStatusBadge(execution.status)}</TableCell>
                                            <TableCell className="max-w-[200px] truncate" title={execution.trigger_message?.content || undefined}>
                                                {execution.trigger_message?.content || '-'}
                                            </TableCell>
                                            <TableCell className="max-w-[150px] truncate text-sm" title={formatMatchedBy(execution.matched_by) ?? formatStopReason(execution.stop_reason) ?? undefined}>
                                                {formatMatchedBy(execution.matched_by) ?? formatStopReason(execution.stop_reason) ?? '-'}
                                            </TableCell>
                                            <TableCell className="font-mono text-sm">
                                                {execution.contact_phone || '-'}
                                            </TableCell>
                                            <TableCell>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => void openExecution(execution)}
                                                    aria-label="Ver detalhes da execução"
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
            </Card>

            {/* Execution Detail Dialog */}
            <Dialog open={!!selectedExecution} onOpenChange={() => setSelectedExecution(null)}>
                <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            Detalhes da execução
                            {selectedExecution && getStatusBadge(selectedExecution.status)}
                        </DialogTitle>
                    </DialogHeader>

                    {selectedExecution && (
                        <div className="flex-1 overflow-auto space-y-4">
                            {/* Trigger Info */}
                            <div className="bg-muted/50 rounded-md p-4 space-y-2">
                                <h4 className="font-medium">Gatilho</h4>
                                <div className="grid grid-cols-2 gap-2 text-sm">
                                    <div>
                                        <span className="text-muted-foreground">Mensagem:</span>
                                        <p className="font-mono bg-background rounded p-2 mt-1">
                                            {selectedExecution.trigger_message?.content || '-'}
                                        </p>
                                    </div>
                                    <div>
                                        <span className="text-muted-foreground">Tipo:</span>
                                        <p>{formatTriggerType(selectedExecution.trigger_type)}</p>
                                        <span className="text-muted-foreground">Correspondência:</span>
                                        <p>{formatMatchedBy(selectedExecution.matched_by) ?? '-'}</p>
                                    </div>
                                </div>
                                {selectedExecution.stop_reason && (
                                    <div>
                                        <span className="text-muted-foreground">Motivo da parada:</span>
                                        <p className="text-orange-600">{formatStopReason(selectedExecution.stop_reason) ?? selectedExecution.stop_reason}</p>
                                    </div>
                                )}
                                {selectedExecution.error && (
                                    <div>
                                        <span className="text-muted-foreground">Erro:</span>
                                        <p className="text-red-600">{selectedExecution.error}</p>
                                    </div>
                                )}
                            </div>

                            {/* Execution Log */}
                            <div>
                                <h4 className="font-medium mb-2">Registro da execução</h4>
                                <ScrollArea className="h-[300px] border rounded-md">
                                    <div className="p-4 space-y-2">
                                        {(selectedExecution.execution_log ?? []).length === 0 ? (
                                            <p className="text-muted-foreground text-center py-4">
                                                Nenhum registro nesta execução
                                            </p>
                                        ) : (
                                            (selectedExecution.execution_log ?? []).map((entry, index) => (
                                                <div
                                                    key={index}
                                                    className="flex items-start gap-3 py-2 border-b last:border-0"
                                                >
                                                    <div className="flex-shrink-0 mt-1">
                                                        {getLogEntryIcon(entry.type)}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-xs text-muted-foreground font-mono">
                                                                #{entry.step}
                                                            </span>
                                                            {entry.node_type && (
                                                                <Badge variant="outline" className="text-xs">
                                                                    {NODE_TYPE_LABELS[entry.node_type] ?? entry.node_type}
                                                                </Badge>
                                                            )}
                                                            <span className="text-xs text-muted-foreground">
                                                                {format(new Date(entry.timestamp), 'HH:mm:ss.SSS')}
                                                            </span>
                                                        </div>
                                                        <p className="text-sm mt-1">{entry.message}</p>
                                                        {entry.details && (
                                                            <pre className="text-xs bg-muted rounded p-2 mt-1 overflow-x-auto">
                                                                {JSON.stringify(entry.details, null, 2)}
                                                            </pre>
                                                        )}
                                                    </div>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </ScrollArea>
                            </div>

                            {/* Metadata */}
                            <div className="text-xs text-muted-foreground grid grid-cols-2 gap-2">
                                <div>
                                    <span>ID: </span>
                                    <span className="font-mono">{selectedExecution.id}</span>
                                </div>
                                <div>
                                    <span>Contato: </span>
                                    <span className="font-mono">{selectedExecution.contact_phone || '-'}</span>
                                </div>
                                <div>
                                    <span>Início: </span>
                                    <span>{format(new Date(selectedExecution.started_at), 'dd/MM/yyyy HH:mm:ss')}</span>
                                </div>
                                <div>
                                    <span>Fim: </span>
                                    <span>
                                        {selectedExecution.completed_at
                                            ? format(new Date(selectedExecution.completed_at), 'dd/MM/yyyy HH:mm:ss')
                                            : '-'}
                                    </span>
                                </div>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
