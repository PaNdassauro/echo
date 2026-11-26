import { useCallback, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type QuickReply = Pick<Tables<"quick_replies">, "id" | "shortcut" | "content">;

export const QUICK_REPLY_SHORTCUT_MAX = 30;
export const QUICK_REPLY_CONTENT_MAX = 4096;

/**
 * Normaliza o atalho para o formato aceito pelo CHECK do banco
 * (^[a-z0-9_-]{1,30}$): lowercase, acentos removidos (NFD), espaços viram
 * "-", o resto fora de [a-z0-9_-] é descartado. Compartilhada entre o
 * cadastro (Settings) e qualquer outro ponto que precise da regra.
 */
export function normalizeShortcut(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, QUICK_REPLY_SHORTCUT_MAX);
}

interface UseQuickRepliesReturn {
  quickReplies: QuickReply[];
  /**
   * Busca uma vez por montagem (idempotente via hasFetchedRef) — chamada
   * quando o "/" é detectado no composer, não no mount: a maioria das
   * conversas abertas nunca usa frase pronta.
   */
  ensureFetched: () => void;
}

// Frases prontas da linha, para o popup de "/" no composer. Sem realtime de
// propósito (mesma decisão de useStickers): a lista só muda pelo cadastro em
// Settings; o ChatInput remonta por conversa, então staleness dura no máximo
// até a próxima troca de conversa.
export function useQuickReplies(phoneNumberId: string | null | undefined): UseQuickRepliesReturn {
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const hasFetchedRef = useRef(false);

  const ensureFetched = useCallback(() => {
    if (hasFetchedRef.current || !phoneNumberId) return;
    hasFetchedRef.current = true;
    void supabase
      .from("quick_replies")
      .select("id, shortcut, content")
      .eq("phone_number_id", phoneNumberId)
      .order("shortcut")
      .then(({ data, error }) => {
        if (error) {
          console.error("Error fetching quick replies:", error);
          // Permite nova tentativa no próximo "/" — falha aqui é silenciosa
          // para o usuário (o popup simplesmente não abre).
          hasFetchedRef.current = false;
          return;
        }
        setQuickReplies(data ?? []);
      });
  }, [phoneNumberId]);

  return { quickReplies, ensureFetched };
}
