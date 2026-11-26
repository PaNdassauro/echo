import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { checkEdgeFunctionResponseAsync } from "@/lib/utils";
import { subscribeWithBackoff } from "@/lib/realtimeReconnect";
import { mergeIncomingMessage, mergeRefreshedRows, normalizeMessageRow, settleOptimistic } from "@/lib/messageReconcile";
import { useRealtimeFallbackPoll } from "@/hooks/useRealtimeFallbackPoll";
import { fetchAllPaginated } from "@/lib/fetchAllPaginated";

export interface Message {
  id: string;
  content: string;
  direction: "inbound" | "outbound";
  created_at: string;
  sent_by: string | null;
  status?: "sending" | "sent" | "delivered" | "read" | "error" | "failed";
  error?: string;
  error_message?: string;
  message_type?: string;
  media_url?: string | null;
  media_mime_type?: string | null;
  media_filename?: string | null;
  sender_name?: string | null;
  sender_phone?: string | null;
  /**
   * JID original do participante ("…@s.whatsapp.net" ou "…@lid"). Distingue
   * telefone real de LID não resolvido: quando o sufixo é @lid e o bare do jid
   * é IGUAL ao sender_phone, o "telefone" gravado é o LID cru.
   */
  sender_jid?: string | null;
  quoted_message_id?: string | null;
  quoted_content?: string | null;
  quoted_direction?: "inbound" | "outbound" | null;
  quoted_media_url?: string | null;
  quoted_message_type?: string | null;
  quoted_sender_jid?: string | null;
  quoted_sender_name?: string | null;
  quoted_sender_phone?: string | null;
  flow_response_json?: Record<string, unknown> | null;
  flow_token?: string | null;
  reaction?: string | null;
  our_reaction?: string | null;
  is_edited?: boolean;
  edited_at?: string | null;
  /**
   * Apagada para todos. O conteúdo original é preservado (mídia inclusive) e a bolha
   * apenas sinaliza. `message_type === 'deleted'` é o formato legado, anterior ao soft delete.
   */
  is_deleted?: boolean;
  deleted_at?: string | null;
  whatsapp_message_id?: string | null;
  /** Client-only: menções da mensagem otimista, preservadas para o Reenviar. */
  pendingMentions?: string[];
  /**
   * Client-only: identidade React estável da bolha. Na reconciliação otimista
   * o id muda (temp-… → uuid real); a key da lista usa clientKey para o DOM
   * não remontar nem reanimar a bolha no meio da transição sending→sent.
   */
  clientKey?: string;
  metadata?: {
    /** Dimensões da mídia em px de exibição ({width,height,seconds?,source?}). Opcional para sempre; ler só via parseMediaDimensions (src/lib/mediaBox.ts). */
    media?: unknown;
    contact?: {
      displayName: string;
      /** Ausente na Cloud API, que manda o contato estruturado em vez de vCard. */
      vcard?: string;
      phones: string[];
      /** Todos os contatos da mensagem; rows antigas só têm os campos singulares acima. */
      contacts?: Array<{ displayName: string; vcard?: string; phones: string[] }>;
    };
    groupAction?: {
      action: string;
      actor: { phone?: string; name?: string; jid?: string };
      targets: Array<{ phone?: string; name?: string; jid?: string }>;
    };
    /** 'instagram' = veio ou saiu pelo Direct do Instagram (fase 2/3 do Direct no Echo). */
    canal?: string;
    /** Versões anteriores do texto, da mais antiga para a mais recente. */
    edit_history?: Array<{ content: string; at: string }>;
    /**
     * O contato editou mas não conseguimos o texto novo (em 1:1 a edição vem cifrada com o
     * segredo da mensagem alvo). O `content` exibido é o antigo.
     */
    edit_content_unavailable?: boolean;
    /** Mensagem encaminhada: pelo Echo (whatsapp-forward) ou pelo contato (qr-service/webhook). */
    forwarded?: boolean;
    /** Encaminhada muitas vezes (forwardingScore >= 5 / frequently_forwarded da Cloud API). */
    frequently_forwarded?: boolean;
    /** Mensagem que saiu num disparo (do Echo ou de um sistema externo pela API). */
    disparo?: { rotulo?: string; campanha?: string; origem?: string };
  } | null;
}

interface UseMessagesOptions {
  conversationId: string | null;
  userId: string;
  phoneNumberId?: string | null;
  isQrConnection?: boolean;
  contactPhone?: string;
  onConversationUpdate?: (clearSelection?: boolean) => void;
  onError?: (title: string, description: string) => void;
  onSuccess?: (title: string, description?: string) => void;
}

interface SendMessageOptions {
  content: string;
  mentionJids?: string[];
  quotedMessageId?: string | null;
}

const MAX_CONCURRENT_SENDS = 5;

const PAGE_SIZE = 200;
/** Pausa antes de tentar de novo uma página que falhou (o load-ahead chama a cada faixa). */
const LOAD_MORE_RETRY_BACKOFF_MS = 3000;
// Releitura de reserva: cobre os recibos das mensagens que o atendente está vendo.
const RECENT_REFRESH_SIZE = 30;

export function useMessages({
  conversationId,
  userId,
  phoneNumberId,
  isQrConnection = false,
  contactPhone,
  onConversationUpdate,
  onError,
  onSuccess,
}: UseMessagesOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // Carregamento do histórico completo para a busca — separado de isLoading
  // para a lista continuar montada enquanto o histórico baixa.
  const [isFetchingAll, setIsFetchingAll] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Refs for race condition handling
  const conversationIdRef = useRef(conversationId);
  const fetchIdRef = useRef(0);
  const fetchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  // Cursores COMPOSTOS (created_at, id). Só created_at não serve: o webhook
  // grava o timestamp do WhatsApp em SEGUNDOS e o import de histórico grava a
  // data original, então mensagens empatam no mesmo created_at (uma conversa
  // importada chega a ter dezenas de mensagens no mesmo
  // instante). Com cursor estrito (`lt`/`gt`) sobre created_at sozinho, todas as
  // empatadas na fronteira da página eram puladas PARA SEMPRE.
  // `id` é UUID: arbitrário, mas total e estável — que é tudo que um desempate
  // precisa ser.
  type MessageCursor = { created_at: string; id: string };
  const oldestMessageDateRef = useRef<MessageCursor | null>(null);
  const newestMessageDateRef = useRef<MessageCursor | null>(null);
  const messagesRef = useRef<Message[]>(messages);

  // Refs for send queue
  const pendingSendsRef = useRef(0);
  const messageQueueRef = useRef<Array<{
    tempId: string;
    content: string;
    mentionJids?: string[];
    quotedMessageId?: string | null;
    conversationId: string;
    contactPhone: string;
    phoneNumberId: string | null | undefined;
  }>>([]);
  const isProcessingQueueRef = useRef(false);

  // Keep conversationIdRef in sync
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  // Keep messagesRef in sync for realtime handler
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Refs para o retry: o memo do MessageBubble ignora props de callback de
  // propósito, então a bolha guarda a closure do mount — que pode ter
  // contactPhone vazio (conversa carregada depois das mensagens). Lendo dos
  // refs, o callback fica estável e sempre vê os valores atuais.
  const contactPhoneRef = useRef(contactPhone);
  const phoneNumberIdRef = useRef(phoneNumberId);
  useEffect(() => {
    contactPhoneRef.current = contactPhone;
    phoneNumberIdRef.current = phoneNumberId;
  }, [contactPhone, phoneNumberId]);

  // Helper to transform raw DB messages
  const transformMessages = useCallback((data: any[]): Message[] => {
    return data.map((msg: any) => {
      const quotedMsg = msg.quoted_message;
      return {
        ...msg,
        status: msg.status === 'failed' ? 'error' : msg.status,
        error: msg.error_message || msg.error,
        quoted_content: quotedMsg?.content || null,
        quoted_direction: quotedMsg?.direction || null,
        quoted_media_url: quotedMsg?.media_url || null,
        quoted_message_type: quotedMsg?.message_type || null,
        quoted_sender_jid: quotedMsg?.sender_jid || null,
        quoted_sender_name: quotedMsg?.sender_name || null,
        quoted_sender_phone: quotedMsg?.sender_phone || null,
      };
    }) as Message[];
  }, []);

  // Fetch latest messages (paginated - most recent PAGE_SIZE)
  const fetchMessages = useCallback(async () => {
    const currentId = conversationId;
    if (!currentId) return;

    const thisFetchId = ++fetchIdRef.current;
    const currentConvId = currentId;

    // Only show loading on initial fetch, not refetches
    const isInitialFetch = messages.length === 0;
    if (isInitialFetch) {
      setIsLoading(true);
    }

    // Fetch latest PAGE_SIZE messages (order desc, then reverse)
    const { data, error } = await supabase
      .from("messages")
      .select(`
        *,
        quoted_message:quoted_message_id (
          id,
          content,
          direction,
          media_url,
          message_type,
          sender_jid,
          sender_name,
          sender_phone
        )
      `)
      .eq("conversation_id", currentId)
      // Ordem TOTAL: a primeira página precisa usar o mesmo critério do
      // loadMore/syncNewMessages, senão a fronteira do cursor não bate.
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE_SIZE);

    if (isInitialFetch) {
      setIsLoading(false);
    }

    if (error) {
      console.error("Error fetching messages:", error);
      return;
    }

    // Only update if this is still the latest fetch
    if (fetchIdRef.current !== thisFetchId) return;
    if (conversationIdRef.current !== currentConvId) return;

    // Reverse to get chronological order
    const reversedData = (data || []).reverse();
    const dbMessages = transformMessages(reversedData);

    setMessages((prev) => {
      const localOnlyMessages = prev.filter(
        (m) => (m.status === "sending" || m.status === "error") &&
          !dbMessages.find((d) => d.id === m.id)
      );

      // Check inside callback to avoid stale closure
      const isFirstFetch = prev.length === 0 || prev.every(m => m.status === "sending" || m.status === "error");

      if (isFirstFetch) {
        // Initial fetch: just use the new data
        // Track oldest and newest message dates
        if (dbMessages.length > 0) {
          oldestMessageDateRef.current = { created_at: dbMessages[0].created_at, id: dbMessages[0].id };
          const last = dbMessages[dbMessages.length - 1];
          newestMessageDateRef.current = { created_at: last.created_at, id: last.id };
        }
        return [...dbMessages, ...localOnlyMessages];
      } else {
        // Refetch: merge new data with existing older messages
        // Keep older messages that aren't in the new fetch
        // Dedupe por ID, não por `created_at <`: o comparador estrito tinha o
        // mesmo bug de empate do cursor — uma mensagem antiga com o MESMO
        // created_at da mais antiga recém-buscada era descartada do state.
        const fetchedIds = new Set(dbMessages.map(m => m.id));
        const oldestFetchedTs = dbMessages[0] ? new Date(dbMessages[0].created_at).getTime() : null;
        const olderMessages = oldestFetchedTs !== null
          ? prev.filter(m =>
              !fetchedIds.has(m.id) &&
              new Date(m.created_at).getTime() <= oldestFetchedTs &&
              m.status !== "sending" && m.status !== "error"
            )
          : [];

        // Update newest message date
        if (dbMessages.length > 0) {
          const last = dbMessages[dbMessages.length - 1];
          newestMessageDateRef.current = { created_at: last.created_at, id: last.id };
        }

        // Don't update oldestMessageDateRef - keep tracking the truly oldest
        return [...olderMessages, ...dbMessages, ...localOnlyMessages];
      }
    });

    // Set hasMore outside the callback
    if (isInitialFetch) {
      setHasMore((data?.length || 0) >= PAGE_SIZE);
    }
  }, [conversationId, transformMessages]);

  // Sync only new messages (for visibility change - doesn't reset scroll)
  const syncNewMessages = useCallback(async () => {
    const currentId = conversationId;
    if (!currentId || !newestMessageDateRef.current) return;
    const cursor = newestMessageDateRef.current;
    const SYNC_PAGE = 200;

    const { data, error } = await supabase
      .from("messages")
      .select(`
        *,
        quoted_message:quoted_message_id (
          id,
          content,
          direction,
          media_url,
          message_type,
          sender_jid,
          sender_name,
          sender_phone
        )
      `)
      .eq("conversation_id", currentId)
      // `gte` + o .or() abaixo formam o cursor composto: o gte é sargável no
      // índice (conversation_id, created_at) e estreita a faixa; o .or() é o
      // filtro residual que desempata dentro dela.
      .gte("created_at", cursor.created_at)
      .or(`created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(SYNC_PAGE);

    if (error) {
      console.error("Error syncing new messages:", error);
      return;
    }

    if (conversationIdRef.current !== currentId) return;

    const newMessages = transformMessages(data || []);

    if (newMessages.length > 0) {
      // Update newest date
      const lastNew = newMessages[newMessages.length - 1];
      newestMessageDateRef.current = { created_at: lastNew.created_at, id: lastNew.id };

      // Anexa no fim (não mexe no scroll). Passa pela mesma reconciliação do
      // INSERT do realtime: este sync roda na reconexão do canal e na volta à
      // aba, justamente quando a linha do nosso envio pode chegar por aqui
      // antes do realtime — anexar por id deixava a temp ao lado dela
      // (bolha fantasma). Sem linha nova, devolve a mesma referência.
      setMessages((prev) => newMessages.reduce(mergeIncomingMessage, prev));
    }
  }, [conversationId, transformMessages]);

  // Contorno para queda do Realtime: intervalos curtos. A reconciliação
  // e a releitura de recibos ficam.
  // Rede de segurança do realtime: com o Realtime do Supabase instável o
  // INSERT pode não chegar nunca (ou se perder com o canal ainda SUBSCRIBED).
  // A busca passa pela mesma reconciliação do realtime (mergeIncomingMessage),
  // então não duplica a bolha otimista. Conversa sem cursor (vazia) refaz o
  // fetch inicial.
  // Os UPDATEs perdidos (✓ → ✓✓ → lido, falha, edição, apagado para todos)
  // vêm de uma releitura das últimas linhas, aplicada só ao que mudou.
  const refreshRecentRows = useCallback(async () => {
    const currentId = conversationId;
    if (!currentId) return;
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", currentId)
      .order("created_at", { ascending: false })
      .limit(RECENT_REFRESH_SIZE);
    if (error) {
      console.error("Error refreshing recent messages:", error);
      return;
    }
    if (conversationIdRef.current !== currentId || !data?.length) return;
    setMessages((prev) => mergeRefreshedRows(prev, data as Array<Record<string, unknown> & { id: string }>));
  }, [conversationId]);

  useRealtimeFallbackPoll(
    async () => {
      if (!newestMessageDateRef.current) return fetchMessages();
      await syncNewMessages();
      await refreshRecentRows();
    },
    { degradedMs: 4_000, healthyMs: 20_000, enabled: !!conversationId },
  );

  // Load more (older) messages
  // Guardas síncronas: o state `isLoadingMore` só chega ao closure depois do
  // commit, e o load-ahead chama onLoadMore a cada mudança de faixa.
  const loadingMoreForRef = useRef<string | null>(null);
  const loadMoreErrorRef = useRef<{ id: string; at: number } | null>(null);

  const loadMore = useCallback(async () => {
    const currentId = conversationId;
    // Don't load more if initial fetch hasn't completed yet
    if (!currentId || !hasMore || isLoadingMore || isLoading) return;
    if (loadingMoreForRef.current === currentId) return;
    const lastError = loadMoreErrorRef.current;
    if (lastError && lastError.id === currentId && Date.now() - lastError.at < LOAD_MORE_RETRY_BACKOFF_MS) return;
    if (!oldestMessageDateRef.current) return;
    const cursor = oldestMessageDateRef.current;

    loadingMoreForRef.current = currentId;
    setIsLoadingMore(true);

    const { data, error } = await supabase
      .from("messages")
      .select(`
        *,
        quoted_message:quoted_message_id (
          id,
          content,
          direction,
          media_url,
          message_type,
          sender_jid,
          sender_name,
          sender_phone
        )
      `)
      .eq("conversation_id", currentId)
      // Cursor composto, espelhando o syncNewMessages: `lte` estreita a faixa
      // usando o índice e o .or() desempata dentro dela. Sem isso, as mensagens
      // que empatam no created_at da mais antiga já carregada nunca eram
      // alcançadas ao rolar para cima.
      .lte("created_at", cursor.created_at)
      .or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE_SIZE);

    if (loadingMoreForRef.current === currentId) loadingMoreForRef.current = null;
    setIsLoadingMore(false);

    if (error) {
      console.error("Error loading more messages:", error);
      loadMoreErrorRef.current = { id: currentId, at: Date.now() };
      return;
    }
    loadMoreErrorRef.current = null;

    if (conversationIdRef.current !== currentId) return;

    // Reverse to get chronological order
    const reversedData = (data || []).reverse();
    const olderMessages = transformMessages(reversedData);

    if (olderMessages.length > 0) {
      oldestMessageDateRef.current = { created_at: olderMessages[0].created_at, id: olderMessages[0].id };
    }

    setHasMore((data?.length || 0) >= PAGE_SIZE);

    if (olderMessages.length > 0) {
      setMessages((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const fresh = olderMessages.filter((m) => !known.has(m.id));
        return fresh.length > 0 ? [...fresh, ...prev] : prev;
      });
    }
  }, [conversationId, hasMore, isLoadingMore, isLoading, transformMessages]);

  // Fetch all messages (for search)
  // Usa isFetchingAll dedicado: reaproveitar isLoading fazia o MessageList
  // DESMONTAR a conversa (early-return de loading) só porque a busca abriu.
  const fetchAllMessages = useCallback(async () => {
    const currentId = conversationId;
    if (!currentId) return;

    setIsFetchingAll(true);

    // PostgREST corta em max_rows (1000) e ignora .limit acima disso — um
    // histórico longo precisa ser drenado por .range(). Tiebreaker por id:
    // linhas importadas em lote compartilham o mesmo created_at.
    let data: Array<{ created_at: string }>;
    try {
      data = await fetchAllPaginated<{ created_at: string }>((from, to) =>
        supabase
          .from("messages")
          .select(`
            *,
            quoted_message:quoted_message_id (
              id,
              content,
              direction,
              media_url,
              message_type,
              sender_jid,
              sender_name,
              sender_phone
            )
          `)
          .eq("conversation_id", currentId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to)
      );
    } catch (error) {
      setIsFetchingAll(false);
      console.error("Error fetching all messages:", error);
      return;
    }

    setIsFetchingAll(false);

    if (conversationIdRef.current !== currentId) return;

    const dbMessages = transformMessages(data || []);

    // Update oldest message ref
    if (dbMessages.length > 0) {
      oldestMessageDateRef.current = { created_at: dbMessages[0].created_at, id: dbMessages[0].id };
    }

    // No more to load after fetching all
    setHasMore(false);

    setMessages((prev) => {
      const localOnlyMessages = prev.filter(
        (m) => (m.status === "sending" || m.status === "error") &&
          !dbMessages.find((d) => d.id === m.id)
      );

      return [...dbMessages, ...localOnlyMessages];
    });
  }, [conversationId, transformMessages]);

  // Internal send function - uses explicit params to avoid stale closure issues
  const sendSingleMessage = useCallback(async (
    tempId: string,
    messageContent: string,
    targetConversationId: string,
    targetContactPhone: string,
    targetPhoneNumberId: string | null | undefined,
    mentionJids?: string[],
    quotedMessageId?: string | null
  ) => {
    // tempId sem prefixo "temp-" = reenvio de uma linha persistida que falhou:
    // a função atualiza a MESMA linha (wamid novo) em vez de inserir outra.
    const retryMessageId = tempId.startsWith('temp-') ? null : tempId;

    try {
      const result = await supabase.functions.invoke('whatsapp-send', {
        body: {
          to: targetContactPhone,
          message: messageContent,
          conversationId: targetConversationId,
          userId,
          phoneNumberId: targetPhoneNumberId,
          quotedMessageId: quotedMessageId || null,
          mentions: mentionJids,
          retryMessageId,
        },
      });

      await checkEdgeFunctionResponseAsync(result);

      const sentWhatsappId =
        (result.data as { messageId?: string } | null)?.messageId ?? null;

      // Reconciliar em vez de remover: a MESMA bolha progride sending→sent (sem
      // remount, sem sumir, sem duplicar). Quando o INSERT do realtime chegar,
      // o handler substitui esta bolha pela linha real casando o
      // whatsapp_message_id; se o realtime chegou ANTES da resposta, a temp já
      // foi substituída e o map abaixo é um no-op.
      if (conversationIdRef.current === targetConversationId) {
        setMessages((prev) => settleOptimistic(prev, tempId, sentWhatsappId));
      }
      // Sem bump da lista pós-envio: o trigger do banco já emite o UPDATE realtime
      // em conversations (last_message_*), e o refetch completo custava a linha inteira.
    } catch (error: any) {
      console.error('[useMessages] Error sending message:', error);
      // Only update error state if still on the same conversation
      if (conversationIdRef.current === targetConversationId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId
              ? { ...m, status: "error" as const, error: error.message }
              : m
          )
        );
      }
      onError?.("Não foi possível enviar mensagem", error.message);
    }
  }, [userId, onConversationUpdate, onError]);

  // Process QR message queue sequentially
  const processMessageQueue = useCallback(async () => {
    if (isProcessingQueueRef.current) return;
    if (messageQueueRef.current.length === 0) return;

    isProcessingQueueRef.current = true;

    while (messageQueueRef.current.length > 0) {
      const msg = messageQueueRef.current.shift()!;
      await sendSingleMessage(
        msg.tempId,
        msg.content,
        msg.conversationId,
        msg.contactPhone,
        msg.phoneNumberId,
        msg.mentionJids,
        msg.quotedMessageId
      );
    }

    isProcessingQueueRef.current = false;
    pendingSendsRef.current = 0;
  }, [sendSingleMessage]);

  // Public send message function
  const sendMessage = useCallback(async (options: SendMessageOptions) => {
    const { content, mentionJids, quotedMessageId } = options;

    if (!content.trim() || !conversationId) return false;

    if (pendingSendsRef.current >= MAX_CONCURRENT_SENDS) {
      onError?.("Aguarde alguns segundos", "Muitas mensagens em fila. Tente de novo em instantes.");
      return false;
    }
    pendingSendsRef.current++;

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Add optimistic message
    const optimisticMessage: Message = {
      id: tempId,
      clientKey: tempId,
      content: content.trim(),
      direction: "outbound",
      created_at: new Date().toISOString(),
      sent_by: userId,
      status: "sending",
      // Preservados na bolha para o "Reenviar" reproduzir o envio original.
      quoted_message_id: quotedMessageId ?? null,
      pendingMentions: mentionJids,
    };

    setMessages((prev) => [...prev, optimisticMessage]);

    // Capture current values to avoid stale closures
    const currentConversationId = conversationId;
    const currentContactPhone = contactPhone;
    const currentPhoneNumberId = phoneNumberId;

    // For QR connections: queue messages
    if (isQrConnection) {
      messageQueueRef.current.push({
        tempId,
        content: content.trim(),
        mentionJids,
        quotedMessageId,
        conversationId: currentConversationId,
        contactPhone: currentContactPhone || '',
        phoneNumberId: currentPhoneNumberId,
      });
      processMessageQueue();
      return true;
    }

    // For API connections: send concurrently
    try {
      await sendSingleMessage(
        tempId,
        content.trim(),
        currentConversationId,
        currentContactPhone || '',
        currentPhoneNumberId,
        mentionJids,
        quotedMessageId
      );
    } finally {
      pendingSendsRef.current--;
    }

    return true;
  }, [conversationId, userId, isQrConnection, processMessageQueue, sendSingleMessage, onError]);

  // Reenviar uma mensagem que falhou: MESMA bolha (mesmo id), mesmo conteúdo,
  // mesma citação e menções — volta a "sending" e refaz o envio. Para linha
  // persistida (id real), a função atualiza a própria linha no DB; telefone e
  // conteúdo são resolvidos server-side (o valor daqui é só fallback).
  const retryMessage = useCallback(async (messageId: string) => {
    const msg = messagesRef.current.find((m) => m.id === messageId);
    if (!msg || !conversationIdRef.current) return false;

    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, status: "sending" as const, error: undefined } : m
      )
    );

    await sendSingleMessage(
      messageId,
      msg.content,
      conversationIdRef.current,
      contactPhoneRef.current || "",
      phoneNumberIdRef.current,
      msg.pendingMentions,
      msg.quoted_message_id ?? null
    );
    return true;
  }, [sendSingleMessage]);

  // Descartar uma mensagem que falhou (remove da timeline). Linha persistida
  // ressuscitaria em qualquer refetch se o descarte fosse só local, então ela
  // vira soft-delete no DB (tombstone) — consistente ao vivo e pós-reload.
  const discardMessage = useCallback(async (messageId: string) => {
    if (messageId.startsWith("temp-")) {
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      return;
    }

    const deletedAt = new Date().toISOString();
    const { error } = await supabase
      .from("messages")
      .update({ is_deleted: true, deleted_at: deletedAt })
      .eq("id", messageId);

    if (error) {
      console.error("[useMessages] Error discarding message:", error);
      onError?.("Não foi possível descartar mensagem", error.message);
      return;
    }

    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, is_deleted: true, deleted_at: deletedAt } : m
      )
    );
  }, [onError]);

  // Edit message (QR connections only)
  const editMessage = useCallback(async (messageId: string, newContent: string) => {
    if (!phoneNumberId || !newContent.trim()) return false;

    try {
      const result = await supabase.functions.invoke('whatsapp-edit', {
        body: {
          conversationId,
          messageId,
          phoneNumberId,
          userId,
          newContent: newContent.trim(),
        },
      });

      await checkEdgeFunctionResponseAsync(result);

      const editedAt = new Date().toISOString();
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: newContent.trim(),
                is_edited: true,
                edited_at: editedAt,
                metadata: {
                  ...(m.metadata ?? {}),
                  edit_history: [...(m.metadata?.edit_history ?? []), { content: m.content, at: editedAt }],
                },
              }
            : m
        )
      );

      onSuccess?.("Mensagem editada", "A mensagem foi atualizada");
      return true;
    } catch (error: any) {
      console.error('[useMessages] Error editing message:', error);
      onError?.("Não foi possível editar mensagem", error.message);
      return false;
    }
  }, [conversationId, phoneNumberId, userId, onSuccess, onError]);

  // Delete message (QR connections only)
  const deleteMessage = useCallback(async (messageId: string) => {
    if (!phoneNumberId) return false;

    try {
      const result = await supabase.functions.invoke('whatsapp-delete', {
        body: {
          conversationId,
          messageId,
          phoneNumberId,
          userId,
        },
      });

      await checkEdgeFunctionResponseAsync(result);

      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, is_deleted: true, deleted_at: new Date().toISOString() } : m
        )
      );

      onSuccess?.("Mensagem apagada", "A mensagem foi apagada para todos");
      return true;
    } catch (error: any) {
      console.error('[useMessages] Error deleting message:', error);
      onError?.("Não foi possível apagar mensagem", error.message);
      return false;
    }
  }, [conversationId, phoneNumberId, userId, onSuccess, onError]);

  // React to message (QR connections only)
  const reactToMessage = useCallback(async (messageId: string, emoji: string) => {
    if (!phoneNumberId) return false;

    try {
      const result = await supabase.functions.invoke('whatsapp-react', {
        body: {
          messageId,
          phoneNumberId,
          emoji,
        },
      });

      await checkEdgeFunctionResponseAsync(result);

      const reactionValue = emoji || null;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, our_reaction: reactionValue } : m
        )
      );

      if (emoji) {
        onSuccess?.("Reação enviada", `Você reagiu com ${emoji}`);
      } else {
        onSuccess?.("Reação removida");
      }
      return true;
    } catch (error: any) {
      console.error('[useMessages] Error sending reaction:', error);
      onError?.("Não foi possível enviar reação", error.message);
      return false;
    }
  }, [phoneNumberId, onSuccess, onError]);

  // Clear messages (used when switching conversations)
  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  // Realtime subscription and visibility handling
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setHasMore(true);
      oldestMessageDateRef.current = null;
      return;
    }

    // Clear messages and reset pagination when conversation changes
    setMessages([]);
    setHasMore(true);
    oldestMessageDateRef.current = null;
    newestMessageDateRef.current = null;
    setIsLoading(true);
    fetchMessages().finally(() => setIsLoading(false));

    // Canal com re-assinatura em backoff: sem isso um CHANNEL_ERROR deixava a
    // conversa aberta surda até trocar de conversa (os outros canais do app já
    // reconectavam; este só refetchava uma vez e ficava morto).
    const createChannel = () => supabase
      .channel(`messages-${conversationId}`)
      .on(
        "postgres_changes",
        // filter server-side: sem ele, cada aba recebe (e o walrus avalia RLS
        // para) TODO insert de messages da instância, não só desta conversa.
        { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` },
        async (payload) => {
          if (payload.eventType === 'INSERT' && payload.new) {
            const newMsg = payload.new as Message;

            if ((newMsg as any).conversation_id !== conversationIdRef.current) return;

            // If message has quoted_message_id, we need to fetch the quoted message data
            // since realtime doesn't include joined relations
            const enrichedMsg = { ...newMsg, status: newMsg.status || 'sent' } as Message;

            if (newMsg.quoted_message_id) {
              // First try to find quoted message in current state
              const quotedFromState = messagesRef.current?.find(m => m.id === newMsg.quoted_message_id);

              if (quotedFromState) {
                enrichedMsg.quoted_content = quotedFromState.content;
                enrichedMsg.quoted_direction = quotedFromState.direction;
                enrichedMsg.quoted_media_url = quotedFromState.media_url;
                enrichedMsg.quoted_message_type = quotedFromState.message_type;
                enrichedMsg.quoted_sender_jid = quotedFromState.sender_jid ?? null;
                enrichedMsg.quoted_sender_name = quotedFromState.sender_name ?? null;
                enrichedMsg.quoted_sender_phone = quotedFromState.sender_phone ?? null;
              } else {
                // Fetch quoted message from DB
                const { data: quotedMsg } = await supabase
                  .from('messages')
                  .select('id, content, direction, media_url, message_type, sender_jid, sender_name, sender_phone')
                  .eq('id', newMsg.quoted_message_id)
                  .maybeSingle() as { data: { id: string; content: string; direction: string; media_url: string | null; message_type: string | null; sender_jid: string | null; sender_name: string | null; sender_phone: string | null } | null };

                if (quotedMsg) {
                  enrichedMsg.quoted_content = quotedMsg.content;
                  enrichedMsg.quoted_direction = quotedMsg.direction as "inbound" | "outbound";
                  enrichedMsg.quoted_media_url = quotedMsg.media_url;
                  enrichedMsg.quoted_message_type = quotedMsg.message_type;
                  enrichedMsg.quoted_sender_jid = quotedMsg.sender_jid;
                  enrichedMsg.quoted_sender_name = quotedMsg.sender_name;
                  enrichedMsg.quoted_sender_phone = quotedMsg.sender_phone;
                }
              }
            }

            // Reconciliação com a bolha otimista: a linha real do nosso envio
            // substitui a temp NO LUGAR (mesma posição, mesma clientKey, sem
            // duplicar). A regra mora em messageReconcile, junto do sync.
            setMessages((prev) => mergeIncomingMessage(prev, enrichedMsg));

            // Update newest message date for sync
            if (newMsg.created_at && newMsg.id) {
              newestMessageDateRef.current = { created_at: newMsg.created_at, id: newMsg.id };
            }
          }
          // Don't call fetchMessages here - realtime already added the message
          // Calling fetchMessages causes scroll position to reset
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          if (payload.eventType === 'UPDATE' && payload.new) {
            const updatedMsg = payload.new as Message;

            if ((updatedMsg as any).conversation_id !== conversationIdRef.current) return;

            // Normaliza como o transformMessages (failed→error, error_message→
            // error) — sem isso, uma falha assíncrona do webhook não mostrava a
            // linha de erro/Reenviar até o reload. Payload traz a linha inteira,
            // então error_message null (retry com sucesso) limpa o erro.
            // Não reusa transformMessages: ele deriva quoted_* de um join que o
            // payload do realtime não tem.
            const normalized = normalizeMessageRow(
              updatedMsg as Message & { error_message?: string | null },
            ) as Message;

            setMessages((prev) =>
              prev.map(m => m.id === updatedMsg.id ? { ...m, ...normalized } : m)
            );
          }
        }
      );

    const cleanupSubscription = subscribeWithBackoff({
      healthKey: 'messages',
      createChannel,
      onSubscribed: (recovered) => {
        if (recovered) {
          // syncNewMessages em vez de fetchMessages: recupera os INSERTs
          // perdidos na queda sem resetar a posição de scroll.
          syncNewMessages();
        }
      },
    });

    // Visibility change handler - use syncNewMessages to avoid scroll reset
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && conversationIdRef.current) {
        // Use syncNewMessages instead of fetchMessages to preserve scroll position
        syncNewMessages();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cleanupSubscription();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (fetchDebounceRef.current) {
        clearTimeout(fetchDebounceRef.current);
      }
    };
  }, [conversationId, fetchMessages, syncNewMessages]);

  return {
    messages,
    isLoading,
    isLoadingMore,
    isFetchingAll,
    hasMore,
    fetchMessages,
    loadMore,
    fetchAllMessages,
    sendMessage,
    editMessage,
    deleteMessage,
    reactToMessage,
    retryMessage,
    discardMessage,
    clearMessages,
    setMessages, // Exposed for optimistic updates from parent
  };
}
