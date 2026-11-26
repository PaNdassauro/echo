import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/** Preferências POR USUÁRIO de uma conversa (tabela conversation_prefs). */
export interface ConversationPref {
  pinned_at: string | null;
  archived_at: string | null;
  muted_until: string | null;
}

const EMPTY_PREF: ConversationPref = { pinned_at: null, archived_at: null, muted_until: null };

/** Sentinela do Postgres para "silenciada para sempre". */
export const MUTED_FOREVER = "infinity";

export function isMutedPref(pref: ConversationPref | undefined, now = Date.now()): boolean {
  const until = pref?.muted_until;
  if (!until) return false;
  if (until === MUTED_FOREVER) return true;
  const ts = Date.parse(until);
  return Number.isFinite(ts) && ts > now;
}

/**
 * Estado de fixar/arquivar/silenciar do usuário logado, com escrita otimista.
 *
 * Consumido pelo NotificationProvider (uma instância só) e exposto via
 * contexto: a lista ordena/filtra por ele e o listener global corta
 * som/toast/OS-notification das silenciadas. Volume pequeno por usuário (só
 * conversas tocadas), uma query sem paginação.
 */
export function useConversationPrefsState() {
  const [prefs, setPrefs] = useState<Map<string, ConversationPref>>(new Map());
  const userIdRef = useRef<string | null>(null);

  const fetchPrefs = useCallback(async () => {
    const { data, error } = await supabase
      .from("conversation_prefs")
      .select("conversation_id, pinned_at, archived_at, muted_until");
    if (error) {
      console.error("Error fetching conversation prefs:", error);
      return;
    }
    const next = new Map<string, ConversationPref>();
    for (const row of data || []) {
      next.set(row.conversation_id, {
        pinned_at: row.pinned_at,
        archived_at: row.archived_at,
        muted_until: row.muted_until,
      });
    }
    setPrefs(next);
  }, []);

  useEffect(() => {
    fetchPrefs();
  }, [fetchPrefs]);

  const resolveUserId = useCallback(async (): Promise<string | null> => {
    if (userIdRef.current) return userIdRef.current;
    const { data } = await supabase.auth.getUser();
    userIdRef.current = data?.user?.id ?? null;
    return userIdRef.current;
  }, []);

  /** Escrita otimista com rollback: devolve false quando o upsert falhou. */
  const patchPref = useCallback(
    async (conversationId: string, patch: Partial<ConversationPref>): Promise<boolean> => {
      const userId = await resolveUserId();
      if (!userId) return false;

      let previous: ConversationPref | undefined;
      let merged: ConversationPref = EMPTY_PREF;
      setPrefs((prev) => {
        previous = prev.get(conversationId);
        merged = { ...(previous ?? EMPTY_PREF), ...patch };
        const next = new Map(prev);
        if (!merged.pinned_at && !merged.archived_at && !merged.muted_until) {
          next.delete(conversationId);
        } else {
          next.set(conversationId, merged);
        }
        return next;
      });

      const { error } = await supabase.from("conversation_prefs").upsert(
        {
          user_id: userId,
          conversation_id: conversationId,
          ...merged,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,conversation_id" }
      );

      if (error) {
        console.error("Error saving conversation pref:", error);
        // Rollback do otimista
        setPrefs((prev) => {
          const next = new Map(prev);
          if (previous) next.set(conversationId, previous);
          else next.delete(conversationId);
          return next;
        });
        return false;
      }
      return true;
    },
    [resolveUserId]
  );

  const togglePinned = useCallback(
    (conversationId: string) => {
      const current = prefs.get(conversationId)?.pinned_at;
      return patchPref(conversationId, { pinned_at: current ? null : new Date().toISOString() });
    },
    [prefs, patchPref]
  );

  const toggleArchived = useCallback(
    (conversationId: string) => {
      const current = prefs.get(conversationId)?.archived_at;
      return patchPref(conversationId, { archived_at: current ? null : new Date().toISOString() });
    },
    [prefs, patchPref]
  );

  /** `until` ISO, MUTED_FOREVER, ou null para reativar o som. */
  const setMutedUntil = useCallback(
    (conversationId: string, until: string | null) =>
      patchPref(conversationId, { muted_until: until }),
    [patchPref]
  );

  const isMuted = useCallback(
    (conversationId: string) => isMutedPref(prefs.get(conversationId)),
    [prefs]
  );

  return {
    conversationPrefs: prefs,
    refreshConversationPrefs: fetchPrefs,
    togglePinned,
    toggleArchived,
    setMutedUntil,
    isMuted,
  };
}
