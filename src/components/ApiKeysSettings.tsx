import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Copy, Eye, EyeOff, Key, Webhook, Save, Loader2 } from "lucide-react";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toUserMessage } from "@/lib/userFacingError";
import { publicFunctionUrl } from "@/lib/runtimeConfig";

interface ApiKeyData {
  id: string;
  name: string;
  key_preview: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

interface ApiKeysSettingsProps {
  userId: string;
  organizationId?: string;
}

// Simple hash function (same as edge function)
async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateApiKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint32Array(32);
  crypto.getRandomValues(array);

  let result = 'wc_';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(array[i] % chars.length);
  }
  return result;
}

const ApiKeysSettings = ({ userId, organizationId }: ApiKeysSettingsProps) => {
  const { toast } = useToast();
  const [apiKeys, setApiKeys] = useState<ApiKeyData[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [loading, setLoading] = useState(false);
  // Primeiro fetch em voo: sem isso o painel abria em "Nenhuma chave" falso
  const [initialLoading, setInitialLoading] = useState(true);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);

  // Webhook state
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookActive, setWebhookActive] = useState(true);
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [webhookExists, setWebhookExists] = useState(false);
  const [showNewKey, setShowNewKey] = useState(false);

  useEffect(() => {
    fetchApiKeys();
    if (organizationId) {
      fetchWebhook();
    }
  }, [organizationId]);

  const fetchWebhook = async () => {
    if (!organizationId) return;

    const { data, error } = await supabase
      .from("organization_webhooks")
      .select("url, is_active")
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (data && !error) {
      setWebhookUrl((data as any).url || "");
      setWebhookActive((data as any).is_active ?? true);
      setWebhookExists(true);
    }
  };

  const handleSaveWebhook = async () => {
    if (!organizationId) {
      toast({
        title: "Organização não identificada",
        description: "Faça login novamente e tente de novo.",
        variant: "destructive",
      });
      return;
    }

    setWebhookLoading(true);

    try {
      if (webhookExists) {
        // Update existing
        const { error } = await supabase
          .from("organization_webhooks")
          .update({
            url: webhookUrl,
            is_active: webhookActive,
            updated_at: new Date().toISOString()
          })
          .eq("organization_id", organizationId);

        if (error) throw error;
      } else {
        // Insert new
        const { error } = await supabase
          .from("organization_webhooks")
          .insert({
            organization_id: organizationId,
            url: webhookUrl,
            is_active: webhookActive
          });

        if (error) throw error;
        setWebhookExists(true);
      }

      toast({
        title: "Webhook salvo",
        description: "Configuração de webhook atualizada.",
      });
    } catch (error: any) {
      toast({
        title: "Não foi possível salvar webhook",
        description: toUserMessage(error),
        variant: "destructive",
      });
    } finally {
      setWebhookLoading(false);
    }
  };

  const fetchApiKeys = async () => {
    const { data, error } = await supabase
      .from("api_keys")
      .select("id, name, key_preview, is_active, created_at, last_used_at")
      .order("created_at", { ascending: false });

    setInitialLoading(false);

    if (error) {
      console.error("Error fetching API keys:", error);
      return;
    }

    setApiKeys(data || []);
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;

    if (!organizationId) {
      toast({
        title: "Organização não identificada",
        description: "Faça login novamente e tente de novo.",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);

    const newKey = generateApiKey();
    const keyHash = await hashApiKey(newKey);
    const keyPreview = `${newKey.slice(0, 7)}...${newKey.slice(-4)}`;

    const { data, error } = await supabase
      .from("api_keys")
      .insert({
        name: newKeyName.trim(),
        key_hash: keyHash,
        key_preview: keyPreview,
        user_id: userId,
        organization_id: organizationId
      })
      .select()
      .single();

    setLoading(false);

    if (error) {
      toast({
        title: "Não foi possível criar API key",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return;
    }

    setApiKeys([data, ...apiKeys]);
    setNewKeyName("");
    setNewlyCreatedKey(newKey);
    setShowNewKey(true);

    toast({
      title: "API Key criada",
      description: "Copie a chave agora, ela não será exibida novamente.",
    });
  };

  // Excluir chave é irreversível e quebra integrações em produção: confirmação
  // com digitação do nome (antes: DELETE num clique de lixeira de 32px).
  const [deleteKeyConfirm, setDeleteKeyConfirm] = useState<{ id: string; name: string } | null>(null);
  const [deletingKey, setDeletingKey] = useState(false);

  const handleDeleteKey = async () => {
    if (!deleteKeyConfirm) return;
    setDeletingKey(true);
    const { id: keyId, name: keyName } = deleteKeyConfirm;
    const { error } = await supabase
      .from("api_keys")
      .delete()
      .eq("id", keyId);
    setDeletingKey(false);

    if (error) {
      toast({
        title: "Não foi possível excluir API key",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return;
    }

    setDeleteKeyConfirm(null);
    setApiKeys(apiKeys.filter((k) => k.id !== keyId));
    toast({
      title: "API Key excluída",
      description: `Chave "${keyName}" excluída.`,
    });
  };

  const handleToggleActive = async (keyId: string, currentState: boolean) => {
    const { error } = await supabase
      .from("api_keys")
      .update({ is_active: !currentState })
      .eq("id", keyId);

    if (error) {
      toast({
        title: "Não foi possível atualizar API key",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return;
    }

    setApiKeys(apiKeys.map(k =>
      k.id === keyId ? { ...k, is_active: !currentState } : k
    ));

    toast({
      title: currentState ? "API Key desativada" : "API Key ativada",
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({
      title: "Copiado",
      description: "API Key copiada para a área de transferência.",
    });
  };

  const baseUrl = publicFunctionUrl("echo-api");

  return (
    <div className="space-y-6">
      {/* Webhook Configuration */}
      <div className="bg-card border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Webhook className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-lg">Webhook geral</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure uma URL única para receber todos os eventos (mensagens, status, notas, etc).
        </p>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://seu-servidor.com/webhook"
              className="flex-1"
            />
            <Button
              onClick={handleSaveWebhook}
              disabled={webhookLoading || !webhookUrl.trim()}
              className="bg-primary hover:bg-primary/90 text-white"
            >
              {webhookLoading ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Salvar
            </Button>
          </div>
          <div className="flex items-center space-x-2">
            <Switch
              id="webhook-active"
              checked={webhookActive}
              onCheckedChange={setWebhookActive}
            />
            <Label htmlFor="webhook-active" className="text-sm">
              Webhook ativo
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            O webhook receberá um POST JSON com o evento (message.received, message.sent, message.status) e os dados da conversa.
          </p>
        </div>
      </div>

      {/* Create new key */}
      <div className="bg-card border rounded-xl p-6 space-y-4">
        <h3 className="font-semibold text-lg">Nova API Key</h3>
        <div className="flex gap-2">
          <Input
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Nome da chave (ex: Integração CRM)"
            className="md:max-w-md"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newKeyName.trim()) {
                handleCreateKey();
              }
            }}
          />
          <Button
            onClick={handleCreateKey}
            disabled={loading || !newKeyName.trim()}
            className="bg-primary hover:bg-primary/90 text-white"
          >
            <Plus className="w-4 h-4 mr-2" />
            Criar Chave
          </Button>
        </div>
      </div>

      {/* Show newly created key */}
      {newlyCreatedKey && (
        <div className="bg-success/10 border border-success/30 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-lg text-success">Nova chave gerada</h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowNewKey(!showNewKey)}
              className="text-success hover:bg-success/15"
              aria-label={showNewKey ? "Ocultar chave" : "Mostrar chave"}
            >
              {showNewKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </Button>
          </div>
          <div className="flex gap-2 items-center">
            <div className="flex-1 bg-card p-3 rounded-md border font-mono text-sm break-all shadow-sm">
              {showNewKey ? newlyCreatedKey : "•".repeat(60)}
            </div>
            <Button
              variant="outline"
              size="icon"
              className="h-11 w-11 shrink-0"
              onClick={() => copyToClipboard(newlyCreatedKey)}
              aria-label="Copiar chave"
            >
              <Copy className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex items-center justify-between text-xs text-success">
            <p>Copie esta chave agora. Por segurança, ela não será exibida novamente.</p>
            <Button
              variant="link"
              size="sm"
              onClick={() => setNewlyCreatedKey(null)}
              className="text-success underline underline-offset-2 [text-underline-position:from-font] [text-decoration-thickness:from-font] p-0 h-auto"
            >
              Fechar aviso
            </Button>
          </div>
        </div>
      )}

      {/* API Base URL */}
      <div className="bg-card border rounded-xl p-6 space-y-4">
        <h3 className="font-semibold text-lg">URL Base da API</h3>
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              value={baseUrl}
              readOnly
              className="bg-muted font-mono text-sm text-muted-foreground"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => copyToClipboard(baseUrl)}
              aria-label="Copiar URL base da API"
            >
              <Copy className="w-4 h-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use o header <code className="bg-muted px-1 py-0.5 rounded text-foreground">x-api-key</code> para autenticação.
          </p>
        </div>
      </div>

      {/* Existing keys */}
      <div className="bg-card border rounded-xl p-6 space-y-4">
        <h3 className="font-semibold text-lg">Chaves ativas</h3>
        <ScrollArea className="h-[300px] pr-4">
          {initialLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="flex items-center justify-between p-4 rounded-lg border">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-8 w-20" />
                </div>
              ))}
            </div>
          ) : apiKeys.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground border-2 border-dashed rounded-lg bg-muted/20">
              <Key className="w-8 h-8 mb-2 opacity-50" />
              <p>Nenhuma chave de API encontrada</p>
            </div>
          ) : (
            <div className="space-y-3">
              {apiKeys.map((key) => (
                <div
                  key={key.id}
                  className={`flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-lg border bg-card hover:shadow-sm transition-shadow duration-200 ease-out ${!key.is_active ? "opacity-60 bg-muted/50" : ""
                    }`}
                >
                  <div className="space-y-1 mb-3 sm:mb-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{key.name}</span>
                      {!key.is_active && (
                        <span className="text-2xs uppercase tracking-wider px-1.5 py-0.5 rounded bg-destructive/10 text-destructive font-bold">
                          Inativa
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
                      <span>{key.key_preview}</span>
                      <span>•</span>
                      <span>{format(new Date(key.created_at), "dd/MM/yyyy", { locale: ptBR })}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant={key.is_active ? "outline" : "default"}
                      size="sm"
                      onClick={() => handleToggleActive(key.id, key.is_active)}
                      className="h-8 text-xs"
                    >
                      {key.is_active ? "Desativar" : "Ativar"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteKeyConfirm({ id: key.id, name: key.name })}
                      aria-label={`Excluir chave ${key.name}`}
                      className="h-11 w-11 sm:h-8 sm:w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      <ConfirmDestructiveDialog
        open={deleteKeyConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteKeyConfirm(null);
        }}
        title="Excluir chave de API?"
        description={
          <>
            Toda integração usando a chave <strong>{deleteKeyConfirm?.name}</strong> vai parar de
            funcionar imediatamente. Esta ação não pode ser desfeita.
          </>
        }
        confirmText={deleteKeyConfirm?.name}
        confirmLabel="Excluir chave"
        pending={deletingKey}
        onConfirm={handleDeleteKey}
      />
    </div>
  );
};

export default ApiKeysSettings;
