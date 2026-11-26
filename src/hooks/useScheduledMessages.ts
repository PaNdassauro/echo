import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { TemplateHeaderMedia } from "@/lib/templateMedia";
import {
  parseScheduledMedia,
  scheduledFilesProblem,
  scheduledMediaPath,
  unsentScheduledPaths,
  type NewScheduledMediaItem,
} from "@/lib/scheduledMedia";

// Visão de domínio da linha: os CHECKs do banco garantem as unions que o
// types.ts gerado alarga para string/Json.
export interface ScheduledMessage {
  id: string;
  organization_id: string;
  phone_number_id: string;
  conversation_id: string;
  message_type: "text" | "template" | "media";
  content: string | null;
  quoted_message_id: string | null;
  mentions: string[] | null;
  template_name: string | null;
  template_language: string | null;
  template_components: unknown[] | null;
  body_variables: string[] | null;
  button_variables: string[] | null;
  header_media: TemplateHeaderMedia | null;
  /** Arquivos de um agendamento `media`; ler com `parseScheduledMedia`. */
  media: unknown;
  contact_phone: string;
  contact_name: string | null;
  scheduled_at: string;
  status: "scheduled" | "processing" | "sent" | "failed" | "cancelled";
  sent_at: string | null;
  error_message: string | null;
  whatsapp_message_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
}

export interface ScheduleTextMessageInput {
  conversationId: string;
  phoneNumberId: string;
  organizationId: string;
  content: string;
  scheduledAt: Date;
  contactPhone: string;
  contactName?: string;
  quotedMessageId?: string;
  mentions?: string[];
}

export interface ScheduleTemplateMessageInput {
  conversationId: string;
  phoneNumberId: string;
  organizationId: string;
  templateName: string;
  templateLanguage?: string;
  templateComponents?: any[];
  bodyVariables?: string[];
  buttonVariables?: string[];
  headerMedia?: TemplateHeaderMedia | null;
  scheduledAt: Date;
  contactPhone: string;
  contactName?: string;
}

export interface ScheduleMediaFileInput {
  file: File;
  caption?: string;
  /** Dimensões medidas no navegador (imagem/vídeo), dica para a caixa da bolha. */
  width?: number;
  height?: number;
  /** Ver uma vez: só QR e só imagem/vídeo (quem chama decide). */
  viewOnce?: boolean;
}

export interface ScheduleMediaMessageInput {
  conversationId: string;
  phoneNumberId: string;
  organizationId: string;
  files: ScheduleMediaFileInput[];
  scheduledAt: Date;
  contactPhone: string;
  contactName?: string;
  /** Citação: vai no primeiro arquivo, como no envio na hora. */
  quotedMessageId?: string;
}

/** Remove arquivos que subiram para um agendamento que não chegou a existir ou foi cancelado. */
async function removeScheduledFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from("attachments").remove(paths);
  if (error) {
    // Sobra arquivo no bucket, nada mais: não atrapalha o atendente.
    console.warn("[scheduled] Não foi possível apagar arquivos do agendamento:", error.message);
  }
}

/**
 * Depois de cancelar: apaga do Storage os arquivos que não vão mais sair. O que
 * já saiu numa tentativa anterior (wamid no item) é a mídia da bolha e fica. A
 * policy só deixa apagar o que a própria pessoa subiu. Best-effort, não espera.
 */
export function discardUnsentScheduledFiles(row: { message_type: string; media: unknown }): void {
  if (row.message_type !== "media") return;
  void removeScheduledFiles(unsentScheduledPaths(parseScheduledMedia(row.media)));
}

interface UseScheduledMessagesOptions {
  organizationId?: string | null;
  conversationId?: string | null;
  phoneNumberId?: string | null;
}

export function useScheduledMessages(options: UseScheduledMessagesOptions = {}) {
  const { organizationId, conversationId, phoneNumberId } = options;
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  // Fetch scheduled messages
  const fetchScheduledMessages = useCallback(async () => {
    if (!organizationId) {
      setScheduledMessages([]);
      return;
    }

    setIsLoading(true);

    try {
      let query = supabase
        .from("scheduled_messages")
        .select("*")
        .eq("organization_id", organizationId)
        .order("scheduled_at", { ascending: true });

      if (conversationId) {
        query = query.eq("conversation_id", conversationId);
      }

      if (phoneNumberId) {
        query = query.eq("phone_number_id", phoneNumberId);
      }

      const { data, error } = await query;

      if (error) {
        console.error("Error fetching scheduled messages:", error);
        return;
      }

      setScheduledMessages((data ?? []) as unknown as ScheduledMessage[]);
    } catch (error) {
      console.error("Error in fetchScheduledMessages:", error);
    } finally {
      setIsLoading(false);
    }
  }, [organizationId, conversationId, phoneNumberId]);

  // Fetch on mount and when dependencies change
  useEffect(() => {
    fetchScheduledMessages();
  }, [fetchScheduledMessages]);

  // O handler é lido por ref para não entrar nos deps do efeito abaixo:
  // `fetchScheduledMessages` muda de identidade a cada troca de conversa
  // (conversationId está nos deps dele), e o canal é escopado por ORGANIZAÇÃO —
  // nome e filtro só usam organizationId. Sem a ref, todo clique em conversa
  // derrubava e recriava uma inscrição que continuava idêntica.
  const fetchRef = useRef(fetchScheduledMessages);
  useEffect(() => {
    fetchRef.current = fetchScheduledMessages;
  }, [fetchScheduledMessages]);

  // Subscribe to realtime changes
  useEffect(() => {
    if (!organizationId) return;

    const channel = supabase
      .channel(`scheduled_messages_${organizationId}`)
      .on(
        "postgres_changes" as any,
        {
          event: "*",
          schema: "public",
          table: "scheduled_messages",
          filter: `organization_id=eq.${organizationId}`,
        },
        () => {
          fetchRef.current();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [organizationId]);

  // Schedule a text message
  const scheduleTextMessage = useCallback(
    async (input: ScheduleTextMessageInput): Promise<{ success: boolean; error?: string }> => {
      setIsSaving(true);

      try {
        const { data: userData } = await supabase.auth.getUser();
        const userId = userData?.user?.id;

        const { error } = await supabase.from("scheduled_messages").insert({
          organization_id: input.organizationId,
          phone_number_id: input.phoneNumberId,
          conversation_id: input.conversationId,
          message_type: "text",
          content: input.content,
          contact_phone: input.contactPhone,
          contact_name: input.contactName || null,
          scheduled_at: input.scheduledAt.toISOString(),
          quoted_message_id: input.quotedMessageId || null,
          mentions: input.mentions || [],
          created_by: userId,
        });

        if (error) {
          console.error("Error scheduling text message:", error);
          toast({
            title: "Não foi possível agendar a mensagem",
            description: toUserMessage(error, "Nada foi agendado. Verifique a conexão e tente de novo."),
            variant: "destructive",
          });
          return { success: false, error: error.message };
        }

        const formattedDate = format(input.scheduledAt, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
        toast({
          title: "Mensagem agendada",
          description: `Será enviada em ${formattedDate}`,
        });

        return { success: true };
      } catch (error: any) {
        console.error("Error in scheduleTextMessage:", error);
        return { success: false, error: error.message };
      } finally {
        setIsSaving(false);
      }
    },
    [toast]
  );

  // Schedule a template message
  const scheduleTemplateMessage = useCallback(
    async (input: ScheduleTemplateMessageInput): Promise<{ success: boolean; error?: string }> => {
      setIsSaving(true);

      try {
        const { data: userData } = await supabase.auth.getUser();
        const userId = userData?.user?.id;

        const { error } = await supabase.from("scheduled_messages").insert({
          organization_id: input.organizationId,
          phone_number_id: input.phoneNumberId,
          conversation_id: input.conversationId,
          message_type: "template",
          template_name: input.templateName,
          template_language: input.templateLanguage || "pt_BR",
          template_components: input.templateComponents || null,
          body_variables: input.bodyVariables || [],
          button_variables: input.buttonVariables || [],
          // Literal explícito: a interface não tem index signature, e o tipo
          // Json da coluna exige uma.
          header_media: input.headerMedia
            ? {
                format: input.headerMedia.format,
                link: input.headerMedia.link,
                filename: input.headerMedia.filename ?? null,
              }
            : null,
          contact_phone: input.contactPhone,
          contact_name: input.contactName || null,
          scheduled_at: input.scheduledAt.toISOString(),
          created_by: userId,
        });

        if (error) {
          console.error("Error scheduling template message:", error);
          toast({
            title: "Não foi possível agendar o template",
            description: toUserMessage(error, "Nada foi agendado. Verifique a conexão e tente de novo."),
            variant: "destructive",
          });
          return { success: false, error: error.message };
        }

        const formattedDate = format(input.scheduledAt, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
        toast({
          title: "Template agendado",
          description: `Será enviado em ${formattedDate}`,
        });

        return { success: true };
      } catch (error: any) {
        console.error("Error in scheduleTemplateMessage:", error);
        return { success: false, error: error.message };
      } finally {
        setIsSaving(false);
      }
    },
    [toast]
  );

  // Schedule files (propostas, fotos, documentos): sobem já para o Storage e o
  // executor manda na hora marcada, na ordem escolhida.
  const scheduleMediaMessage = useCallback(
    async (input: ScheduleMediaMessageInput): Promise<{ success: boolean; error?: string }> => {
      const problem = scheduledFilesProblem(
        input.files.map((entry) => ({ name: entry.file.name, size: entry.file.size, caption: entry.caption }))
      );
      if (problem) {
        toast({ title: "Não foi possível agendar os arquivos", description: problem, variant: "destructive" });
        return { success: false, error: "invalid_files" };
      }
      setIsSaving(true);
      const uploaded: string[] = [];

      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const userId = sessionData.session?.user?.id;
        if (!userId) {
          toast({
            title: "Não foi possível agendar os arquivos",
            description: "Sua sessão expirou. Entre de novo e agende outra vez.",
            variant: "destructive",
          });
          return { success: false, error: "no_session" };
        }

        const now = Date.now();
        const items: NewScheduledMediaItem[] = [];
        for (const [index, entry] of input.files.entries()) {
          const path = scheduledMediaPath(userId, entry.file.name, index, now);
          const contentType = entry.file.type || "application/octet-stream";
          const { error: uploadError } = await supabase.storage
            .from("attachments")
            .upload(path, entry.file, { contentType, upsert: false });
          if (uploadError) {
            console.error("Error uploading scheduled file:", uploadError);
            await removeScheduledFiles(uploaded);
            toast({
              title: "Não foi possível agendar os arquivos",
              description: toUserMessage(uploadError, `O arquivo ${entry.file.name} não subiu. Nada foi agendado; tente de novo.`),
              variant: "destructive",
            });
            return { success: false, error: uploadError.message };
          }
          uploaded.push(path);
          const caption = entry.caption?.trim();
          items.push({
            storage_path: path,
            filename: entry.file.name,
            mime_type: contentType,
            size_bytes: entry.file.size,
            ...(caption ? { caption } : {}),
            ...(entry.width && entry.height ? { width: entry.width, height: entry.height } : {}),
            ...(entry.viewOnce ? { view_once: true } : {}),
          });
        }

        // Id gerado aqui: com erro de rede no INSERT dá para conferir se a linha
        // entrou antes de apagar os arquivos (apagar os de um agendamento que
        // existe faria ele falhar no horário).
        const id = crypto.randomUUID();
        const { error: insertError } = await supabase.from("scheduled_messages").insert({
          id,
          organization_id: input.organizationId,
          phone_number_id: input.phoneNumberId,
          conversation_id: input.conversationId,
          message_type: "media",
          media: items,
          contact_phone: input.contactPhone,
          contact_name: input.contactName || null,
          scheduled_at: input.scheduledAt.toISOString(),
          quoted_message_id: input.quotedMessageId || null,
          created_by: userId,
        });

        // Sem `code` o Postgres não respondeu (rede caiu ou tempo esgotou): a linha
        // pode ter entrado. Só a leitura decide.
        let error = insertError;
        if (insertError && !insertError.code) {
          const { data: existing, error: readError } = await supabase
            .from("scheduled_messages")
            .select("id")
            .eq("id", id)
            .maybeSingle();
          if (existing) error = null;
          else if (readError) {
            // Nem a leitura respondeu: não dá para saber. Os arquivos ficam, e o atendente confere.
            toast({
              title: "Não foi possível confirmar o agendamento",
              description: "A conexão caiu no meio. Confira a lista de agendadas antes de agendar de novo: ele pode ter sido criado.",
              variant: "destructive",
            });
            return { success: false, error: readError.message };
          }
        }

        if (error) {
          console.error("Error scheduling media message:", error);
          await removeScheduledFiles(uploaded);
          toast({
            title: "Não foi possível agendar os arquivos",
            description: toUserMessage(error, "Nada foi agendado. Verifique a conexão e tente de novo."),
            variant: "destructive",
          });
          return { success: false, error: error.message };
        }

        const formattedDate = format(input.scheduledAt, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
        toast({
          title: items.length === 1 ? "Arquivo agendado" : `${items.length} arquivos agendados`,
          description: `${items.length === 1 ? "Será enviado" : "Serão enviados"} em ${formattedDate}`,
        });

        return { success: true };
      } catch (error) {
        console.error("Error in scheduleMediaMessage:", error);
        await removeScheduledFiles(uploaded);
        toast({
          title: "Não foi possível agendar os arquivos",
          description: toUserMessage(error, "Nada foi agendado. Verifique a conexão e tente de novo."),
          variant: "destructive",
        });
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        setIsSaving(false);
      }
    },
    [toast]
  );

  // Cancel a scheduled message
  const cancelScheduledMessage = useCallback(
    async (id: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const { data, error } = await supabase
          .from("scheduled_messages")
          .update({ status: "cancelled" })
          .eq("id", id)
          .eq("status", "scheduled") // Only cancel if still scheduled
          .select("id, message_type, media");

        if (error) {
          console.error("Error cancelling scheduled message:", error);
          toast({
            title: "Não foi possível cancelar o agendamento",
            description: toUserMessage(error, "A mensagem continua agendada. Tente de novo."),
            variant: "destructive",
          });
          return { success: false, error: error.message };
        }

        if (!data?.length) {
          // O agendador venceu a corrida: a linha já saiu de "scheduled".
          toast({
            title: "Não foi possível cancelar",
            description: "Este agendamento já foi processado ou cancelado.",
            variant: "destructive",
          });
          return { success: false, error: "already_processed" };
        }

        // Agendamento com arquivo: o que não vai mais sair sai do Storage.
        discardUnsentScheduledFiles(data[0]);

        toast({
          title: "Agendamento cancelado",
        });

        return { success: true };
      } catch (error: any) {
        console.error("Error in cancelScheduledMessage:", error);
        return { success: false, error: error.message };
      }
    },
    [toast]
  );

  // Update scheduled message (reschedule or edit content)
  const updateScheduledMessage = useCallback(
    async (
      id: string,
      updates: {
        scheduledAt?: Date;
        content?: string;
        bodyVariables?: string[];
        buttonVariables?: string[];
      }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const updateData: Record<string, string | string[] | null> = {};

        if (updates.scheduledAt) {
          updateData.scheduled_at = updates.scheduledAt.toISOString();
          // Reagendar zera o backoff de retry: a elegibilidade de envio é
          // COALESCE(next_attempt_at, scheduled_at), então um retry pendente
          // furaria o horário novo. Mesma regra do PATCH da API pública.
          updateData.next_attempt_at = null;
        }
        if (updates.content !== undefined) {
          updateData.content = updates.content;
        }
        if (updates.bodyVariables) {
          updateData.body_variables = updates.bodyVariables;
        }
        if (updates.buttonVariables) {
          updateData.button_variables = updates.buttonVariables;
        }

        const { data, error } = await supabase
          .from("scheduled_messages")
          .update(updateData)
          .eq("id", id)
          .eq("status", "scheduled") // Only update if still scheduled
          .select("id");

        if (error) {
          console.error("Error updating scheduled message:", error);
          toast({
            title: "Não foi possível atualizar o agendamento",
            description: toUserMessage(error, "O agendamento anterior foi mantido. Tente de novo."),
            variant: "destructive",
          });
          return { success: false, error: error.message };
        }

        if (!data?.length) {
          toast({
            title: "Não foi possível atualizar",
            description: "Este agendamento já foi processado ou cancelado.",
            variant: "destructive",
          });
          return { success: false, error: "already_processed" };
        }

        toast({
          title: "Agendamento atualizado",
        });

        return { success: true };
      } catch (error: any) {
        console.error("Error in updateScheduledMessage:", error);
        return { success: false, error: error.message };
      }
    },
    [toast]
  );

  // Send a scheduled message immediately, through the scheduler's own pipeline
  // (canal, template, quoted, retry, reaper — nada é duplicado aqui): adianta a
  // elegibilidade e cutuca o dispatcher para não esperar a volta do cron.
  const sendScheduledMessageNow = useCallback(
    async (id: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const { data, error } = await supabase
          .from("scheduled_messages")
          .update({ next_attempt_at: new Date().toISOString() })
          .eq("id", id)
          .eq("status", "scheduled") // guarda de corrida contra o cron
          .select("id");

        if (error) {
          console.error("Error sending scheduled message now:", error);
          toast({
            title: "Não foi possível enviar agora",
            description: toUserMessage(error, "A mensagem continua agendada. Tente de novo."),
            variant: "destructive",
          });
          return { success: false, error: error.message };
        }

        if (!data?.length) {
          toast({
            title: "Não foi possível enviar",
            description: "Este agendamento já foi processado ou cancelado.",
            variant: "destructive",
          });
          return { success: false, error: "already_processed" };
        }

        // Best-effort: se o tick imediato falhar, o cron envia em até 60s.
        supabase.rpc("process_scheduled_messages").then(({ error: rpcError }) => {
          if (rpcError) {
            console.warn("[scheduled] immediate tick failed, cron will pick it up:", rpcError.message);
          }
        });

        toast({
          title: "Enviando agora",
          description: "A mensagem entrou na fila de envio imediato.",
        });

        return { success: true };
      } catch (error: any) {
        console.error("Error in sendScheduledMessageNow:", error);
        return { success: false, error: error.message };
      }
    },
    [toast]
  );

  // Get count of pending scheduled messages for a conversation
  const getPendingCount = useCallback(
    (forConversationId?: string) => {
      const filtered = forConversationId
        ? scheduledMessages.filter((m) => m.conversation_id === forConversationId)
        : scheduledMessages;

      return filtered.filter((m) => m.status === "scheduled").length;
    },
    [scheduledMessages]
  );

  return {
    scheduledMessages,
    isLoading,
    isSaving,
    scheduleTextMessage,
    scheduleTemplateMessage,
    scheduleMediaMessage,
    cancelScheduledMessage,
    updateScheduledMessage,
    sendScheduledMessageNow,
    refetch: fetchScheduledMessages,
    getPendingCount,
  };
}
