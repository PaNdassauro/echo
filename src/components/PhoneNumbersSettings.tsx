import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Trash2, Plus, Phone, MessageSquare, ChevronDown, ChevronUp, QrCode, Building2, Instagram } from "lucide-react";
import { IdCopyButton } from "@/components/ui/id-copy-button";
import { HuePicker, HuePickerPopover } from "@/components/ui/hue-picker";
import { cn } from "@/lib/utils";
import QRCodeConnect from "@/components/QRCodeConnect";
import InstagramConnections from "@/components/InstagramConnections";
import SectorIsolationSwitch from "@/components/settings/SectorIsolationSwitch";
import { toUserMessage } from "@/lib/userFacingError";
import { invalidarNumerosAcessiveis } from "@/hooks/useAccessiblePhoneNumbers";

interface PhoneNumber {
  id: string;
  phone_number_id: string;
  display_name: string;
  phone_number: string;
  is_active: boolean;
  theme_hue: number | null;
  auto_reply_message: string | null;
  append_agent_name: boolean;
  sector_isolation_enabled: boolean;
  sector_follows_owner: boolean;
  typing_indicator_enabled: boolean;
  send_read_receipts: boolean;
}

const PhoneNumbersSettings = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { currentOrganization, isLoading: isOrgLoading } = useOrganization();
  const [searchParams] = useSearchParams();
  // Volta do login do Instagram (?instagram=…) abre direto na aba Instagram.
  const [abaInicial] = useState(() => (searchParams.has("instagram") ? "instagram" : "qr_code"));
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPhoneNumberId, setNewPhoneNumberId] = useState("");
  const [newPhoneNumber, setNewPhoneNumber] = useState("");
  const [newThemeHue, setNewThemeHue] = useState(176);
  const [isAdding, setIsAdding] = useState(false);
  const [expandedPhoneId, setExpandedPhoneId] = useState<string | null>(null);
  const [editingAutoReply, setEditingAutoReply] = useState<Record<string, string>>({});

  // Primeiro fetch em voo: sem isso o painel abria em "Nenhum número" falso
  const [initialLoading, setInitialLoading] = useState(true);

  const fetchPhoneNumbers = async () => {
    if (!currentOrganization) {
      // Contexto resolvido sem org: sai do skeleton para o vazio real
      if (!isOrgLoading) setInitialLoading(false);
      return;
    }

    // Explicit columns — keep credentials/secrets out of the client.
    const { data, error } = await supabase
      .from("phone_numbers")
      .select("id, phone_number_id, display_name, phone_number, is_active, theme_hue, auto_reply_message, append_agent_name, sector_isolation_enabled, sector_follows_owner, typing_indicator_enabled, send_read_receipts, connection_type")
      .eq("organization_id", currentOrganization.id)
      .order("display_name");

    setInitialLoading(false);

    if (error) {
      console.error("Error fetching phone numbers:", error);
      return;
    }

    // Business API tab: only Meta numbers. Default connection_type is 'business_api';
    // exclude QR ('qr') which lives in its own tab.
    setPhoneNumbers(
      (data ?? []).filter((p) => p.connection_type !== 'qr')
    );
  };

  // Efeito único, keyed no id da org (o objeto muda de identidade a cada render
  // do contexto — com ele nas deps, refetch redundante em cascata)
  useEffect(() => {
    fetchPhoneNumbers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrganization?.id, isOrgLoading]);

  // O Dashboard e os diálogos leem nome, cor, canal e isolamento dos números de
  // um mapa próprio (React Query). Depois de mexer numa linha, invalida o mapa
  // para a próxima leitura buscar de novo. O switch de isolamento por setor
  // invalida sozinho.
  const invalidateAccessibleNumbers = () => invalidarNumerosAcessiveis(queryClient);

  const handleAdd = async () => {
    if (!newDisplayName.trim() || !newPhoneNumberId.trim() || !newPhoneNumber.trim()) {
      toast({
        title: "Campos obrigatórios",
        description: "Preencha todos os campos",
        variant: "destructive",
      });
      return;
    }

    const { error } = await supabase.from("phone_numbers").insert({
      display_name: newDisplayName.trim(),
      phone_number_id: newPhoneNumberId.trim(),
      phone_number: newPhoneNumber.trim(),
      theme_hue: newThemeHue,
      organization_id: currentOrganization?.id
    });

    if (error) {
      toast({
        title: "Não foi possível adicionar número",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return;
    }

    setNewDisplayName("");
    setNewPhoneNumberId("");
    setNewPhoneNumber("");
    setNewThemeHue(176);
    setIsAdding(false);
    fetchPhoneNumbers();
    invalidateAccessibleNumbers();

    toast({
      title: "Número adicionado",
      description: "O número foi adicionado",
    });
  };

  const handleChangeTheme = async (id: string, hue: number) => {
    const { error } = await supabase
      .from("phone_numbers")
      .update({ theme_hue: hue })
      .eq("id", id);

    if (error) {
      toast({
        title: "Não foi possível atualizar cor",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return;
    }

    fetchPhoneNumbers();
    invalidateAccessibleNumbers();
  };

  const handleToggleAppendAgentName = async (id: string, checked: boolean) => {
    setPhoneNumbers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, append_agent_name: checked } : p))
    );

    const { error } = await (supabase
      .from("phone_numbers")
      .update({ append_agent_name: checked } as any)
      .eq("id", id) as any);

    if (error) {
      toast({
        title: "Não foi possível atualizar configuração",
        description: toUserMessage(error),
        variant: "destructive",
      });
      fetchPhoneNumbers();
      return;
    }

    invalidateAccessibleNumbers();
    toast({
      title: "Configuração atualizada",
      description: `Identificação de agente ${checked ? "ativada" : "desativada"}`,
    });
  };

  const handleToggleReadReceipts = async (id: string, checked: boolean) => {
    setPhoneNumbers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, send_read_receipts: checked } : p))
    );

    const { error } = await supabase
      .from("phone_numbers")
      .update({ send_read_receipts: checked })
      .eq("id", id);

    if (error) {
      toast({
        title: "Não foi possível atualizar configuração",
        description: toUserMessage(error),
        variant: "destructive",
      });
      fetchPhoneNumbers();
      return;
    }

    invalidateAccessibleNumbers();
    toast({
      title: "Configuração atualizada",
      description: `Confirmação de leitura ${checked ? "ativada" : "desativada"}`,
    });
  };

  const handleToggleTypingIndicator = async (id: string, checked: boolean) => {
    setPhoneNumbers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, typing_indicator_enabled: checked } : p))
    );

    const { error } = await supabase
      .from("phone_numbers")
      .update({ typing_indicator_enabled: checked })
      .eq("id", id);

    if (error) {
      toast({
        title: "Não foi possível atualizar configuração",
        description: toUserMessage(error),
        variant: "destructive",
      });
      fetchPhoneNumbers();
      return;
    }

    invalidateAccessibleNumbers();
    toast({
      title: "Configuração atualizada",
      description: `Indicador de digitação ${checked ? "ativado" : "desativado"}`,
    });
  };

  const handleToggleActive = async (id: string, currentActive: boolean) => {
    const { error } = await supabase
      .from("phone_numbers")
      .update({ is_active: !currentActive })
      .eq("id", id);

    if (error) {
      toast({
        title: "Não foi possível atualizar número",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return;
    }

    fetchPhoneNumbers();
    invalidateAccessibleNumbers();
  };

  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (id: string) => {
    setDeleting(true);
    const { error } = await supabase
      .from("phone_numbers")
      .delete()
      .eq("id", id);

    if (error) {
      setDeleting(false);
      toast({
        title: "Não foi possível remover número",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return;
    }
    setDeleting(false);
    setDeleteConfirm(null);

    fetchPhoneNumbers();
    invalidateAccessibleNumbers();

    toast({
      title: "Número removido",
      description: "O número foi removido",
    });
  };

  const handleSaveAutoReply = async (id: string) => {
    const message = editingAutoReply[id]?.trim() || null;

    const { error } = await supabase
      .from("phone_numbers")
      .update({ auto_reply_message: message } as any)
      .eq("id", id);

    if (error) {
      toast({
        title: "Não foi possível salvar resposta automática",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return;
    }

    setExpandedPhoneId(null);
    fetchPhoneNumbers();
    invalidateAccessibleNumbers();

    toast({
      title: "Resposta automática salva",
      description: message ? "A mensagem será enviada automaticamente" : "Resposta automática desativada",
    });
  };

  return (
    <Tabs defaultValue={abaInicial} className="w-full">
      <TabsList className="grid w-full grid-cols-3 mb-4">
        <TabsTrigger value="qr_code" className="flex items-center gap-2">
          <QrCode className="w-4 h-4" />
          QR Code
        </TabsTrigger>
        <TabsTrigger value="business_api" className="flex items-center gap-2">
          <Building2 className="w-4 h-4" />
          Business API
        </TabsTrigger>
        <TabsTrigger value="instagram" className="flex items-center gap-2">
          <Instagram className="w-4 h-4" />
          Instagram
        </TabsTrigger>
      </TabsList>

      <TabsContent value="instagram">
        <InstagramConnections />
      </TabsContent>

      <TabsContent value="qr_code">
        <QRCodeConnect />
      </TabsContent>

      <TabsContent value="business_api">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Números de WhatsApp (Business API)</h3>
            {!isAdding && (
              <Button size="sm" variant="outline" onClick={() => setIsAdding(true)}>
                <Plus />
                Adicionar
              </Button>
            )}
          </div>

          {isAdding && (
            <div className="p-4 border rounded-lg space-y-3 bg-muted/50">
              <div className="space-y-2">
                <Label htmlFor="displayName">Nome de exibição</Label>
                <Input
                  id="displayName"
                  placeholder="Ex: Vendas, Suporte…"
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phoneNumberId">Phone Number ID (Meta)</Label>
                <Input
                  id="phoneNumberId"
                  placeholder="ID do número no Meta Business"
                  value={newPhoneNumberId}
                  onChange={(e) => setNewPhoneNumberId(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phoneNumber">Número de telefone</Label>
                <Input
                  id="phoneNumber"
                  placeholder="+55 11 99999-9999"
                  value={newPhoneNumber}
                  onChange={(e) => setNewPhoneNumber(e.target.value)}
                />
              </div>
              <HuePicker value={newThemeHue} onChange={setNewThemeHue} />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAdd}>
                  Salvar
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setIsAdding(false);
                    setNewDisplayName("");
                    setNewPhoneNumberId("");
                    setNewPhoneNumber("");
                    setNewThemeHue(176);
                  }}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          )}

          {initialLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {Array.from({ length: 2 }, (_, i) => (
                <Skeleton key={i} className="h-28 rounded-lg" />
              ))}
            </div>
          ) : phoneNumbers.length === 0 && !isAdding ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Nenhum número cadastrado
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {phoneNumbers.map((phone, index) => {
                const isExpanded = expandedPhoneId === phone.id;
                const hasAutoReply = Boolean((phone as { auto_reply_message?: string | null }).auto_reply_message);
                return (
                  <div
                    key={phone.id}
                    className={cn(
                      "border rounded-lg p-4 flex flex-col gap-3 bg-card",
                      "transition-[box-shadow] duration-200 ease-out",
                      "animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-backwards",
                      isExpanded && "col-span-full ring-1 ring-primary/30",
                    )}
                    style={{ animationDelay: `${Math.min(index, 8) * 40}ms`, animationDuration: "260ms" }}
                  >
                    {/* Header: color picker + name + copy id + auto badge */}
                    <div className="flex items-start gap-3">
                      <HuePickerPopover
                        value={phone.theme_hue ?? 176}
                        onChange={(hue) => handleChangeTheme(phone.id, hue)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="font-medium text-sm truncate" title={phone.display_name}>{phone.display_name}</p>
                          <IdCopyButton id={phone.id} label="Internal ID" className="h-4 w-4" />
                          {hasAutoReply && (
                            <span className="text-2xs bg-primary/10 text-primary px-1.5 py-0.5 rounded flex items-center gap-1">
                              <MessageSquare className="w-3 h-3" />
                              Auto
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Body: phone number + meta id */}
                    <div className="text-xs text-muted-foreground space-y-1 min-w-0">
                      <p className="truncate" title={phone.phone_number}>{phone.phone_number}</p>
                      <div className="flex items-center gap-1 min-w-0">
                        <span className="truncate" title={phone.phone_number_id}>Meta: {phone.phone_number_id}</span>
                        <IdCopyButton id={phone.phone_number_id} label="Meta Phone ID" className="h-3 w-3 shrink-0" />
                      </div>
                    </div>

                    {/* Footer actions */}
                    <div className="flex items-center justify-between pt-3 border-t mt-auto">
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`active-${phone.id}`} className="text-xs">
                          Ativo
                        </Label>
                        <Switch
                          id={`active-${phone.id}`}
                          checked={phone.is_active}
                          onCheckedChange={() =>
                            handleToggleActive(phone.id, phone.is_active)
                          }
                        />
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 transition-transform duration-150 ease-out active:scale-[0.96]"
                          onClick={() => {
                            if (isExpanded) {
                              setExpandedPhoneId(null);
                            } else {
                              setExpandedPhoneId(phone.id);
                              setEditingAutoReply(prev => ({
                                ...prev,
                                [phone.id]: (phone as { auto_reply_message?: string | null }).auto_reply_message || ''
                              }));
                            }
                          }}
                          aria-label={isExpanded ? "Fechar configurações" : "Abrir configurações"}
                        >
                          {isExpanded ? (
                            <ChevronUp className="w-4 h-4" />
                          ) : (
                            <ChevronDown className="w-4 h-4" />
                          )}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-destructive transition-transform duration-150 ease-out active:scale-[0.96]"
                          onClick={() => setDeleteConfirm({ id: phone.id, label: phone.display_name || phone.phone_number })}
                          aria-label="Remover número"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>

                    {/* Expanded configuration panel — grid-rows trick for smooth height animation */}
                    <div
                      className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
                      style={{
                        gridTemplateRows: isExpanded ? "1fr" : "0fr",
                        opacity: isExpanded ? 1 : 0,
                      }}
                      aria-hidden={!isExpanded}
                    >
                      <div className="overflow-hidden min-h-0">
                        <div className="pt-3 border-t space-y-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-0.5">
                              <Label htmlFor={`append-agent-${phone.id}`} className="text-sm">
                                Identificar agente
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Adiciona o nome do agente no topo de cada mensagem enviada (ex: *Nome*: mensagem).
                              </p>
                            </div>
                            <Switch
                              id={`append-agent-${phone.id}`}
                              checked={phone.append_agent_name}
                              onCheckedChange={(checked) =>
                                handleToggleAppendAgentName(phone.id, checked)
                              }
                              tabIndex={isExpanded ? 0 : -1}
                            />
                          </div>

                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-0.5">
                              <Label htmlFor={`typing-indicator-${phone.id}`} className="text-sm">
                                Indicador de &quot;digitando&quot;
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Mostra &quot;digitando…&quot; no WhatsApp do cliente enquanto o atendente digita ou responde (Meta Cloud API).
                              </p>
                            </div>
                            <Switch
                              id={`typing-indicator-${phone.id}`}
                              checked={phone.typing_indicator_enabled || false}
                              onCheckedChange={(checked) =>
                                handleToggleTypingIndicator(phone.id, checked)
                              }
                              tabIndex={isExpanded ? 0 : -1}
                            />
                          </div>

                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-0.5">
                              <Label htmlFor={`read-receipts-${phone.id}`} className="text-sm">
                                Confirmação de leitura
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Abrir a conversa no painel envia o tique azul ao cliente. Desligado, a leitura fica invisível para ele.
                              </p>
                            </div>
                            <Switch
                              id={`read-receipts-${phone.id}`}
                              checked={phone.send_read_receipts || false}
                              onCheckedChange={(checked) =>
                                handleToggleReadReceipts(phone.id, checked)
                              }
                              tabIndex={isExpanded ? 0 : -1}
                            />
                          </div>


                          <SectorIsolationSwitch
                            phoneNumberId={phone.id}
                            enabled={phone.sector_isolation_enabled}
                            followsOwner={phone.sector_follows_owner}
                            onOptimisticChange={(patch) =>
                              setPhoneNumbers((prev) =>
                                prev.map((p) => (p.id === phone.id ? { ...p, ...patch } : p))
                              )
                            }
                            onFailure={fetchPhoneNumbers}
                            tabIndex={isExpanded ? 0 : -1}
                          />

                          <Label className="flex items-center gap-2">
                            <MessageSquare className="w-4 h-4" />
                            Resposta Automatica
                          </Label>
                          <Textarea
                            placeholder="Digite a mensagem automatica que sera enviada quando um cliente enviar uma mensagem. Deixe em branco para desativar."
                            value={editingAutoReply[phone.id] || ''}
                            onChange={(e) => setEditingAutoReply(prev => ({
                              ...prev,
                              [phone.id]: e.target.value
                            }))}
                            rows={3}
                            tabIndex={isExpanded ? 0 : -1}
                          />
                          <p className="text-xs text-muted-foreground">
                            Esta mensagem sera enviada automaticamente quando alguem enviar uma mensagem para este numero.
                          </p>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleSaveAutoReply(phone.id)}
                              tabIndex={isExpanded ? 0 : -1}
                            >
                              Salvar
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setExpandedPhoneId(null)}
                              tabIndex={isExpanded ? 0 : -1}
                            >
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </TabsContent>

      <ConfirmDestructiveDialog
        open={deleteConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirm(null);
        }}
        title="Remover número?"
        description={
          <>
            Você está prestes a remover <strong>{deleteConfirm?.label}</strong>. Isso desconecta o
            WhatsApp e apaga o número permanentemente. Esta ação não pode ser desfeita.
          </>
        }
        confirmLabel="Remover número"
        pending={deleting}
        onConfirm={() => {
          if (deleteConfirm) void handleDelete(deleteConfirm.id);
        }}
      />
    </Tabs>
  );
};

export default PhoneNumbersSettings;
