import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Plus, Workflow, Pencil, Trash2, ArrowLeft, MessageSquare, Zap, Clock, Construction, Phone, Smartphone, Send, AlertTriangle, Loader2 } from "lucide-react";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useIsMobile } from "@/hooks/use-mobile";
import { BottomNavigation } from "@/components/layout";
import { DEFAULT_MATCH_TYPE, hasEmptyKeywordTrigger } from "@/lib/automationTriggers";
import { toUserMessage } from "@/lib/userFacingError";

interface AutomationTrigger {
    id: string;
    trigger_type: string;
    trigger_config: any;
    is_active: boolean;
}

interface AutomationFlow {
    id: string;
    name: string;
    description: string | null;
    is_active: boolean;
    trigger_type: string;
    trigger_config: any;
    created_at: string;
    updated_at: string;
    phone_number_id: string | null;
    automation_triggers?: AutomationTrigger[];
}

const triggerTypeLabels: Record<string, string> = {
    message_received: "Msg recebida",
    keyword: "Palavra-chave",
    conversation_created: "Nova conversa",
    message_sent: "Msg enviada",
};

const triggerTypeIcons: Record<string, React.ReactNode> = {
    message_received: <MessageSquare className="h-4 w-4" />,
    keyword: <Zap className="h-4 w-4" />,
    conversation_created: <Clock className="h-4 w-4" />,
    message_sent: <Send className="h-4 w-4" />,
};

export default function Automations() {
    const navigate = useNavigate();
    const { toast } = useToast();
    const { currentOrganization } = useOrganization();
    const [flows, setFlows] = useState<AutomationFlow[]>([]);
    const [loading, setLoading] = useState(true);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [flowToDelete, setFlowToDelete] = useState<string | null>(null);
    const [createDialogOpen, setCreateDialogOpen] = useState(false);
    const [newFlowName, setNewFlowName] = useState("");
    const [newFlowDescription, setNewFlowDescription] = useState("");
    const [newFlowTrigger, setNewFlowTrigger] = useState("keyword");
    const [newFlowPhoneNumberId, setNewFlowPhoneNumberId] = useState<string>("all");
    const [phoneNumbers, setPhoneNumbers] = useState<any[]>([]);
    const [creating, setCreating] = useState(false);
    const isMobile = useIsMobile();

    useEffect(() => {
        if (currentOrganization?.id) {
            loadFlows();
            loadPhoneNumbers();
        }
    }, [currentOrganization?.id]);

    const loadPhoneNumbers = async () => {
        if (!currentOrganization?.id) return;

        const { data, error } = await supabase
            .from("phone_numbers")
            .select("id, display_name, phone_number")
            .eq("organization_id", currentOrganization.id)
            .eq("is_active", true);

        if (!error && data) {
            setPhoneNumbers(data);
        }
    };

    const loadFlows = async () => {
        if (!currentOrganization?.id) return;

        setLoading(true);
        // Colunas explícitas em vez de "*": o `*` trazia junto `flow_data`, que é
        // o grafo INTEIRO da automação em jsonb (nós, arestas, textos de cada
        // mensagem) — centenas de KB por fluxo, multiplicado por todos os fluxos
        // da organização, só para desenhar cards que mostram nome, descrição,
        // estado e gatilhos. A lista abaixo é exatamente a interface
        // AutomationFlow (:50); o editor carrega o flow_data do seu próprio
        // fluxo, um por vez, em FlowBuilderPage.tsx.
        const { data, error } = await (supabase as any)
            .from("automation_flows")
            .select(
                "id, name, description, is_active, trigger_type, trigger_config, created_at, updated_at, phone_number_id, " +
                "automation_triggers (id, trigger_type, trigger_config, is_active)"
            )
            .eq("organization_id", currentOrganization.id)
            .order("created_at", { ascending: false });

        if (error) {
            toast({
                title: "Não foi possível carregar automações",
                description: toUserMessage(error),
                variant: "destructive",
            });
        } else {
            setFlows(data || []);
        }
        setLoading(false);
    };

    /**
     * Gatilho de palavra-chave sem palavra nunca dispara. Deixar ativar dava a
     * falsa sensação de fluxo no ar (caso em que a frase
     * tinha ficado só no nome do gatilho).
     */
    const flowIsMute = (flow: AutomationFlow): boolean => {
        const triggers = flow.automation_triggers?.filter(t => t.is_active) ?? [];

        return hasEmptyKeywordTrigger(
            triggers.length > 0
                ? triggers
                : [{ trigger_type: flow.trigger_type, trigger_config: flow.trigger_config }],
        );
    };

    const toggleFlowActive = async (flowId: string, isActive: boolean) => {
        const flow = flows.find(f => f.id === flowId);

        if (isActive && flow && flowIsMute(flow)) {
            toast({
                title: "Não foi possível ativar",
                description: "O gatilho de palavra-chave está sem nenhuma palavra: o fluxo nunca dispararia. Abra o editor e configure as palavras.",
                variant: "destructive",
            });
            return;
        }

        const { error } = await (supabase as any)
            .from("automation_flows")
            .update({ is_active: isActive })
            .eq("id", flowId);

        if (error) {
            toast({
                title: "Não foi possível atualizar automação",
                description: toUserMessage(error),
                variant: "destructive",
            });
        } else {
            setFlows(flows.map(f => f.id === flowId ? { ...f, is_active: isActive } : f));
            toast({
                title: isActive ? "Automação ativada" : "Automação desativada",
            });
        }
    };

    const deleteFlow = async () => {
        if (!flowToDelete) return;

        const { error } = await (supabase as any)
            .from("automation_flows")
            .delete()
            .eq("id", flowToDelete);

        if (error) {
            toast({
                title: "Não foi possível excluir automação",
                description: toUserMessage(error),
                variant: "destructive",
            });
        } else {
            setFlows(flows.filter(f => f.id !== flowToDelete));
            toast({ title: "Automação excluída" });
        }
        setDeleteDialogOpen(false);
        setFlowToDelete(null);
    };

    const createFlow = async () => {
        if (!currentOrganization?.id || !newFlowName.trim()) return;

        setCreating(true);

        const initialFlowData = {
            nodes: [
                {
                    id: "trigger-1",
                    type: "triggerNode",
                    position: { x: 250, y: 50 },
                    data: {
                        label: "Início",
                        triggerType: newFlowTrigger,
                        triggers: [{
                            type: newFlowTrigger,
                            config: newFlowTrigger === "keyword" ? { keywords: [], match_type: DEFAULT_MATCH_TYPE } : {},
                        }],
                    },
                },
            ],
            edges: [],
            viewport: { x: 0, y: 0, zoom: 1 },
        };

        const { data, error } = await (supabase as any)
            .from("automation_flows")
            .insert({
                organization_id: currentOrganization.id,
                name: newFlowName.trim(),
                description: newFlowDescription.trim() || null,
                phone_number_id: newFlowPhoneNumberId === "all" ? null : newFlowPhoneNumberId,
                trigger_type: newFlowTrigger,
                trigger_config: newFlowTrigger === "keyword" ? { keywords: [], match_type: DEFAULT_MATCH_TYPE } : {},
                flow_data: initialFlowData,
                is_active: false,
            })
            .select()
            .single();

        if (error) {
            toast({
                title: "Não foi possível criar automação",
                description: toUserMessage(error),
                variant: "destructive",
            });
        } else if (data) {
            toast({ title: "Automação criada" });
            setCreateDialogOpen(false);
            setNewFlowName("");
            setNewFlowDescription("");
            setNewFlowTrigger("keyword");
            setNewFlowPhoneNumberId("all");
            navigate(`/automations/${data.id}`);
        }
        setCreating(false);
    };

    return (
        <div className="min-h-dvh bg-background">
            {/* Header */}
            <div className="border-b sticky top-0 z-10 bg-background safe-area-top">
                <div className="container mx-auto px-4 py-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 sm:gap-4">
                            {!isMobile && (
                                <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")} aria-label="Voltar">
                                    <ArrowLeft className="h-5 w-5" />
                                </Button>
                            )}
                            <div>
                                <h1 className="text-lg sm:text-2xl font-bold flex items-center gap-2">
                                    <Workflow className="h-5 w-5 sm:h-6 sm:w-6 text-primary" />
                                    Automações
                                </h1>
                                {!isMobile && (
                                    <p className="text-muted-foreground text-sm">
                                        Crie fluxos de conversa automatizados para WhatsApp
                                    </p>
                                )}
                            </div>
                        </div>
                        <Button onClick={() => setCreateDialogOpen(true)} size={isMobile ? "sm" : "default"}>
                            <Plus className="h-4 w-4 mr-1 sm:mr-2" />
                            <span className="hidden xs:inline">Nova Automação</span><span className="xs:hidden">Automação</span>
                        </Button>
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className={`container mx-auto px-4 pt-4 sm:pt-8 space-y-4 sm:space-y-8 ${isMobile ? "pb-bottom-nav" : "pb-4 sm:pb-8"}`}>
                {/* WIP Banner */}
                <Card className="border-amber-500/50 bg-amber-500/5">
                    <CardContent className="flex items-center gap-3 sm:gap-4 py-4 sm:py-6">
                        <Construction className="h-8 w-8 sm:h-10 sm:w-10 text-amber-500 shrink-0" />
                        <div>
                            <h2 className="text-base sm:text-lg font-semibold text-amber-500">
                                Funcionalidade em desenvolvimento (beta)
                            </h2>
                            <p className="text-muted-foreground text-sm hidden sm:block text-pretty">
                                O módulo de automações já funciona: você pode criar e testar fluxos enquanto a interface e os recursos continuam sendo refinados.
                            </p>
                        </div>
                    </CardContent>
                </Card>

                <div className="">
                    {loading ? (
                        <div className="flex items-center justify-center h-64">
                            <Loader2 className="h-8 w-8 animate-spin text-primary" />
                        </div>
                    ) : flows.length === 0 ? (
                        <Card className="border-dashed">
                            <CardContent className="flex flex-col items-center justify-center py-12 sm:py-16">
                                <Workflow className="h-12 w-12 sm:h-16 sm:w-16 text-muted-foreground/50 mb-4" />
                                <h3 className="text-base sm:text-lg font-semibold mb-2 text-balance">Nenhuma automação criada</h3>
                                <p className="text-muted-foreground text-center mb-6 max-w-md text-sm text-pretty">
                                    Crie fluxos de conversa para automatizar respostas e direcionar seus clientes.
                                </p>
                                <Button onClick={() => setCreateDialogOpen(true)}>
                                    <Plus className="h-4 w-4 mr-2" />
                                    Criar primeira automação
                                </Button>
                            </CardContent>
                        </Card>
                    ) : (
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {flows.map((flow) => (
                                <Card key={flow.id} className="hover:border-primary/50 transition-colors">
                                    <CardHeader className="pb-3">
                                        <div className="flex items-start justify-between">
                                            <div className="flex-1 min-w-0">
                                                <CardTitle className="text-base sm:text-lg flex items-center gap-2 truncate">
                                                    {flow.name}
                                                </CardTitle>
                                                {flow.description && (
                                                    <CardDescription className="mt-1 line-clamp-2">
                                                        {flow.description}
                                                    </CardDescription>
                                                )}
                                            </div>
                                            <Switch
                                                checked={flow.is_active}
                                                onCheckedChange={(checked) => toggleFlowActive(flow.id, checked)}
                                                className="touch-manipulation"
                                            />
                                        </div>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="flex items-center gap-2 mb-4 flex-wrap">
                                            {/* Show triggers from new table if available, otherwise fallback to legacy */}
                                            {(flow.automation_triggers && flow.automation_triggers.length > 0) ? (
                                                flow.automation_triggers.filter(t => t.is_active).map((trigger, idx) => (
                                                    <Badge key={trigger.id} variant="secondary" className="flex items-center gap-1">
                                                        {triggerTypeIcons[trigger.trigger_type] || <Zap className="h-4 w-4" />}
                                                        {triggerTypeLabels[trigger.trigger_type] || trigger.trigger_type}
                                                        {idx < (flow.automation_triggers?.filter(t => t.is_active).length || 0) - 1 && (
                                                            <span className="ml-1 text-muted-foreground">|</span>
                                                        )}
                                                    </Badge>
                                                ))
                                            ) : (
                                                <Badge variant="secondary" className="flex items-center gap-1">
                                                    {triggerTypeIcons[flow.trigger_type] || <Zap className="h-4 w-4" />}
                                                    {triggerTypeLabels[flow.trigger_type] || flow.trigger_type}
                                                </Badge>
                                            )}
                                            {flow.phone_number_id ? (
                                                <Badge variant="outline" className="flex items-center gap-1">
                                                    <Phone className="h-3 w-3" />
                                                    <span className="truncate max-w-[100px]">
                                                        {phoneNumbers.find(p => p.id === flow.phone_number_id)?.display_name || "Específico"}
                                                    </span>
                                                </Badge>
                                            ) : (
                                                <Badge variant="outline" className="flex items-center gap-1">
                                                    <Smartphone className="h-3 w-3" />
                                                    Todos
                                                </Badge>
                                            )}
                                            {flow.is_active && (
                                                <Badge variant="default" className="bg-green-500">
                                                    Ativo
                                                </Badge>
                                            )}
                                            {flowIsMute(flow) && (
                                                <Badge variant="destructive" className="flex items-center gap-1">
                                                    <AlertTriangle className="h-3 w-3" />
                                                    Sem palavra-chave
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="flex-1 touch-manipulation"
                                                onClick={() => navigate(`/automations/${flow.id}`)}
                                            >
                                                <Pencil className="h-4 w-4 mr-2" />
                                                Editar
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="touch-manipulation"
                                                onClick={() => {
                                                    setFlowToDelete(flow.id);
                                                    setDeleteDialogOpen(true);
                                                }}
                                                aria-label={`Excluir automação ${flow.name}`}
                                            >
                                                <Trash2 className="h-4 w-4 text-destructive" />
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Delete confirmation dialog */}
            <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Excluir automação?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Esta ação não pode ser desfeita. A automação será permanentemente excluída.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction onClick={deleteFlow} className="bg-destructive text-destructive-foreground">
                            Excluir
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Create flow dialog */}
            <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Nova Automação</DialogTitle>
                        <DialogDescription>
                            Configure o básico da sua automação.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="name">Nome</Label>
                            <Input
                                id="name"
                                placeholder="Ex: Boas-vindas"
                                value={newFlowName}
                                onChange={(e) => setNewFlowName(e.target.value)}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="description">Descrição (opcional)</Label>
                            <Textarea
                                id="description"
                                placeholder="Descreva o que essa automação faz…"
                                value={newFlowDescription}
                                onChange={(e) => setNewFlowDescription(e.target.value)}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="trigger">Gatilho</Label>
                            <Select value={newFlowTrigger} onValueChange={setNewFlowTrigger}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="keyword">Palavra-chave</SelectItem>
                                    <SelectItem value="message_received">Qualquer mensagem recebida</SelectItem>
                                    <SelectItem value="message_sent">Mensagem enviada</SelectItem>
                                    <SelectItem value="conversation_created">Nova conversa</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="phone">Número de destino</Label>
                            <Select value={newFlowPhoneNumberId} onValueChange={setNewFlowPhoneNumberId}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">Todos os números</SelectItem>
                                    {phoneNumbers.map((phone) => (
                                        <SelectItem key={phone.id} value={phone.id}>
                                            {phone.display_name} ({phone.phone_number})
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <DialogFooter className="flex-col sm:flex-row gap-2">
                        <Button variant="outline" onClick={() => setCreateDialogOpen(false)} className="w-full sm:w-auto">
                            Cancelar
                        </Button>
                        <Button onClick={createFlow} disabled={!newFlowName.trim() || creating} className="w-full sm:w-auto">
                            {creating ? "Criando…" : "Criar e editar"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {isMobile && <BottomNavigation />}
        </div>
    );
}
