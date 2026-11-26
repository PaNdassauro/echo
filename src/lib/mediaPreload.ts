import { bubbleImageSrc } from "@/lib/mediaDerivative";
import { rememberMediaSize } from "@/lib/mediaSizeCache";
import type { TimelineItem } from "@/lib/timeline";

/**
 * Pré-carga das imagens das próximas linhas no sentido da rolagem.
 *
 * O Virtuoso só monta a linha 600 px acima / 200 px abaixo da viewport, tarde
 * demais para a imagem chegar sem "pipoco". Aqui a imagem das próximas linhas
 * já é buscada ANTES do mount: quando a bolha monta, o arquivo está no cache
 * HTTP, o bitmap decodificado fica preso num LRU de objetos Image e o tamanho
 * natural já está no `mediaSizeCache` (a bolha monta no estado "carregada").
 */

export interface MediaPreloaderOptions {
  /** Downloads simultâneos (default 3). */
  concurrency?: number;
  /** Quantos objetos Image manter vivos (default 200). */
  keep?: number;
  /** Também busca o placeholder de 32 px (default true). */
  fetchThumbs?: boolean;
}

export interface MediaPreloader {
  /** Enfileira as imagens dos próximos `count` itens a partir de `from`, no sentido `direction`. */
  preload(items: readonly TimelineItem[], from: number, direction: -1 | 1, count?: number): void;
  /** Descarta a fila pendente (o que já está em voo termina). */
  cancel(): void;
  /** Quantos objetos Image estão retidos no LRU. */
  size(): number;
}

interface Job {
  src: string;
  /** URL original da mídia quando este job é o de exibição (registra o tamanho); null no placeholder. */
  original: string | null;
}

const THUMB_PX = 32;
const DISPLAY_PX = 600;

function saveDataOn(): boolean {
  if (typeof navigator === "undefined") return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return conn?.saveData === true;
}

// LRU compartilhado por todas as instâncias (e pela bolha, via retainImage):
// um objeto Image vivo segura o bitmap decodificado na memória, então a
// remontagem da linha encontra a imagem completa no mesmo quadro.
const lru = new Map<string, HTMLImageElement>();
let lruKeep = 200;

const retain = (src: string, img: HTMLImageElement): void => {
  lru.delete(src);
  lru.set(src, img);
  while (lru.size > lruKeep) {
    const oldest = lru.keys().next().value;
    if (oldest === undefined) break;
    lru.delete(oldest);
  }
};

/**
 * Segura na memória uma imagem que a bolha acabou de carregar (acerto do cache
 * de memória: sem rede, sem decode novo). Chamado no onLoad da bolha para que a
 * saída e a volta da linha não fiquem um quadro vazias.
 */
export function retainImage(src: string | null | undefined): void {
  if (!src || lru.has(src) || typeof Image === "undefined") return;
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
    retain(src, img);
  } catch {
    // nunca atrapalha a bolha
  }
}

/** Só para testes. */
export function clearRetainedImages(): void {
  lru.clear();
  lruKeep = 200;
}

export function createMediaPreloader(opts: MediaPreloaderOptions = {}): MediaPreloader {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  if (opts.keep !== undefined) lruKeep = Math.max(1, opts.keep);
  const fetchThumbs = opts.fetchThumbs ?? true;

  const queued = new Set<string>();
  let queue: Job[] = [];
  let active = 0;
  let generation = 0;
  let lastDirection: -1 | 1 | null = null;

  const finish = (): void => {
    active -= 1;
    pump();
  };

  const run = (job: Job): void => {
    active += 1;
    try {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        try {
          if (job.original) rememberMediaSize(job.original, img.naturalWidth, img.naturalHeight);
          retain(job.src, img);
          img.decode().catch(() => undefined);
        } catch (err) {
          console.warn("[mediaPreload] falha ao registrar imagem", err);
        }
        queued.delete(job.src);
        finish();
      };
      img.onerror = () => {
        queued.delete(job.src);
        finish();
      };
      img.src = job.src;
    } catch (err) {
      console.warn("[mediaPreload] falha ao iniciar download", err);
      queued.delete(job.src);
      finish();
    }
  };

  function pump(): void {
    while (active < concurrency && queue.length > 0) {
      const job = queue.shift();
      if (job) run(job);
    }
  }

  const enqueue = (job: Job): void => {
    // Só o que já está retido no LRU (ou na fila) é pulado. Uma imagem que a aba
    // já carregou pela bolha, mas que saiu da tela, também entra: o objeto Image
    // segura o bitmap na memória e a remontagem a encontra completa na hora,
    // em vez de voltar a buscar no cache de disco e ficar um quadro vazia.
    if (lru.has(job.src) || queued.has(job.src)) return;
    queued.add(job.src);
    queue.push(job);
  };

  const dropPending = (): void => {
    for (const job of queue) queued.delete(job.src);
    queue = [];
  };

  return {
    preload(items, from, direction, count = 10) {
      try {
        if (saveDataOn()) return;
        if (lastDirection !== null && lastDirection !== direction) {
          generation += 1;
          dropPending();
        }
        lastDirection = direction;
        const token = generation;
        for (let n = 0, i = from; n < count && i >= 0 && i < items.length; n += 1, i += direction) {
          if (token !== generation) return;
          const item = items[i];
          // Vídeo fica de fora: a capa vem de metadata.media.thumb ou é capturada
          // pela bolha ao montar, em tempo ocioso. Decodificar vídeo durante a
          // rolagem derrubava frames (medido no harness: 16 frames > 50 ms).
          if (item._type !== "message" || item.message_type !== "image" || !item.media_url) continue;
          const original = item.media_url;
          if (fetchThumbs) {
            const thumb = bubbleImageSrc(original, THUMB_PX);
            if (thumb) enqueue({ src: thumb, original: null });
          }
          enqueue({ src: bubbleImageSrc(original, DISPLAY_PX) ?? original, original });
        }
        pump();
      } catch (err) {
        console.warn("[mediaPreload] preload falhou", err);
      }
    },
    cancel() {
      generation += 1;
      lastDirection = null;
      dropPending();
    },
    size: () => lru.size,
  };
}
