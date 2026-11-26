import { z } from "zod";

/**
 * Tamanho natural das mídias já vistas, por URL.
 *
 * A lista de mensagens é virtualizada: a bolha que sai da tela desmonta e, ao
 * voltar, a imagem recomeçava sem altura (skeleton de min-h) e crescia de novo
 * no load. Com o tamanho guardado, a bolha remonta já com a caixa final.
 *
 * Três camadas:
 * - memória da aba (`sizes`): tamanho conhecido, venha de onload ou de dica;
 * - `loaded`: URLs cujo byte já carregou NESTA aba (só o onLoad preenche);
 * - localStorage (conveniência por visualizador): enquanto o backfill de
 *   `metadata.media` não roda, evita que toda imagem antiga abra como letterbox
 *   em cada sessão. Entradas persistidas contam como "conhecidas", mas não como
 *   "carregadas".
 */

export interface MediaSize {
  width: number;
  height: number;
}

/** Teto de entradas: a conversa aberta cabe com folga; a mais antiga sai. */
const MAX_ENTRIES = 2000;
const sizes = new Map<string, MediaSize>();
/** Só rememberMediaSize (onLoad / onLoadedMetadata) preenche; seed não. */
const loaded = new Set<string>();

// ---- camada persistida -------------------------------------------------

const STORAGE_KEY = "echo.mediaSize.v1";
const PERSIST_DEBOUNCE_MS = 1000;
const PUBLIC_PREFIX = "/storage/v1/object/public/attachments/";

const PersistedSchema = z.record(
  z.tuple([z.number().int().positive().max(65535), z.number().int().positive().max(65535), z.number()]),
);

/** chave persistida -> [w, h, lastUsedSec], na ordem de uso (a mais antiga primeiro). */
const persisted = new Map<string, [number, number, number]>();
let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let pagehideRegistered = false;

/** Caminho dentro do bucket quando a URL é pública nossa; senão a URL inteira. URL assinada não persiste. */
function persistKey(url: string): string | null {
  if (url.includes("?")) return null;
  const i = url.indexOf(PUBLIC_PREFIX);
  return i >= 0 ? url.slice(i + PUBLIC_PREFIX.length) : url;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = PersistedSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const entries = Object.entries(parsed.data).sort((a, b) => a[1][2] - b[1][2]);
    const fromBlob = new Map<string, [number, number, number]>();
    for (const [k, v] of entries) fromBlob.set(k, [v[0], v[1], v[2]]);
    // O que esta aba já anotou vale mais que o blob: entra por último (mais recente).
    for (const [k, v] of persisted) {
      fromBlob.delete(k);
      fromBlob.set(k, v);
    }
    persisted.clear();
    for (const [k, v] of fromBlob) persisted.set(k, v);
    while (persisted.size > MAX_ENTRIES) {
      const oldest = persisted.keys().next().value;
      if (oldest === undefined) break;
      persisted.delete(oldest);
    }
  } catch {
    // JSON corrompido ou localStorage indisponível: segue só com a memória.
  }
}

function persistNow(): void {
  persistTimer = undefined;
  hydrate();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(persisted)));
  } catch {
    // modo privado ou cota cheia: silencioso.
  }
}

function schedulePersist(): void {
  if (typeof window !== "undefined" && !pagehideRegistered) {
    pagehideRegistered = true;
    window.addEventListener("pagehide", () => {
      if (persistTimer !== undefined) {
        clearTimeout(persistTimer);
        persistNow();
      }
    });
  }
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
}

function track(url: string, width: number, height: number): void {
  const key = persistKey(url);
  if (key === null) return;
  persisted.delete(key);
  persisted.set(key, [width, height, nowSec()]);
  while (persisted.size > MAX_ENTRIES) {
    const oldest = persisted.keys().next().value;
    if (oldest === undefined) break;
    persisted.delete(oldest);
  }
  schedulePersist();
}

function store(url: string, width: number, height: number): void {
  if (!sizes.has(url) && sizes.size >= MAX_ENTRIES) {
    const oldest = sizes.keys().next().value;
    if (oldest !== undefined) {
      sizes.delete(oldest);
      loaded.delete(oldest);
    }
  }
  sizes.set(url, { width, height });
  track(url, width, height);
}

export function rememberMediaSize(url: string | null | undefined, width: number, height: number): void {
  if (!url || !(width > 0) || !(height > 0)) return;
  store(url, width, height);
  loaded.add(url);
}

/**
 * Dica de tamanho conhecida antes de qualquer load (ex.: medida local do envio).
 * Guarda o tamanho SEM marcar a URL como carregada: a bolha ainda mostra o
 * estado de carregamento até o onLoad real.
 */
export function seedMediaSize(url: string | null | undefined, width: number, height: number): void {
  if (!url || !(width > 0) || !(height > 0)) return;
  store(url, width, height);
}

/** True só depois de um onLoad / onLoadedMetadata desta aba. */
export function wasMediaLoaded(url: string | null | undefined): boolean {
  return url ? loaded.has(url) : false;
}

export function knownMediaSize(url: string | null | undefined): MediaSize | undefined {
  if (!url) return undefined;
  const hit = sizes.get(url);
  if (hit) return hit;
  hydrate();
  const key = persistKey(url);
  const stored = key === null ? undefined : persisted.get(key);
  return stored ? { width: stored[0], height: stored[1] } : undefined;
}

/** Caixa exibida dentro de um teto quadrado, sem ampliar (como max-w/max-h + object-contain). */
export function fitWithin(size: MediaSize, max: number): MediaSize {
  const scale = Math.min(1, max / size.width, max / size.height);
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}

/** Só para testes. */
export function clearMediaSizes(): void {
  sizes.clear();
  loaded.clear();
  persisted.clear();
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  hydrated = false;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // silencioso
  }
}
