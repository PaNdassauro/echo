import { isSameDay } from "date-fns";
import type { Message } from "@/hooks/chat/useMessages";
import type { Note } from "@/hooks/chat/useNotes";

/** Índice virtual inicial do Virtuoso (alto o bastante para prepends sem ficar negativo). */
export const START_INDEX = 100000;

export type TimelineItem =
  | (Message & { _type: "message" })
  | (Note & { _type: "note" });

/**
 * Junta mensagens e notas internas numa linha do tempo ordenada.
 *
 * Com `hasMore`, notas mais antigas que a primeira mensagem carregada ficam
 * de fora: uma nota assim viraria o item 0 e as mensagens antigas seriam
 * inseridas DEPOIS dela, o que a detecção de prepend (nextFirstIndex) não
 * consegue expressar. Elas entram quando a página que as cobre chega.
 */
export function buildTimeline(messages: Message[], notes: Note[], hasMore: boolean): TimelineItem[] {
  const minT = hasMore && messages.length > 0 ? Date.parse(messages[0].created_at) : -Infinity;
  const keptNotes = notes.filter((n) => Date.parse(n.created_at) >= minT);
  const items: TimelineItem[] = [
    ...messages.map((m) => ({ ...m, _type: "message" as const })),
    ...keptNotes.map((n) => ({ ...n, _type: "note" as const })),
  ];
  // Decora com o timestamp uma vez só e ordena (sort estável: empate mantém mensagem antes da nota).
  return items
    .map((item) => ({ item, t: Date.parse(item.created_at) }))
    .sort((a, b) => a.t - b.t)
    .map((d) => d.item);
}

export interface FirstIndexState {
  items: ReadonlyArray<{ id: string }>;
  firstIndex: number;
  anchorIds: string[];
}

/**
 * Deriva o firstItemIndex do Virtuoso no mesmo render dos dados.
 *
 * Âncoras: os 5 primeiros ids da lista anterior. O primeiro que ainda existe
 * dá o deslocamento (prepend sobe a posição, exclusão do item 0 desce).
 * Sem nenhuma âncora em comum é outra conversa: recomeça em START_INDEX.
 */
export function nextFirstIndex(
  prev: FirstIndexState | null,
  items: ReadonlyArray<{ id: string }>,
): FirstIndexState {
  if (prev && prev.items === items) return prev;
  const anchorIds = items.slice(0, 5).map((i) => i.id);
  if (!prev || items.length === 0 || prev.anchorIds.length === 0) {
    return { items, firstIndex: START_INDEX, anchorIds };
  }
  for (let k = 0; k < prev.anchorIds.length; k++) {
    const pos = items.findIndex((i) => i.id === prev.anchorIds[k]);
    if (pos !== -1) return { items, firstIndex: prev.firstIndex - (pos - k), anchorIds };
  }
  return { items, firstIndex: START_INDEX, anchorIds };
}

/** Ids dos itens que abrem um dia novo (recebem o divisor de data). O item 0 só abre se não há mais histórico. */
export function computeDayStarts(
  items: ReadonlyArray<{ id: string; created_at: string }>,
  hasMore: boolean,
): Set<string> {
  const starts = new Set<string>();
  const dates = items.map((i) => new Date(i.created_at));
  for (let i = 0; i < items.length; i++) {
    if (i === 0) {
      if (!hasMore) starts.add(items[0].id);
    } else if (!isSameDay(dates[i], dates[i - 1])) {
      starts.add(items[i].id);
    }
  }
  return starts;
}

/** id e clientKey dos últimos `n` itens (os que ainda animam a entrada). */
export function tailIds(items: ReadonlyArray<{ id: string; clientKey?: string }>, n = 3): Set<string> {
  const out = new Set<string>();
  for (const item of items.slice(-n)) {
    out.add(item.id);
    if (item.clientKey) out.add(item.clientKey);
  }
  return out;
}

export const timelineItemKey = (_index: number, item: TimelineItem): string =>
  item._type === "note" ? `note:${item.id}` : item.clientKey || item.id;
