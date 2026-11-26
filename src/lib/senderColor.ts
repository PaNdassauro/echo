/**
 * Cor estável por participante de grupo (paridade WhatsApp).
 *
 * Hash FNV-1a do identificador → índice 1..8 nos tokens --group-sender-N
 * (definidos em index.css para light e dark). Determinístico entre reloads e
 * entre bolhas do mesmo remetente.
 *
 * A chave preferida é o telefone (sobrevive à resolução LID→phone); o JID cru
 * entra como fallback para participantes @lid ainda não resolvidos.
 */

export const GROUP_SENDER_COLOR_COUNT = 8;

export function senderColorIndex(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % GROUP_SENDER_COLOR_COUNT) + 1;
}

/** Chave de cor de uma mensagem de grupo: telefone > JID sem sufixo > nome. */
export function senderColorKey(sender: {
  sender_phone?: string | null;
  sender_jid?: string | null;
  sender_name?: string | null;
}): string | null {
  const bareJid = sender.sender_jid ? sender.sender_jid.split("@")[0] : null;
  return sender.sender_phone || bareJid || sender.sender_name || null;
}

/** CSS color string para o índice (1..8). */
export function senderColorCss(index: number): string {
  return `hsl(var(--group-sender-${index}))`;
}
