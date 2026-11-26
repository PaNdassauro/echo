/**
 * Poster de vídeo: primeiro quadro capturado no navegador, uma vez por URL.
 *
 * Ordem de consulta: cache de memória, depois localStorage (mapa url -> dataURL
 * com teto de ~1,5 MB, LRU por inserção). A captura usa um <video> fora do DOM,
 * no máximo 2 por vez, e nunca lança: qualquer falha (erro, canvas contaminado,
 * timeout) resolve null e fica lembrada na sessão para não haver tempestade de retry.
 */

const STORAGE_KEY = "echo.videoPoster.v1";
const STORAGE_CAP_CHARS = 1_500_000;
// Uma captura por vez: decodificar vídeo compete com a rolagem.
const MAX_CONCURRENT = 1;

const memory = new Map<string, string>();
const failed = new Set<string>();
const inFlight = new Map<string, Promise<string | null>>();
let storageLoaded = false;
let active = 0;
const waiting: Array<() => void> = [];

function readStorage(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function loadStorageOnce(): void {
  if (storageLoaded) return;
  storageLoaded = true;
  for (const [k, v] of Object.entries(readStorage())) if (!memory.has(k)) memory.set(k, v);
}

function persist(url: string, dataUrl: string): void {
  try {
    const map = readStorage();
    delete map[url];
    map[url] = dataUrl;
    let total = 0;
    for (const [k, v] of Object.entries(map)) total += k.length + v.length;
    for (const k of Object.keys(map)) {
      if (total <= STORAGE_CAP_CHARS) break;
      total -= k.length + map[k].length;
      delete map[k];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // storage cheio ou bloqueado: o cache de memória basta
  }
}

/**
 * Agenda `fn` para um momento ocioso do navegador (requestIdleCallback, ou
 * 300 ms onde não existe) e devolve o cancelamento. A bolha usa isto para a
 * captura não disputar frame com a rolagem.
 */
export function scheduleIdle(fn: () => void): () => void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  const cic = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
  if (typeof ric === "function" && typeof cic === "function") {
    const id = ric(fn, { timeout: 2000 });
    return () => cic(id);
  }
  const timer = setTimeout(fn, 300);
  return () => clearTimeout(timer);
}

/** Poster já conhecido (memória ou localStorage), síncrono. */
export function getVideoPoster(url: string): string | null {
  try {
    loadStorageOnce();
    return memory.get(url) ?? null;
  } catch {
    return null;
  }
}

/** Só para testes: zera caches, falhas e fila. */
export function clearVideoPosters(): void {
  memory.clear();
  failed.clear();
  inFlight.clear();
  waiting.length = 0;
  active = 0;
  storageLoaded = false;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignora
  }
}

/** Só para testes: grava um poster no cache de memória. */
export function seedVideoPoster(url: string, dataUrl: string): void {
  memory.set(url, dataUrl);
}

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(() => resolve()));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active = Math.max(0, active - 1);
}

function grabFrame(url: string, maxWidth: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let video: HTMLVideoElement | null = null;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        if (video) {
          video.removeAttribute("src");
          video.load();
        }
      } catch {
        // ignora
      }
      resolve(value);
    };
    try {
      video = document.createElement("video");
      const v = video;
      v.crossOrigin = "anonymous";
      v.muted = true;
      v.playsInline = true;
      v.preload = "metadata";
      timer = setTimeout(() => finish(null), timeoutMs);
      const draw = (): void => {
        try {
          const w = v.videoWidth;
          const h = v.videoHeight;
          if (!w || !h) return finish(null);
          const scale = Math.min(1, maxWidth / w);
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext("2d");
          if (!ctx) return finish(null);
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL("image/jpeg", 0.7));
        } catch {
          finish(null); // SecurityError (canvas contaminado) ou afins
        }
      };
      v.addEventListener("loadedmetadata", () => {
        try {
          const d = Number.isFinite(v.duration) ? v.duration : 0;
          v.currentTime = Math.min(0.1, d / 10);
        } catch {
          finish(null);
        }
      });
      v.addEventListener("seeked", draw);
      v.addEventListener("error", () => finish(null));
      v.src = url;
    } catch {
      finish(null);
    }
  });
}

/** Captura o primeiro quadro do vídeo. Deduplica por URL; nunca lança. */
export function captureVideoPoster(
  url: string,
  opts: { maxWidth?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  try {
    const known = getVideoPoster(url);
    if (known) return Promise.resolve(known);
    if (failed.has(url)) return Promise.resolve(null);
    const pending = inFlight.get(url);
    if (pending) return pending;
    const job = (async (): Promise<string | null> => {
      await acquire();
      try {
        const result = await grabFrame(url, opts.maxWidth ?? 320, opts.timeoutMs ?? 6000);
        if (result) {
          memory.set(url, result);
          persist(url, result);
        } else {
          failed.add(url);
        }
        return result;
      } catch {
        failed.add(url);
        return null;
      } finally {
        release();
        inFlight.delete(url);
      }
    })();
    inFlight.set(url, job);
    return job;
  } catch {
    return Promise.resolve(null);
  }
}
