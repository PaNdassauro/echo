/**
 * Efeitos que falam com o WhatsApp (presença, metadata de grupo) só podem usar os
 * dados da conversa ABERTA.
 *
 * Ao trocar da conversa A (número 1) para a B (número 2), o primeiro render já tem o
 * número da B nas props, mas o `useConversation` ainda guarda a A até o fetch voltar.
 * Misturar os dois mandava `presence-subscribe/<número 2>` com o contato da A (ou
 * buscava o grupo da A no número 2), e em linha sensível a ban isso é tráfego errado.
 * Na caixa conjunta a troca entre números é frequente, e o Direct do Instagram nunca
 * é telefone (`ig:<id>`).
 */
import { ehDirect } from "@/lib/directDoInstagram";

export interface ConversaCarregavel {
  id: string;
  contact_phone: string;
  is_group?: boolean;
  group_jid?: string;
  channel?: "whatsapp" | "instagram";
}

/** A conversa carregada, só se for a do id aberto; senão null (ainda é a anterior, ou nenhuma). */
export function conversaDoId<T extends { id: string }>(
  conversa: T | null | undefined,
  conversationId: string | null | undefined,
): T | null {
  return conversa && conversationId && conversa.id === conversationId ? conversa : null;
}

export interface AlvoDeContato {
  /** Telefone (ou JID do grupo) que os efeitos de WhatsApp usam; undefined desliga todos. */
  contactPhone: string | undefined;
  isGroup: boolean;
  /** JID do grupo, para buscar os participantes; undefined fora de grupo. */
  groupJid: string | undefined;
}

const SEM_ALVO: AlvoDeContato = { contactPhone: undefined, isGroup: false, groupJid: undefined };

/**
 * Para quem os efeitos de WhatsApp da conversa aberta apontam. Sem alvo enquanto a
 * conversa carregada não é a do id aberto e para conversa do Direct do Instagram.
 */
export function alvoDeContato(
  conversa: ConversaCarregavel | null | undefined,
  conversationId: string | null | undefined,
): AlvoDeContato {
  const carregada = conversaDoId(conversa, conversationId);
  if (!carregada || ehDirect(carregada)) return SEM_ALVO;
  return {
    contactPhone: carregada.contact_phone,
    isGroup: carregada.is_group ?? false,
    groupJid: carregada.group_jid,
  };
}
