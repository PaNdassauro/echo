/**
 * As tags das conversas da lista, uma chamada por número do escopo.
 *
 * `get_conversation_tags_for_user` é escopada por número (sem o escopo ela devolvia
 * as tags de todas as linhas e o PostgREST cortava em 1000 sem erro), então a caixa
 * conjunta pede um número por vez e junta o resultado. Puro e sem React: a chamada
 * entra por `buscar`, e o que fazer com a falha de um número (ficar com o que já se
 * sabia dele) é regra daqui, testável.
 */

import { z } from "zod";
import type { TagData } from "@/components/ConversationTagPills";
import { mapComLimite } from "@/lib/fetchAllPaginated";

/** Quantas chamadas de tags correm ao mesmo tempo (as RPCs escopadas por RLS são caras). */
export const TAGS_CONCORRENCIA = 4;

const linhaDeTagSchema = z.object({
  conversation_id: z.string(),
  tag_id: z.string(),
  tag_name: z.string(),
  tag_color: z.string().nullish(),
});
const linhasDeTagSchema = z.array(linhaDeTagSchema);

export type TagsPorConversa = Map<string, TagData[]>;

/**
 * A resposta da RPC como mapa conversa → tags. null = fora do contrato (não é lista, ou
 * uma linha sem os campos): vale como falha do número, não como "sem tags".
 */
export function tagsDaResposta(data: unknown): TagsPorConversa | null {
  const parsed = linhasDeTagSchema.safeParse(data ?? []);
  if (!parsed.success) {
    console.error("[tags] resposta fora do contrato:", parsed.error.issues);
    return null;
  }
  const mapa: TagsPorConversa = new Map();
  // A RPC não devolve phone_number_id (ver o RETURNS TABLE no baseline); a linha da tag
  // vem de `tags`, este mapa só diz quais tags cada conversa tem.
  for (const linha of parsed.data) {
    const tag: TagData = { id: linha.tag_id, name: linha.tag_name, color: linha.tag_color ?? "", phone_number_id: null };
    const atuais = mapa.get(linha.conversation_id);
    if (atuais) atuais.push(tag);
    else mapa.set(linha.conversation_id, [tag]);
  }
  return mapa;
}

/** O que a busca de um número devolveu: as tags dele, ou null se falhou. */
export interface TagsDoNumero {
  numeroId: string;
  tags: TagsPorConversa | null;
}

export type BuscarTagsDoNumero = (numeroId: string) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * Busca as tags de cada número (até `TAGS_CONCORRENCIA` ao mesmo tempo). A falha de um
 * número (erro da RPC, exceção ou resposta fora do contrato) vira `tags: null` e não
 * derruba os outros.
 */
export function buscarTagsDosNumeros(
  numeros: readonly string[],
  buscar: BuscarTagsDoNumero,
  { concorrencia = TAGS_CONCORRENCIA }: { concorrencia?: number } = {},
): Promise<TagsDoNumero[]> {
  return mapComLimite(
    numeros,
    async (numeroId): Promise<TagsDoNumero> => {
      try {
        const { data, error } = await buscar(numeroId);
        if (error) return { numeroId, tags: null };
        return { numeroId, tags: tagsDaResposta(data) };
      } catch (erro) {
        console.error("[tags] busca de um número falhou:", erro);
        return { numeroId, tags: null };
      }
    },
    { concurrency: concorrencia },
  );
}

/**
 * Junta o que chegou ao mapa que já está na tela.
 *
 * - Número que respondeu: as conversas dele são SUBSTITUÍDAS pelas da resposta (uma
 *   conversa sem tag some do mapa).
 * - Número que falhou: as conversas dele ficam como estavam (a linha de cada
 *   conversa vem de `linhaDaConversa`, a lista em memória).
 * - Número que nem foi pedido (atualização de um número só): ficam como estavam.
 * - Conversa de um número fora do escopo sai. A de linha desconhecida (não está na lista
 *   em memória) só sai quando a busca cobre o escopo todo (`completo`): numa parcial
 *   não há como saber de quem ela é.
 */
export function mesclarTagsDosNumeros(params: {
  anterior: TagsPorConversa;
  resultados: readonly TagsDoNumero[];
  linhaDaConversa: (conversationId: string) => string | null | undefined;
  escopo: ReadonlySet<string>;
  completo: boolean;
}): TagsPorConversa {
  const { anterior, resultados, linhaDaConversa, escopo, completo } = params;
  const respondidos = new Set(resultados.filter((r) => r.tags !== null).map((r) => r.numeroId));

  const out: TagsPorConversa = new Map();
  for (const [conversationId, tags] of anterior) {
    const linha = linhaDaConversa(conversationId);
    if (!linha) {
      if (!completo) out.set(conversationId, tags);
      continue;
    }
    if (!escopo.has(linha) || respondidos.has(linha)) continue;
    out.set(conversationId, tags);
  }
  for (const resultado of resultados) {
    if (!resultado.tags) continue;
    for (const [conversationId, tags] of resultado.tags) out.set(conversationId, tags);
  }
  return out;
}

const eventoDeTagSchema = z.object({ conversation_id: z.string().min(1) }).passthrough();

/**
 * A conversa de um evento do realtime de `conversation_tags`, ou null quando o evento não
 * diz. Um DELETE quase sempre devolve null: com RLS ativa, o Supabase Realtime manda no
 * `old` só a chave primária (`id`), mesmo com REPLICA IDENTITY FULL. Então o DELETE de uma
 * tag cai no refetch de todos os números do escopo (N chamadas, 4 por vez). Resolver isso
 * exige a RPC devolver `conversation_tags.id` junto de cada tag, para o front mapear o id
 * da tag para a conversa (migração; fica como pendência).
 */
export function idDaConversaDoEventoDeTag(payload: { new?: unknown; old?: unknown }): string | null {
  for (const linha of [payload.new, payload.old]) {
    const parsed = eventoDeTagSchema.safeParse(linha);
    if (parsed.success) return parsed.data.conversation_id;
  }
  return null;
}
