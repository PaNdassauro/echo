/**
 * A busca global de mensagens sobre um conjunto de números.
 *
 * `search_messages` é escopada por número (`p_phone_number_id`), então a caixa conjunta
 * faz uma chamada por número e junta: as mais novas primeiro, no máximo `LIMITE_DA_BUSCA`.
 * Sem React: a chamada e o sinal de cancelamento entram por parâmetro, e a regra de
 * juntar e de abortar o lote fica testável.
 */

import { z } from "zod";
import { mapComLimite } from "@/lib/fetchAllPaginated";

/** Quantas mensagens a lista de resultados mostra, no total (não por número). */
export const LIMITE_DA_BUSCA = 50;
/** Quantas chamadas `search_messages` correm ao mesmo tempo. */
export const BUSCA_CONCORRENCIA = 4;

export interface GlobalSearchResult {
  id: string;
  content: string;
  created_at: string;
  direction: string;
  message_type: string | null;
  conversation_id: string;
  contact_name: string;
  contact_phone: string;
  is_group: boolean;
  /** O número (phone_numbers.id) em que a mensagem foi achada: o selo da caixa conjunta usa. */
  phone_number_id: string;
}

/** A linha da RPC. `phone_number_id` é opcional: a RPC de hoje não o devolve. */
const linhaDaBuscaSchema = z.object({
  id: z.string(),
  content: z.string().nullish(),
  created_at: z.string(),
  direction: z.string(),
  message_type: z.string().nullish(),
  conversation_id: z.string(),
  contact_name: z.string().nullish(),
  contact_phone: z.string().nullish(),
  is_group: z.boolean().nullish(),
  phone_number_id: z.string().nullish(),
});
const linhasDaBuscaSchema = z.array(linhaDaBuscaSchema);

/**
 * A resposta de UM número como resultados. O número da mensagem é o da linha da RPC, se
 * vier, e senão o que se consultou (a RPC só devolve conversas do número pedido). null =
 * fora do contrato.
 */
export function resultadosDaResposta(data: unknown, numeroConsultado: string): GlobalSearchResult[] | null {
  const parsed = linhasDaBuscaSchema.safeParse(data ?? []);
  if (!parsed.success) {
    console.error("[busca] resposta fora do contrato:", parsed.error.issues);
    return null;
  }
  return parsed.data.map((item) => ({
    id: item.id,
    content: item.content ?? "",
    created_at: item.created_at,
    direction: item.direction,
    message_type: item.message_type ?? null,
    conversation_id: item.conversation_id,
    contact_name: item.contact_name || "Desconhecido",
    contact_phone: item.contact_phone || "",
    is_group: item.is_group ?? false,
    phone_number_id: item.phone_number_id || numeroConsultado,
  }));
}

/** Junta os resultados dos números: mais novos primeiro, um por id, cortados em `limite`. */
export function juntarResultados(lotes: readonly (readonly GlobalSearchResult[])[], limite = LIMITE_DA_BUSCA): GlobalSearchResult[] {
  const vistos = new Set<string>();
  const decorados: Array<{ resultado: GlobalSearchResult; instante: number }> = [];
  for (const lote of lotes) {
    for (const resultado of lote) {
      if (vistos.has(resultado.id)) continue;
      vistos.add(resultado.id);
      const instante = Date.parse(resultado.created_at);
      decorados.push({ resultado, instante: Number.isNaN(instante) ? 0 : instante });
    }
  }
  // Sort estável: com o mesmo instante, vale a ordem dos números e a da RPC.
  decorados.sort((a, b) => b.instante - a.instante);
  return decorados.slice(0, limite).map((item) => item.resultado);
}

export type BuscarNoNumero = (
  numeroId: string,
  sinal: AbortSignal,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export interface ResultadoDoLote {
  /** O que os números que responderam acharam, já juntado e cortado. */
  resultados: GlobalSearchResult[];
  /** Os números cuja busca falhou (erro da RPC, exceção ou fora do contrato). */
  falhas: string[];
  /** O lote foi cancelado (um termo novo, ou o diálogo fechou): quem pediu descarta. */
  abortado: boolean;
}

/**
 * Um lote de busca: uma chamada por número, até `BUSCA_CONCORRENCIA` ao mesmo tempo, todas
 * com o MESMO sinal — abortar o controller do lote cancela o que está em voo e o que ainda
 * esperava vaga (essas nem saem). A falha de um número não derruba os outros.
 */
export async function buscarNosNumeros(
  numeros: readonly string[],
  buscar: BuscarNoNumero,
  sinal: AbortSignal,
  { concorrencia = BUSCA_CONCORRENCIA, limite = LIMITE_DA_BUSCA }: { concorrencia?: number; limite?: number } = {},
): Promise<ResultadoDoLote> {
  const respostas = await mapComLimite(
    numeros,
    async (numeroId): Promise<{ numeroId: string; resultados: GlobalSearchResult[] | null }> => {
      if (sinal.aborted) return { numeroId, resultados: null };
      try {
        const { data, error } = await buscar(numeroId, sinal);
        if (error) {
          if (!sinal.aborted) console.error("Error searching messages:", error);
          return { numeroId, resultados: null };
        }
        return { numeroId, resultados: resultadosDaResposta(data, numeroId) };
      } catch (erro) {
        if (!sinal.aborted) console.error("Search error:", erro);
        return { numeroId, resultados: null };
      }
    },
    { concurrency: concorrencia },
  );

  if (sinal.aborted) return { resultados: [], falhas: [], abortado: true };

  const falhas = respostas.filter((r) => r.resultados === null).map((r) => r.numeroId);
  const lotes = respostas.flatMap((r) => (r.resultados ? [r.resultados] : []));
  return { resultados: juntarResultados(lotes, limite), falhas, abortado: false };
}
