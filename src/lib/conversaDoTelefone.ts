/**
 * Acha a conversa individual de um telefone numa linha, mesmo quando a RLS a
 * esconde de quem chama. Com "só quem assumiu vê" ligado, a busca direta em
 * `conversations` devolve 0 linhas para a conversa de outra atendente, e o
 * fluxo de "Nova conversa" caía no INSERT (23505 ou duplicata). A RPC
 * `conversa_do_telefone_na_linha` casa por variações BR, ignora a RLS e diz se
 * quem chama enxerga a conversa e quem é a dona.
 */

import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

// O id só vem quando quem chama enxerga a conversa (a RPC esconde o da conversa
// de outra pessoa): visível sem id é resposta fora do contrato.
const linhaSchema = z
  .object({
    conversation_id: z.string().uuid().nullable(),
    visivel: z.boolean(),
    dono: z.string().nullable(),
  })
  .refine((linha) => !linha.visivel || linha.conversation_id !== null, {
    message: "conversa visível sem id",
  });

// A RPC devolve 0 ou 1 linha.
const respostaSchema = z.array(linhaSchema).max(1);

export type ConversaDoTelefone =
  | { tipo: "visivel"; id: string }
  | { tipo: "de_outra"; dono: string | null }
  | { tipo: "nenhuma" };

/** Erro da RPC ou resposta fora do contrato: lança, o fluxo mostra o toast de erro. */
export async function buscarConversaDoTelefone(
  phoneNumberId: string,
  telefone: string,
): Promise<ConversaDoTelefone> {
  const { data, error } = await supabase.rpc("conversa_do_telefone_na_linha", {
    p_phone_number_id: phoneNumberId,
    p_telefone: telefone,
  });
  if (error) {
    console.error("[conversaDoTelefone] RPC falhou:", error);
    throw error;
  }

  const parsed = respostaSchema.safeParse(data);
  if (!parsed.success) {
    console.error("[conversaDoTelefone] resposta fora do contrato:", parsed.error.issues[0]);
    throw new Error("Resposta inesperada ao buscar a conversa do telefone.");
  }

  const linha = parsed.data[0];
  if (!linha) return { tipo: "nenhuma" };
  if (linha.visivel && linha.conversation_id) return { tipo: "visivel", id: linha.conversation_id };
  return { tipo: "de_outra", dono: linha.dono?.trim() || null };
}

/** Título e descrição do toast quando a conversa já está com outra pessoa. */
export function avisoConversaDeOutra(dono: string | null): { title: string; description: string } {
  return {
    title: dono ? `Esta conversa já está com ${dono}` : "Esta conversa já está em atendimento",
    description: "Peça para quem está atendendo compartilhar ou transferir a conversa com você.",
  };
}
