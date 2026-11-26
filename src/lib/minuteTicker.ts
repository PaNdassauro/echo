/**
 * Relógio compartilhado de 1 minuto para `useSyncExternalStore`.
 *
 * Os "há X minutos" da lista precisam envelhecer sem prop nova. Um setInterval
 * por row viraria centenas de timers; um estado no pai re-renderizaria a lista
 * inteira. Aqui há UM intervalo, ligado no primeiro subscriber e desligado no
 * último, e só as rows montadas (as que assinaram) re-renderizam.
 */

const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function tick() {
  version++;
  listeners.forEach((listener) => listener());
}

export function subscribeMinute(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) timer = setInterval(tick, 60_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function getMinuteVersion(): number {
  return version;
}
