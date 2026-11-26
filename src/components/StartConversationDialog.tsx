import { useState, useEffect, useRef } from "react";
import {
  ResponsiveDialog as Dialog,
  ResponsiveDialogContent as DialogContent,
  ResponsiveDialogHeader as DialogHeader,
  ResponsiveDialogFooter as DialogFooter,
  ResponsiveDialogTitle as DialogTitle,
  ResponsiveDialogDescription as DialogDescription,
} from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { extractVariables, variableContext } from "@/lib/templateBuilder";
import { useToast } from "@/hooks/use-toast";
import { checkEdgeFunctionResponseAsync } from "@/lib/utils";
import { Loader2, MessageSquarePlus, User as UserIcon, Search, FileSpreadsheet, Plus } from "lucide-react";
import { useInlineTemplateCreation } from "@/components/templates/useInlineTemplateCreation";
import TemplateMediaHeaderInput from "@/components/templates/TemplateMediaHeaderInput";
import { getTemplateHeaderFormat, buildHeaderComponent, TemplateHeaderMedia } from "@/lib/templateMedia";
import ImportConversationsDialog from "@/components/chat/ImportConversationsDialog";
import PhoneNumberInput from "@/components/phone/PhoneNumberInput";
import { PhoneCheck, phoneCheckForDigits } from "@/lib/phoneInput";
import { getLookupVariations } from "@/lib/phone";
import { avisoConversaDeOutra, buscarConversaDoTelefone } from "@/lib/conversaDoTelefone";


interface TemplateComponent {
  type: string;
  text?: string;
  example?: {
    body_text?: string[][];
  };
  buttons?: Array<{
    type: string;
    text?: string;
    url?: string;
    phone_number?: string;
  }>;
}

interface Template {
  id: string;
  name: string;
  language: string;
  status: string;
  components: TemplateComponent[];
}

interface StartConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  /** `conversationId` quando a criação toca UMA conversa (a lista refaz só ela); sem id (importação em lote), a lista refaz tudo. */
  onConversationCreated?: (conversationId?: string) => void;
  phoneNumberId?: string | null; // Meta's phone_number_id
  phoneNumberDbId?: string | null; // Database ID
  isQrConnection?: boolean; // True for QR-connected numbers (no template required)
  /**
   * Números por onde a conversa pode sair (o escopo da lista). Com mais de um o diálogo
   * pede "Enviar pelo número", e o id da Meta, o canal (template ou texto livre) e a
   * busca e criação da conversa saem do número escolhido. Sem a lista valem as props
   * `phoneNumberId`, `phoneNumberDbId` e `isQrConnection`, como no modo número.
   */
  numerosPossiveis?: readonly NumeroDeEnvio[];
  /** Número que vem marcado (o da conversa aberta), se estiver entre os possíveis; senão o primeiro. */
  numeroPreferidoId?: string | null;
}

import { useOrganization } from "@/contexts/OrganizationContext";
import { toUserMessage } from "@/lib/userFacingError";
import EmojiPicker from "@/components/EmojiPicker";
import { useIsMobile } from "@/hooks/use-mobile";
import { insertIntoField } from "@/lib/insertAtCursor";
import { numeroDeEnvio } from "@/lib/caixaConjunta";
import { SeletorNumeroDeEnvio, type NumeroDeEnvio } from "@/components/SeletorNumeroDeEnvio";

const StartConversationDialog = ({
  open,
  onOpenChange,
  userId,
  onConversationCreated,
  phoneNumberId: phoneNumberIdDaLista,
  phoneNumberDbId: phoneNumberDbIdDaLista,
  isQrConnection: isQrConnectionDaLista,
  numerosPossiveis,
  numeroPreferidoId,
}: StartConversationDialogProps) => {
  const { currentOrganization } = useOrganization();
  // O número de envio: com a lista de números possíveis, o escolhido (padrão: o da
  // conversa aberta, ou o primeiro); sem ela, o que o pai mandou. O id da Meta, o canal
  // e o id interno saem SEMPRE do mesmo número, nunca de dois diferentes.
  const [numeroEscolhidoId, setNumeroEscolhidoId] = useState<string | null>(null);
  const numeroDeEnvioAtual = numerosPossiveis?.length
    ? numeroDeEnvio(numerosPossiveis, numeroEscolhidoId, numeroPreferidoId)
    : null;
  // Com a lista (caixa conjunta), as props do fallback nunca valem: a lista da conjunta
  // não tem número único, então sem número escolhido o envio fica sem número (e Enviar
  // desabilitado) em vez de sair pelo número que a lista mandou antes.
  const comLista = numerosPossiveis !== undefined;
  const phoneNumberId = numeroDeEnvioAtual ? numeroDeEnvioAtual.metaPhoneNumberId : comLista ? null : phoneNumberIdDaLista;
  const phoneNumberDbId = numeroDeEnvioAtual ? numeroDeEnvioAtual.id : comLista ? null : phoneNumberDbIdDaLista;
  const isQrConnection = numeroDeEnvioAtual ? numeroDeEnvioAtual.connectionType === 'qr' : comLista ? false : isQrConnectionDaLista;
  const isFreeTextChannel = Boolean(isQrConnection);
  // Dígitos compostos (E.164 sem "+") vindos do PhoneNumberInput: o país é
  // escolhido no campo, nunca inferido do formato do texto.
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneCheck, setPhoneCheck] = useState<PhoneCheck>(() => phoneCheckForDigits(""));
  const [contactName, setContactName] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [parameters, setParameters] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [directMessage, setDirectMessage] = useState(""); // For QR numbers
  const directMessageRef = useRef<HTMLTextAreaElement>(null);
  const isMobile = useIsMobile();
  const [templateSearch, setTemplateSearch] = useState("");
  const [urlSuffix, setUrlSuffix] = useState("");
  const [headerMedia, setHeaderMedia] = useState<TemplateHeaderMedia | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const { toast } = useToast();


  useEffect(() => {
    if (open) {
      fetchTemplates();
      // Cada abertura parte do padrão (o número da conversa aberta), não da escolha anterior.
      setNumeroEscolhidoId(null);
    }
  }, [open]);

  useEffect(() => {
    if (selectedTemplate) {
      const count = getVariableCount(selectedTemplate);
      // O exemplo da Meta vira só placeholder: pré-preencher mandava "Maria" para o cliente real.
      setParameters(Array(count).fill(''));
      setHeaderMedia(null);
    }
  }, [selectedTemplate]);

  const headerFormat = selectedTemplate ? getTemplateHeaderFormat(selectedTemplate) : null;
  const headerMediaMissing = headerFormat !== null && !headerMedia?.link;

  // Criar na hora: quando a Meta aprova, o template entra na lista já selecionado.
  const templateCreation = useInlineTemplateCreation({
    onApproved: (template) => {
      setTemplates((prev) => [template, ...prev.filter((t) => t.id !== template.id)]);
      // Diálogo fechado ou outro template já escolhido: não troca por baixo (ia para o próximo contato).
      if (open && !selectedTemplate) setSelectedTemplate(template);
    },
  });

  const fetchTemplates = async () => {
    setIsLoading(true);
    try {
      const result = await supabase.functions.invoke('whatsapp-templates', {
        body: { organizationId: currentOrganization?.id }
      });
      const data = await checkEdgeFunctionResponseAsync(result);

      const approvedTemplates = (data?.data || []).filter(
        (t: Template) => t.status === 'APPROVED'
      );
      setTemplates(approvedTemplates);
    } catch (error) {
      console.error('Error fetching templates:', error);
      toast({
        title: "Não foi possível carregar os templates",
        description: "Verifique a conexão e tente novamente.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const getVariableCount = (template: Template): number => {
    const bodyComponent = template.components.find(c => c.type === 'BODY');
    if (!bodyComponent?.text) return 0;
    // Variável repetida ({{1}} duas vezes) é um parâmetro só.
    return extractVariables(bodyComponent.text).length;
  };

  const getBodyText = (template: Template): string => {
    const bodyComponent = template.components.find(c => c.type === 'BODY');
    return bodyComponent?.text || '';
  };

  const getExamples = (template: Template): string[] => {
    const bodyComponent = template.components.find(c => c.type === 'BODY');
    return bodyComponent?.example?.body_text?.[0] || [];
  };

  const getPreview = () => {
    if (!selectedTemplate) return '';
    let preview = getBodyText(selectedTemplate);
    parameters.forEach((param, index) => {
      preview = preview.split(`{{${index + 1}}}`).join(param || `[Variável ${index + 1}]`);
    });
    return preview;
  };

  const getButtons = (template: Template) => {
    const buttonsComponent = template.components.find(c => c.type === 'BUTTONS');
    return buttonsComponent?.buttons || [];
  };

  const getDynamicUrlButtonIndex = (template: Template): number => {
    const buttonsComponent = template.components.find(c => c.type === 'BUTTONS');
    if (!buttonsComponent?.buttons) return -1;
    return buttonsComponent.buttons.findIndex(btn => btn.type === 'URL' && btn.url?.includes('{{1}}'));
  };

  const handleSend = async () => {
    // Caixa conjunta sem número de envio (a lista ainda não chegou): nada sai sem número.
    if (comLista && !phoneNumberDbId) {
      toast({
        title: "Escolha o número de envio",
        description: "Os números ainda estão carregando. Tente de novo em instantes.",
        variant: "destructive",
      });
      return;
    }
    // For free-text channels (QR): require directMessage, for API: require template
    if (isFreeTextChannel) {
      if (!directMessage.trim() || !phoneCheck.ok) return;
    } else {
      if (!selectedTemplate || !phoneCheck.ok) return;
    }

    const formattedPhone = phoneCheck.phone;
    if (!formattedPhone) {
      toast({
        title: "Número inválido",
        description: phoneCheck.error || "Digite um número de telefone válido.",
        variant: "destructive",
      });
      return;
    }

    // O campo já entregou o número completo com o DDI do país escolhido, então
    // ele é o valor gravado e o valor enviado — sem heurística de prefixo.
    const normalizedPhone = formattedPhone;
    // Para números brasileiros isso cobre as linhas antigas gravadas com/sem o
    // 9º dígito; para os demais países devolve só os dígitos exatos.
    const phoneVariations = getLookupVariations(normalizedPhone);

    // Template validation only for template channels (Business API)
    if (!isFreeTextChannel && selectedTemplate) {
      if (headerMediaMissing) {
        toast({
          title: "Mídia do cabeçalho",
          description: "Envie a mídia do cabeçalho antes de iniciar a conversa.",
          variant: "destructive",
        });
        return;
      }
      const variableCount = getVariableCount(selectedTemplate);
      if (variableCount > 0 && parameters.some(p => !p.trim())) {
        toast({
          title: "Preencha as variáveis do template",
          description: "Todas as variáveis precisam de valor para enviar.",
          variant: "destructive",
        });
        return;
      }

      setIsSending(true);
      try {
        // Existe conversa deste telefone nesta linha? A RPC ignora a RLS e diz se
        // quem chama a enxerga: com "só quem assumiu vê", a busca direta devolvia
        // 0 linhas para a conversa de outra atendente e caía no INSERT.
        // Só individual (is_group = false): grupo tem contact_phone = jid @g.us e
        // nunca é o alvo aqui.
        let conversationId: string | undefined;
        if (phoneNumberDbId) {
          const achada = await buscarConversaDoTelefone(phoneNumberDbId, normalizedPhone);
          if (achada.tipo === 'de_outra') {
            toast({ ...avisoConversaDeOutra(achada.dono), variant: "destructive" });
            return;
          }
          if (achada.tipo === 'visivel') conversationId = achada.id;
        } else {
          // Sem número de envio não há escopo para a RPC: busca pelas linhas que a
          // RLS mostra, a mais recente primeiro (sem a ordem, o limit(1) pegava uma
          // linha arbitrária, possivelmente de OUTRO número).
          const { data: existingConvs } = await supabase
            .from('conversations')
            .select('id')
            .in('contact_phone', phoneVariations)
            .eq('is_group', false)
            .order('last_message_at', { ascending: false, nullsFirst: false })
            .limit(1);
          conversationId = existingConvs?.[0]?.id;
        }

        // Create new conversation if doesn't exist
        if (!conversationId) {
          try {
            const { data: newConv, error: convError } = await supabase
              .from('conversations')
              .insert({
                contact_phone: normalizedPhone,
                contact_name: contactName.trim() || normalizedPhone,
                whatsapp_id: normalizedPhone,
                status: 'active',
                assigned_to: userId,
                phone_number_id: phoneNumberDbId,
              })
              .select('id')
              .single();

            if (convError) {
              // Check for duplicate key error (code 23505)
              if (convError.code === '23505' && phoneNumberDbId) {
                // Outra aba/atendente criou a conversa no meio: a RPC acha a que
                // causou o conflito, mesmo que a RLS a esconda de nós.
                const conflito = await buscarConversaDoTelefone(phoneNumberDbId, normalizedPhone);
                if (conflito.tipo === 'visivel') {
                  conversationId = conflito.id;
                } else if (conflito.tipo === 'de_outra') {
                  toast({ ...avisoConversaDeOutra(conflito.dono), variant: "destructive" });
                  return;
                } else {
                  throw convError; // Should not happen if constraint violated
                }
              } else {
                throw convError;
              }
            } else {
              conversationId = newConv?.id;
            }
          } catch (err: any) {
            console.error("Error creating conversation:", err);
            toast({
              title: "Não foi possível criar conversa",
              description: toUserMessage(err),
              variant: "destructive",
            });
            setIsSending(false);
            return;
          }
        }

        // Validate conversationId exists before sending
        if (!conversationId) {
          toast({
            title: "Não foi possível criar conversa",
            description: "Verifique a conexão e tente novamente.",
            variant: "destructive",
          });
          setIsSending(false);
          return;
        }

        // Build components array for WhatsApp API
        const components: any[] = [];

        const headerComp = buildHeaderComponent(headerMedia ?? null);
        if (headerComp) {
          components.push(headerComp);
        }

        if (variableCount > 0) {
          components.push({
            type: 'body',
            parameters: parameters.map(p => ({
              type: 'text',
              text: p
            }))
          });
        }

        const dynamicUrlIndex = getDynamicUrlButtonIndex(selectedTemplate);
        if (dynamicUrlIndex !== -1 && urlSuffix.trim()) {
          components.push({
            type: 'button',
            sub_type: 'url',
            index: dynamicUrlIndex.toString(),
            parameters: [{
              type: 'text',
              text: urlSuffix.trim()
            }]
          });
        }

        // Send template message
        const sendResult = await supabase.functions.invoke('whatsapp-send-template', {
          body: {
            to: formattedPhone,
            templateName: selectedTemplate.name,
            languageCode: selectedTemplate.language,
            components,
            headerMedia: headerMedia ?? undefined,
            messageContent: getPreview(),
            conversationId,
            userId,
            phoneNumberId,
          },
        });

        await checkEdgeFunctionResponseAsync(sendResult);

        toast({
          title: "Mensagem enviada",
        });

        // Reset form
        setPhoneNumber("");
        setPhoneCheck(phoneCheckForDigits(""));
        setContactName("");
        setSelectedTemplate(null);
        setParameters([]);
        setUrlSuffix("");
        setHeaderMedia(null);
        onOpenChange(false);
        onConversationCreated?.(conversationId);
      } catch (error: any) {
        console.error('[StartConversation] Error starting/sending:', error);
        console.error('[StartConversation] Error details:', {
          message: error?.message,
          context: error?.context,
          body: error?.context?.body
        });
        const errorMessage = toUserMessage(error?.context?.body?.error ?? error);
        toast({
          title: "Não foi possível enviar mensagem",
          description: errorMessage,
          variant: "destructive",
        });
      } finally {
        setIsSending(false);
      }
    } else if (isFreeTextChannel) {
      // Free-text channel (QR): send direct message via whatsapp-send
      setIsSending(true);
      try {
        if (!phoneNumberDbId) throw new Error('Selecione um número conectado.');

        // A RPC casa pelas variações (uma linha antiga gravada sem o 9º dígito não
        // casaria com o valor de 13 e nasceria uma segunda conversa para o mesmo
        // contato) e enxerga também a conversa que a RLS esconde de quem chama.
        let conversationId: string | undefined;
        const achada = await buscarConversaDoTelefone(phoneNumberDbId, normalizedPhone);
        if (achada.tipo === 'de_outra') {
          toast({ ...avisoConversaDeOutra(achada.dono), variant: "destructive" });
          return;
        }
        if (achada.tipo === 'visivel') conversationId = achada.id;

        if (!conversationId) {
          const { data: newConv, error: convError } = await supabase
            .from('conversations')
            .insert({
              contact_phone: normalizedPhone,
              contact_name: contactName.trim() || normalizedPhone,
              whatsapp_id: normalizedPhone,
              status: 'active',
              assigned_to: userId,
              phone_number_id: phoneNumberDbId,
            })
            .select('id')
            .single();

          if (convError) {
            // Handle duplicate: a RPC acha a conversa que causou o conflito.
            if (convError.code === '23505') {
              const conflito = await buscarConversaDoTelefone(phoneNumberDbId, normalizedPhone);
              if (conflito.tipo === 'de_outra') {
                toast({ ...avisoConversaDeOutra(conflito.dono), variant: "destructive" });
                return;
              }
              if (conflito.tipo === 'visivel') conversationId = conflito.id;
            } else {
              throw convError;
            }
          } else {
            conversationId = newConv?.id;
          }
        }

        // Validate conversationId exists before sending
        if (!conversationId) {
          throw new Error('Falha ao criar conversa. Tente novamente.');
        }

        // Send via whatsapp-send (will route to QR service)
        const sendResult = await supabase.functions.invoke('whatsapp-send', {
          body: {
            to: formattedPhone,
            message: directMessage.trim(),
            conversationId,
            userId,
            phoneNumberId,
          },
        });

        await checkEdgeFunctionResponseAsync(sendResult);

        toast({
          title: "Mensagem enviada",
        });

        // Reset form
        setPhoneNumber("");
        setPhoneCheck(phoneCheckForDigits(""));
        setContactName("");
        setDirectMessage("");
        onOpenChange(false);
        onConversationCreated?.(conversationId);
      } catch (error: any) {
        console.error('Error starting QR conversation:', error);
        toast({
          title: "Não foi possível enviar mensagem",
          description: toUserMessage(error),
          variant: "destructive",
        });
      } finally {
        setIsSending(false);
      }
    }
  };

  const variableCount = selectedTemplate ? getVariableCount(selectedTemplate) : 0;
  const examples = selectedTemplate ? getExamples(selectedTemplate) : [];
  const buttons = selectedTemplate ? getButtons(selectedTemplate) : [];

  const filteredTemplates = templates.filter(template =>
    template.name.toLowerCase().includes(templateSearch.toLowerCase())
  );


  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquarePlus className="w-5 h-5" />
            Iniciar conversa
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-4 p-1">
            {/* Caixa conjunta: de qual número a conversa sai. Template e texto livre seguem este número. */}
            {numerosPossiveis && numerosPossiveis.length > 1 && numeroDeEnvioAtual && (
              <SeletorNumeroDeEnvio
                id="start-conversation-numero"
                opcoes={numerosPossiveis}
                valor={numeroDeEnvioAtual.id}
                onChange={(id) => {
                  setNumeroEscolhidoId(id);
                  // Trocar entre QR (texto livre) e API (template) troca o formulário: o template escolhido não vale mais.
                  const proximo = numerosPossiveis.find((n) => n.id === id);
                  if (proximo && (proximo.connectionType === 'qr') !== isFreeTextChannel) setSelectedTemplate(null);
                }}
              />
            )}

            {/* Phone Number */}
            <div className="space-y-2">
              <Label htmlFor="start-conversation-phone" className="text-sm font-medium">
                Número de Telefone
              </Label>
              <PhoneNumberInput
                id="start-conversation-phone"
                value={phoneNumber}
                onChange={(digits, check) => {
                  setPhoneNumber(digits);
                  setPhoneCheck(check);
                }}
                error={phoneCheck.error}
              />
              <p className="text-xs text-muted-foreground">
                Brasil: DDD + número. Para outro país, marque a opção e informe o DDI.
              </p>
            </div>

            {/* Contact Name (Optional) */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Nome do contato (opcional)</Label>
              <div className="relative">
                <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="Nome do contato (opcional)"
                  className="pl-10"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Se preenchido, será usado como nome do contato
              </p>
            </div>

            {/* Free-text input for QR OR Template Selection for Business API */}
            {isFreeTextChannel ? (
              <div className="space-y-2">
                <Label className="text-sm font-medium">Mensagem</Label>
                <Textarea
                  ref={directMessageRef}
                  value={directMessage}
                  onChange={(e) => setDirectMessage(e.target.value)}
                  placeholder="Digite sua mensagem…"
                  rows={4}
                  className="resize-none"
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    Números conectados via QR Code não precisam de template
                  </p>
                  <EmojiPicker
                    variant={isMobile ? "drawer" : "popover"}
                    onEmojiSelect={(emoji) =>
                      insertIntoField(directMessageRef.current, directMessage, emoji, setDirectMessage)
                    }
                  />
                </div>
              </div>
            ) : (
              <>
                {/* Template Selection */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-sm font-medium">Template</Label>
                    <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => templateCreation.openBuilder()}>
                      <Plus className="w-4 h-4 mr-1" aria-hidden />
                      Criar template
                    </Button>
                  </div>
                  {templateCreation.notice}
                  {isLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <>
                      {templates.length > 0 && (
                        <div className="relative mb-2">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                          <Input
                            placeholder="Buscar templates…"
                            value={templateSearch}
                            onChange={(e) => setTemplateSearch(e.target.value)}
                            className="pl-9 h-9"
                          />
                        </div>
                      )}
                      <div className="grid gap-2 max-h-40 overflow-y-auto">
                        {filteredTemplates.map((template) => (
                          <button
                            key={template.id}
                            onClick={() => setSelectedTemplate(template)}
                            className={`text-left p-3 rounded-lg border active:scale-[0.96] motion-reduce:active:scale-100 transition-[background-color,border-color,transform] duration-150 ease-out ${selectedTemplate?.id === template.id
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:border-primary/50 hover:bg-muted/50'
                              }`}
                          >
                            <span className="font-medium text-sm">{template.name}</span>
                            <span className="text-xs text-muted-foreground ml-2">
                              ({template.language})
                            </span>
                          </button>
                        ))}
                        {templates.length > 0 && filteredTemplates.length === 0 && (
                          <p className="text-sm text-muted-foreground text-center py-4">
                            Nenhum template encontrado
                          </p>
                        )}
                        {templates.length === 0 && (
                          <div className="flex flex-col items-center gap-2 py-4 text-center">
                            <p className="text-sm text-muted-foreground">Nenhum template aprovado ainda.</p>
                            <Button type="button" size="sm" onClick={() => templateCreation.openBuilder()}>
                              <Plus className="w-4 h-4 mr-1" aria-hidden />
                              Criar template
                            </Button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>


                {/* Template Preview & Parameters */}
                {selectedTemplate && (
                  <>
                    {/* Preview */}
                    <div className="bg-muted p-3 rounded-lg">
                      <Label className="text-xs text-muted-foreground mb-2 block">Prévia da mensagem</Label>
                      <p className="text-sm whitespace-pre-wrap">{getPreview()}</p>
                      {buttons.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-border/50">
                          {buttons.map((btn, idx) => (
                            <span
                              key={idx}
                              className="text-xs bg-background px-3 py-1.5 rounded-full border"
                            >
                              {btn.text}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Header media */}
                    {headerFormat && (
                      <TemplateMediaHeaderInput
                        format={headerFormat}
                        value={headerMedia}
                        onChange={setHeaderMedia}
                        organizationId={currentOrganization?.id}
                      />
                    )}

                    {/* Parameters */}
                    {variableCount > 0 && (
                      <div className="space-y-3">
                        <Label className="text-sm font-medium">Preencha as variáveis</Label>
                        {Array.from({ length: variableCount }).map((_, index) => (
                          <div key={index}>
                            {/* O trecho em volta diz o que vai ali ("Olá ___, sua reserva"). */}
                            <Label htmlFor={`start-var-${index}`} className="text-xs text-muted-foreground">
                              Variável {index + 1}
                              {variableContext(getBodyText(selectedTemplate), index + 1) && (
                                <span className="ml-1 text-foreground/70">· {variableContext(getBodyText(selectedTemplate), index + 1)}</span>
                              )}
                            </Label>
                            <Input
                              id={`start-var-${index}`}
                              value={parameters[index] || ''}
                              onChange={(e) => {
                                const newParams = [...parameters];
                                newParams[index] = e.target.value;
                                setParameters(newParams);
                              }}
                              placeholder={examples[index] ? `Ex.: ${examples[index]}` : `Valor de {{${index + 1}}}`}
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Dynamic URL Suffix */}
                    {getDynamicUrlButtonIndex(selectedTemplate) !== -1 && (
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">Final da URL (Botão)</Label>
                        <Input
                          value={urlSuffix}
                          onChange={(e) => setUrlSuffix(e.target.value)}
                          placeholder="Ex: order-123"
                        />
                        <p className="text-xs text-muted-foreground">
                          O valor que será adicionado ao final do link do botão
                        </p>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </ScrollArea>

        <div className="flex gap-2 justify-between items-center mt-4">
          <Button
            variant="outline"
            onClick={() => setImportOpen(true)}
            disabled={!phoneNumberDbId || isSending}
            title={!phoneNumberDbId ? "Selecione um número conectado" : undefined}
          >
            <FileSpreadsheet className="w-4 h-4 mr-1" />
            Importar CSV
          </Button>
          <div className="flex gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={handleSend}
            disabled={
              !phoneCheck.ok ||
              isSending ||
              (comLista && !phoneNumberDbId) ||
              (isFreeTextChannel ? !directMessage.trim() : (!selectedTemplate || headerMediaMissing || (variableCount > 0 && parameters.some(p => !p.trim())) || (getDynamicUrlButtonIndex(selectedTemplate) !== -1 && !urlSuffix.trim())))
            }
          >
            {isSending ? (
              <>
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                Enviando…
              </>
            ) : (
              'Enviar'
            )}
          </Button>
          </div>
        </div>

        <ImportConversationsDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          userId={userId}
          phoneNumberDbId={phoneNumberDbId}
          onImported={() => {
            onConversationCreated?.();
            setImportOpen(false);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
    {/* Fora do Dialog pai: no celular não vira um Drawer dentro de outro. */}
    {templateCreation.dialog}
    </>
  );
};

export default StartConversationDialog;
