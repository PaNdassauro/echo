/**
 * Contagem de não-lidas NO MOMENTO em que a conversa foi aberta pela lista.
 *
 * A lista chama resetUnread() no clique — depois disso o contador some do
 * contexto. Este store de módulo captura o valor um instante antes; o ChatArea
 * o consome (uma vez) para posicionar o divisor "N mensagens não lidas".
 * Aberturas fora da lista (deep-link, busca global) não capturam → sem divisor,
 * comportamento aceito.
 */
const captured = new Map<string, number>();

export function captureUnreadAtOpen(conversationId: string, count: number): void {
  if (count > 0) captured.set(conversationId, count);
  else captured.delete(conversationId);
}

/** Lê E remove — o divisor é congelado por abertura, não deve renascer. */
export function consumeUnreadAtOpen(conversationId: string): number {
  const count = captured.get(conversationId) ?? 0;
  captured.delete(conversationId);
  return count;
}
