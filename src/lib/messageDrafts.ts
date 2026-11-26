/**
 * Rascunhos de mensagem por conversa.
 *
 * Texto: persistido em localStorage com TTL de 7 dias — trocar de conversa (o
 * ChatInput é remontado por key) ou recarregar a página não perde o que o
 * atendente estava digitando.
 * Reply (mensagem citada): apenas em memória — o objeto é grande e a citação
 * pendente não precisa sobreviver a um reload.
 */

const STORAGE_KEY = "echo_message_drafts_v1";
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

interface StoredDraft {
  text: string;
  updatedAt: number;
}

let cache: Record<string, StoredDraft> | null = null;
let persistTimer: number | undefined;

// Observável mínimo para o React (useSyncExternalStore): a lista de conversas
// mostra o indicador de rascunho e precisa re-renderizar quando ele nasce/morre.
let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version++;
  listeners.forEach((listener) => listener());
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDraftsVersion(): number {
  return version;
}

function readAll(): Record<string, StoredDraft> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: Record<string, StoredDraft> = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    for (const key of Object.keys(parsed)) {
      const entry = parsed[key];
      if (!entry?.text || now - entry.updatedAt > DRAFT_TTL_MS) {
        delete parsed[key];
      }
    }
    cache = parsed;
  } catch {
    cache = {};
  }
  return cache;
}

function persistNow() {
  if (persistTimer) {
    window.clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readAll()));
  } catch {
    // Quota cheia ou modo privado — o rascunho continua vivo em memória.
  }
}

// Digitação é frequente: escreve no localStorage com debounce de 300ms.
function schedulePersist() {
  if (persistTimer) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(persistNow, 300);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", persistNow);
}

export function getDraft(conversationId: string): string {
  return readAll()[conversationId]?.text ?? "";
}

export function setDraft(conversationId: string, text: string) {
  const all = readAll();
  const had = Boolean(all[conversationId]?.text.trim());
  const has = Boolean(text.trim());
  if (has) {
    all[conversationId] = { text, updatedAt: Date.now() };
  } else {
    delete all[conversationId];
  }
  schedulePersist();
  // Só notifica quando a EXISTÊNCIA do rascunho muda (o indicador da lista só
  // depende disso) — digitar não re-renderiza a lista a cada tecla.
  if (had !== has) notify();
}

export function hasDraft(conversationId: string): boolean {
  return Boolean(readAll()[conversationId]?.text.trim());
}

// --- Reply pendente (só memória) ---

const replyDrafts = new Map<string, unknown>();

export function getReplyDraft<T>(conversationId: string): T | null {
  return (replyDrafts.get(conversationId) as T | undefined) ?? null;
}

export function setReplyDraft(conversationId: string, message: unknown | null) {
  if (message) {
    replyDrafts.set(conversationId, message);
  } else {
    replyDrafts.delete(conversationId);
  }
}
