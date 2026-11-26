import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toUserMessage } from "@/lib/userFacingError";
import { camposDoApelido } from "@/lib/nomeDoGrupo";

export interface Conversation {
  id: string;
  contact_name: string;
  contact_phone: string;
  is_group?: boolean;
  group_jid?: string;
  /** Nome do grupo no WhatsApp; `contact_name` é o nome exibido (pode ser apelido). */
  group_subject?: string | null;
  contact_avatar_url?: string | null;
  channel?: 'whatsapp' | 'instagram';
  instagram_username?: string | null;
  instagram_user_id?: string | null;
}

interface UseConversationOptions {
  conversationId: string | null;
  userId: string;
  /**
   * Dados que o chamador já tem da conversa (vindos da lista) para semear o
   * header instantaneamente na troca — o fetch completa os campos depois.
   */
  seedConversation?: Conversation | null;
  onConversationUpdate?: (clearSelection?: boolean) => void;
  /**
   * A conversa aberta deixou de ser visível para quem a abriu (a RLS devolve 0
   * linhas: outra pessoa a assumiu, ou saiu do acesso). Só dispara com 0 linhas
   * de verdade; erro de rede/servidor não conta.
   */
  onInaccessible?: (conversationId: string) => void;
  onNotesRefresh?: () => void;
  onSuccess?: (title: string, description?: string) => void;
  onError?: (title: string, description: string) => void;
}

export function useConversation({
  conversationId,
  userId,
  seedConversation = null,
  onConversationUpdate,
  onInaccessible,
  onNotesRefresh,
  onSuccess,
  onError,
}: UseConversationOptions) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  // Edit name state
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");
  const [isSavingName, setIsSavingName] = useState(false);
  const editNameInputRef = useRef<HTMLInputElement>(null);

  // Edit phone state
  const [isEditingPhone, setIsEditingPhone] = useState(false);
  const [editPhoneValue, setEditPhoneValue] = useState("");
  const [isSavingPhone, setIsSavingPhone] = useState(false);
  const editPhoneInputRef = useRef<HTMLInputElement>(null);

  // Ref to track current conversation
  const conversationIdRef = useRef(conversationId);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  // Latest-value ref: o seed muda de identidade a cada render do chamador e não
  // deve re-disparar o effect de troca — só é lido no instante da troca.
  const seedRef = useRef(seedConversation);
  seedRef.current = seedConversation;

  // Idem: o chamador costuma passar uma função nova a cada render, e o fetch não
  // pode refazer a busca por causa disso.
  const onInaccessibleRef = useRef(onInaccessible);
  onInaccessibleRef.current = onInaccessible;

  // Fetch conversation data
  const fetchConversation = useCallback(async () => {
    const currentId = conversationId;
    if (!currentId) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("conversations")
        .select("id, contact_name, contact_phone, is_group, group_jid, group_subject, contact_avatar_url, channel, instagram_username, instagram_user_id")
        .eq("id", currentId)
        .maybeSingle();

      if (conversationIdRef.current !== currentId) return;

      if (error) {
        console.error("Error fetching conversation:", error);
        return;
      }

      // 0 linhas sem erro = a RLS esconde a conversa de quem a abriu (outra
      // pessoa a assumiu). O chamador tira da lista e sai dela.
      if (!data) {
        onInaccessibleRef.current?.(currentId);
        return;
      }

      setConversation(data as unknown as Conversation);
    } finally {
      setIsLoading(false);
    }
  }, [conversationId]);

  // Ao trocar de conversa, semear o estado com os dados que a lista já tem
  // (nome/telefone/avatar) em vez de zerar — o header nunca desmonta e o fetch
  // apenas completa campos que faltam (ex.: group_jid). Sem seed (deep-link),
  // fica null e o chamador mostra um placeholder de altura fixa.
  useEffect(() => {
    // Edição aberta é da conversa anterior. O header não desmonta na troca, e
    // sem este reset o campo seguia aberto com o valor do card anterior: um
    // Enter gravava o telefone de um contato no card de um grupo.
    setIsEditingName(false);
    setEditNameValue("");
    setIsEditingPhone(false);
    setEditPhoneValue("");
    if (!conversationId) {
      setConversation(null);
      return;
    }
    const seed = seedRef.current;
    setConversation(seed && seed.id === conversationId ? seed : null);
    fetchConversation();
  }, [conversationId, fetchConversation]);

  // Card aberto: a lista recebe o UPDATE da conversa por realtime e a semente
  // muda. Sem acompanhar, nome/telefone/avatar ficavam velhos até um F5, e o
  // telefone é o destino de todo envio do card (grupo corrigido no
  // banco seguia mandando para o número antigo na aba aberta).
  const seedId = seedConversation?.id;
  const seedName = seedConversation?.contact_name;
  const seedPhone = seedConversation?.contact_phone;
  const seedAvatar = seedConversation?.contact_avatar_url;
  useEffect(() => {
    if (!seedId || seedId !== conversationIdRef.current) return;
    setConversation((prev) => {
      if (!prev || prev.id !== seedId) return prev;
      if (prev.contact_name === seedName && prev.contact_phone === seedPhone && (seedAvatar === undefined || prev.contact_avatar_url === seedAvatar)) {
        return prev;
      }
      return {
        ...prev,
        contact_name: seedName ?? prev.contact_name,
        contact_phone: seedPhone ?? prev.contact_phone,
        contact_avatar_url: seedAvatar === undefined ? prev.contact_avatar_url : seedAvatar,
      };
    });
  }, [seedId, seedName, seedPhone, seedAvatar]);

  // Edit name functions
  const startEditName = useCallback(() => {
    if (!conversation) return;
    setEditNameValue(conversation.contact_name);
    setIsEditingName(true);
    setTimeout(() => editNameInputRef.current?.focus(), 50);
  }, [conversation]);

  const cancelEditName = useCallback(() => {
    setIsEditingName(false);
    setEditNameValue("");
  }, []);

  const saveContactName = useCallback(async () => {
    if (!conversation || !editNameValue.trim() || isSavingName) return false;
    if (editNameValue.trim() === conversation.contact_name) {
      cancelEditName();
      return true;
    }

    setIsSavingName(true);
    try {
      // Grupo: os nomes vêm do banco na hora, não do estado da tela (pode estar sem
      // group_subject antes do fetch, ou velho se outro atendente mexeu).
      let campos: { contact_name: string; group_subject?: string } = { contact_name: editNameValue.trim() };
      if (conversation.is_group) {
        const { data: atual, error: readError } = await supabase
          .from("conversations")
          .select("is_group, contact_name, group_subject, group_jid")
          .eq("id", conversation.id)
          .single();
        if (readError) throw readError;
        campos = camposDoApelido(atual, editNameValue);
      }
      const { error } = await supabase
        .from("conversations")
        .update(campos)
        .eq("id", conversation.id);

      if (error) throw error;

      setConversation(prev => prev ? { ...prev, ...campos } : null);
      setIsEditingName(false);
      setEditNameValue("");
      onConversationUpdate?.(false);

      onSuccess?.("Nome atualizado", `Nome alterado para "${editNameValue.trim()}"`);
      return true;
    } catch (error: unknown) {
      console.error('[useConversation] Error updating contact name:', error);
      const errorMessage = toUserMessage(error);
      onError?.("Não foi possível atualizar nome", errorMessage);
      return false;
    } finally {
      setIsSavingName(false);
    }
  }, [conversation, editNameValue, isSavingName, cancelEditName, onConversationUpdate, onSuccess, onError]);

  // Edit phone functions
  const startEditPhone = useCallback(() => {
    if (!conversation) return;
    setEditPhoneValue(conversation.contact_phone);
    setIsEditingPhone(true);
    setTimeout(() => editPhoneInputRef.current?.focus(), 50);
  }, [conversation]);

  const cancelEditPhone = useCallback(() => {
    setIsEditingPhone(false);
    setEditPhoneValue("");
  }, []);

  const saveContactPhone = useCallback(async () => {
    if (!conversation || !editPhoneValue.trim() || isSavingPhone) return false;
    if (editPhoneValue.trim() === conversation.contact_phone) {
      cancelEditPhone();
      return true;
    }

    setIsSavingPhone(true);
    try {
      const { error } = await supabase
        .from("conversations")
        .update({ contact_phone: editPhoneValue.trim() })
        .eq("id", conversation.id);

      if (error) throw error;

      setConversation(prev => prev ? { ...prev, contact_phone: editPhoneValue.trim() } : null);
      setIsEditingPhone(false);
      setEditPhoneValue("");
      onConversationUpdate?.(false);

      onSuccess?.("Número atualizado", `Número alterado para "${editPhoneValue.trim()}"`);
      return true;
    } catch (error: unknown) {
      console.error('[useConversation] Error updating contact phone:', error);
      const errorMessage = toUserMessage(error);
      onError?.("Não foi possível atualizar número", errorMessage);
      return false;
    } finally {
      setIsSavingPhone(false);
    }
  }, [conversation, editPhoneValue, isSavingPhone, cancelEditPhone, onConversationUpdate, onSuccess, onError]);

  // Release conversation
  const releaseConversation = useCallback(async () => {
    if (!conversationId || isUpdating) return false;

    setIsUpdating(true);
    try {
      const { error } = await supabase
        .from("conversations")
        .update({ assigned_to: null, status: "waiting" })
        .eq("id", conversationId);

      if (error) throw error;

      onSuccess?.("Conversa liberada", "A conversa foi devolvida para a fila de espera");
      onConversationUpdate?.();
      return true;
    } catch (error: any) {
      onError?.("Não foi possível liberar conversa", error.message);
      return false;
    } finally {
      setIsUpdating(false);
    }
  }, [conversationId, isUpdating, onConversationUpdate, onSuccess, onError]);

  // Transfer conversation (uses the promote_co_owner_to_primary RPC so it handles
  // the shared-custody edge cases transactionally: removes target from co_owners if
  // they were there, and optionally demotes the old primary to co-owner).
  const transferConversation = useCallback(async (
    targetUserId: string,
    targetUserName: string,
    keepOldAsCoOwner: boolean = false,
  ) => {
    if (!conversationId || isUpdating) return false;

    setIsUpdating(true);
    try {
      // Get conversation name before transfer
      const { data: convData } = await supabase
        .from("conversations")
        .select("contact_name")
        .eq("id", conversationId)
        .single();

      // A nota vai ANTES da transferência: depois dela, quem transferiu pode não
      // enxergar mais a conversa (linha com "só quem assumiu vê", ou setor) e o
      // INSERT em conversation_notes cai na RLS (42501), perdendo o registro.
      // Se a transferência falhar, a nota sai.
      const noteContent = keepOldAsCoOwner
        ? `Conversa transferida para ${targetUserName}. O responsável anterior continua acompanhando.`
        : `Conversa transferida para ${targetUserName}`;
      const { data: note, error: noteError } = await supabase
        .from("conversation_notes" as never)
        .insert({
          conversation_id: conversationId,
          content: noteContent,
          created_by: userId,
        } as never)
        .select("id")
        .maybeSingle();

      if (noteError) {
        console.error("Error creating transfer note:", noteError);
      }
      const noteId = (note as { id?: string } | null)?.id ?? null;

      const { error: rpcError } = await supabase.rpc("promote_co_owner_to_primary", {
        p_conversation_id: conversationId,
        p_new_primary_user_id: targetUserId,
        p_keep_old_as_co_owner: keepOldAsCoOwner,
      });

      if (rpcError) {
        if (noteId) {
          const { error: undoError } = await supabase
            .from("conversation_notes" as never)
            .delete()
            .eq("id", noteId);
          if (undoError) console.error("Error removing transfer note after failed transfer:", undoError);
        }
        throw rpcError;
      }

      // Broadcast to notify the target user (Supabase realtime doesn't send UPDATEs to users who couldn't see the row before).
      //
      // A guarda não é otimização: `supabase.channel()` deduplica por tópico e
      // devolve o canal JÁ EXISTENTE. Transferindo para si mesmo, isto pegaria o
      // canal vivo do GlobalNotificationListener e o `removeChannel` abaixo o
      // derrubaria — o usuário ficaria sem nenhuma notificação até dar F5.
      // Mesma guarda que forwardToSector já fazia no loop de membros.
      if (targetUserId !== userId) {
        const channel = supabase.channel(`user-${targetUserId}-notifications`);
        await channel.send({
          type: "broadcast",
          event: "conversation-transfer",
          payload: {
            conversationId,
            contactName: convData?.contact_name || "Conversa",
          },
        });
        supabase.removeChannel(channel);
      }

      onSuccess?.("Conversa transferida", `O atendimento foi transferido para ${targetUserName}`);
      onConversationUpdate?.();
      onNotesRefresh?.();
      return true;
    } catch (error: unknown) {
      const msg = toUserMessage(error);
      onError?.("Não foi possível transferir conversa", msg);
      return false;
    } finally {
      setIsUpdating(false);
    }
  }, [conversationId, userId, isUpdating, onConversationUpdate, onNotesRefresh, onSuccess, onError]);

  // Close conversation
  const closeConversation = useCallback(async (reason: string) => {
    if (!conversationId || isUpdating) return false;

    setIsUpdating(true);
    try {
      const { error } = await supabase
        .from("conversations")
        .update({
          status: "closed",
          close_reason: reason,
          closed_at: new Date().toISOString(),
          closed_by: userId
        })
        .eq("id", conversationId);

      if (error) throw error;

      onSuccess?.("Atendimento encerrado", "A conversa foi encerrada");
      onConversationUpdate?.();
      return true;
    } catch (error: any) {
      onError?.("Não foi possível encerrar conversa", error.message);
      return false;
    } finally {
      setIsUpdating(false);
    }
  }, [conversationId, userId, isUpdating, onConversationUpdate, onSuccess, onError]);

  /**
   * Encaminhar a conversa para outro setor.
   *
   * O que acontece, e por quê:
   *
   *   1. `sector_id` passa a ser o destino e `assigned_to` é LIMPO — encaminhar
   *      é devolver a conversa para a fila do setor destino, senão ela continuaria
   *      "assumida por alguém de outro setor" e ninguém de lá a puxaria.
   *   2. Quem estava responsável entra como COPROPRIETÁRIO, para não perder o
   *      acesso: sob isolamento, a RLS só a devolveria pelo ramo assignee. A
   *      ordem importa — o trigger `prevent_primary_in_assignees` recusa quem
   *      ainda é `assigned_to`, então o UPDATE vem antes do INSERT.
   *   3. Nota de auditoria: quem moveu, para onde. Encaminhamento errado é o
   *      conserto de "assumi por engano", e precisa deixar rastro.
   *   4. Broadcast para cada membro do setor destino, no MESMO canal
   *      `user-<id>-notifications` que transferência e compartilhamento já usam:
   *      o postgres_changes não entrega UPDATE de linha que o usuário não podia
   *      ver antes, e agora ela está no escopo dele.
   */
  const forwardToSector = useCallback(async (
    targetSectorId: string,
    targetSectorName: string,
  ) => {
    if (!conversationId || isUpdating) return false;

    setIsUpdating(true);
    try {
      const { data: convData, error: readError } = await supabase
        .from("conversations")
        .select("contact_name, assigned_to, sector_id")
        .eq("id", conversationId)
        .single();

      if (readError) throw readError;

      const previousAssignee = convData?.assigned_to ?? null;

      const { error: updateError } = await supabase
        .from("conversations")
        .update({ sector_id: targetSectorId, assigned_to: null, status: "waiting" })
        .eq("id", conversationId);

      if (updateError) throw updateError;

      // Custódia de quem estava atendendo. Falha aqui não desfaz o
      // encaminhamento (já aconteceu), mas não pode ser silenciosa: sem a linha
      // em conversation_assignees, o antigo responsável perde a conversa de vista.
      if (previousAssignee) {
        const { error: coOwnerError } = await supabase
          .from("conversation_assignees")
          .insert({
            conversation_id: conversationId,
            user_id: previousAssignee,
            added_by: userId,
          });

        if (coOwnerError) {
          console.error("Error keeping previous assignee as co-owner:", coOwnerError);
          onError?.(
            "Encaminhado, mas sem acompanhamento",
            "A conversa mudou de setor, porém não foi possível manter o responsável anterior acompanhando.",
          );
        }
      }

      const { error: noteError } = await supabase
        .from("conversation_notes" as never)
        .insert({
          conversation_id: conversationId,
          content: `Conversa encaminhada para o setor ${targetSectorName}`,
          created_by: userId,
        } as never);

      if (noteError) {
        console.error("Error creating sector forward note:", noteError);
      }

      // Fan-out para o setor destino. Uma query em sector_members e um send por
      // membro: é ação manual, não caminho quente.
      const { data: targetMembers } = await supabase
        .from("sector_members")
        .select("user_id")
        .eq("sector_id", targetSectorId);

      for (const member of targetMembers ?? []) {
        if (member.user_id === userId) continue;
        const channel = supabase.channel(`user-${member.user_id}-notifications`);
        await channel.send({
          type: "broadcast",
          event: "conversation-sector-changed",
          payload: {
            conversationId,
            contactName: convData?.contact_name || "Conversa",
            sectorName: targetSectorName,
          },
        });
        supabase.removeChannel(channel);
      }

      // Setor de ORIGEM: sob isolamento, quem ficou lá perdeu o escopo RLS e o
      // walrus não entrega o UPDATE de uma linha que o assinante não pode mais
      // ver. Sem este aviso a conversa ficaria na lista deles até um refetch.
      // Evento próprio, sem toast: só pede a rebusca pontual (0 linhas = some).
      const originSectorId = convData?.sector_id ?? null;
      if (originSectorId && originSectorId !== targetSectorId) {
        const { data: originMembers } = await supabase
          .from("sector_members")
          .select("user_id")
          .eq("sector_id", originSectorId);
        for (const member of originMembers ?? []) {
          if (member.user_id === userId) continue;
          const channel = supabase.channel(`user-${member.user_id}-notifications`);
          await channel.send({
            type: "broadcast",
            event: "conversation-left-scope",
            payload: { conversationId },
          });
          supabase.removeChannel(channel);
        }
      }

      onSuccess?.(
        "Conversa encaminhada",
        `Agora está na fila do setor ${targetSectorName}. Você continua acompanhando a conversa.`,
      );
      onConversationUpdate?.();
      onNotesRefresh?.();
      return true;
    } catch (error: unknown) {
      const msg = toUserMessage(error);
      onError?.("Não foi possível encaminhar conversa", msg);
      return false;
    } finally {
      setIsUpdating(false);
    }
  }, [conversationId, userId, isUpdating, onConversationUpdate, onNotesRefresh, onSuccess, onError]);

  // Shared custody: add a co-owner to this conversation
  const addCoOwner = useCallback(async (targetUserId: string, targetUserName: string) => {
    if (!conversationId || isUpdating) return false;

    setIsUpdating(true);
    try {
      // Fetch conversation name for broadcast
      const { data: convData } = await supabase
        .from("conversations")
        .select("contact_name")
        .eq("id", conversationId)
        .single();

      const { error: insertError } = await supabase
        .from("conversation_assignees")
        .insert({
          conversation_id: conversationId,
          user_id: targetUserId,
          added_by: userId,
        });

      if (insertError) throw insertError;

      // Audit note
      const { error: noteError } = await supabase
        .from("conversation_notes" as never)
        .insert({
          conversation_id: conversationId,
          content: `${targetUserName} passou a acompanhar esta conversa`,
          created_by: userId,
        } as never);

      if (noteError) {
        console.error("Error creating co-owner note:", noteError);
      }

      // Broadcast to notify the target user — their RLS already lets them see
      // the conversation, but the broadcast triggers an instant refetch on their client.
      // Guarda pelo mesmo motivo de transferConversation: compartilhar consigo
      // mesmo derrubaria o próprio canal de notificações.
      if (targetUserId !== userId) {
        const channel = supabase.channel(`user-${targetUserId}-notifications`);
        await channel.send({
          type: "broadcast",
          event: "conversation-shared",
          payload: {
            conversationId,
            contactName: convData?.contact_name || "Conversa",
          },
        });
        supabase.removeChannel(channel);
      }

      onSuccess?.("Atendente adicionado", `${targetUserName} passa a acompanhar esta conversa`);
      onConversationUpdate?.();
      onNotesRefresh?.();
      return true;
    } catch (error: unknown) {
      const msg = toUserMessage(error);
      onError?.("Não foi possível adicionar o atendente", msg);
      return false;
    } finally {
      setIsUpdating(false);
    }
  }, [conversationId, userId, isUpdating, onConversationUpdate, onNotesRefresh, onSuccess, onError]);

  // Shared custody: remove a co-owner (admin/primary action)
  const removeCoOwner = useCallback(async (targetUserId: string, targetUserName: string) => {
    if (!conversationId || isUpdating) return false;

    setIsUpdating(true);
    try {
      const { error: deleteError } = await supabase
        .from("conversation_assignees")
        .delete()
        .eq("conversation_id", conversationId)
        .eq("user_id", targetUserId);

      if (deleteError) throw deleteError;

      // Audit note
      const { error: noteError } = await supabase
        .from("conversation_notes" as never)
        .insert({
          conversation_id: conversationId,
          content: `${targetUserName} deixou de acompanhar esta conversa`,
          created_by: userId,
        } as never);

      if (noteError) {
        console.error("Error creating co-owner removal note:", noteError);
      }

      onSuccess?.("Atendente removido", `${targetUserName} deixa de acompanhar esta conversa`);
      onConversationUpdate?.();
      onNotesRefresh?.();
      return true;
    } catch (error: unknown) {
      const msg = toUserMessage(error);
      onError?.("Não foi possível remover o atendente", msg);
      return false;
    } finally {
      setIsUpdating(false);
    }
  }, [conversationId, userId, isUpdating, onConversationUpdate, onNotesRefresh, onSuccess, onError]);

  // Shared custody: current user leaves the conversation (self-remove as co-owner)
  const leaveSharedConversation = useCallback(async () => {
    if (!conversationId || isUpdating) return false;

    setIsUpdating(true);
    try {
      const { error: deleteError } = await supabase
        .from("conversation_assignees")
        .delete()
        .eq("conversation_id", conversationId)
        .eq("user_id", userId);

      if (deleteError) throw deleteError;

      // Audit note
      const { error: noteError } = await supabase
        .from("conversation_notes" as never)
        .insert({
          conversation_id: conversationId,
          content: "Saiu da conversa compartilhada",
          created_by: userId,
        } as never);

      if (noteError) {
        console.error("Error creating leave note:", noteError);
      }

      onSuccess?.("Você saiu desta conversa", "Ela não aparece mais na aba Compartilhadas.");
      onConversationUpdate?.(true);
      onNotesRefresh?.();
      return true;
    } catch (error: unknown) {
      const msg = toUserMessage(error);
      onError?.("Não foi possível sair da conversa", msg);
      return false;
    } finally {
      setIsUpdating(false);
    }
  }, [conversationId, userId, isUpdating, onConversationUpdate, onNotesRefresh, onSuccess, onError]);

  return {
    conversation,
    isLoading,
    isUpdating,
    fetchConversation,
    // Edit name
    isEditingName,
    editNameValue,
    setEditNameValue,
    isSavingName,
    editNameInputRef,
    startEditName,
    cancelEditName,
    saveContactName,
    // Edit phone
    isEditingPhone,
    editPhoneValue,
    setEditPhoneValue,
    isSavingPhone,
    editPhoneInputRef,
    startEditPhone,
    cancelEditPhone,
    saveContactPhone,
    // Actions
    releaseConversation,
    transferConversation,
    forwardToSector,
    closeConversation,
    // Shared custody
    addCoOwner,
    removeCoOwner,
    leaveSharedConversation,
  };
}
