import type { Message } from "@/hooks/chat/useMessages";

/**
 * Teto de mensagens por encaminhamento. Espelha o `.max()` do schema do
 * whatsapp-forward: 10 mensagens × 5 destinos = 50 envios sequenciais numa
 * única invocação, que é o que cabe com folga no wall-clock da edge function.
 */
export const MAX_SELECTED_MESSAGES = 10;

/**
 * Tipos encaminháveis — espelha o allowlist do whatsapp-forward. Fora daqui
 * (contact, list, flow, template, group_action, deleted) o conteúdo não é
 * reproduzível verbatim em outro chat.
 */
const FORWARDABLE_TYPES = ["text", "image", "video", "audio", "ptt", "document", "sticker"];

/** Fonte única da regra: a lista, a bolha e a barra de seleção consultam esta função. */
export const isForwardable = (message: Message): boolean => {
  if (message.is_deleted) return false;
  if (message.status === "sending" || message.status === "error" || message.status === "failed") return false;
  const type = message.message_type || "text";
  if (!FORWARDABLE_TYPES.includes(type)) return false;
  // Mídia sem URL (ex.: ainda subindo, ou linha importada sem arquivo) não tem o que encaminhar.
  if (type !== "text" && !message.media_url) return false;
  return true;
};

/**
 * Marca/desmarca respeitando o teto. Desmarcar sempre funciona — mesmo no
 * limite, senão a seleção trava quando o usuário quer trocar de mensagem.
 * Devolve o Set original quando nada muda, para não re-renderizar à toa.
 */
export const toggleSelection = (
  selected: ReadonlySet<string>,
  messageId: string,
  max: number = MAX_SELECTED_MESSAGES,
): Set<string> => {
  if (selected.has(messageId)) {
    const next = new Set(selected);
    next.delete(messageId);
    return next;
  }
  if (selected.size >= max) return selected as Set<string>;
  const next = new Set(selected);
  next.add(messageId);
  return next;
};

/**
 * Mensagens selecionadas na ordem em que aparecem na conversa. O destino recebe
 * nessa ordem, então a origem é sempre a lista renderizada (cronológica), nunca
 * a ordem em que o usuário clicou.
 */
export const selectedInOrder = (messages: Message[], selected: ReadonlySet<string>): Message[] =>
  messages.filter((message) => selected.has(message.id));
