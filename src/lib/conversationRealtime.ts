/**
 * Contratos dos payloads de realtime da lista de conversas.
 *
 * Tudo que chega pelo canal (postgres_changes de `conversations` e
 * `conversation_assignees`, broadcast de conversa) é input externo: passa por
 * Zod antes de tocar no estado. Campos que não estão no schema são descartados
 * (comportamento padrão de `z.object`), então uma coluna nova no banco não
 * quebra nem vaza para a UI sem passar por aqui.
 */

import { z } from "zod";
import type { Conversation } from "@/types/conversation";
import { getMessagePreview } from "./messagePreview";

export const conversationRowSchema = z.object({
  id: z.string().uuid(),
  contact_name: z.string().nullable(),
  contact_phone: z.string().nullable(),
  last_message_at: z.string(),
  status: z.string().nullable(),
  phone_number_id: z.string().uuid().nullable(),
  sector_id: z.string().uuid().nullable(),
  assigned_to: z.string().uuid().nullable(),
  is_group: z.boolean().nullable(),
  contact_avatar_url: z.string().nullable(),
  contact_avatar_updated_at: z.string().nullable().optional(),
  // Colunas desnormalizadas da última mensagem. Opcionais porque um canal
  // assinado antes da migração ainda entrega linhas sem elas.
  last_message_content: z.string().nullable().optional(),
  last_message_type: z.string().nullable().optional(),
  last_message_direction: z.enum(["inbound", "outbound"]).nullable().optional(),
  last_message_is_deleted: z.boolean().nullable().optional(),
  // Direct do Instagram (fase 2). Opcionais pelo mesmo motivo acima.
  channel: z.string().nullable().optional(),
  instagram_username: z.string().nullable().optional(),
  instagram_user_id: z.string().nullable().optional(),
  // Aba Disparos. Opcionais pelo mesmo motivo acima. Um nome nulo dentro do
  // array (array_agg sem filtro) sai aqui em vez de derrubar a linha inteira.
  disparo_desde: z.string().nullable().optional(),
  disparo_rotulo: z.string().nullable().optional(),
  disparo_status: z.string().nullable().optional(),
  disparo_campanhas: z
    .array(z.string().nullable())
    .transform((nomes) => nomes.filter((nome): nome is string => !!nome))
    .nullable()
    .optional(),
  // Aba Com a IA. Opcionais pelo mesmo motivo.
  ia_desde: z.string().nullable().optional(),
  ia_origem: z.string().nullable().optional(),
  ia_sem_resposta_desde: z.string().nullable().optional(),
});

export type ConversationRow = z.infer<typeof conversationRowSchema>;

export const assigneeRowSchema = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

/**
 * No DELETE com REPLICA IDENTITY DEFAULT o Postgres só publica a chave
 * primária — `old_record` chega com `id` e nada mais.
 */
export const assigneeOldRowSchema = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
});

export const broadcastConversationPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  contactName: z.string().nullish(),
  sectorName: z.string().nullish(),
  sectorId: z.string().uuid().nullish(),
});

export type BroadcastConversationPayload = z.infer<typeof broadcastConversationPayloadSchema>;

/**
 * Prévia/direção a partir das colunas desnormalizadas. Só existe quando a row
 * traz `last_message_direction`: sem ele não há como saber se a conversa não
 * tem mensagem ou se a linha veio de um canal antigo, e a UI trata os dois
 * casos como "sem prévia".
 */
export function previewFromRow(
  row: ConversationRow,
): Pick<Conversation, "last_message_preview" | "last_message_direction"> {
  if (row.last_message_direction == null) {
    return { last_message_preview: undefined, last_message_direction: undefined };
  }
  return {
    last_message_preview: getMessagePreview({
      content: row.last_message_content,
      message_type: row.last_message_type,
      is_deleted: row.last_message_is_deleted,
    }),
    last_message_direction: row.last_message_direction,
  };
}

/** Monta uma Conversation completa a partir de uma row do realtime. */
export function rowToConversation(
  row: ConversationRow,
  profiles: Conversation["profiles"],
  coAssigneeIds: string[],
): Conversation {
  return {
    id: row.id,
    contact_name: row.contact_name ?? "",
    contact_phone: row.contact_phone ?? "",
    last_message_at: row.last_message_at,
    status: row.status ?? "",
    phone_number_id: row.phone_number_id,
    sector_id: row.sector_id,
    assigned_to: row.assigned_to,
    is_group: row.is_group ?? false,
    contact_avatar_url: row.contact_avatar_url,
    contact_avatar_updated_at: row.contact_avatar_updated_at ?? null,
    channel: row.channel === "instagram" ? "instagram" : "whatsapp",
    instagram_username: row.instagram_username ?? null,
    instagram_user_id: row.instagram_user_id ?? null,
    disparo_desde: row.disparo_desde ?? null,
    disparo_rotulo: row.disparo_rotulo ?? null,
    disparo_status: row.disparo_status ?? null,
    disparo_campanhas: row.disparo_campanhas ?? null,
    ia_desde: row.ia_desde ?? null,
    ia_origem: row.ia_origem ?? null,
    ia_sem_resposta_desde: row.ia_sem_resposta_desde ?? null,
    ...previewFromRow(row),
    profiles,
    co_assignee_ids: coAssigneeIds,
  };
}
