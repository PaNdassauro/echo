import { useCallback, useSyncExternalStore } from "react";

/** Emojis usados recentemente — mais recente primeiro, cap 32, localStorage. */
const STORAGE_KEY = "echo_recent_emojis_v1";
const MAX_RECENTS = 32;

let cache: string[] | null = null;
const listeners = new Set<() => void>();

function load(): string[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function pushRecentInternal(emoji: string) {
  const next = [emoji, ...load().filter((e) => e !== emoji)].slice(0, MAX_RECENTS);
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage indisponível: recents viram só-sessão */
  }
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const EMPTY: string[] = [];

export function useRecentEmojis() {
  const recents = useSyncExternalStore(subscribe, load, () => EMPTY);
  const pushRecent = useCallback((emoji: string) => pushRecentInternal(emoji), []);
  return { recents, pushRecent };
}
