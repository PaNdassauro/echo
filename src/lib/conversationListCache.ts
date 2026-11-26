/**
 * Cache em memória da lista de conversas por linha.
 *
 * Vive no módulo (não em estado React) de propósito: o Dashboard remonta ao
 * cruzar o breakpoint mobile/desktop e ao voltar de outra rota, e sem isso a
 * lista piscava vazia e refazia o fetch inteiro a cada troca. Uma linha grande
 * pesa ~4 MB em objetos Conversation, por isso o LRU limita a poucas linhas —
 * quem alterna entre dois ou três números não paga refetch, o resto paga.
 *
 * A caixa conjunta precisa de mais: ela mostra todos os números do escopo de uma
 * vez, e um LRU de 4 evictaria os de cima enquanto os de baixo ainda chegam. Por
 * isso a capacidade é ajustável (`setCapacity`), com piso em `MAX_LINES`: quem
 * monta um escopo de N números pede N + 1 (a folga é o número de onde veio), e ao
 * voltar para um escopo pequeno a capacidade desce e as mais antigas saem.
 */

import type { Conversation } from "@/types/conversation";

export interface CachedLine {
  rows: Conversation[];
  fetchedAt: number;
  /** false quando o último commit do número foi parcial (faltavam páginas): o reconcile não pode descartar o que não veio. */
  complete: boolean;
}

/** Capacidade base — e o piso: nenhum escopo reduz o cache abaixo disto. */
export const MAX_LINES = 4;

// Map preserva ordem de inserção: reinserir a cada set() mantém o mais
// recente no fim e o candidato à evicção no início.
const lines = new Map<string, CachedLine>();

let capacity = MAX_LINES;

const evictOverCapacity = () => {
  while (lines.size > capacity) {
    const oldest = lines.keys().next().value;
    if (oldest === undefined) break;
    lines.delete(oldest);
  }
};

export const conversationListCache = {
  get(phoneId: string): CachedLine | undefined {
    return lines.get(phoneId);
  },
  set(phoneId: string, entry: CachedLine): void {
    lines.delete(phoneId);
    lines.set(phoneId, entry);
    evictOverCapacity();
  },
  /**
   * Quantas linhas o cache guarda. Nunca fica abaixo de `MAX_LINES`; ao descer, as
   * menos recentes saem na hora. Quem encolhe o escopo deve tocar (get + set) as
   * linhas que vai usar ANTES, para elas não estarem entre as que saem.
   */
  setCapacity(next: number): void {
    capacity = Number.isFinite(next) ? Math.max(MAX_LINES, Math.floor(next)) : MAX_LINES;
    evictOverCapacity();
  },
  capacity(): number {
    return capacity;
  },
  clear(): void {
    lines.clear();
  },
};
