/**
 * Busca da lista de conversas por número, para o escopo da tela (um ou vários).
 *
 * Puro e sem rede: quem monta a query do PostgREST injeta `buscarPagina` /
 * `buscar`, e quem guarda o estado recebe os resultados por callback. É o que
 * deixa o comportamento (ordem, prazo, teto de requisições, coalescência)
 * testável com relógio falso.
 *
 * Três caminhos:
 *  - `buscarEscopoCompleto`: baixa os números inteiros, um fetch por número, em
 *    paralelo. Cada número roda o algoritmo de sempre (página 1 com `count`,
 *    páginas 2..N de uma vez, guarda de cauda enquanto a última vem cheia), e o
 *    teto de requisições em voo vale para o escopo todo, não por número;
 *  - `buscarIncremental`: UMA requisição com o que mudou desde a marca d'água do
 *    servidor. É o que o poll, o reassinar do canal e a volta da aba usam, no lugar
 *    de baixar tudo de novo;
 *  - `buscarCoResponsaveis`: o retrato dos co-responsáveis do escopo, que o
 *    incremental pede junto.
 *
 * A marca d'água é SEMPRE dado do servidor (o maior `updated_at` visto), nunca o
 * relógio do cliente: um relógio adiantado esconderia para sempre o que mudou.
 *
 * Pontos cegos do incremental, e quem os cobre:
 *  - conversa APAGADA ou que saiu do escopo da RLS: nenhuma linha vem, e só o fetch
 *    completo (periódico, ou após uma queda do canal) a tira da lista;
 *  - co-responsável (o embed `conversation_assignees`): incluir ou tirar
 *    um co-responsável não move `conversations.updated_at` (não há gatilho em
 *    `conversation_assignees`), então a revalidação pede o retrato à parte.
 */
import type { Conversation } from "@/types/conversation";
import { LIST_PAGE_SIZE, parseCoResponsaveis, parseListPage } from "@/lib/conversationListQuery";
import { criarLimitador } from "@/lib/fetchAllPaginated";

/** Quanto se espera pela página 1 de todos os números antes de pintar o que já chegou. */
export const PRAZO_PRIMEIRA_PAGINA_MS = 1_500;

/** Requisições de página em voo ao mesmo tempo, somando todos os números. */
export const MAX_PAGINAS_EM_VOO = 6;

/**
 * Esperas antes de cada nova tentativa de UMA página (até 2 novas tentativas, 3 no
 * total). Só vale para falha transitória (ver `respostaTransitoria`): a caixa conjunta
 * multiplica as requisições, e um soluço de rede (QUIC, endereço inalcançável) numa
 * página 2+ não pode marcar o número inteiro como falho nem acender a faixa de erro.
 */
export const ESPERAS_NOVA_TENTATIVA_MS: readonly number[] = [400, 1_200];

/** Entre dois commits de um mesmo número (o commit final não espera). */
export const INTERVALO_COMMIT_MS = 250;

/**
 * Folga da revalidação incremental. O `updated_at` é o `now()` do início da
 * transação que gravou, então uma linha pode ser confirmada depois de outra com
 * `updated_at` mais novo: buscar a partir da marca menos esta folga não perde
 * nenhuma, e o que vier repetido o reconcile absorve.
 */
export const FOLGA_INCREMENTAL_MS = 2 * 60_000;

/** De quanto em quanto tempo a revalidação de fundo vira um fetch completo. */
export const COMPLETO_A_CADA_MS = 10 * 60_000;

/**
 * Depois de uma queda do canal realtime o completo volta a valer, mas só se o último
 * já tem mais que isto: uma tempestade de reconexões (queda prolongada do Realtime) não pode
 * baixar o escopo inteiro a cada reassinatura.
 */
export const COMPLETO_APOS_QUEDA_MS = 2 * 60_000;

/** O que o PostgREST devolve por página (`data` é cru: quem valida é `parseListPage`). */
export interface RespostaDePagina {
  data: unknown;
  count: number | null;
  error: { message: string; code?: string } | null;
  /**
   * Status HTTP da resposta, como o supabase-js devolve. 0 ou ausente com `error` =
   * a requisição nem chegou ao servidor (rede): o erro é transitório.
   */
  status?: number;
}

/**
 * Falha que vale tentar de novo: erro sem status HTTP (rede), 5xx, 408 e 429. Os 4xx
 * de contrato (400/401/403/404/406 do PostgREST) repetiriam o mesmo erro: não repetem. Também
 * não repete o 57014 (statement timeout / cancelamento do Postgres, que o PostgREST devolve
 * como 500): o timeout de 8 s é sinal de banco saturado, e refazer a página (com OFFSET
 * fundo nas páginas 2+) só triplicaria a carga.
 */
export function respostaTransitoria(resposta: RespostaDePagina): boolean {
  if (!resposta.error) return false;
  if (resposta.error.code === "57014") return false;
  const { status } = resposta;
  if (typeof status !== "number" || status === 0) return true;
  return status >= 500 || status === 408 || status === 429;
}

export interface InfoDoCommit {
  /**
   * `last_message_at` mais novo da página 1, em ms (a hora do cliente quando o
   * número veio vazio). Separa conversa criada durante o fetch de conversa apagada.
   */
  watermark: number;
  /** false enquanto faltam páginas: o que não veio ainda pode existir. */
  complete: boolean;
}

export interface OpcoesDaBuscaCompleta {
  escopo: readonly string[];
  /** Uma página de UM número: `.eq(phone_number_id)`, ordenada e com `.range(from, from + 999)`. */
  buscarPagina: (numeroId: string, from: number, comCount: boolean) => PromiseLike<RespostaDePagina>;
  /** false quando a busca foi superada (troca de escopo, outro fetch): nada mais é entregue. */
  isCurrent: () => boolean;
  /** Entrega o estado de um número. `fetched` é uma cópia: pode ser guardada. */
  aoCommitar: (numeroId: string, fetched: Map<string, Conversation>, info: InfoDoCommit) => void;
  /** Um número falhou; os outros seguem. */
  aoFalhar: (numeroId: string, erro: unknown) => void;
  prazoPrimeiraPaginaMs?: number;
  maxEmVoo?: number;
  intervaloCommitMs?: number;
  /** Esperas entre as tentativas de uma página com falha transitória; `[]` desliga o retry. */
  esperasNovaTentativaMs?: readonly number[];
}

export interface ResultadoDaBusca {
  /** Maior `updated_at` do servidor entre todas as linhas recebidas (valor original). */
  maiorUpdatedAt: string | null;
  /** Números que falharam, na ordem em que falharam. */
  falhas: string[];
}

interface EstadoDaLinha {
  numeroId: string;
  fetched: Map<string, Conversation>;
  watermark: number;
  /** true só quando a última página chegou (ou a página 1 foi a única). */
  complete: boolean;
  /** A página 1 já foi absorvida: há o que mostrar. */
  temPagina1: boolean;
  /** Há dado que ainda não foi entregue. */
  sujo: boolean;
  /** Quando saiu o último commit; -Infinity enquanto nenhum saiu. */
  ultimoCommitEm: number;
  /** Commit coalescido já agendado. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Nada mais a pedir: terminou ou falhou. */
  encerrada: boolean;
  /** Já contou para a porta da primeira pintura. */
  contouNaPorta: boolean;
}

/** Instante de um `updated_at`/`last_message_at`; NaN quando não se lê. */
const emMs = (valor: string | null | undefined): number => (valor ? Date.parse(valor) : Number.NaN);

/**
 * O mais recente entre dois `updated_at` do servidor, no formato original. Um valor
 * que não se lê perde para qualquer um que se leia.
 */
export function maisRecente(a: string | null, b: string | null): string | null {
  const msA = emMs(a);
  const msB = emMs(b);
  if (!Number.isFinite(msB)) return Number.isFinite(msA) ? a : null;
  if (!Number.isFinite(msA)) return b;
  return msB > msA ? b : a;
}

/**
 * Busca o escopo inteiro, um fetch por número.
 *
 * Primeira pintura: a lista não pinta número a número (a tela pularia a cada
 * chegada). Espera a página 1 de TODOS os números, ou o prazo, o que vier antes, e
 * então entrega o que já tem; quem chega depois entrega ao chegar.
 *
 * Depois, cada número entrega no máximo uma vez por `intervaloCommitMs`: páginas que
 * chegam juntas viram um commit só (cada commit reconcilia o array inteiro e
 * re-renderiza a lista). O commit final de um número (`complete: true`) nunca é
 * adiado nem descartado.
 *
 * Um número que falha chama `aoFalhar` e não para os outros; o que ele já entregou
 * continua entregue. Depois que `isCurrent()` vira false nenhum callback roda e
 * nenhuma requisição nova sai.
 */
export async function buscarEscopoCompleto(opcoes: OpcoesDaBuscaCompleta): Promise<ResultadoDaBusca> {
  const {
    escopo,
    buscarPagina,
    isCurrent,
    aoCommitar,
    aoFalhar,
    prazoPrimeiraPaginaMs = PRAZO_PRIMEIRA_PAGINA_MS,
    maxEmVoo = MAX_PAGINAS_EM_VOO,
    intervaloCommitMs = INTERVALO_COMMIT_MS,
    esperasNovaTentativaMs = ESPERAS_NOVA_TENTATIVA_MS,
  } = opcoes;

  const numeros = Array.from(new Set(escopo));
  const falhas: string[] = [];
  let maiorUpdatedAt: string | null = null;
  if (numeros.length === 0) return { maiorUpdatedAt, falhas };

  const limitar = criarLimitador(maxEmVoo);
  const linhas = new Map<string, EstadoDaLinha>(
    numeros.map((numeroId) => [
      numeroId,
      {
        numeroId,
        fetched: new Map(),
        watermark: Date.now(),
        complete: false,
        temPagina1: false,
        sujo: false,
        ultimoCommitEm: Number.NEGATIVE_INFINITY,
        timer: null,
        encerrada: false,
        contouNaPorta: false,
      },
    ]),
  );

  // A "porta" da primeira pintura: fechada até a página 1 de todos os números
  // resolver (ou o prazo vencer). Fechada, os commits só marcam o estado como sujo.
  let portaAberta = false;
  let pendentesDaPorta = numeros.length;
  let timerDoPrazo: ReturnType<typeof setTimeout> | null = null;

  // ── Entrega ────────────────────────────────────────────────────────────────

  const entregar = (linha: EstadoDaLinha) => {
    if (linha.timer) {
      clearTimeout(linha.timer);
      linha.timer = null;
    }
    if (!isCurrent()) return;
    linha.sujo = false;
    linha.ultimoCommitEm = Date.now();
    try {
      aoCommitar(linha.numeroId, new Map(linha.fetched), { watermark: linha.watermark, complete: linha.complete });
    } catch (erro) {
      // Defeito de quem recebe não pode virar "o número falhou" nem derrubar os outros.
      console.error(`[conversationListFetch] commit de ${linha.numeroId} falhou:`, erro);
    }
  };

  /** Commit intermediário: no máximo um por intervalo, sempre com o estado mais novo. */
  const pedirCommit = (linha: EstadoDaLinha) => {
    linha.sujo = true;
    if (!portaAberta || linha.timer) return;
    const espera = linha.ultimoCommitEm + intervaloCommitMs - Date.now();
    if (espera <= 0) {
      entregar(linha);
      return;
    }
    linha.timer = setTimeout(() => {
      linha.timer = null;
      if (linha.sujo) entregar(linha);
    }, espera);
  };

  /** Commit final: nunca adiado. Com a porta fechada, sai na abertura. */
  const finalizar = (linha: EstadoDaLinha) => {
    linha.complete = true;
    linha.encerrada = true;
    linha.sujo = true;
    if (portaAberta) entregar(linha);
  };

  // ── Primeira pintura ───────────────────────────────────────────────────────

  const abrirPorta = () => {
    if (portaAberta) return;
    portaAberta = true;
    if (timerDoPrazo) {
      clearTimeout(timerDoPrazo);
      timerDoPrazo = null;
    }
    for (const linha of linhas.values()) {
      if (linha.temPagina1 && linha.sujo) entregar(linha);
    }
  };

  /** A página 1 do número resolveu (chegou ou falhou): uma vez só por número. */
  const contarNaPorta = (linha: EstadoDaLinha) => {
    if (linha.contouNaPorta) return;
    linha.contouNaPorta = true;
    pendentesDaPorta -= 1;
    if (pendentesDaPorta <= 0) abrirPorta();
  };

  timerDoPrazo = setTimeout(abrirPorta, prazoPrimeiraPaginaMs);

  // ── Um número ──────────────────────────────────────────────────────────────

  const registrarUpdatedAt = (candidato: string | null) => {
    maiorUpdatedAt = maisRecente(maiorUpdatedAt, candidato);
  };

  /** Guarda as linhas válidas da página e devolve o tamanho CRU (é ele que diz se a página veio cheia). */
  const absorver = (linha: EstadoDaLinha, data: unknown): number => {
    const pagina = parseListPage(data);
    for (const row of pagina.rows) linha.fetched.set(row.id, row);
    registrarUpdatedAt(pagina.maiorUpdatedAt);
    return Array.isArray(data) ? data.length : 0;
  };

  /** Uma só requisição pela fila compartilhada. `null` = a busca já não vale. */
  const pedirUmaVez = (linha: EstadoDaLinha, from: number, comCount: boolean) =>
    limitar(async (): Promise<RespostaDePagina | null> => {
      if (linha.encerrada || !isCurrent()) return null;
      // Marca d'água de reserva (número vazio): a hora em que a página 1 sai, e não a do início da fila.
      if (from === 0) linha.watermark = Date.now();
      return buscarPagina(linha.numeroId, from, comCount);
    });

  /**
   * Uma página, com até `esperasNovaTentativaMs.length` novas tentativas quando a falha é
   * transitória (fetch que rejeita, erro sem status, 5xx/408/429). Cada tentativa passa
   * pela fila de novo, então o teto em voo vale; a espera acontece FORA dela, sem segurar
   * vaga. Esgotadas as tentativas, a última falha segue como antes (resposta com `error`
   * ou rejeição). `null` = a busca já não vale (superada, ou o número já terminou): a
   * requisição nem sai, e a conferência é refeita depois de cada espera.
   */
  const pedirPagina = async (linha: EstadoDaLinha, from: number, comCount: boolean): Promise<RespostaDePagina | null> => {
    for (let tentativa = 0; ; tentativa += 1) {
      let resposta: RespostaDePagina | null = null;
      let rejeitou = false;
      let motivo: unknown;
      try {
        resposta = await pedirUmaVez(linha, from, comCount);
      } catch (erro) {
        rejeitou = true;
        motivo = erro;
      }
      const transitoria = rejeitou || (resposta !== null && respostaTransitoria(resposta));
      if (!transitoria) return resposta;
      if (tentativa >= esperasNovaTentativaMs.length) {
        if (rejeitou) throw motivo;
        return resposta;
      }
      await new Promise<void>((resolver) => setTimeout(resolver, esperasNovaTentativaMs[tentativa]));
      if (linha.encerrada || !isCurrent()) return null;
    }
  };

  const buscarLinha = async (linha: EstadoDaLinha): Promise<void> => {
    try {
      const primeira = await pedirPagina(linha, 0, true);
      if (primeira === null || !isCurrent()) return;
      if (primeira.error) throw primeira.error;

      let ultimoTamanho = absorver(linha, primeira.data);
      // Toda conversa local ausente do fetch com last_message_at maior que a mais
      // nova da página 1 nasceu depois dela, por construção da ordenação — sem
      // depender do relógio do cliente.
      let maisNova = Number.NEGATIVE_INFINITY;
      for (const row of linha.fetched.values()) {
        const ms = Date.parse(row.last_message_at);
        if (Number.isFinite(ms) && ms > maisNova) maisNova = ms;
      }
      if (Number.isFinite(maisNova)) linha.watermark = maisNova;

      const total = primeira.count ?? ultimoTamanho;
      const totalDePaginas = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
      const paginaUnica = totalDePaginas === 1 && ultimoTamanho < LIST_PAGE_SIZE;

      linha.temPagina1 = true;
      linha.sujo = true;
      if (paginaUnica) {
        linha.complete = true;
        linha.encerrada = true;
      }
      // Porta aberta: é o primeiro commit do número e sai já. Fechada: conta, e o
      // último a chegar abre a porta e entrega todos.
      if (portaAberta) entregar(linha);
      else contarNaPorta(linha);
      if (paginaUnica) return;

      // Páginas 2..N pedidas todas de uma vez (o count exato da primeira diz
      // quantas são) — a fila compartilhada é que segura o teto; a espera é em
      // ordem para o commit ser progressivo e determinístico.
      const restantes = Array.from({ length: totalDePaginas - 1 }, (_, i) =>
        pedirPagina(linha, (i + 1) * LIST_PAGE_SIZE, false),
      );
      // Se uma falha antes de a espera em ordem chegar nela, o erro não pode virar rejeição sem tratador.
      for (const restante of restantes) restante.catch(() => undefined);

      for (const pendente of restantes) {
        const resposta = await pendente;
        if (resposta === null || !isCurrent()) return;
        if (resposta.error) throw resposta.error;
        ultimoTamanho = absorver(linha, resposta.data);
        pedirCommit(linha);
      }

      // Guarda de cauda: linhas inseridas durante o fetch podem criar uma página
      // além do count inicial — enquanto a última vier cheia, segue.
      let from = totalDePaginas * LIST_PAGE_SIZE;
      while (ultimoTamanho === LIST_PAGE_SIZE) {
        const resposta = await pedirPagina(linha, from, false);
        if (resposta === null || !isCurrent()) return;
        if (resposta.error) throw resposta.error;
        ultimoTamanho = absorver(linha, resposta.data);
        from += LIST_PAGE_SIZE;
        if (ultimoTamanho === LIST_PAGE_SIZE) pedirCommit(linha);
      }

      finalizar(linha);
    } catch (erro) {
      linha.encerrada = true;
      if (isCurrent()) {
        falhas.push(linha.numeroId);
        // O que já chegou deste número não se perde: sai o que estava esperando o intervalo.
        if (portaAberta && linha.sujo) entregar(linha);
        try {
          aoFalhar(linha.numeroId, erro);
        } catch (erroDoCallback) {
          console.error(`[conversationListFetch] aviso de falha de ${linha.numeroId} falhou:`, erroDoCallback);
        }
      }
      // Falhar na página 1 também resolve a espera da porta (e com ela, a pintura dos outros).
      contarNaPorta(linha);
    }
  };

  try {
    await Promise.all(Array.from(linhas.values(), buscarLinha));
  } finally {
    if (timerDoPrazo) clearTimeout(timerDoPrazo);
    for (const linha of linhas.values()) {
      if (linha.timer) clearTimeout(linha.timer);
    }
  }

  return { maiorUpdatedAt, falhas };
}

export interface OpcoesDaBuscaIncremental {
  escopo: readonly string[];
  /** Maior `updated_at` do servidor já visto, no formato original. */
  desde: string;
  /**
   * UMA requisição: `.in('phone_number_id', numeros).gt('updated_at', atualizadoApos)
   * .order('updated_at', { ascending: false }).range(0, 999)`.
   */
  buscar: (numeros: string[], atualizadoApos: string) => PromiseLike<RespostaDePagina>;
}

export interface ResultadoIncremental {
  rows: Conversation[];
  /** Maior `updated_at` do servidor entre as linhas recebidas; null se nenhuma trouxe. */
  maiorUpdatedAt: string | null;
  /**
   * A resposta pode estar truncada (veio uma página cheia) ou a marca d'água não
   * serve: o chamador refaz o escopo por inteiro em vez de confiar no que veio.
   */
  precisaCompleto: boolean;
}

/**
 * O que mudou nos números do escopo desde `desde` (menos a folga). Lança o erro da
 * requisição: quem chama decide se loga ou avisa.
 */
export async function buscarIncremental({
  escopo,
  desde,
  buscar,
}: OpcoesDaBuscaIncremental): Promise<ResultadoIncremental> {
  const numeros = Array.from(new Set(escopo));
  if (numeros.length === 0) return { rows: [], maiorUpdatedAt: null, precisaCompleto: false };

  const desdeMs = Date.parse(desde);
  // Marca ilegível: não há de onde partir. Pede o escopo inteiro em vez de adivinhar.
  if (!Number.isFinite(desdeMs)) return { rows: [], maiorUpdatedAt: null, precisaCompleto: true };

  const atualizadoApos = new Date(desdeMs - FOLGA_INCREMENTAL_MS).toISOString();
  const resposta = await buscar(numeros, atualizadoApos);
  if (resposta.error) throw resposta.error;

  const { rows, maiorUpdatedAt } = parseListPage(resposta.data);
  const tamanho = Array.isArray(resposta.data) ? resposta.data.length : 0;
  return { rows, maiorUpdatedAt, precisaCompleto: tamanho >= LIST_PAGE_SIZE };
}

/** Quem é co-responsável de cada conversa do retrato, e em que número ela está. */
export type RetratoDeCoResponsaveis = Map<string, { numeroId: string | null; userIds: string[] }>;

/** Teto de páginas do retrato (100 mil co-responsáveis): a consulta não pode girar para sempre. */
const MAX_PAGINAS_DO_RETRATO = 100;

export interface OpcoesDoRetrato {
  escopo: readonly string[];
  /**
   * Uma página: `conversation_assignees` com `COLUNAS_CO_RESPONSAVEIS`,
   * `.in('conversations.phone_number_id', numeros)`, `.order('id')` (único: as páginas
   * não se repetem nem pulam) e `.range(from, from + 999)`.
   */
  buscar: (numeros: string[], from: number) => PromiseLike<RespostaDePagina>;
}

/**
 * Os co-responsáveis de TODAS as conversas dos números do escopo, página a página até
 * esgotar (o PostgREST corta em 1000 linhas). É um retrato: quem ele não cita não tem
 * co-responsável. Por isso nunca devolve um retrato parcial: erro, linha fora do contrato
 * ou teto de páginas lançam, e quem chama deixa a lista como está.
 */
export async function buscarCoResponsaveis({ escopo, buscar }: OpcoesDoRetrato): Promise<RetratoDeCoResponsaveis> {
  const numeros = Array.from(new Set(escopo));
  const retrato: RetratoDeCoResponsaveis = new Map();
  if (numeros.length === 0) return retrato;

  for (let pagina = 0; pagina < MAX_PAGINAS_DO_RETRATO; pagina += 1) {
    const resposta = await buscar(numeros, pagina * LIST_PAGE_SIZE);
    if (resposta.error) throw resposta.error;

    for (const { conversationId, userId, numeroId } of parseCoResponsaveis(resposta.data)) {
      const da = retrato.get(conversationId);
      if (da) da.userIds.push(userId);
      else retrato.set(conversationId, { numeroId, userIds: [userId] });
    }
    // Página curta = esgotou.
    if (!Array.isArray(resposta.data) || resposta.data.length < LIST_PAGE_SIZE) return retrato;
  }
  throw new Error("retrato de co-responsáveis passou do teto de páginas");
}

export type ModoDaBusca = "completo" | "incremental";

/**
 * Quando uma revalidação de fundo (poll, reassinar do canal, volta da aba) pode ser
 * incremental. Pedido explícito de `completo` (troca de escopo, puxar para
 * atualizar, `online`) vale sempre. Um incremental vira completo quando não há
 * marca d'água do servidor, quando o último completo passou de
 * `COMPLETO_A_CADA_MS` (o incremental não enxerga o que foi APAGADO ou saiu do
 * escopo da RLS, então o completo periódico é o que limpa isso) ou quando o último
 * completo nunca terminou.
 *
 * Duas exceções, em sentidos opostos:
 *  - `adiarCompleto` (aba escondida): o completo periódico espera a volta da aba, e o
 *    incremental segue, que é barato e mantém dono e co-responsáveis em dia para o gate
 *    de notificação. Não vence um pedido de completo, a falta de marca d'água nem a falta
 *    de um completo anterior: sem de onde partir não há incremental.
 *  - `aposQueda` (o canal realtime reassinou): houve um intervalo sem entrega, e é
 *    justamente o que o incremental não enxerga (apagadas, saídas do escopo), então o
 *    completo vale — a menos que o último seja de menos de `COMPLETO_APOS_QUEDA_MS`.
 */
export function decidirModo({
  pedido,
  maiorUpdatedAt,
  ultimoCompletoEm,
  agora,
  adiarCompleto = false,
  aposQueda = false,
}: {
  pedido: ModoDaBusca;
  maiorUpdatedAt: string | null;
  /** Quando terminou o último fetch completo deste escopo; 0 = nenhum. */
  ultimoCompletoEm: number;
  agora: number;
  adiarCompleto?: boolean;
  aposQueda?: boolean;
}): ModoDaBusca {
  if (pedido === "completo") return "completo";
  if (!maiorUpdatedAt || ultimoCompletoEm <= 0) return "completo";
  if (adiarCompleto) return "incremental";
  if (aposQueda && agora - ultimoCompletoEm > COMPLETO_APOS_QUEDA_MS) return "completo";
  if (agora - ultimoCompletoEm > COMPLETO_A_CADA_MS) return "completo";
  return "incremental";
}
