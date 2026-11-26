/**
 * Forma da linha da lista de conversas: colunas explícitas no lugar de "*".
 *
 * Medido em prod: cada linha com "*" + embeds pesava ~700 bytes de
 * JSON (3,9 MB numa linha grande). Metade das colunas nunca era lida pela
 * lista (whatsapp_id, close_reason, closed_*, contact_picture_url,
 * picture_fetched_at, group_jid, source, last_auto_reply_at, created_at). As
 * quatro `last_message_*` são colunas de conversations (baseline) e substituem a segunda
 * etapa (RPC get_last_messages por bloco de 500 ids).
 *
 * `updated_at` é a exceção que voltou: a revalidação incremental da lista
 * (`conversationListFetch`) busca só o que mudou desde o maior `updated_at` que o
 * SERVIDOR já devolveu, e é desta coluna que sai essa marca d'água. Ela não vai
 * para a `Conversation` (a UI não a usa): `parseListPage` a devolve à parte.
 *
 * Único ponto onde a resposta do PostgREST vira `Conversation`: a lista, o
 * refresh de uma conversa (NotificationContext) e o realtime passam por aqui.
 *
 * Os co-responsáveis (`conversation_assignees(user_id)` no embed) têm uma segunda via, o
 * retrato do escopo (`COLUNAS_CO_RESPONSAVEIS`): o incremental busca por `updated_at`, e
 * incluir ou tirar um co-responsável não o move.
 */
import { z } from "zod";
import type { Conversation } from "@/types/conversation";
import { conversationRowSchema, rowToConversation } from "@/lib/conversationRealtime";

export const LIST_COLUMNS =
  "id, contact_name, contact_phone, last_message_at, status, phone_number_id, sector_id, " +
  "assigned_to, is_group, contact_avatar_url, contact_avatar_updated_at, " +
  "last_message_content, last_message_type, last_message_direction, last_message_is_deleted, " +
  "channel, instagram_username, instagram_user_id, updated_at, " +
  "disparo_desde, disparo_rotulo, disparo_campanhas, disparo_status, " +
  "ia_desde, ia_origem, ia_sem_resposta_desde, " +
  "profiles:assigned_to(first_name, last_name, email), conversation_assignees(user_id)";

/** Tamanho de página = max_rows do PostgREST (db-max-rows=1000). */
export const LIST_PAGE_SIZE = 1000;

const profilesSchema = z
  .object({
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    email: z.string().nullable(),
  })
  .nullable();

export const listRowSchema = conversationRowSchema.extend({
  // Opcional: uma resposta sem a coluna (select parcial, mock) ainda vira Conversation; só não
  // entra na marca d'água. O refresh de uma conversa a recebe (usa LIST_COLUMNS), mas não passa
  // por parseListPage e não a alimenta.
  updated_at: z.string().nullable().optional(),
  profiles: profilesSchema.optional(),
  conversation_assignees: z.array(z.object({ user_id: z.string() })).nullable().optional(),
});

export type ListRow = z.infer<typeof listRowSchema>;

/** Converte UMA linha do select LIST_COLUMNS em Conversation (embeds achatados). */
export function listRowToConversation(row: ListRow): Conversation {
  const { profiles, conversation_assignees, ...rest } = row;
  // Reconstruído campo a campo: com strictNullChecks desligado o tipo inferido
  // do Zod perde o `| null` e não casa com Conversation["profiles"].
  const profile: Conversation["profiles"] = profiles
    ? { first_name: profiles.first_name, last_name: profiles.last_name, email: profiles.email }
    : null;
  return rowToConversation(rest, profile, (conversation_assignees ?? []).map((a) => a.user_id));
}

/** Uma página já validada: as conversas e o maior `updated_at` (do servidor) entre elas. */
export interface PaginaDaLista {
  rows: Conversation[];
  /** O valor original do servidor, ou null quando nenhuma linha trouxe um válido. */
  maiorUpdatedAt: string | null;
}

/**
 * Valida e converte a resposta de uma página. Linha malformada é descartada
 * com aviso em vez de derrubar a lista inteira (uma linha ruim entre 1000).
 *
 * O maior `updated_at` só considera linhas válidas e datas que se leem: um valor
 * torto não pode virar a marca d'água da próxima revalidação.
 */
export function parseListPage(data: unknown): PaginaDaLista {
  const rows: Conversation[] = [];
  let maiorUpdatedAt: string | null = null;
  let maiorMs = Number.NEGATIVE_INFINITY;
  if (!Array.isArray(data)) return { rows, maiorUpdatedAt };

  for (const raw of data) {
    const parsed = listRowSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[conversationListQuery] linha ignorada:", parsed.error.issues[0]?.message);
      continue;
    }
    rows.push(listRowToConversation(parsed.data));

    const updatedAt = parsed.data.updated_at;
    if (!updatedAt) continue;
    const ms = Date.parse(updatedAt);
    if (Number.isFinite(ms) && ms > maiorMs) {
      maiorMs = ms;
      maiorUpdatedAt = updatedAt;
    }
  }
  return { rows, maiorUpdatedAt };
}

/**
 * O retrato dos co-responsáveis do escopo: uma linha de `conversation_assignees` com o
 * número da conversa. `conversation_assignees` não move `conversations.updated_at`, então
 * a revalidação incremental só os vê por aqui. O embed `conversations!inner` é
 * muitos-para-um e volta como objeto; o `!inner` já dispensa a linha cuja conversa a RLS
 * esconde, e o `.in('conversations.phone_number_id', …)` recorta o escopo no servidor.
 */
export const COLUNAS_CO_RESPONSAVEIS = "conversation_id, user_id, conversations!inner(phone_number_id)";

const coResponsavelRowSchema = z.object({
  conversation_id: z.string(),
  user_id: z.string(),
  conversations: z.object({ phone_number_id: z.string().nullable() }).nullable().optional(),
});

export interface LinhaDeCoResponsavel {
  conversationId: string;
  userId: string;
  /** O número da conversa; null quando o embed não o trouxe. */
  numeroId: string | null;
}

/**
 * Valida uma página do retrato. Diferente da lista, aqui uma linha fora do contrato NÃO
 * pode ser descartada em silêncio: o retrato vale por completo ("quem não aparece não tem
 * co-responsável"), e uma linha a menos tiraria o co-responsável de alguém. Lança, e quem
 * chama deixa a lista como está. O mesmo vale para uma página que nem é lista: tratá-la como
 * vazia diria "ninguém é co-responsável" e apagaria todos eles.
 */
export function parseCoResponsaveis(data: unknown): LinhaDeCoResponsavel[] {
  if (!Array.isArray(data)) throw new Error("página de co-responsáveis fora do contrato: não é uma lista");
  return data.map((raw) => {
    const parsed = coResponsavelRowSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`linha de co-responsável fora do contrato: ${parsed.error.issues[0]?.message ?? "sem detalhe"}`);
    }
    return {
      conversationId: parsed.data.conversation_id,
      userId: parsed.data.user_id,
      numeroId: parsed.data.conversations?.phone_number_id ?? null,
    };
  });
}
