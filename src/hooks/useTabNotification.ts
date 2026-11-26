import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useNotifications } from "@/contexts/NotificationContext";
import {
    initFaviconBadge,
    setFaviconBadge,
    clearFaviconBadge,
} from "@/lib/faviconBadge";

/**
 * Sinaliza mensagens não lidas de conversas do usuário logado:
 * - Badge no favicon (sempre ativo).
 * - Título da aba piscando quando `document.hidden === true`.
 *
 * Agrega dois contadores (§8 Q13/Q14 da spec de guarda compartilhada):
 *   - `myUnreadTotal`: conversas onde sou o dono primário (`assigned_to === userId`).
 *   - `sharedUnreadTotal`: conversas onde sou co-proprietário (modo exclusivo,
 *     não-sobreposto com `myUnreadTotal`).
 *
 * Conversas com `status === "closed"` são ignoradas.
 */
export const useTabNotification = () => {
    const { conversations, unreadCounts } = useNotifications();
    const [userId, setUserId] = useState<string | null>(null);
    const [isHidden, setIsHidden] = useState<boolean>(
        typeof document !== "undefined" ? document.hidden : false
    );

    // 1) Fetch current user id once
    useEffect(() => {
        supabase.auth.getUser().then(({ data }) => {
            setUserId(data.user?.id ?? null);
        });
    }, []);

    // 2) Track tab visibility
    useEffect(() => {
        const handleVisibility = () => setIsHidden(document.hidden);
        document.addEventListener("visibilitychange", handleVisibility);
        return () => {
            document.removeEventListener("visibilitychange", handleVisibility);
        };
    }, []);

    // 3) Init favicon base once
    useEffect(() => {
        initFaviconBadge();
    }, []);

    // 4a) Unread total for conversations assigned to me as primary
    const myUnreadTotal = useMemo(() => {
        if (!userId) return 0;
        let total = 0;
        for (const conv of conversations) {
            if (conv.assigned_to === userId && conv.status !== "closed") {
                total += unreadCounts.get(conv.id) || 0;
            }
        }
        return total;
    }, [conversations, unreadCounts, userId]);

    // 4b) Unread total for conversations where I'm co-owner only (exclusive mode)
    const sharedUnreadTotal = useMemo(() => {
        if (!userId) return 0;
        let total = 0;
        for (const conv of conversations) {
            const isCoOwnerOnly =
                conv.assigned_to !== userId &&
                (conv.co_assignee_ids?.includes(userId) ?? false);
            if (isCoOwnerOnly && conv.status !== "closed") {
                total += unreadCounts.get(conv.id) || 0;
            }
        }
        return total;
    }, [conversations, unreadCounts, userId]);

    // 4c) Aggregated total (§8 Q14 resolved: contemplar ambos).
    // NOTA: fora do Dashboard (conversations vazio) o badge fica em 0. Um
    // fallback pelo unreadCounts foi tentado e revertido quando a RPC ainda era
    // org-wide. Hoje get_unread_counts já é per-user (marca d'água em
    // conversation_reads) e escopada por telefone/janela
    // (get_my_conversation_phone_ids) — reavaliar o fallback
    // é decisão de feature, não bug.
    const totalUnread = myUnreadTotal + sharedUnreadTotal;

    // 5) Favicon badge: always reflects aggregated total
    useEffect(() => {
        if (totalUnread > 0) {
            setFaviconBadge(totalUnread);
        } else {
            clearFaviconBadge();
        }
    }, [totalUnread]);

    // 6) Title flashing: only when tab hidden AND there are unreads
    useEffect(() => {
        if (totalUnread <= 0 || !isHidden) {
            return;
        }

        const baseTitle = document.title;
        const flashTitle = `(${totalUnread}) 💬 Nova mensagem · Echo`;
        let toggle = false;

        // Set immediately so the user sees the alert on first tick
        document.title = flashTitle;
        toggle = true;

        const intervalId = window.setInterval(() => {
            toggle = !toggle;
            document.title = toggle ? flashTitle : baseTitle;
        }, 1000);

        return () => {
            window.clearInterval(intervalId);
            document.title = baseTitle;
        };
    }, [totalUnread, isHidden]);
};
