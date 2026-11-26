import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  getRealtimeHealthVersion,
  isRealtimeDegraded,
  subscribeRealtimeHealth,
} from "@/lib/realtimeHealth";

export interface RealtimeFallbackPollOptions {
  /** Intervalo enquanto algum canal realtime está caído. */
  degradedMs: number;
  /**
   * Intervalo com o realtime saudável (0 = não busca). Cobre o evento que o
   * servidor perde em silêncio com o canal ainda SUBSCRIBED.
   */
  healthyMs: number;
  /** Desliga a busca (ex.: nenhuma conversa aberta). Default true. */
  enabled?: boolean;
}

/**
 * Rede de segurança do realtime: chama `poll` periodicamente, mais rápido
 * enquanto o realtimeHealth acusa canal caído. Com o Realtime do Supabase
 * instável, o INSERT/UPDATE pode não chegar nunca, e sem isto a tela ficava
 * congelada até o canal voltar ou um F5.
 *
 * Uma busca por vez: o próximo disparo só é agendado depois que a anterior
 * termina (com erro ou não), então uma rede lenta não empilha requisições.
 */
export function useRealtimeFallbackPoll(
  poll: () => Promise<unknown> | void,
  { degradedMs, healthyMs, enabled = true }: RealtimeFallbackPollOptions,
): void {
  useSyncExternalStore(subscribeRealtimeHealth, getRealtimeHealthVersion);
  const degraded = isRealtimeDegraded();
  const intervalMs = degraded ? degradedMs : healthyMs;

  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      timer = setTimeout(async () => {
        timer = undefined;
        try {
          await pollRef.current();
        } catch (error) {
          console.error("[useRealtimeFallbackPoll] busca falhou:", error);
        }
        if (!cancelled) schedule();
      }, intervalMs);
    };

    schedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, intervalMs]);
}
