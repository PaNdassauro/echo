/**
 * Configuração da organização que envolve segredo (token da WhatsApp Cloud API
 * e chave de IA).
 *
 * `authenticated` não tem SELECT nas colunas secretas de `organizations`: o front
 * só sabe SE o segredo existe, pelas RPCs get_org_whatsapp_config e
 * get_org_ai_config (admin da organização ou super admin; as duas dão 42501 para
 * os demais). A escrita do token é um UPDATE de coluna e a da chave de IA é a
 * RPC set_ai_api_key.
 */
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

export const orgWhatsappConfigSchema = z.object({
  whatsapp_waba_id: z.string().nullable(),
  whatsapp_app_id: z.string().nullable(),
  tem_token: z.boolean(),
});

export const orgAiConfigSchema = z.object({
  tem_chave: z.boolean(),
  ai_insights_prompt: z.string().nullable(),
});

export type OrgWhatsappConfig = z.infer<typeof orgWhatsappConfigSchema>;
export type OrgAiConfig = z.infer<typeof orgAiConfigSchema>;

/** As duas RPCs devolvem no máximo uma linha; organização inexistente volta vazia. */
const primeiraLinha = <T extends z.ZodTypeAny>(schema: T) =>
  z.array(schema).transform((linhas) => linhas[0] ?? null);

export async function buscarConfigWhatsapp(orgId: string): Promise<OrgWhatsappConfig | null> {
  const { data, error } = await supabase.rpc("get_org_whatsapp_config", { p_org_id: orgId });
  if (error) throw error;
  const parsed = primeiraLinha(orgWhatsappConfigSchema).safeParse(data ?? []);
  if (!parsed.success) {
    console.error("[orgSecrets] get_org_whatsapp_config fora do contrato:", parsed.error.issues);
    throw new Error("Resposta inesperada ao carregar a integração do WhatsApp.");
  }
  return parsed.data;
}

export async function buscarConfigIa(orgId: string): Promise<OrgAiConfig | null> {
  const { data, error } = await supabase.rpc("get_org_ai_config", { p_org_id: orgId });
  if (error) throw error;
  const parsed = primeiraLinha(orgAiConfigSchema).safeParse(data ?? []);
  if (!parsed.success) {
    console.error("[orgSecrets] get_org_ai_config fora do contrato:", parsed.error.issues);
    throw new Error("Resposta inesperada ao carregar a configuração de IA.");
  }
  return parsed.data;
}
