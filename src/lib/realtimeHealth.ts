/**
 * Saúde dos canais realtime, observável pelo React (useSyncExternalStore).
 *
 * Os canais caíam em silêncio (console.warn e nada mais): a lista congelava e
 * o atendente só descobria no F5. Cada assinatura reporta aqui o próprio
 * estado; a faixa global "Reconectando…" aparece enquanto QUALQUER canal
 * estiver fora do ar.
 */

const unhealthyChannels = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version++;
  listeners.forEach((listener) => listener());
}

export function reportChannelHealth(key: string, healthy: boolean) {
  const wasUnhealthy = unhealthyChannels.has(key);
  if (healthy && wasUnhealthy) {
    unhealthyChannels.delete(key);
    notify();
  } else if (!healthy && !wasUnhealthy) {
    unhealthyChannels.add(key);
    notify();
  }
}

export function subscribeRealtimeHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRealtimeHealthVersion(): number {
  return version;
}

export function isRealtimeDegraded(): boolean {
  return unhealthyChannels.size > 0;
}
