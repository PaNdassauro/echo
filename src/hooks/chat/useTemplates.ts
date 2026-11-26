import { useState, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { extractVariables, fillVariables } from "@/lib/templateBuilder";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { checkEdgeFunctionResponseAsync } from "@/lib/utils";
import { buildHeaderComponent, TemplateHeaderMedia } from "@/lib/templateMedia";

// === TYPES ===

export interface TemplateButton {
  type: string;
  text?: string;
  url?: string;
  phone_number?: string;
  flow_id?: string;
  flow_action?: string;
  navigate_screen?: string;
}

export interface TemplateComponent {
  type: string;
  text?: string;
  format?: string;
  example?: {
    body_text?: string[][];
    header_text?: string[];
  };
  buttons?: TemplateButton[];
}

export interface Template {
  id: string;
  name: string;
  language: string;
  status: string;
  components: TemplateComponent[];
}

interface UseTemplatesOptions {
  organizationId: string | null;
  phoneNumberId: string | null;
}

interface SendTemplateParams {
  template: Template;
  parameters: string[];
  buttonParameters?: string[];
  headerMedia?: TemplateHeaderMedia | null;
  conversationId: string;
  contactPhone: string;
  userId: string;
  onOptimisticMessage: (message: any) => void;
  onMessageUpdate: (tempId: string, updates: any) => void;
  onMessageRemove: (tempId: string) => void;
  onSuccess?: () => void;
}

interface SendFlowTemplateParams {
  template: Template;
  bodyParameters?: string[];
  conversationId: string;
  contactPhone: string;
  phoneNumberDbId: string | null;
  phoneNumberId: string | null;
  userId: string;
  onSuccess?: () => void;
}

/**
 * Hook for managing WhatsApp templates (regular and flow templates)
 */
export function useTemplates({ organizationId, phoneNumberId }: UseTemplatesOptions) {
  const { toast } = useToast();

  // Regular templates state
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateSearch, setTemplateSearch] = useState("");

  // Flow templates state (templates with flow buttons)
  const [flowTemplates, setFlowTemplates] = useState<Template[]>([]);
  const [loadingFlowTemplates, setLoadingFlowTemplates] = useState(false);
  const [flowTemplatesOpen, setFlowTemplatesOpen] = useState(false);
  const [selectedFlowTemplate, setSelectedFlowTemplate] = useState<Template | null>(null);
  const [flowTemplateDialogOpen, setFlowTemplateDialogOpen] = useState(false);
  const [flowTemplateSearch, setFlowTemplateSearch] = useState("");
  const [flowTemplateParams, setFlowTemplateParams] = useState<string[]>([]);

  // === HELPERS ===

  const hasFlowButton = useCallback((template: Template): boolean => {
    return template.components.some(comp =>
      comp.type === 'BUTTONS' && comp.buttons?.some(btn => btn.type === 'FLOW')
    );
  }, []);

  const getVariableCount = useCallback((template: Template): number => {
    const bodyComponent = template.components.find(c => c.type === 'BODY');
    if (!bodyComponent?.text) return 0;
    // Variável repetida ({{1}} duas vezes) é um parâmetro só.
    return extractVariables(bodyComponent.text).length;
  }, []);

  const getTemplatePreview = useCallback((template: Template, params: string[]): string => {
    const bodyComponent = template.components.find(c => c.type === 'BODY');
    if (!bodyComponent?.text) return template.name;

    let text = bodyComponent.text;
    params.forEach((param, index) => {
      text = text.split(`{{${index + 1}}}`).join(param || `{{${index + 1}}}`);
    });
    return text;
  }, []);

  // === FETCH FUNCTIONS ===

  const fetchTemplates = useCallback(async () => {
    // Já carregada: mostra o que tem e atualiza em silêncio (template aprovado
    // depois, em outra tela, aparecia só recarregando a página).
    const silent = templates.length > 0;

    setTemplateSearch("");
    if (!silent) setLoadingTemplates(true);
    try {
      const result = await supabase.functions.invoke('whatsapp-templates', {
        body: { organizationId, phoneNumberId }
      });

      const data = await checkEdgeFunctionResponseAsync(result);
      // Só aprovado envia: pendente e recusado davam erro da Meta na hora do envio.
      setTemplates((data?.data || []).filter((t: Template) => t.status === 'APPROVED'));
    } catch (error: any) {
      console.error("Error fetching templates:", error);
      if (silent) return;
      toast({
        title: "Não foi possível carregar os templates",
        description: toUserMessage(error, "Verifique a conexão e abra o seletor de novo."),
        variant: "destructive",
      });
    } finally {
      setLoadingTemplates(false);
    }
  }, [organizationId, phoneNumberId, templates.length, toast]);

  const fetchFlowTemplates = useCallback(async () => {
    if (flowTemplates.length > 0) return; // Already loaded

    setFlowTemplateSearch("");
    setLoadingFlowTemplates(true);
    try {
      const result = await supabase.functions.invoke('whatsapp-templates', {
        body: { organizationId, phoneNumberId }
      });

      const data = await checkEdgeFunctionResponseAsync(result);
      const templatesWithFlows = (data?.data || []).filter((t: Template) => hasFlowButton(t));
      setFlowTemplates(templatesWithFlows);
    } catch (error: any) {
      console.error("Error fetching flow templates:", error);
      toast({
        title: "Não foi possível carregar os templates com formulário",
        description: toUserMessage(error, "Verifique a conexão e abra o seletor de novo."),
        variant: "destructive",
      });
    } finally {
      setLoadingFlowTemplates(false);
    }
  }, [organizationId, phoneNumberId, flowTemplates.length, hasFlowButton, toast]);

  // === SELECTION HANDLERS ===

  /** Template criado na hora e já aprovado: entra na lista sem refazer o fetch. */
  const upsertTemplate = useCallback((template: Template) => {
    setTemplates((prev) => [template, ...prev.filter((t) => t.id !== template.id)]);
  }, []);

  const selectTemplate = useCallback((template: Template) => {
    setSelectedTemplate(template);
    setTemplatesOpen(false);
    setTemplateDialogOpen(true);
  }, []);

  const selectFlowTemplate = useCallback((template: Template) => {
    setSelectedFlowTemplate(template);
    setFlowTemplatesOpen(false);

    const varCount = getVariableCount(template);
    setFlowTemplateParams(Array(varCount).fill(''));
    setFlowTemplateDialogOpen(true);
  }, [getVariableCount]);

  // === SEND FUNCTIONS ===

  const sendTemplate = useCallback(async ({
    template,
    parameters,
    buttonParameters = [],
    headerMedia,
    conversationId,
    contactPhone,
    userId,
    onOptimisticMessage,
    onMessageUpdate,
    onMessageRemove,
    onSuccess,
  }: SendTemplateParams) => {
    const tempId = `temp-${Date.now()}`;
    const bodyComponent = template.components.find(c => c.type === 'BODY');
    const buttonsComponent = template.components.find(c => c.type === 'BUTTONS');

    let messageContent = bodyComponent?.text || template.name;

    // Fill in parameters in preview (todas as ocorrências: {{1}} repetido ficava cru na bolha)
    messageContent = fillVariables(messageContent, parameters);

    // Add buttons to message content if present
    if (buttonsComponent && Array.isArray((buttonsComponent as any).buttons)) {
      const buttons = (buttonsComponent as any).buttons as Array<{ type: string; text: string; url?: string; phone_number?: string }>;
      if (buttons.length > 0) {
        // buttonParameters segue só os links dinâmicos, não a posição entre todos os botões.
        let dynamicIdx = 0;
        messageContent += '\n\n---BUTTONS---\n' + buttons.map((btn) => {
          if (btn.type === 'URL' && btn.url) {
            let url = btn.url;
            if (url.includes('{{')) {
              const suffix = buttonParameters[dynamicIdx++];
              if (suffix) url = url.replace(/\{\{\d+\}\}/g, suffix);
            }
            return `[URL:${url}]${btn.text}`;
          } else if (btn.type === 'PHONE_NUMBER' && btn.phone_number) {
            return `[PHONE:${btn.phone_number}]${btn.text}`;
          } else {
            return `[QUICK]${btn.text}`;
          }
        }).join('\n');
      }
    }

    // Add optimistic message
    onOptimisticMessage({
      id: tempId,
      content: messageContent,
      direction: "outbound",
      created_at: new Date().toISOString(),
      sent_by: userId,
      status: "sending",
    });

    try {
      // Build components array for WhatsApp API.
      // Note: the Edge Function authoritatively rebuilds the header from
      // `headerMedia` (sent separately below), so we don't *need* to also
      // include it here — but including it keeps the payload sane on inspection.
      const components: any[] = [];

      const headerComponent = buildHeaderComponent(headerMedia ?? null);
      if (headerComponent) {
        components.push(headerComponent);
      }

      if (parameters.length > 0) {
        components.push({
          type: "body",
          parameters: parameters.map(text => ({ type: "text", text }))
        });
      }

      // Add button parameters for URL buttons with dynamic params
      if (buttonsComponent && Array.isArray((buttonsComponent as any).buttons)) {
        const buttons = (buttonsComponent as any).buttons as Array<{ type: string; url?: string }>;
        let buttonParamIdx = 0;
        buttons.forEach((btn, index) => {
          if (btn.type === 'URL' && btn.url?.includes('{{')) {
            components.push({
              type: "button",
              sub_type: "url",
              index: String(index),
              parameters: [{ type: "text", text: buttonParameters[buttonParamIdx] || '' }]
            });
            buttonParamIdx++;
          }
        });
      }

      const result = await supabase.functions.invoke('whatsapp-send-template', {
        body: {
          to: contactPhone,
          templateName: template.name,
          languageCode: template.language,
          conversationId,
          userId,
          components: components.length > 0 ? components : undefined,
          headerMedia: headerMedia ?? undefined,
          messageContent,
          phoneNumberId,
        },
      });

      await checkEdgeFunctionResponseAsync(result);

      onMessageRemove(tempId);

      toast({
        title: "Template enviado",
        description: `“${template.name}” foi enviado ao contato.`,
      });

      onSuccess?.();
    } catch (error: any) {
      console.error('[useTemplates] Error sending template:', error);
      onMessageUpdate(tempId, { status: "error", error: error.message });

      toast({
        title: "Não foi possível enviar o template",
        description: toUserMessage(error, "A mensagem não saiu. Toque em Reenviar no balão ou tente de novo."),
        variant: "destructive",
      });
    }
  }, [phoneNumberId, toast]);

  const sendFlowTemplate = useCallback(async ({
    template,
    bodyParameters,
    conversationId,
    contactPhone,
    phoneNumberDbId,
    phoneNumberId: phoneNumId,
    userId,
    onSuccess,
  }: SendFlowTemplateParams) => {
    const varCount = getVariableCount(template);

    if (varCount > 0 && bodyParameters?.some(p => !p.trim())) {
      toast({
        title: "Preencha todas as variáveis",
        description: "Cada variável do template precisa de um valor antes do envio.",
        variant: "destructive",
      });
      return;
    }

    try {
      const result = await supabase.functions.invoke('whatsapp-send-flow', {
        body: {
          to: contactPhone,
          phoneNumberId: phoneNumberDbId || phoneNumId,
          conversationId,
          userId,
          templateName: template.name,
          languageCode: template.language,
          bodyParameters: varCount > 0 ? bodyParameters : undefined,
        }
      });

      await checkEdgeFunctionResponseAsync(result);

      toast({
        title: "Formulário enviado",
        description: `“${template.name}” foi enviado ao contato.`,
      });

      setFlowTemplateDialogOpen(false);
      setSelectedFlowTemplate(null);
      setFlowTemplateParams([]);

      onSuccess?.();
    } catch (error: any) {
      console.error("Error sending flow template:", error);
      toast({
        title: "Não foi possível enviar o formulário",
        description: toUserMessage(error, "Nada foi enviado. Verifique a conexão e tente de novo."),
        variant: "destructive",
      });
    }
  }, [getVariableCount, toast]);

  // === FILTERED TEMPLATES ===

  const filteredTemplates = useMemo(() => {
    if (!templateSearch.trim()) return templates;
    const search = templateSearch.toLowerCase();
    return templates.filter(t =>
      t.name.toLowerCase().includes(search) ||
      t.components.some(c => c.text?.toLowerCase().includes(search))
    );
  }, [templates, templateSearch]);

  const filteredFlowTemplates = useMemo(() => {
    if (!flowTemplateSearch.trim()) return flowTemplates;
    const search = flowTemplateSearch.toLowerCase();
    return flowTemplates.filter(t =>
      t.name.toLowerCase().includes(search) ||
      t.components.some(c => c.text?.toLowerCase().includes(search))
    );
  }, [flowTemplates, flowTemplateSearch]);

  // === RESET FUNCTIONS ===

  const closeTemplateDialog = useCallback(() => {
    setTemplateDialogOpen(false);
    setSelectedTemplate(null);
  }, []);

  const closeFlowTemplateDialog = useCallback(() => {
    setFlowTemplateDialogOpen(false);
    setSelectedFlowTemplate(null);
    setFlowTemplateParams([]);
  }, []);

  return {
    // Regular templates
    templates: filteredTemplates,
    loadingTemplates,
    templatesOpen,
    setTemplatesOpen,
    selectedTemplate,
    templateDialogOpen,
    templateSearch,
    setTemplateSearch,
    fetchTemplates,
    upsertTemplate,
    selectTemplate,
    sendTemplate,
    closeTemplateDialog,

    // Flow templates
    flowTemplates: filteredFlowTemplates,
    loadingFlowTemplates,
    flowTemplatesOpen,
    setFlowTemplatesOpen,
    selectedFlowTemplate,
    flowTemplateDialogOpen,
    flowTemplateSearch,
    setFlowTemplateSearch,
    flowTemplateParams,
    setFlowTemplateParams,
    fetchFlowTemplates,
    selectFlowTemplate,
    sendFlowTemplate,
    closeFlowTemplateDialog,

    // Helpers
    getVariableCount,
    getTemplatePreview,
    hasFlowButton,
  };
}
