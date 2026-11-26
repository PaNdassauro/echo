/**
 * Qual número vale para cada coisa na tela de conversas, em regras puras.
 *
 * Dois conceitos que o Dashboard antes tratava como um só:
 *  - o número SELECIONADO: o que o seletor mostra e que escopa a lista;
 *  - o número do CHAT: o da conversa aberta. É dele que saem o id de envio, o
 *    tipo de canal e a cor, porque a conversa pode não ser do número
 *    selecionado (deep link de push ou busca, e a caixa conjunta que vem
 *    depois). Mandar pelo número errado não dá erro: a mensagem sai por ele.
 *
 * Sem React e sem rede: o que dá para testar no vitest.
 */
import { z } from "zod";

/** O que o chat, o tema e a ligação precisam saber de um número. */
export interface LineMeta {
  /** `phone_numbers.id` (UUID interno). */
  id: string;
  /** `phone_numbers.phone_number_id`: o id da Meta. Linha QR guarda `qr_<ts>`. */
  metaPhoneNumberId: string;
  themeHue: number | null;
  /** 'qr' | 'business_api'. A checagem é sempre `=== 'qr'`. */
  connectionType: string | null;
  displayName: string;
}

/**
 * Número da conversa aberta. Guarda o id da conversa junto para nunca servir o
 * número da conversa anterior a uma conversa diferente.
 */
export interface ChatTarget {
  conversationId: string;
  /** `phone_numbers.id` da conversa. */
  lineId: string;
  /**
   * Último retrato conhecido do número: o do mapa no momento em que a conversa
   * abriu (e refrescado enquanto a linha segue nele) ou, no deep link, o embed da
   * conversa. Só vale quando o número NÃO está no mapa de números acessíveis:
   * linha desativada, que o mapa não lista, ou que um admin desativou com a
   * conversa aberta. Sem ele o chat perderia o id de envio e o canal no meio da
   * sessão.
   */
  fallback: LineMeta | null;
}

/** Embed `phone_number:phone_numbers(...)` da busca da conversa no deep link. */
const lineEmbedSchema = z.object({
  id: z.string().min(1),
  phone_number_id: z.string(),
  theme_hue: z.number().nullable(),
  connection_type: z.string().nullable(),
  display_name: z.string(),
});

/** Valida o embed do número e o converte em LineMeta; null se faltar ou vier fora do contrato. */
export function lineMetaFromEmbed(raw: unknown): LineMeta | null {
  if (raw == null) return null;
  const parsed = lineEmbedSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn("[numeroDaConversa] embed do número fora do contrato:", parsed.error.issues[0]?.message);
    return null;
  }
  const { id, phone_number_id, theme_hue, connection_type, display_name } = parsed.data;
  return {
    id,
    metaPhoneNumberId: phone_number_id,
    themeHue: theme_hue,
    connectionType: connection_type,
    displayName: display_name,
  };
}

/**
 * Id do número da conversa aberta, sem depender do mapa de números (que pode
 * ainda estar carregando). Null para qualquer conversa que não seja a do alvo.
 */
export function chatLineId(target: ChatTarget | null, conversationId: string | null): string | null {
  if (!target || !conversationId || target.conversationId !== conversationId) return null;
  return target.lineId;
}

/**
 * Metadados do número da conversa `conversationId`: o mapa vivo primeiro (nome e
 * cor frescos), o último retrato de reserva. Conversa diferente da do alvo
 * devolve null, e nunca o número de outra conversa: mandaria o envio pelo número
 * errado.
 */
export function resolveChatLine(
  target: ChatTarget | null,
  conversationId: string | null,
  linesById: ReadonlyMap<string, LineMeta>,
): LineMeta | null {
  const lineId = chatLineId(target, conversationId);
  if (!target || !lineId) return null;
  const fromMap = linesById.get(lineId);
  if (fromMap) return fromMap;
  // Reserva só se for mesmo do número do alvo.
  return target.fallback?.id === lineId ? target.fallback : null;
}

/**
 * Número selecionado depois que a lista de números da org carregou:
 * o atual, se ainda vale; senão o salvo (`echo_last_phone_<org>`), se ainda
 * vale; senão o primeiro. Org sem número devolve null.
 */
export function resolveSelectedLineId(input: {
  selectedId: string | null;
  savedId: string | null;
  lineIds: readonly string[];
}): string | null {
  const { selectedId, savedId, lineIds } = input;
  if (lineIds.length === 0) return null;
  if (selectedId && lineIds.includes(selectedId)) return selectedId;
  if (savedId && lineIds.includes(savedId)) return savedId;
  return lineIds[0];
}
