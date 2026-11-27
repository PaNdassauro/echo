import { supabase } from "@/integrations/supabase/client";

/** Violação de índice único do Postgres. */
const CODIGO_DUPLICADA = "23505";

export interface ConversaDeGrupo {
  conversationId?: string;
  error: { message: string; code?: string } | null;
}

/**
 * Garante a conversa de um grupo que a linha acabou de criar ou em que acabou de entrar.
 *
 * O serviço de QR também cria essa conversa quando o evento do grupo chega pelo webhook. Quem grava depois esbarra
 * no índice único `idx_conversations_unique_phone` (phone_number_id, contact_phone, is_group): nesse caso a conversa
 * já existe, e o certo é devolvê-la em vez de reportar erro (a tela dizia "houve um erro ao salvar a conversa" com
 * a conversa na lista, e não abria o grupo recém-criado).
 */
export async function garantirConversaDoGrupo(phoneNumberId: string, groupJid: string, name: string): Promise<ConversaDeGrupo> {
  const { data, error } = await supabase
    .from("conversations")
    .insert({
      phone_number_id: phoneNumberId,
      contact_name: name,
      contact_phone: groupJid, // o JID do grupo faz o papel do telefone no roteamento
      whatsapp_id: groupJid,
      is_group: true,
      group_jid: groupJid,
      status: "active",
    })
    .select("id")
    .single();

  if (!error) return { conversationId: data?.id, error: null };
  if (error.code !== CODIGO_DUPLICADA) return { error };

  const { data: existente, error: erroDaBusca } = await supabase
    .from("conversations")
    .select("id")
    .eq("phone_number_id", phoneNumberId)
    .eq("contact_phone", groupJid)
    .eq("is_group", true)
    .maybeSingle();

  if (erroDaBusca || !existente) return { error };
  return { conversationId: existente.id, error: null };
}
