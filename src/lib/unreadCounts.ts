/**
 * Contagem de não-lidas por número: as partes puras do `refreshUnreadCounts`.
 *
 * A RPC `get_unread_counts` corta em 999 conversas POR CHAMADA, então com vários
 * números no escopo ela roda uma vez por número (cada um com o seu teto) e o
 * resultado é a junção das respostas. Duas decisões moram aqui, fora do React,
 * para serem testáveis sem montar o contexto:
 *
 *  - `mesclarContagens`: um número que falha não apaga as contagens dele (o badge
 *    sumindo por causa de um erro de rede seria dizer "lido" sem ter lido);
 *  - `criarVooUnico`: uma busca em voo por vez, que quem chega no meio reaproveita.
 *    Focus, visibilidade, reassinar do canal, troca de escopo e o poll disparam a
 *    mesma busca; sem isto, cada disparo custava N chamadas;
 *  - `buscarContagemDaLinha`: UMA chamada com prazo. Sem ele, uma RPC pendurada
 *    seguraria o voo único para sempre (badge, troca de escopo, reassinar e poll
 *    esperariam por ela).
 */
import { z } from "zod";

export interface LinhaDeContagem {
  conversation_id: string;
  /** `bigint` no Postgres: o PostgREST pode entregar número ou texto. */
  count: number | string;
  total_conversations?: number | string;
}

/** `bigint` chega como número ou como texto: vale o que vira um número finito. */
const numeroOuTexto = z
  .union([z.number(), z.string().trim().min(1)])
  .refine((valor) => Number.isFinite(Number(valor)), "não é número");

const linhaDeContagemSchema = z.object({
  conversation_id: z.string().min(1),
  count: numeroOuTexto,
  total_conversations: numeroOuTexto.nullish().transform((valor) => valor ?? undefined),
});

/**
 * Valida a resposta de `get_unread_counts`. Linha fora do contrato é descartada com
 * aviso (como `parseListRows`): uma linha ruim não derruba o badge das outras. Algo que
 * nem é lista (e não é `null`, que é "sem não-lidas") devolve `null` = a chamada falhou.
 */
export function parseLinhasDeContagem(data: unknown): LinhaDeContagem[] | null {
  if (data == null) return [];
  if (!Array.isArray(data)) {
    console.warn("[unreadCounts] resposta de get_unread_counts não é uma lista:", typeof data);
    return null;
  }
  const linhas: LinhaDeContagem[] = [];
  for (const bruta of data) {
    const parsed = linhaDeContagemSchema.safeParse(bruta);
    if (!parsed.success) {
      console.warn("[unreadCounts] linha ignorada:", parsed.error.issues[0]?.message);
      continue;
    }
    const { conversation_id, count, total_conversations } = parsed.data;
    linhas.push(
      total_conversations === undefined
        ? { conversation_id, count }
        : { conversation_id, count, total_conversations },
    );
  }
  return linhas;
}

/** Quanto se espera por UMA chamada de `get_unread_counts` antes de dá-la como falha. */
export const PRAZO_CONTAGEM_MS = 15_000;

/**
 * Uma chamada de `get_unread_counts` com prazo. Estourou o prazo, erro ou exceção:
 * `falhou: true` (o número mantém as contagens de antes em `mesclarContagens`). O
 * `AbortController` cancela a requisição de verdade; a corrida com o relógio garante
 * que a promise assenta mesmo que quem chamou ignore o sinal.
 */
export async function buscarContagemDaLinha(
  linha: string | null,
  chamar: (linha: string | null, sinal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }>,
  prazoMs: number = PRAZO_CONTAGEM_MS,
): Promise<RespostaDeContagem> {
  const nome = linha ?? "todos os números";
  const controlador = new AbortController();
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const estouro = new Promise<"prazo">((resolver) => {
    relogio = setTimeout(() => {
      controlador.abort();
      resolver("prazo");
    }, prazoMs);
  });
  try {
    const resultado = await Promise.race([chamar(linha, controlador.signal), estouro]);
    if (resultado === "prazo") {
      console.error(`Error fetching unread counts (${nome}): sem resposta em ${prazoMs} ms`);
      return { linha, rows: null, falhou: true };
    }
    if (resultado.error) {
      console.error(`Error fetching unread counts (${nome}):`, resultado.error);
      return { linha, rows: null, falhou: true };
    }
    const rows = parseLinhasDeContagem(resultado.data);
    return rows ? { linha, rows, falhou: false } : { linha, rows: null, falhou: true };
  } catch (erro) {
    // Um número que lança não pode derrubar a busca dos outros.
    console.error(`Error fetching unread counts (${nome}):`, erro);
    return { linha, rows: null, falhou: true };
  } finally {
    clearTimeout(relogio);
  }
}

export interface RespostaDeContagem {
  /** O número consultado. `null` = a consulta sem escopo (todos os números do usuário). */
  linha: string | null;
  rows: readonly LinhaDeContagem[] | null;
  /** A RPC falhou (erro devolvido pelo PostgREST ou exceção). */
  falhou: boolean;
}

/**
 * Junta as respostas por número no mapa conversa → não-lidas.
 *
 * - Número que respondeu: as contagens dele substituem as de antes.
 * - Número que falhou: ficam as contagens que a lista já tinha para as conversas
 *   dele (`linhaDaConversa` diz a quem cada uma pertence). Conversa de número
 *   desconhecido não é mantida: não dá para saber se é dele.
 * - `ignorar`: conversas com leitura em voo. A resposta foi montada antes de a
 *   marca d'água ser gravada e ressuscitaria o badge que o usuário acabou de limpar.
 *
 * Devolve `undefined` quando nenhuma resposta serve (todas falharam, ou não houve
 * nenhuma): quem chama deixa o mapa como está, que é o caminho de erro de sempre.
 */
export function mesclarContagens({
  respostas,
  anterior,
  linhaDaConversa,
  ignorar,
}: {
  respostas: readonly RespostaDeContagem[];
  anterior: ReadonlyMap<string, number>;
  linhaDaConversa: (conversationId: string) => string | null | undefined;
  ignorar: ReadonlySet<string>;
}): Map<string, number> | undefined {
  if (respostas.length === 0 || respostas.every((resposta) => resposta.falhou)) return undefined;

  const mesclado = new Map<string, number>();
  const linhasQueFalharam = new Set<string | null>();

  for (const resposta of respostas) {
    if (resposta.falhou) {
      linhasQueFalharam.add(resposta.linha);
      continue;
    }
    for (const row of resposta.rows ?? []) {
      if (ignorar.has(row.conversation_id)) continue;
      mesclado.set(row.conversation_id, Number(row.count));
    }
  }

  if (linhasQueFalharam.size > 0) {
    for (const [conversationId, quantidade] of anterior) {
      // O que acabou de chegar de um número que respondeu é mais novo que o guardado.
      if (ignorar.has(conversationId) || mesclado.has(conversationId)) continue;
      const linha = linhaDaConversa(conversationId);
      if (linha != null && linhasQueFalharam.has(linha)) mesclado.set(conversationId, quantidade);
    }
  }

  return mesclado;
}

/**
 * A RPC ordena, corta em 999 e devolve o total ANTES do corte em cada linha. Se o
 * total passa do que veio, a resposta foi truncada: as conversas mais paradas ficaram
 * sem badge. Sem comparar, a truncagem seria invisível.
 */
export function respostaTruncada(rows: readonly LinhaDeContagem[] | null): { recebidas: number; total: number } | null {
  if (!rows || rows.length === 0) return null;
  const total = Number(rows[0].total_conversations ?? 0);
  return total > rows.length ? { recebidas: rows.length, total } : null;
}

export interface OpcoesDoVoo {
  /**
   * Quer o resultado de uma busca que COMECE depois desta chamada. Sem isto, quem chega
   * no meio do voo recebe a busca que já estava a caminho, e a foto do servidor dela é
   * anterior à chamada: serve para focus e poll, não para quem acabou de reassinar o
   * canal e precisa do que ele perdeu enquanto esteve fora (o INSERT que caiu entre a
   * foto e a assinatura não está na resposta nem chegou pelo realtime).
   */
  fresca?: boolean;
}

export interface VooUnico<TResultado> {
  (opcoes?: OpcoesDoVoo): Promise<TResultado>;
  /**
   * O que a busca em voo olhou mudou (o escopo): o que ela trouxer é de outro
   * escopo e não vale. Ela termina, descarta o resultado e roda mais uma vez, e é
   * essa segunda que todos os que esperavam recebem.
   */
  invalidar: () => void;
}

/**
 * Quantas vezes, no máximo, chamadas frescas reiniciam UM mesmo voo. Um canal que oscila
 * mais depressa do que a busca dura (a reassinatura chama `fresca` a cada volta) a
 * reiniciaria sem fim, e nenhum resultado chegaria ao estado enquanto a oscilação durasse.
 * Passado o limite a chamada divide o voo em curso, e a próxima queda abre outro.
 */
export const MAX_REINICIOS_FRESCOS = 2;

/**
 * Uma busca por vez. Chamadas durante o voo recebem a MESMA promise (e portanto o
 * mesmo resultado); só depois que ela termina uma nova chamada dispara outra busca.
 * Uma chamada `fresca` no meio do voo faz o mesmo que `invalidar`: a busca em voo
 * termina, é descartada e roda mais uma vez, e todos recebem a nova (até
 * `MAX_REINICIOS_FRESCOS` vezes por voo).
 *
 * `buscar` não deve ter efeito colateral: o que ela devolve só chega a `aplicar`
 * (que grava no estado) se não houve `invalidar()` (ou chamada fresca) durante o voo.
 * Assim um resultado de escopo velho nunca aparece na tela, nem por um instante.
 */
export function criarVooUnico<TBusca, TResultado>(
  buscar: () => Promise<TBusca>,
  aplicar: (busca: TBusca) => TResultado,
): VooUnico<TResultado> {
  let voo: Promise<TResultado> | null = null;
  let geracao = 0;
  // A geração com que a busca em curso começou: se `geracao` já passou dela, há uma nova busca
  // pendente (por `invalidar` ou por outra chamada fresca), e ela atende quem chegar agora também.
  let geracaoEmCurso = 0;
  let reiniciosFrescos = 0;

  const executar = async (): Promise<TResultado> => {
    for (;;) {
      const geracaoDaBusca = geracao;
      geracaoEmCurso = geracaoDaBusca;
      const busca = await buscar();
      if (geracaoDaBusca !== geracao) continue;
      return aplicar(busca);
    }
  };

  const chamar = ((opcoes?: OpcoesDoVoo) => {
    if (voo) {
      if (opcoes?.fresca && geracao === geracaoEmCurso && reiniciosFrescos < MAX_REINICIOS_FRESCOS) {
        reiniciosFrescos += 1;
        geracao += 1;
      }
      return voo;
    }
    reiniciosFrescos = 0;
    // O `.finally` roda depois de a promise assentar (nunca no mesmo tick): a
    // atribuição abaixo já aconteceu, e uma falha síncrona de `buscar` não deixa
    // `voo` preso a uma promise rejeitada.
    const atual: Promise<TResultado> = executar().finally(() => {
      if (voo === atual) voo = null;
    });
    voo = atual;
    return atual;
  }) as VooUnico<TResultado>;

  chamar.invalidar = () => {
    geracao += 1;
  };

  return chamar;
}
