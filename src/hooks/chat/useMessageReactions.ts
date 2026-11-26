import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPaginated } from "@/lib/fetchAllPaginated";
import { subscribeWithBackoff } from "@/lib/realtimeReconnect";
import { useRealtimeFallbackPoll } from "@/hooks/useRealtimeFallbackPoll";
import type { AggregatedReaction } from "@/components/chat/bubbles/ReactionPills";

interface ReactionRow {
  id: string;
  message_id: string;
  reactor_jid: string | null;
  reactor_name: string | null;
  is_from_me: boolean;
  emoji: string;
}

/**
 * Reações agregadas por mensagem (tabela message_reactions).
 *
 * Fetch inicial via filtro embutido (messages!inner → conversation_id): uma
 * query por conversa, sem .in() gigante de ids (lição do limite de ~30KB de
 * URL). Realtime: INSERT/DELETE sem filtro server-side (a tabela não tem
 * conversation_id) — os eventos são acumulados por message_id e cada bolha só
 * lê o próprio id, então evento de outra conversa não vaza visualmente.
 * DELETE carrega a linha antiga inteira (REPLICA IDENTITY FULL na migração).
 */
export function useMessageReactions(conversationId: string | null) {
  const [rows, setRows] = useState<ReactionRow[]>([]);
  const conversationIdRef = useRef(conversationId);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const fetchRows = useCallback(async () => {
    const currentId = conversationId;
    if (!currentId) {
      setRows([]);
      return;
    }
    try {
      const data = await fetchAllPaginated<ReactionRow>((from, to) =>
        supabase
          .from("message_reactions")
          .select("id, message_id, reactor_jid, reactor_name, is_from_me, emoji, messages!inner(conversation_id)")
          .eq("messages.conversation_id", currentId)
          .order("id", { ascending: true })
          .range(from, to)
      );
      if (conversationIdRef.current !== currentId) return;
      setRows(data);
    } catch (error) {
      console.error("Error fetching message reactions:", error);
    }
  }, [conversationId]);

  useEffect(() => {
    fetchRows();

    if (!conversationId) return;

    const cleanup = subscribeWithBackoff({
      healthKey: "message-reactions",
      createChannel: () =>
        supabase
          .channel(`message-reactions-${conversationId}`)
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "message_reactions" },
            (payload) => {
              const row = payload.new as ReactionRow;
              if (!row?.message_id) return;
              setRows((prev) => {
                // Delete+insert do webhook pode chegar fora de ordem — dedup por
                // (message, reator) mantém só a linha mais nova.
                const filtered = prev.filter(
                  (r) =>
                    r.id !== row.id &&
                    !(
                      r.message_id === row.message_id &&
                      r.is_from_me === row.is_from_me &&
                      (r.reactor_jid ?? "") === (row.reactor_jid ?? "")
                    )
                );
                return [...filtered, row];
              });
            }
          )
          .on(
            "postgres_changes",
            { event: "DELETE", schema: "public", table: "message_reactions" },
            (payload) => {
              const old = payload.old as Partial<ReactionRow> | null;
              if (!old?.id) return;
              setRows((prev) => prev.filter((r) => r.id !== old.id));
            }
          ),
      onSubscribed: (recovered) => {
        if (recovered) fetchRows();
      },
    });

    return cleanup;
  }, [conversationId, fetchRows]);

  // Rede de segurança do realtime: reação dada ou tirada enquanto o canal está
  // caído (ou perdida em silêncio) chega por aqui.
  useRealtimeFallbackPoll(fetchRows, {
    degradedMs: 10_000,
    healthyMs: 60_000,
    enabled: !!conversationId,
  });

  /** Map message_id → pills agregados (emoji, count, mine, nomes). */
  const reactionsByMessage = useMemo(() => {
    const map = new Map<string, AggregatedReaction[]>();
    const grouped = new Map<string, ReactionRow[]>();
    for (const row of rows) {
      const list = grouped.get(row.message_id);
      if (list) list.push(row);
      else grouped.set(row.message_id, [row]);
    }
    for (const [messageId, messageRows] of grouped) {
      const byEmoji = new Map<string, { count: number; mine: boolean; names: string[] }>();
      for (const row of messageRows) {
        const entry = byEmoji.get(row.emoji) ?? { count: 0, mine: false, names: [] };
        entry.count += 1;
        if (row.is_from_me) entry.mine = true;
        else if (row.reactor_name) entry.names.push(row.reactor_name);
        byEmoji.set(row.emoji, entry);
      }
      map.set(
        messageId,
        [...byEmoji.entries()].map(([emoji, e]) => ({
          emoji,
          count: e.count,
          mine: e.mine,
          reactorNames: e.names.length ? e.names : undefined,
        }))
      );
    }
    return map;
  }, [rows]);

  return { reactionsByMessage };
}
