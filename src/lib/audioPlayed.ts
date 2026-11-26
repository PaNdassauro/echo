/**
 * Rastreio de notas de voz já ouvidas (dot verde de "não ouvida", paridade
 * WhatsApp). localStorage com cap — o registro é por URL de mídia.
 */
const STORAGE_KEY = "echo_audio_played_v1";
const MAX_ENTRIES = 800;

let cache: Set<string> | null = null;
const listeners = new Set<() => void>();

function load(): Set<string> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    cache = new Set();
  }
  return cache;
}

function persist(set: Set<string>) {
  try {
    let entries = [...set];
    if (entries.length > MAX_ENTRIES) {
      // FIFO: descarta as mais antigas (inserção preserva ordem no Set)
      entries = entries.slice(entries.length - MAX_ENTRIES);
      cache = new Set(entries);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* storage cheio/indisponível: o dot degrada sem quebrar o player */
  }
}

export function wasAudioPlayed(src: string): boolean {
  return load().has(src);
}

export function markAudioPlayed(src: string): void {
  const set = load();
  if (set.has(src)) return;
  set.add(src);
  persist(set);
  listeners.forEach((cb) => cb());
}

export function subscribeAudioPlayed(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
