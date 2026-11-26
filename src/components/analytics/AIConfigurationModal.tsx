import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Settings, Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { supabase } from "@/integrations/supabase/client";
import { buscarConfigIa } from "@/lib/orgSecrets";

interface AIConfigurationModalProps {
    orgId: string;
    existingPrompt?: string;
    onSave?: () => void;
}

export function AIConfigurationModal({ orgId, existingPrompt, onSave }: AIConfigurationModalProps) {
    const [open, setOpen] = useState(false);
    const [apiKey, setApiKey] = useState("");
    const [prompt, setPrompt] = useState(existingPrompt || "Analise os dados fornecidos e gere insights estratégicos sobre o desempenho do atendimento, identificando tendências, pontos de melhoria e oportunidades de eficiência. Foque em métricas de volume, tempo de resposta e engajamento.");
    const [isLoading, setIsLoading] = useState(false);
    const [showKey, setShowKey] = useState(false);
    const [isFetching, setIsFetching] = useState(false);
    const [hasKey, setHasKey] = useState(false);

    useEffect(() => {
        if (open && orgId) {
            const fetchSettings = async () => {
                setIsFetching(true);
                setApiKey("");
                try {
                    const config = await buscarConfigIa(orgId);
                    if (config?.ai_insights_prompt) setPrompt(config.ai_insights_prompt);
                    setHasKey(config?.tem_chave ?? false);
                } catch (err) {
                    console.error("Error fetching AI settings:", err);
                } finally {
                    setIsFetching(false);
                }
            };
            fetchSettings();
        }
    }, [open, orgId]);

    const handleSave = async () => {
        setIsLoading(true);
        try {
            // Update Prompt (standard update). UPDATE que não casa linha (RLS) não dá erro: conferir.
            if (prompt) {
                const { data, error: promptError } = await supabase
                    .from('organizations')
                    .update({ ai_insights_prompt: prompt })
                    .eq('id', orgId)
                    .select('id');
                if (promptError) throw promptError;
                if (!data || data.length === 0) {
                    throw new Error("Você não tem permissão para alterar a configuração de IA desta organização.");
                }
            }

            // A chave nunca volta do servidor: só vai pela RPC quando o usuário digitou uma nova.
            const novaChave = apiKey.trim();
            if (novaChave) {
                const { error: keyError } = await supabase
                    .rpc('set_ai_api_key', {
                        p_org_id: orgId,
                        p_raw_key: novaChave
                    });

                if (keyError) throw keyError;
                setHasKey(true);
            }

            toast({ title: "Configurações salvas" });
            setOpen(false);
            setApiKey(""); // Clear local state
            if (onSave) onSave();
        } catch (error: unknown) {
            console.error("Error saving AI settings:", error);
            toast({
                title: "Não foi possível salvar as configurações",
                description: toUserMessage(error, "Nada foi alterado. Verifique a conexão e tente de novo."),
                variant: "destructive",
            });
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                    <Settings className="h-4 w-4" />
                    Configurar IA
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>Configuração de Inteligência Artificial</DialogTitle>
                    <DialogDescription>
                        Configure sua chave de API e o prompt para geração de insights.
                        A chave será armazenada de forma segura.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <Label htmlFor="apiKey">Chave de IA (OpenAI ou Anthropic)</Label>
                        <div className="relative">
                            <Input
                                id="apiKey"
                                type={showKey ? "text" : "password"}
                                placeholder={hasKey ? "Chave já configurada. Digite só para substituir." : "sk-... (OpenAI) ou sk-ant-... (Anthropic)"}
                                autoComplete="off"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute right-0 top-0 h-full px-3"
                                onClick={() => setShowKey(!showKey)}
                            >
                                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </Button>
                        </div>
                        <p className="text-sm text-muted-foreground">
                            {hasKey ? "Chave já configurada. Deixe em branco para mantê-la." : "Nenhuma chave configurada ainda."}
                        </p>
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="prompt">Instrução para a IA</Label>
                        <Textarea
                            id="prompt"
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            placeholder="Ex: Foque em tempo de resposta e aponte os 3 maiores gargalos"
                            className="min-h-[150px]"
                            disabled={isFetching}
                        />
                        {isFetching && <p className="text-xs text-muted-foreground">Carregando configurações…</p>}
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
                    <Button onClick={handleSave} disabled={isLoading}>
                        {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Salvar Configurações
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
