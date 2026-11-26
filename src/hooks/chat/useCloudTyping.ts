import { useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Indicador de "digitando" para conversas Cloud API (Meta WhatsApp Business).
 *
 * Diferente do QR (que tem websocket contínuo), a Meta usa um sinal fire-and-forget
 * atrelado à última mensagem recebida do cliente, com duração de ~25s.
 *
 * Para não sobrecarregar a API nem a Edge Function durante digitação contínua,
 * aplicamos um throttle de 20s por conversa.
 */
export const CLOUD_TYPING_THROTTLE_MS = 20_000;

interface UseCloudTypingOptions {
  throttleMs?: number;
}

export function useCloudTyping(options?: UseCloudTypingOptions) {
  const throttleMs = options?.throttleMs ?? CLOUD_TYPING_THROTTLE_MS;
  const lastSentRef = useRef<Map<string, number>>(new Map());

  const notifyCloudTyping = useCallback(
    async (conversationId: string | null | undefined, phoneNumberDbId?: string | null) => {
      if (!conversationId) return;

      const now = Date.now();
      const lastSent = lastSentRef.current.get(conversationId) ?? 0;

      if (now - lastSent < throttleMs) {
        return;
      }

      lastSentRef.current.set(conversationId, now);

      try {
        await supabase.functions.invoke("whatsapp-typing-start", {
          body: {
            conversationId,
            ...(phoneNumberDbId ? { phoneNumberId: phoneNumberDbId } : {}),
          },
        });
      } catch (err: unknown) {
        // Fire-and-forget: erro não deve interromper a experiência de digitação do atendente
        console.debug("[useCloudTyping] Failed to send typing indicator:", err);
      }
    },
    [throttleMs],
  );

  const resetCloudTyping = useCallback((conversationId?: string) => {
    if (conversationId) {
      lastSentRef.current.delete(conversationId);
    } else {
      lastSentRef.current.clear();
    }
  }, []);

  return { notifyCloudTyping, resetCloudTyping };
}
