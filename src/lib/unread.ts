/**
 * Não-lido da lista de conversas: duas fontes, uma leitura.
 *
 * O contador vem da RPC `get_unread_counts` (mensagens inbound acima da marca
 * d'água pessoal em `conversation_reads.last_read_at`). A marcação manual vem da
 * coluna `conversation_reads.marked_unread_at`, ligada pelo menu de contexto —
 * ver a RPC mark_conversations_read no baseline para o porquê de a segunda
 * não caber dentro da primeira.
 *
 * São coisas diferentes ("chegou mensagem" × "eu deixei pendente") e por isso
 * viajam separadas do servidor até aqui; só a renderização as junta. Estas
 * funções são esse ponto de junção — puras de propósito, para o comportamento
 * ficar testável sem montar a lista virtualizada inteira.
 */

/** A linha aparece destacada? Contador OU marcação manual. */
export const isConversationUnread = (
  unreadCount: number,
  isMarkedUnread: boolean,
): boolean => unreadCount > 0 || isMarkedUnread;

/**
 * O número efetivo de não-lidas: o que aparece no badge, o que soma nos totais
 * das abas e o que ordena no modo "notificações primeiro".
 *
 * A marcação manual vale 1. Ela não representa mensagem nenhuma, mas o badge
 * precisa de um número — e 1 é o que empata com a conversa de uma mensagem, para
 * a linha flutuar junto no topo em vez de ficar em negrito lá embaixo.
 */
export const unreadWeight = (
  unreadCount: number,
  isMarkedUnread: boolean,
): number => (unreadCount > 0 ? unreadCount : isMarkedUnread ? 1 : 0);

/** Rótulo da pílula: o teto de 99+ evita a linha crescer com conversa parada. */
export const formatUnreadCount = (unreadCount: number): string =>
  unreadCount > 99 ? "99+" : String(unreadCount);

export interface RingableIncreaseContext {
  userId: string | null;
  activeConversationId: string | null;
  tabHidden: boolean;
  isMuted: (conversationId: string) => boolean;
  /** Dono e co-donos da conversa em memória; undefined = desconhecida. */
  ownership: (conversationId: string) => { assignedTo: string | null; coAssigneeIds: string[] } | undefined;
}

/**
 * Reserva do som de mensagem nova quando o canal global está caído: a busca
 * periódica do não-lido acusa aumento, e o som segue as MESMAS regras do
 * handler de INSERT do GlobalNotificationListener — só dono ou co-dono
 * (fail-closed: conversa fora da memória não toca), não silenciada, e com a
 * aba escondida ou outra conversa aberta.
 */
export function hasRingableUnreadIncrease(
  before: ReadonlyMap<string, number> | undefined,
  after: ReadonlyMap<string, number>,
  ctx: RingableIncreaseContext,
): boolean {
  const { userId } = ctx;
  if (!userId) return false;
  for (const [conversationId, count] of after) {
    if (count <= (before?.get(conversationId) ?? 0)) continue;
    if (ctx.isMuted(conversationId)) continue;
    if (!ctx.tabHidden && conversationId === ctx.activeConversationId) continue;
    const owner = ctx.ownership(conversationId);
    if (!owner) continue;
    if (owner.assignedTo === userId || owner.coAssigneeIds.includes(userId)) return true;
  }
  return false;
}
