
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useOrganization } from "@/contexts/OrganizationContext";
import { supabase } from "@/integrations/supabase/client";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { buscarConfigWhatsapp } from "@/lib/orgSecrets";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, CheckCircle, AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toUserMessage } from "@/lib/userFacingError";
import { publicFunctionUrl } from "@/lib/runtimeConfig";

export function IntegrationSettings() {
    const { currentOrganization, isLoading: orgLoading } = useOrganization();
    const { toast } = useToast();
    const [loading, setLoading] = useState(false);

    // Form State
    const [wabaId, setWabaId] = useState("");
    const [appId, setAppId] = useState("");
    const [accessToken, setAccessToken] = useState("");
    const [hasCredentials, setHasCredentials] = useState(false);

    useEffect(() => {
        setAccessToken("");
        setHasCredentials(false);
        if (currentOrganization?.id) {
            fetchCredentials();
        }
    }, [currentOrganization?.id]);

    const fetchCredentials = async () => {
        if (!currentOrganization?.id) return;

        try {
            const config = await buscarConfigWhatsapp(currentOrganization.id);
            setWabaId(config?.whatsapp_waba_id ?? "");
            setAppId(config?.whatsapp_app_id ?? "");
            setHasCredentials(config?.tem_token ?? false);
        } catch (error) {
            console.error("Error fetching credentials:", error);
        }
    };

    const handleSave = async () => {
        if (!currentOrganization?.id) return;
        setLoading(true);

        try {
            if (!wabaId) {
                toast({
                    title: "Informe o ID da WABA",
                    description: "O campo é obrigatório para salvar as credenciais.",
                    variant: "destructive"
                });
                setLoading(false);
                return;
            }

            const updates: TablesUpdate<"organizations"> = {
                whatsapp_waba_id: wabaId,
                whatsapp_app_id: appId.trim() || null,
                updated_at: new Date().toISOString()
            };

            // O token nunca volta do servidor: só vai no UPDATE quando o usuário digitou um novo.
            const novoToken = accessToken.trim();
            if (novoToken) {
                updates.whatsapp_access_token = novoToken;
            }

            // UPDATE que não casa linha (RLS) não dá erro: conferir quantas voltaram.
            const { data, error } = await supabase
                .from('organizations')
                .update(updates)
                .eq('id', currentOrganization.id)
                .select('id');

            if (error) throw error;
            if (!data || data.length === 0) {
                throw new Error("Você não tem permissão para alterar as credenciais desta organização.");
            }

            toast({
                title: "Sucesso",
                description: "Credenciais do WhatsApp salvas.",
            });
            if (novoToken) {
                setHasCredentials(true);
                setAccessToken("");
            }
        } catch (error: unknown) {
            console.error("Error saving credentials:", error);
            toast({
                title: "Não foi possível salvar as credenciais",
                description: toUserMessage(error),
                variant: "destructive"
            });
        } finally {
            setLoading(false);
        }
    };

    if (orgLoading) {
        return <div className="flex justify-center p-8"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
    }

    if (!currentOrganization) {
        return <Alert><AlertDescription>Selecione uma organização para configurar a integração.</AlertDescription></Alert>;
    }

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-2xl font-semibold">Integração WhatsApp</h2>
                <p className="text-sm text-muted-foreground">Configure as credenciais da API do WhatsApp Business.</p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Credenciais da API</CardTitle>
                    <CardDescription>
                        Insira o ID da sua Conta do WhatsApp Business (WABA) e o Token de Acesso Permanente.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {!hasCredentials && (
                        <Alert variant="destructive" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/20">
                            <AlertCircle className="h-4 w-4" />
                            <AlertTitle>Configuração pendente</AlertTitle>
                            <AlertDescription>
                                Sua organização ainda não tem credenciais configuradas. O envio de mensagens não funcionará.
                            </AlertDescription>
                        </Alert>
                    )}

                    <div className="space-y-2">
                        <Label htmlFor="wabaId">WhatsApp Business Account ID (WABA ID)</Label>
                        <Input
                            id="wabaId"
                            placeholder="Ex: 100500…"
                            value={wabaId}
                            onChange={(e) => setWabaId(e.target.value)}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="token">Token de acesso (sistema)</Label>
                        <Input
                            id="token"
                            type="password"
                            placeholder={hasCredentials ? "Já configurado. Digite só para substituir." : "Ex: EAAG…"}
                            autoComplete="off"
                            value={accessToken}
                            onChange={(e) => setAccessToken(e.target.value)}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="appId">Meta App ID (opcional)</Label>
                        <Input
                            id="appId"
                            placeholder="Ex: 1234567890123456"
                            value={appId}
                            onChange={(e) => setAppId(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                            Necessário apenas para criar/editar templates com header de mídia (imagem, vídeo, documento).
                        </p>
                    </div>
                </CardContent>
                <CardFooter className="flex justify-between items-center border-t px-6 py-4 bg-muted/20">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {hasCredentials && (
                            <>
                                <CheckCircle className="w-4 h-4 text-green-500" />
                                <span>Configurado</span>
                            </>
                        )}
                    </div>
                    <Button onClick={handleSave} disabled={loading} size="sm">
                        {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                        Salvar
                    </Button>
                </CardFooter>
            </Card>

            <Card className="bg-muted/30">
                <CardHeader>
                    <CardTitle className="text-sm font-medium">Webhook URL</CardTitle>
                </CardHeader>
                <CardContent>
                    <code className="block bg-background p-2 rounded border text-xs font-mono">
                        {publicFunctionUrl("whatsapp-webhook")}
                    </code>
                    <p className="text-xs text-muted-foreground mt-2">
                        Configure esta URL no seu App no painel da Meta para receber mensagens.
                    </p>
                </CardContent>
            </Card>
        </div>
    );
}
