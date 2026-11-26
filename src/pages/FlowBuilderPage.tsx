import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Play, Pause, Construction, Phone, Smartphone, Timer, History, Workflow, ClipboardList, Users, Loader2 } from "lucide-react";
import { FlowBuilder } from "@/components/automation/FlowBuilder";
import { ExecutionsPanel } from "@/components/automation/ExecutionsPanel";
import { SurveyResultsPanel } from "@/components/automation/SurveyResultsPanel";
import { Edge, Node } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
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
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    findKeywordCollisions,
    toKeywordTriggerRefs,
    type KeywordCollision,
} from "@/lib/automationKeywordCollisions";
import {
    DEFAULT_MATCH_TYPE,
    hasEmptyKeywordTrigger,
    sanitizeTriggers,
    type AutomationTriggerDraft,
} from "@/lib/automationTriggers";
import { toUserMessage } from "@/lib/userFacingError";

interface TriggerConfig {
    type: string;
    config: {
        keywords?: string[];
        match_type?: string;
    };
}

interface AutomationFlow {
    id: string;
    name: string;
    description: string | null;
    is_active: boolean;
    trigger_type: string;
    trigger_config: Record<string, unknown>;
    flow_data: {
        nodes: Node[];
        edges: Edge[];
        viewport?: { x: number; y: number; zoom: number };
    };
    phone_number_id: string | null;
    cooldown_minutes: number;
    run_in_groups: boolean;
}

export default function FlowBuilderPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { toast } = useToast();
    const { currentOrganization } = useOrganization();
    const [flow, setFlow] = useState<AutomationFlow | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [flowName, setFlowName] = useState("");
    const [isActive, setIsActive] = useState(false);
    const [flowPhoneNumberId, setFlowPhoneNumberId] = useState<string>("all");
    const [cooldownMinutes, setCooldownMinutes] = useState<number>(30);
    const [runInGroups, setRunInGroups] = useState(false);
    const [phoneNumbers, setPhoneNumbers] = useState<any[]>([]);
    const [builderDirty, setBuilderDirty] = useState(false);
    const [leaveConfirm, setLeaveConfirm] = useState(false);
    const [collisions, setCollisions] = useState<KeywordCollision[] | null>(null);
    const collisionDecision = useRef<((proceed: boolean) => void) | null>(null);

    // Campos do header também são salvos pelo mesmo Salvar do canvas
    const fieldsDirty =
        flow !== null &&
        (flowName !== flow.name ||
            cooldownMinutes !== (flow.cooldown_minutes ?? 30) ||
            runInGroups !== flow.run_in_groups ||
            flowPhoneNumberId !== (flow.phone_number_id || "all"));
    const isDirty = builderDirty || fieldsDirty;

    // Fechar a aba / F5 com trabalho não salvo pede confirmação do navegador
    useEffect(() => {
        if (!isDirty) return;
        const handler = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, [isDirty]);

    const handleBack = () => {
        if (isDirty) {
            setLeaveConfirm(true);
            return;
        }
        navigate("/automations");
    };

    useEffect(() => {
        if (id && currentOrganization?.id) {
            loadFlow();
            loadPhoneNumbers();
        }
    }, [id, currentOrganization?.id]);

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

    const loadFlow = async () => {
        if (!id) return;

        setLoading(true);
        // Using any to bypass type checking since automation_flows table types 
        // are not yet generated (will be after running the migration)
        const { data, error } = await (supabase as any)
            .from("automation_flows")
            .select("*")
            .eq("id", id)
            .single();

        if (error) {
            toast({
                title: "Não foi possível carregar automação",
                description: toUserMessage(error),
                variant: "destructive",
            });
            navigate("/automations");
        } else if (data) {
            // Parse flow_data if it's a string
            const flowData =
                typeof data.flow_data === "string"
                    ? JSON.parse(data.flow_data)
                    : data.flow_data;

            const automationFlow: AutomationFlow = {
                id: data.id,
                name: data.name,
                description: data.description,
                is_active: data.is_active,
                trigger_type: data.trigger_type,
                trigger_config: data.trigger_config,
                flow_data: flowData,
                phone_number_id: data.phone_number_id,
                cooldown_minutes: data.cooldown_minutes ?? 30,
                run_in_groups: data.run_in_groups === true,
            };

            setFlow(automationFlow);
            setFlowName(data.name);
            setIsActive(data.is_active);
            setFlowPhoneNumberId(data.phone_number_id || "all");
            setCooldownMinutes(data.cooldown_minutes ?? 30);
            setRunInGroups(data.run_in_groups === true);
        }
        setLoading(false);
    };

    /**
     * Pergunta ao usuário se salva mesmo com palavra-chave colidindo. Resolve o
     * `Promise` só depois da decisão, para o `handleSave` devolver ao builder se
     * o fluxo foi salvo de fato (e o canvas não limpar o dirty à toa).
     */
    const askCollisionConfirm = (found: KeywordCollision[]): Promise<boolean> =>
        new Promise((resolve) => {
            collisionDecision.current = resolve;
            setCollisions(found);
        });

    const resolveCollision = (proceed: boolean) => {
        setCollisions(null);
        const decide = collisionDecision.current;
        collisionDecision.current = null;
        decide?.(proceed);
    };

    /**
     * Palavras-chave que também acionariam (ou seriam roubadas por) outro fluxo
     * ATIVO da mesma linha. Falha de leitura não bloqueia o save: é um aviso.
     */
    const loadCollisions = async (triggers: AutomationTriggerDraft[], phoneNumberId: string | null) => {
        if (!id || !currentOrganization?.id) return [];

        const { data, error } = await supabase
            .from("automation_flows")
            .select("id, name, phone_number_id, trigger_type, trigger_config, automation_triggers (trigger_type, trigger_config, is_active)")
            .eq("organization_id", currentOrganization.id)
            .eq("is_active", true)
            .neq("id", id);

        if (error || !data) {
            if (error) console.error("Erro ao checar colisão de palavra-chave:", error);
            return [];
        }

        return findKeywordCollisions(
            { flowId: id, phoneNumberId, triggers },
            toKeywordTriggerRefs(data),
        );
    };

    const handleSave = async (data: { nodes: Node[]; edges: Edge[] }): Promise<boolean> => {
        if (!id || !flow) return false;

        // Extract trigger config from trigger node
        const triggerNode = data.nodes.find((n) => n.type === "triggerNode");
        const nodeData = triggerNode?.data as Record<string, unknown> | undefined;

        // Support both new format (triggers array) and old format (triggerType/keywords)
        const rawTriggers: TriggerConfig[] = nodeData?.triggers as TriggerConfig[] || [{
            type: (nodeData?.triggerType as string) || flow.trigger_type || "keyword",
            config: {
                keywords: (nodeData?.keywords as string[]) || [],
                match_type: DEFAULT_MATCH_TYPE
            }
        }];

        // Palavra-chave vazia = fluxo mudo. Barra aqui, antes de gravar.
        const { triggers, error: validationError } = sanitizeTriggers(rawTriggers);
        if (validationError) {
            toast({
                title: "Não foi possível salvar",
                description: validationError,
                variant: "destructive",
            });
            return false;
        }

        const phoneNumberId = flowPhoneNumberId === "all" ? null : flowPhoneNumberId;

        setSaving(true);

        // Fluxo inativo não disputa mensagem com ninguém: só avisa se for ativar.
        if (isActive) {
            const found = await loadCollisions(triggers, phoneNumberId);
            if (found.length > 0) {
                setSaving(false);
                const proceed = await askCollisionConfirm(found);
                if (!proceed) return false;
                setSaving(true);
            }
        }

        // Grava os gatilhos limpos também no flow_data, para o canvas reabrir
        // igual ao que o executor vai enxergar.
        const nodes = triggerNode
            ? data.nodes.map((n) =>
                n.id === triggerNode.id
                    ? { ...n, data: { ...(n.data as Record<string, unknown>), triggers, keywords: undefined } }
                    : n,
            )
            : data.nodes;

        // Use first trigger for legacy fields (backwards compatibility)
        const primaryTrigger = triggers[0];
        const triggerType = primaryTrigger.type;
        const triggerConfig = primaryTrigger.config;

        const { error } = await (supabase as any)
            .from("automation_flows")
            .update({
                name: flowName,
                is_active: isActive,
                phone_number_id: phoneNumberId,
                cooldown_minutes: cooldownMinutes,
                run_in_groups: runInGroups,
                trigger_type: triggerType,
                trigger_config: triggerConfig,
                flow_data: {
                    nodes,
                    edges: data.edges,
                    viewport: flow.flow_data.viewport,
                },
            })
            .eq("id", id);

        if (error) {
            toast({
                title: "Não foi possível salvar o fluxo",
                description: toUserMessage(error),
                variant: "destructive",
            });
            setSaving(false);
            return false;
        }

        // Sync triggers to automation_triggers table
        // First delete existing triggers
        await (supabase as any)
            .from("automation_triggers")
            .delete()
            .eq("flow_id", id);

        // Then insert new triggers
        const triggersToInsert = triggers.map(t => ({
            flow_id: id,
            trigger_type: t.type,
            trigger_config: t.config || {},
            is_active: true
        }));

        const { error: triggerError } = await (supabase as any)
            .from("automation_triggers")
            .insert(triggersToInsert);

        if (triggerError) {
            console.error("Error saving triggers:", triggerError);
            // Don't fail the whole save, triggers table might not exist yet
        }

        toast({ title: "Fluxo salvo" });
        setFlow({
            ...flow,
            name: flowName,
            is_active: isActive,
            phone_number_id: phoneNumberId,
            cooldown_minutes: cooldownMinutes,
            run_in_groups: runInGroups,
            trigger_type: triggerType as string,
            trigger_config: triggerConfig,
            flow_data: { nodes, edges: data.edges },
        });

        setSaving(false);
        return true;
    };

    /** Gatilhos como estão SALVOS (é o que o executor vê), não como estão no canvas. */
    const savedTriggers = (): Array<{ type?: string; config?: unknown; trigger_type?: string; trigger_config?: unknown }> => {
        const triggerNode = flow?.flow_data?.nodes?.find((n) => n.type === "triggerNode");
        const nodeTriggers = (triggerNode?.data as Record<string, unknown> | undefined)?.triggers as TriggerConfig[] | undefined;

        if (nodeTriggers?.length) return nodeTriggers;

        return [{ type: flow?.trigger_type, config: flow?.trigger_config }];
    };

    const toggleActive = async () => {
        const newValue = !isActive;

        if (newValue && hasEmptyKeywordTrigger(savedTriggers())) {
            toast({
                title: "Não foi possível ativar",
                description: "O gatilho de palavra-chave está sem nenhuma palavra: o fluxo nunca dispararia.",
                variant: "destructive",
            });
            return;
        }

        if (newValue) {
            const { triggers } = sanitizeTriggers(savedTriggers().map((t) => ({
                type: t.type ?? t.trigger_type,
                config: t.config ?? t.trigger_config ?? {},
            })));
            const found = triggers.length > 0
                ? await loadCollisions(triggers, flow?.phone_number_id ?? null)
                : [];

            if (found.length > 0 && !(await askCollisionConfirm(found))) return;
        }

        setIsActive(newValue);

        const { error } = await (supabase as any)
            .from("automation_flows")
            .update({ is_active: newValue })
            .eq("id", id);

        if (error) {
            toast({
                title: "Não foi possível atualizar status",
                description: toUserMessage(error),
                variant: "destructive",
            });
            setIsActive(!newValue);
        } else {
            toast({
                title: newValue ? "Automação ativada" : "Automação desativada",
            });
        }
    };

    if (loading) {
        return (
            <div className="h-dvh flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    if (!flow) {
        return (
            <div className="h-dvh flex items-center justify-center">
                <p className="text-muted-foreground">Automação não encontrada</p>
            </div>
        );
    }

    return (
        <div className="h-dvh flex flex-col">
            {/* Header */}
            <div className="border-b bg-background px-4 py-2 flex items-center justify-between shrink-0 gap-2 overflow-x-auto">
                <div className="flex items-center gap-4">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleBack}
                        aria-label="Voltar"
                    >
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                    <div className="flex items-center gap-3">
                        <Input
                            value={flowName}
                            onChange={(e) => setFlowName(e.target.value)}
                            className="w-64 font-semibold"
                            placeholder="Nome da automação"
                        />
                        <Select
                            value={flowPhoneNumberId}
                            onValueChange={setFlowPhoneNumberId}
                        >
                            <SelectTrigger className="w-[200px] h-9">
                                <SelectValue placeholder="Número" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">
                                    <div className="flex items-center gap-2">
                                        <Smartphone className="h-4 w-4" />
                                        Todos os números
                                    </div>
                                </SelectItem>
                                {phoneNumbers.map((phone) => (
                                    <SelectItem key={phone.id} value={phone.id}>
                                        <div className="flex items-center gap-2">
                                            <Phone className="h-4 w-4" />
                                            {phone.display_name}
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Badge variant="outline" className="text-amber-500 border-amber-500/50 bg-amber-500/5 gap-1">
                            <Construction className="h-3 w-3" />
                            WIP
                        </Badge>
                        <div className="flex items-center gap-2 ml-2 pl-2 border-l">
                            <Timer className="h-4 w-4 text-muted-foreground" />
                            <Input
                                type="number"
                                value={cooldownMinutes}
                                onChange={(e) => setCooldownMinutes(parseInt(e.target.value) || 0)}
                                className="w-16 h-8 text-center"
                                min={0}
                            />
                            <span className="text-xs text-muted-foreground">min cooldown</span>
                        </div>
                        <div className="flex items-center gap-2 ml-2 pl-2 border-l">
                            <Users className="h-4 w-4 text-muted-foreground" />
                            <Switch
                                id="run-in-groups"
                                checked={runInGroups}
                                onCheckedChange={setRunInGroups}
                                aria-label="Rodar também em conversas de grupo"
                            />
                            <Label htmlFor="run-in-groups" className="text-xs text-muted-foreground whitespace-nowrap">
                                grupos
                            </Label>
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <Label
                            htmlFor="active-toggle"
                            className="text-sm text-muted-foreground"
                        >
                            {isActive ? (
                                <span className="flex items-center gap-1 text-green-600">
                                    <Play className="h-4 w-4" /> Ativo
                                </span>
                            ) : (
                                <span className="flex items-center gap-1">
                                    <Pause className="h-4 w-4" /> Inativo
                                </span>
                            )}
                        </Label>
                        <Switch
                            id="active-toggle"
                            checked={isActive}
                            onCheckedChange={toggleActive}
                        />
                    </div>
                </div>
            </div>

            {/* Tabs for Editor and Executions */}
            <Tabs defaultValue="editor" className="flex-1 flex flex-col overflow-hidden">
                <div className="border-b px-4">
                    <TabsList className="h-10">
                        <TabsTrigger value="editor" className="gap-2">
                            <Workflow className="h-4 w-4" />
                            Editor
                        </TabsTrigger>
                        <TabsTrigger value="executions" className="gap-2">
                            <History className="h-4 w-4" />
                            Execuções
                        </TabsTrigger>
                        {flow?.flow_data?.nodes?.some((n: Node) => n.type === "surveyNode") && (
                            <TabsTrigger value="survey-results" className="gap-2">
                                <ClipboardList className="h-4 w-4" />
                                Pesquisa
                            </TabsTrigger>
                        )}
                    </TabsList>
                </div>

                <TabsContent value="editor" className="flex-1 overflow-hidden mt-0">
                    <FlowBuilder
                        initialData={flow.flow_data}
                        onSave={handleSave}
                        saving={saving}
                        onDirtyChange={setBuilderDirty}
                    />
                </TabsContent>

                <TabsContent value="executions" className="flex-1 overflow-auto mt-0 p-4">
                    <ExecutionsPanel flowId={id!} />
                </TabsContent>

                <TabsContent value="survey-results" className="flex-1 overflow-auto mt-0 p-4">
                    <SurveyResultsPanel flowId={id!} />
                </TabsContent>
            </Tabs>

            <AlertDialog
                open={collisions !== null}
                onOpenChange={(open) => { if (!open) resolveCollision(false); }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Palavra-chave em conflito</AlertDialogTitle>
                        <AlertDialogDescription>
                            Outra automação ativa desta linha também responde a estas palavras. As duas vão
                            disparar na mesma mensagem — e um contato pode receber o conteúdo de outro fluxo.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <ul className="space-y-2 text-sm">
                        {(collisions ?? []).map((collision, index) => (
                            <li key={`${collision.flowName}-${collision.keyword}-${index}`} className="rounded-md border p-2">
                                <span className="font-medium">“{collision.keyword}”</span>
                                {collision.kind === "substring" ? " está contida em " : " é igual a "}
                                <span className="font-medium">“{collision.otherKeyword}”</span>
                                {" de "}
                                <span className="font-medium">{collision.flowName}</span>
                            </li>
                        ))}
                    </ul>
                    <AlertDialogFooter>
                        <AlertDialogCancel onClick={() => resolveCollision(false)}>Voltar e ajustar</AlertDialogCancel>
                        <AlertDialogAction onClick={() => resolveCollision(true)}>Salvar mesmo assim</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={leaveConfirm} onOpenChange={setLeaveConfirm}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Sair sem salvar?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Este fluxo tem alterações não salvas. Se você sair agora, elas serão perdidas.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Continuar editando</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => navigate("/automations")}
                        >
                            Sair sem salvar
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
