/**
 * (Re)assinatura de canal realtime com backoff exponencial.
 *
 * O Supabase nem sempre re-junta um canal sozinho depois de
 * CHANNEL_ERROR/TIMED_OUT — o canal morre em silêncio e a UI congela até o F5.
 * Este helper é o ÚNICO lugar que assina canal com reconexão (lista de
 * conversas, notificações globais, mensagens e reações da conversa): remover
 * o canal morto, esperar 1s → 2s → 4s … (teto configurável) e assinar de novo,
 * reportando o estado ao realtimeHealth (faixa "Conexão instável").
 *
 * Três mortes silenciosas que o status callback do realtime-js não cobre, e
 * que deixavam a faixa presa (canal reportado caído e nunca mais "de pé") ou
 * a tela surda sem faixa nenhuma:
 *
 * - `CLOSED` que não fomos nós que pedimos: o servidor fecha o canal (join
 *   duplicado do mesmo tópico quando o buffer de envio é esvaziado após a
 *   volta da rede, token vencido, limite). O canal some da lista do socket e
 *   nenhum erro chega depois. Aqui vira queda: reporta e reassina.
 * - Canal mudo: `subscribe()` que não chama o callback com status nenhum
 *   (`channel.teardown()` do socket apaga os bindings e o join pendente;
 *   `supabase.channel(nome)` devolve um canal existente e `subscribe()` vira
 *   no-op). O cão de guarda trata "nada em JOIN_WATCHDOG_MS" como TIMED_OUT.
 * - Status de um canal que já foi descartado: cada callback confere se o seu
 *   canal ainda é o ativo, então o `CLOSED` do canal que nós mesmos removemos
 *   nunca é confundido com uma queda nova.
 *
 * `onSubscribed(recovered)` roda a cada SUBSCRIBED; `recovered=true` indica
 * que houve falha antes OU que o canal já tinha assinado (rejoin silencioso do
 * socket: SUBSCRIBED de novo sem erro no meio). Nos dois casos houve um
 * intervalo sem entrega — é o gancho para ressincronizar o que se perdeu (ex.:
 * syncNewMessages), sem refetch no primeiro connect.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { reportChannelHealth } from "@/lib/realtimeHealth";

const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * O join do realtime-js tem timeout próprio de 10 s. Um canal que em 20 s não
 * disse SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT nem CLOSED não vai dizer mais nada.
 */
export const JOIN_WATCHDOG_MS = 20_000;

export interface SubscribeWithBackoffOptions {
  /** Chave no realtimeHealth (aparece agregada na faixa "Conexão instável"). */
  healthKey: string;
  /** Cria o canal com os handlers `.on(...)` anexados — SEM chamar subscribe. */
  createChannel: () => RealtimeChannel;
  /** Chamado a cada SUBSCRIBED; `recovered=true` quando houve um intervalo sem entrega antes. */
  onSubscribed?: (recovered: boolean) => void;
  /** Chamado a cada queda (erro, timeout, fechado por fora ou mudo), antes de agendar o retry. */
  onDown?: () => void;
  /** Teto do backoff (default 30s). */
  maxDelayMs?: number;
  /** Injetável para teste; default supabase.removeChannel. */
  removeChannel?: (channel: RealtimeChannel) => void;
}

/**
 * Retorna o cleanup: cancela retry pendente, remove o canal e reporta o canal
 * como saudável (desmontagem não é falha).
 */
export function subscribeWithBackoff(options: SubscribeWithBackoffOptions): () => void {
  const {
    healthKey,
    createChannel,
    onSubscribed,
    onDown,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    removeChannel = (channel) => supabase.removeChannel(channel),
  } = options;

  let channel: RealtimeChannel | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let everFailed = false;
  let subscribedBefore = false;
  let cancelled = false;

  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = undefined;
  };

  /** O canal `current` caiu (ou calou): descarta, reporta e agenda a reassinatura. */
  const scheduleRetry = (current: RealtimeChannel, status: string) => {
    clearWatchdog();
    everFailed = true;
    reportChannelHealth(healthKey, false);
    onDown?.();
    // Antes do removeChannel: o CLOSED que ele dispara chega para um canal que
    // já não é o ativo, e é ignorado.
    channel = null;
    removeChannel(current);
    const delay = Math.min(1000 * 2 ** attempts, maxDelayMs);
    attempts += 1;
    console.warn(`[Realtime] ${healthKey} ${status}; reconnecting in ${delay}ms`);
    retryTimer = setTimeout(connect, delay);
  };

  const connect = () => {
    if (cancelled) return;
    const current = createChannel();
    channel = current;
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (cancelled || channel !== current) return;
      scheduleRetry(current, "sem resposta");
    }, JOIN_WATCHDOG_MS);
    current.subscribe((status) => {
      if (cancelled || channel !== current) return;
      if (status === "SUBSCRIBED") {
        clearWatchdog();
        attempts = 0;
        reportChannelHealth(healthKey, true);
        const recovered = everFailed || subscribedBefore;
        everFailed = false;
        subscribedBefore = true;
        onSubscribed?.(recovered);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        scheduleRetry(current, status);
      }
    });
  };

  connect();

  return () => {
    cancelled = true;
    clearWatchdog();
    reportChannelHealth(healthKey, true);
    if (retryTimer) clearTimeout(retryTimer);
    const current = channel;
    channel = null;
    if (current) removeChannel(current);
  };
}
