
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useNotifications } from "@/contexts/NotificationContext";
import { useNotificationSound } from "@/hooks/useNotificationSound";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { ensureNotificationPermission, showNativeNotification } from "@/lib/nativeNotification";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { subscribeWithBackoff } from "@/lib/realtimeReconnect";
import { broadcastConversationPayloadSchema } from "@/lib/conversationRealtime";
import { useRealtimeFallbackPoll } from "@/hooks/useRealtimeFallbackPoll";
import { hasRingableUnreadIncrease } from "@/lib/unread";
import { classificarUpdate } from "@/lib/messageUpdateNotify";

// Shape of the realtime `messages` row fields this listener reads.
interface MessageRow {
    id: string;
    conversation_id: string;
    content: string | null;
    message_type: string | null;
    direction: "inbound" | "outbound";
    created_at?: string | null;
    metadata?: Record<string, unknown> | null;
    status: string | null;
    read_at: string | null;
}

// Linha de `message_reactions` (INSERT de reação de cliente) e a mensagem alvo, lida pela RLS.
interface ReactionRow {
    id: string;
    message_id: string;
    emoji: string;
    is_from_me: boolean;
}
interface ReactedMessage {
    id: string;
    conversation_id: string;
    content: string | null;
    message_type: string | null;
    direction: "inbound" | "outbound";
    created_at: string | null;
    is_deleted: boolean | null;
}

// Ownership fields fetched per conversation to decide whether to notify.
interface ConvOwnership {
    contact_name: string | null;
    assigned_to: string | null;
    conversation_assignees: Array<{ user_id: string }> | null;
}

const RECONNECT_MAX_MS = 30000;

function preview(content: string | null, max: number): string {
    const text = content ?? "";
    return text.length > max ? `${text.substring(0, max)}…` : text;
}

export const GlobalNotificationListener = () => {
    const {
        activeConversationId,
        incrementUnread,
        incrementFailed,
        handleNewMessage,
        triggerConversationRefresh,
        refreshUnreadCounts,
        isMuted,
        findConversation,
        unreadCounts,
        chaveDoMapaDeNaoLidos,
    } = useNotifications();

    // Ref pelo mesmo motivo do activeConversationIdRef: isMuted muda de
    // identidade a cada pref alterada e não pode re-assinar o canal.
    const isMutedRef = useRef(isMuted);
    useEffect(() => {
        isMutedRef.current = isMuted;
    }, [isMuted]);
    const { playNotificationSound } = useNotificationSound();
    const navigate = useNavigate();
    const [userId, setUserId] = useState<string | null>(null);

    // Ref pelo mesmo motivo do isMutedRef, e este é o que mais custava: o
    // `navigate` do react-router tem `locationPathname` nos próprios deps, então
    // ganha identidade nova A CADA NAVEGAÇÃO. Como o Dashboard navega ao clicar
    // numa conversa, tê-lo nos deps fazia todo clique derrubar e recriar os dois
    // canais abaixo — em toda aba aberta. Isso é churn em realtime.subscription,
    // e o walrus (realtime.list_changes) já é 43,8% do tempo do banco.
    const navigateRef = useRef(navigate);
    useEffect(() => {
        navigateRef.current = navigate;
    }, [navigate]);

    // Read the active conversation through a ref so the realtime channel does
    // NOT resubscribe every time the user switches conversations. Resubscribing
    // tore the channel down and reopened it, leaving a window with no listener
    // where inbound INSERTs were missed (no badge, no notification).
    const activeConversationIdRef = useRef<string | null>(activeConversationId);
    useEffect(() => {
        activeConversationIdRef.current = activeConversationId;
    }, [activeConversationId]);

    useEffect(() => {
        supabase.auth.getUser().then(({ data }) => {
            setUserId(data.user?.id ?? null);
        });
    }, []);

    // Register this device for server-sent Web Push (closed-tab notifications).
    // No-op until permission is granted and the VAPID public key is configured.
    usePushSubscription(userId);

    // Pre-prompt explícito em vez do pedido de emboscada no primeiro clique
    // (o prompt no meio de um gesto qualquer é o padrão que Chrome/Safari
    // punem com bloqueio permanente). O request real só dispara no botão do
    // toast — ainda é um gesto do usuário, como os browsers exigem.
    useEffect(() => {
        if (!userId) return;
        if (typeof Notification === "undefined") return;
        if (Notification.permission !== "default") return;
        if (localStorage.getItem("echo_notif_preprompt_v1")) return;

        // A flag só é gravada quando o toast é RESPONDIDO ou expira na tela —
        // gravar antes queimava a única chance se o app fechasse antes de o
        // usuário ver o convite.
        const markSeen = () => localStorage.setItem("echo_notif_preprompt_v1", "1");
        toast("Ativar notificações de novas mensagens?", {
            description: "Receba alertas do sistema mesmo com a aba em segundo plano.",
            duration: 15000,
            onDismiss: markSeen,
            onAutoClose: markSeen,
            action: {
                label: "Ativar",
                onClick: () => {
                    markSeen();
                    void ensureNotificationPermission();
                },
            },
        });
    }, [userId]);

    // Listen for conversation transfers + shared custody adds via broadcast
    // (Supabase realtime doesn't send UPDATEs for RLS-filtered rows)
    useEffect(() => {
        if (!userId) return;

        // Payload de broadcast é input externo: validado antes de tocar na lista.
        // Com id válido a lista rebusca SÓ aquela conversa; payload inválido cai
        // no refetch completo da linha (comportamento antigo) para não perder nada.
        const refreshFromPayload = (raw: unknown): { conversationId: string | null; contactName: string | null; sectorName: string | null } => {
            const parsed = broadcastConversationPayloadSchema.safeParse(raw);
            if (!parsed.success) {
                console.warn("[Broadcast] payload inválido, refetch completo:", parsed.error.issues[0]?.message);
                triggerConversationRefresh();
                return { conversationId: null, contactName: null, sectorName: null };
            }
            triggerConversationRefresh(parsed.data.conversationId);
            return {
                conversationId: parsed.data.conversationId,
                contactName: parsed.data.contactName ?? null,
                sectorName: parsed.data.sectorName ?? null,
            };
        };

        const channel = supabase
            .channel(`user-${userId}-notifications`)
            .on("broadcast", { event: "conversation-transfer" }, (payload) => {
                const { conversationId, contactName } = refreshFromPayload(payload.payload);
                console.log("[Broadcast] Conversation transfer received:", conversationId);

                // Play sound + show toast notification
                playNotificationSound();
                toast(`Nova conversa transferida`, {
                    description: `${contactName || "Conversa"} foi transferida para você`,
                    action: {
                        label: "Ver",
                        onClick: () => navigateRef.current(`/dashboard/${conversationId}`),
                    },
                });
            })
            .on("broadcast", { event: "conversation-shared" }, (payload) => {
                // O novo codono passa a ver a conversa agora: o refresh pontual a traz.
                const { conversationId, contactName } = refreshFromPayload(payload.payload);
                console.log("[Broadcast] Conversation shared received:", conversationId);

                playNotificationSound();
                toast(`Compartilharam uma conversa com você`, {
                    description: `${contactName || "Conversa"} agora está em suas copropriedades`,
                    action: {
                        label: "Ver",
                        onClick: () => navigateRef.current(`/dashboard/${conversationId}`),
                    },
                });
            })
            .on("broadcast", { event: "conversation-left-scope" }, (payload) => {
                // Conversa que SAIU do meu escopo (encaminhada para outro setor
                // isolado): só rebusca — o select devolve 0 linhas e ela some.
                refreshFromPayload(payload.payload);
            })
            .on("broadcast", { event: "conversation-sector-changed" }, (payload) => {
                // Quem encaminhou manda este evento para cada membro do setor
                // destino: a conversa entrou no escopo deles agora, e o UPDATE do
                // postgres_changes não chega para quem não podia ver a linha antes.
                const { conversationId, contactName, sectorName } = refreshFromPayload(payload.payload);
                console.log("[Broadcast] Conversation sector changed:", conversationId);

                playNotificationSound();
                toast(`Conversa encaminhada para o seu setor`, {
                    description: `${contactName || "Conversa"} está na fila${sectorName ? ` de ${sectorName}` : ""}`,
                    action: {
                        label: "Ver",
                        onClick: () => navigateRef.current(`/dashboard/${conversationId}`),
                    },
                });
            })
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [userId, triggerConversationRefresh, playNotificationSound]);

    // Contorno para queda do Realtime: busca de reserva
    // do não-lido. Com o canal global caído, o INSERT não chega e nada tocava;
    // a busca acusa o aumento e o som segue as mesmas regras do INSERT.
    const globalChannelDownRef = useRef(false);
    useRealtimeFallbackPoll(
        async () => {
            const before = unreadCounts;
            const chaveAntes = chaveDoMapaDeNaoLidos();
            const after = await refreshUnreadCounts();
            if (!after || !globalChannelDownRef.current) return;
            // A lista trocou de número enquanto a busca estava em voo: o mapa que chegou é de outro
            // escopo, e comparar com o de antes daria um "aumento" que não existe (um toque falso).
            if (chaveDoMapaDeNaoLidos() !== chaveAntes) return;
            const ring = hasRingableUnreadIncrease(before, after, {
                userId,
                activeConversationId: activeConversationIdRef.current,
                tabHidden: document.hidden,
                isMuted: (id) => isMutedRef.current(id),
                ownership: (id) => {
                    const conv = findConversation(id);
                    return conv
                        ? { assignedTo: conv.assigned_to, coAssigneeIds: conv.co_assignee_ids ?? [] }
                        : undefined;
                },
            });
            if (ring) playNotificationSound();
        },
        { degradedMs: 10_000, healthyMs: 60_000, enabled: !!userId },
    );

    useEffect(() => {
        // Guarda igual à dos dois efeitos acima. Sem ela o canal era aberto uma
        // vez com userId nulo e recriado assim que o getUser resolvia — uma
        // subscription descartada por aba, por sessão. Nada é perdido esperando:
        // o gate de notificação é fail-closed em userId, então o canal aberto
        // cedo demais não notificaria ninguém de qualquer forma.
        if (!userId) return;

        // Fetch conversation ownership, retrying with backoff on an empty result
        // (replication/timing lag between the message INSERT event and the
        // conversations read). The retries protect real owners from transient
        // lag; if the row still can't be read after them, the caller must treat
        // ownership as NOT confirmed (fail-closed) — realtime delivery only
        // proves org-level visibility, never ownership.
        const fetchOwnership = async (conversationId: string): Promise<ConvOwnership | null> => {
            // A lista em memória já tem dono e codonos da conversa: sem rede.
            // O select com retries fica só para conversa ausente da lista
            // (outra linha, ainda não carregada) — fail-closed preservado.
            const local = findConversation(conversationId);
            if (local) {
                return {
                    contact_name: local.contact_name,
                    assigned_to: local.assigned_to,
                    conversation_assignees: (local.co_assignee_ids ?? []).map((user_id) => ({ user_id })),
                };
            }

            const query = () =>
                supabase
                    .from("conversations")
                    .select("contact_name, assigned_to, conversation_assignees(user_id)")
                    .eq("id", conversationId)
                    .maybeSingle();

            let { data } = await query();
            for (const delay of [400, 1000]) {
                if (data) break;
                await new Promise((resolve) => setTimeout(resolve, delay));
                ({ data } = await query());
            }
            return (data as unknown as ConvOwnership) ?? null;
        };

        const handleInboundInsert = async (row: MessageRow) => {
            const conversationId = row.conversation_id;

            // Linhas que já nascem com read_at são "lidas para todos por
            // design": eventos de grupo (webhook) e histórico importado. Sem
            // este corte, uma rodada de import-history disparava badge e som
            // para a org inteira, e o servidor logo devolveria zero — badge
            // fantasma que só sumia no próximo refresh.
            if (row.read_at) return;

            // Group participant events are silent system logs — no sound, toast or unread badge.
            if (row.message_type === "group_action") return;

            // Always increment unread locally for the sidebar
            incrementUnread(conversationId);

            // Update global conversation state (reorder to top + reopen if closed)
            await handleNewMessage(row, { reopen: true });

            const conv = await fetchOwnership(conversationId);
            const assignees = conv?.conversation_assignees;
            const coOwnerIds = Array.isArray(assignees) ? assignees.map((a) => a.user_id) : [];
            // Fail-closed: a RLS de messages é escopada por linha para agents
            // (admins seguem org-wide), então este INSERT ainda chega a todo
            // admin e a agents da linha — o check de dono/co-dono abaixo segue
            // sendo o que mantém as conversas dos outros em silêncio. Se a
            // posse não puder ser confirmada (conv null após retries, ou userId
            // ainda não carregado — null === null casaria errado com conversa
            // sem dono), NÃO notifica; fail-open aqui toastaria a org.
            const userIsInvolved =
                userId !== null &&
                conv !== null &&
                (conv.assigned_to === userId || coOwnerIds.includes(userId));

            if (!userIsInvolved) return;

            // Silenciada: badge continua (incrementUnread já rodou), mas nada
            // de som/toast/notificação — paridade com o mute do WhatsApp.
            if (isMutedRef.current(conversationId)) return;

            const activeId = activeConversationIdRef.current;
            const contactName = conv?.contact_name || "Contato";

            // Play sound if tab is hidden OR conversation is not active
            if (document.hidden || conversationId !== activeId) {
                playNotificationSound();
            }

            // Tab in the background: fire an OS-level notification so the alert
            // survives the tab losing focus (in-tab toast is easy to miss).
            if (document.hidden) {
                showNativeNotification(`Nova mensagem de ${contactName}`, {
                    body: preview(row.content, 80),
                    tag: `conv-${conversationId}`,
                    onClick: () => navigateRef.current(`/dashboard/${conversationId}`),
                });
            }

            // Show toast only if it's NOT the active conversation
            if (conversationId !== activeId) {
                toast(`Nova mensagem de ${contactName}`, {
                    description: preview(row.content, 50),
                    action: {
                        label: "Ver",
                        onClick: () => navigateRef.current(`/dashboard/${conversationId}`),
                    },
                });
            }
        };

        // Falhas já notificadas nesta sessão (por id). Com RLS o `old` do Realtime traz só a PK, então
        // sem isto todo UPDATE de metadata (leitura, link preview, edição)
        // numa mensagem `failed` soaria como falha nova. Ver classificarUpdate.
        const falhasVistas = new Set<string>();

        const handleMessageUpdate = async (oldMsg: Partial<MessageRow> | null, newMsg: MessageRow) => {
            // Send failure on Meta Cloud API numbers: status transitions to 'failed'.
            // No ownership filter — anyone with RLS access to the conversation sees the UPDATE
            // and should get the badge + sound.
            // Reação NÃO é tratada aqui: vem do INSERT em message_reactions (handleReactionInsert).
            if (classificarUpdate(oldMsg, newMsg, falhasVistas) === "falha") {
                const conversationId = newMsg.conversation_id;

                const { data: conv } = await supabase
                    .from("conversations")
                    .select("phone_number:phone_numbers!inner(connection_type)")
                    .eq("id", conversationId)
                    .maybeSingle();

                const connectionType = (conv as unknown as { phone_number?: { connection_type?: string } })
                    ?.phone_number?.connection_type;
                if (connectionType !== "business_api") return;

                playNotificationSound();
                incrementFailed(conversationId);
            }
        };

        // Reação de cliente: o INSERT em message_reactions (is_from_me=false) é o único gatilho.
        // Busca a mensagem alvo pela RLS (falha de leitura = sem notificação, fail-closed), reordena a
        // lista e aplica o mesmo gate de dono/co-dono do INSERT inbound.
        const handleReactionInsert = async (reaction: ReactionRow) => {
            if (!reaction?.message_id || !reaction.emoji || reaction.is_from_me) return;

            const { data, error } = await supabase
                .from("messages")
                .select("id, conversation_id, content, message_type, direction, created_at, is_deleted")
                .eq("id", reaction.message_id)
                .maybeSingle();
            if (error || !data) return;
            const target = data as unknown as ReactedMessage;
            const conversationId = target.conversation_id;

            // Reorder conversation in sidebar
            await handleNewMessage(target);

            // Only notify if it's NOT the active conversation
            if (conversationId === activeConversationIdRef.current) return;

            const conv = await fetchOwnership(conversationId);
            const assignees = conv?.conversation_assignees;
            const coOwnerIds = Array.isArray(assignees) ? assignees.map((a) => a.user_id) : [];
            // Fail-closed — same reasoning as the inbound INSERT gate above.
            const userIsInvolved =
                userId !== null &&
                conv !== null &&
                (conv.assigned_to === userId || coOwnerIds.includes(userId));
            if (!userIsInvolved) return;

            // Play sound + show toast if user is primary OR co-owner
            playNotificationSound();
            toast(`Reação de ${conv?.contact_name || "Contato"}`, {
                description: `${reaction.emoji} em: ${preview(target.content, 30)}`,
                action: {
                    label: "Ver",
                    onClick: () => navigateRef.current(`/dashboard/${conversationId}`),
                },
            });
        };

        // (Re)connect with backoff (subscribeWithBackoff). Supabase does not always
        // auto-rejoin a channel after CHANNEL_ERROR/TIMED_OUT, and a dead channel
        // silently stops every badge + notification. On a successful (re)subscribe
        // we refresh unread counts so any INSERTs missed while disconnected are
        // recovered.
        const createChannel = () =>
            supabase
                .channel("global-notifications")
                .on(
                    "postgres_changes",
                    { event: "INSERT", schema: "public", table: "messages", filter: "direction=eq.inbound" },
                    (payload) => {
                        void handleInboundInsert(payload.new as unknown as MessageRow);
                    }
                )
                .on(
                    "postgres_changes",
                    { event: "UPDATE", schema: "public", table: "messages" },
                    (payload) => {
                        void handleMessageUpdate(
                            payload.old as unknown as Partial<MessageRow> | null,
                            payload.new as unknown as MessageRow
                        );
                    }
                )
                .on(
                    "postgres_changes",
                    { event: "INSERT", schema: "public", table: "message_reactions", filter: "is_from_me=eq.false" },
                    (payload) => {
                        void handleReactionInsert(payload.new as unknown as ReactionRow);
                    }
                );

        const cleanupSubscription = subscribeWithBackoff({
            healthKey: "global-notifications",
            createChannel,
            maxDelayMs: RECONNECT_MAX_MS,
            onDown: () => {
                globalChannelDownRef.current = true;
            },
            onSubscribed: (reassinou) => {
                // Reassinatura = houve um intervalo sem entrega (CHANNEL_ERROR antes, ou o
                // rejoin silencioso do socket). A busca de não-lido que já estiver em voo
                // tirou a foto do servidor ANTES da assinatura: o INSERT que caiu entre as
                // duas não está nela nem chegou pelo canal. Por isso só uma busca iniciada
                // agora serve. A primeira assinatura da carga continua dividindo o voo
                // inicial: a janela ali é curta, o poll de reserva a fecha em até 60 s, e
                // uma busca a mais por número a cada carga seria custo sem queda nenhuma.
                globalChannelDownRef.current = false;
                // Recover any unread increments missed while the channel was down.
                void refreshUnreadCounts(reassinou ? { fresca: true } : undefined);
            },
        });

        return () => {
            globalChannelDownRef.current = false;
            cleanupSubscription();
        };
    }, [
        userId,
        incrementUnread,
        incrementFailed,
        handleNewMessage,
        findConversation,
        playNotificationSound,
        refreshUnreadCounts,
    ]);

    return null;
};
