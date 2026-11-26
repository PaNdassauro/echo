import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/types/conversation";
import { LIST_PAGE_SIZE } from "./conversationListQuery";
import { reconcileFetched } from "./conversationListReducer";
import {
  buscarCoResponsaveis,
  buscarEscopoCompleto,
  buscarIncremental,
  COMPLETO_A_CADA_MS,
  COMPLETO_APOS_QUEDA_MS,
  decidirModo,
  FOLGA_INCREMENTAL_MS,
  maisRecente,
  type InfoDoCommit,
  type OpcoesDaBuscaCompleta,
  type RespostaDePagina,
} from "./conversationListFetch";

const LINHA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINHA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINHA_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const AGORA = "2026-10-21T12:00:00.000Z";

let contador = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Linha crua como o PostgREST a devolve para o select da lista. */
const linhaCrua = (
  numeroId: string,
  { id = uuid(++contador), lastMessageAt = AGORA, updatedAt = AGORA }: { id?: string; lastMessageAt?: string; updatedAt?: string } = {},
) => ({
  id,
  contact_name: "Contato",
  contact_phone: "5511999990001",
  last_message_at: lastMessageAt,
  status: "active",
  phone_number_id: numeroId,
  sector_id: null,
  assigned_to: null,
  is_group: false,
  contact_avatar_url: null,
  contact_avatar_updated_at: null,
  updated_at: updatedAt,
  profiles: null,
  conversation_assignees: [],
});

/** `n` linhas do número, da mais nova para a mais antiga (como a ordenação do servidor). */
const paginaDe = (numeroId: string, n: number, base = Date.parse(AGORA)) =>
  Array.from({ length: n }, (_, i) =>
    linhaCrua(numeroId, {
      lastMessageAt: new Date(base - i * 1000).toISOString(),
      updatedAt: new Date(base - i * 1000).toISOString(),
    }),
  );

interface Pedido {
  numeroId: string;
  from: number;
  comCount: boolean;
  respondido: boolean;
  responder: (resposta?: Partial<RespostaDePagina>) => void;
  falhar: (erro: unknown) => void;
}

/** O "servidor": guarda cada pedido de página até o teste responder. */
function criarBancada() {
  const pedidos: Pedido[] = [];
  let emVoo = 0;
  let picoEmVoo = 0;

  const buscarPagina = vi.fn(
    (numeroId: string, from: number, comCount: boolean) =>
      new Promise<RespostaDePagina>((resolve, reject) => {
        emVoo += 1;
        picoEmVoo = Math.max(picoEmVoo, emVoo);
        const pedido: Pedido = {
          numeroId,
          from,
          comCount,
          respondido: false,
          responder: (resposta = {}) => {
            if (pedido.respondido) return;
            pedido.respondido = true;
            emVoo -= 1;
            resolve({ data: [], count: null, error: null, ...resposta });
          },
          falhar: (erro) => {
            if (pedido.respondido) return;
            pedido.respondido = true;
            emVoo -= 1;
            reject(erro);
          },
        };
        pedidos.push(pedido);
      }),
  );

  return {
    buscarPagina,
    pedidos,
    pendentes: () => pedidos.filter((p) => !p.respondido),
    /** O pedido (ainda sem resposta) de uma página de um número. */
    achar: (numeroId: string, from = 0) => {
      const pedido = pedidos.find((p) => p.numeroId === numeroId && p.from === from && !p.respondido);
      if (!pedido) throw new Error(`sem pedido pendente de ${numeroId} em ${from}`);
      return pedido;
    },
    pico: () => picoEmVoo,
  };
}

interface Commit {
  numeroId: string;
  ids: string[];
  fetched: Map<string, Conversation>;
  info: InfoDoCommit;
  /** Instante (relógio falso) em que o commit saiu. */
  em: number;
}

/** Roda a busca com os callbacks gravados e devolve o que o teste precisa para conferir. */
function iniciar(
  bancada: ReturnType<typeof criarBancada>,
  opcoes: Partial<OpcoesDaBuscaCompleta> & { escopo: readonly string[] },
) {
  const commits: Commit[] = [];
  const avisos: Array<{ numeroId: string; erro: unknown; em: number }> = [];
  const estado = { atual: true };

  const resultado = buscarEscopoCompleto({
    buscarPagina: bancada.buscarPagina,
    isCurrent: () => estado.atual,
    aoCommitar: (numeroId, fetched, info) =>
      commits.push({ numeroId, ids: Array.from(fetched.keys()), fetched, info, em: Date.now() }),
    aoFalhar: (numeroId, erro) => avisos.push({ numeroId, erro, em: Date.now() }),
    ...opcoes,
  });

  return { resultado, commits, avisos, estado };
}

/** Deixa as continuações (promessas) e os timers vencidos agora rodarem. */
const assentar = () => vi.advanceTimersByTimeAsync(0);
const passar = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  contador = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(AGORA));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("buscarEscopoCompleto — um número", () => {
  it("página única: pede com count, entrega UM commit completo e devolve a marca d'água do servidor", async () => {
    const bancada = criarBancada();
    const { resultado, commits, avisos } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    expect(bancada.pedidos).toHaveLength(1);
    expect(bancada.pedidos[0]).toMatchObject({ numeroId: LINHA_A, from: 0, comCount: true });

    const linhas = paginaDe(LINHA_A, 3);
    bancada.achar(LINHA_A).responder({ data: linhas, count: 3 });
    await assentar();

    const final = await resultado;
    expect(commits).toHaveLength(1);
    expect(commits[0].numeroId).toBe(LINHA_A);
    expect(commits[0].ids).toEqual(linhas.map((l) => l.id));
    expect(commits[0].info.complete).toBe(true);
    // Marca d'água = last_message_at mais novo da página 1, em ms.
    expect(commits[0].info.watermark).toBe(Date.parse(linhas[0].last_message_at));
    expect(avisos).toEqual([]);
    expect(final).toEqual({ maiorUpdatedAt: linhas[0].updated_at, falhas: [] });
  });

  it("número vazio: a marca d'água cai na hora em que a página 1 saiu", async () => {
    const bancada = criarBancada();
    const { resultado, commits } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    await passar(400);
    bancada.achar(LINHA_A).responder({ data: [], count: 0 });
    await assentar();
    await resultado;

    expect(commits).toHaveLength(1);
    expect(commits[0].info).toEqual({ watermark: Date.parse(AGORA), complete: true });
    expect(commits[0].ids).toEqual([]);
  });

  it("várias páginas: as demais saem de uma vez, sem count, e o último commit é o completo", async () => {
    const bancada = criarBancada();
    const { resultado, commits } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 2500 });
    await assentar();

    // Página 1 já pintou, incompleta.
    expect(commits).toHaveLength(1);
    expect(commits[0].info.complete).toBe(false);
    expect(commits[0].ids).toHaveLength(LIST_PAGE_SIZE);

    // As páginas 2 e 3 já estão pedidas, as duas, sem esperar uma pela outra.
    expect(bancada.pendentes().map((p) => [p.from, p.comCount])).toEqual([
      [1000, false],
      [2000, false],
    ]);

    bancada.achar(LINHA_A, 1000).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE) });
    bancada.achar(LINHA_A, 2000).responder({ data: paginaDe(LINHA_A, 500) });
    await assentar();
    await resultado;

    const ultimo = commits[commits.length - 1];
    expect(ultimo.info.complete).toBe(true);
    expect(ultimo.ids).toHaveLength(2500);
    expect(commits.filter((c) => c.info.complete)).toHaveLength(1);
  });

  it("guarda de cauda: enquanto a última página vier cheia, pede a próxima", async () => {
    const bancada = criarBancada();
    const { resultado, commits } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    // O count diz 1000 (uma página), e ela vem cheia: pode haver mais.
    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 1000 });
    await assentar();
    expect(commits[0].info.complete).toBe(false);

    bancada.achar(LINHA_A, 1000).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE) });
    await assentar();
    // Cheia de novo: mais uma.
    bancada.achar(LINHA_A, 2000).responder({ data: paginaDe(LINHA_A, 40) });
    await assentar();
    await resultado;

    const ultimo = commits[commits.length - 1];
    expect(ultimo.info.complete).toBe(true);
    expect(ultimo.ids).toHaveLength(2040);
    expect(bancada.pedidos.map((p) => p.from)).toEqual([0, 1000, 2000]);
  });

  it("página 1 cheia e a seguinte vazia: fecha completo sem commit a mais além do final", async () => {
    const bancada = criarBancada();
    const { resultado, commits } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 1000 });
    await assentar();
    bancada.achar(LINHA_A, 1000).responder({ data: [] });
    await assentar();
    await resultado;

    expect(commits[commits.length - 1].info.complete).toBe(true);
    expect(commits[commits.length - 1].ids).toHaveLength(LIST_PAGE_SIZE);
  });

  it("linha malformada na página é descartada, mas a página conta cheia pelo tamanho cru", async () => {
    const bancada = criarBancada();
    const { resultado, commits } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    const pagina = paginaDe(LINHA_A, LIST_PAGE_SIZE);
    pagina[5] = { ...pagina[5], id: "não-é-uuid" };
    bancada.achar(LINHA_A).responder({ data: pagina, count: 1000 });
    await assentar();
    // Cheia (1000 crus) → a cauda é consultada, mesmo com 999 válidas.
    expect(bancada.pendentes().map((p) => p.from)).toEqual([1000]);

    bancada.achar(LINHA_A, 1000).responder({ data: [] });
    await assentar();
    await resultado;
    expect(commits[commits.length - 1].ids).toHaveLength(LIST_PAGE_SIZE - 1);
  });
});

describe("buscarEscopoCompleto — primeira pintura", () => {
  it("espera a página 1 de todos os números e entrega junto", async () => {
    const bancada = criarBancada();
    const { resultado, commits } = iniciar(bancada, { escopo: [LINHA_A, LINHA_B] });
    await assentar();

    await passar(100);
    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, 2), count: 2 });
    await assentar();
    // A chegou, B não: nada pinta ainda.
    expect(commits).toEqual([]);

    await passar(800);
    bancada.achar(LINHA_B).responder({ data: paginaDe(LINHA_B, 4), count: 4 });
    await assentar();
    await resultado;

    expect(commits.map((c) => c.numeroId).sort()).toEqual([LINHA_A, LINHA_B].sort());
    // Os dois no mesmo instante: o da última a chegar.
    expect(commits.every((c) => c.em === Date.parse(AGORA) + 900)).toBe(true);
  });

  it("vence o prazo de 1,5 s: pinta quem já chegou, e quem chega depois entrega ao chegar", async () => {
    const bancada = criarBancada();
    const { resultado, commits } = iniciar(bancada, { escopo: [LINHA_A, LINHA_B] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, 2), count: 2 });
    await assentar();
    await passar(1499);
    expect(commits).toEqual([]);

    await passar(1);
    expect(commits.map((c) => c.numeroId)).toEqual([LINHA_A]);
    expect(commits[0].em).toBe(Date.parse(AGORA) + 1500);

    await passar(1000);
    bancada.achar(LINHA_B).responder({ data: paginaDe(LINHA_B, 5), count: 5 });
    await assentar();
    await resultado;

    expect(commits.map((c) => c.numeroId)).toEqual([LINHA_A, LINHA_B]);
    expect(commits[1].em).toBe(Date.parse(AGORA) + 2500);
    expect(commits[1].ids).toHaveLength(5);
  });

  it("o prazo é configurável", async () => {
    const bancada = criarBancada();
    const { commits } = iniciar(bancada, { escopo: [LINHA_A, LINHA_B], prazoPrimeiraPaginaMs: 200 });
    await assentar();
    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, 1), count: 1 });
    await passar(199);
    expect(commits).toEqual([]);
    await passar(1);
    expect(commits).toHaveLength(1);
  });

  it("um número que falha na página 1 conta como resolvido: os outros pintam na hora, sem esperar o prazo", async () => {
    const bancada = criarBancada();
    const { resultado, commits, avisos } = iniciar(bancada, { esperasNovaTentativaMs: [], escopo: [LINHA_A, LINHA_B] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, 2), count: 2 });
    await passar(300);
    expect(commits).toEqual([]);

    const erro = new Error("timeout da RLS");
    bancada.achar(LINHA_B).falhar(erro);
    await assentar();

    expect(commits.map((c) => c.numeroId)).toEqual([LINHA_A]);
    expect(commits[0].em).toBe(Date.parse(AGORA) + 300);
    expect(avisos).toEqual([{ numeroId: LINHA_B, erro, em: Date.parse(AGORA) + 300 }]);
    await expect(resultado).resolves.toMatchObject({ falhas: [LINHA_B] });
  });

  it("erro devolvido no corpo da resposta (PostgREST) também é falha do número", async () => {
    const bancada = criarBancada();
    const { resultado, commits, avisos } = iniciar(bancada, { esperasNovaTentativaMs: [], escopo: [LINHA_A, LINHA_B] });
    await assentar();

    const erro = { message: "canceling statement due to statement timeout" };
    bancada.achar(LINHA_A).responder({ data: null, error: erro });
    bancada.achar(LINHA_B).responder({ data: paginaDe(LINHA_B, 2), count: 2 });
    await assentar();

    expect((await resultado).falhas).toEqual([LINHA_A]);
    expect(avisos.map((a) => [a.numeroId, a.erro])).toEqual([[LINHA_A, erro]]);
    expect(commits.map((c) => c.numeroId)).toEqual([LINHA_B]);
  });

  it("todos os números falham: nenhum commit, todos avisados", async () => {
    const bancada = criarBancada();
    const { resultado, commits, avisos } = iniciar(bancada, { esperasNovaTentativaMs: [], escopo: [LINHA_A, LINHA_B] });
    await assentar();

    bancada.achar(LINHA_A).falhar(new Error("a"));
    bancada.achar(LINHA_B).falhar(new Error("b"));
    await assentar();

    expect(commits).toEqual([]);
    expect(avisos.map((a) => a.numeroId)).toEqual([LINHA_A, LINHA_B]);
    expect((await resultado).falhas).toEqual([LINHA_A, LINHA_B]);
  });
});

describe("buscarEscopoCompleto — falha no meio de um número", () => {
  it("o número que falha na página 2 avisa e para; o que já entregou fica e os outros seguem", async () => {
    const bancada = criarBancada();
    const { resultado, commits, avisos } = iniciar(bancada, { esperasNovaTentativaMs: [], escopo: [LINHA_A, LINHA_B] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 1500 });
    bancada.achar(LINHA_B).responder({ data: paginaDe(LINHA_B, 3), count: 3 });
    await assentar();
    // Página 1 de A (incompleta) e B (completo) já pintaram.
    expect(commits.map((c) => [c.numeroId, c.info.complete])).toEqual([
      [LINHA_A, false],
      [LINHA_B, true],
    ]);

    const erro = new Error("conexão caiu");
    bancada.achar(LINHA_A, 1000).falhar(erro);
    await assentar();
    const final = await resultado;

    expect(avisos.map((a) => [a.numeroId, a.erro])).toEqual([[LINHA_A, erro]]);
    expect(final.falhas).toEqual([LINHA_A]);
    // Nenhum commit "completo" de A: o que ficou em memória não pode ser dado por apagado.
    expect(commits.some((c) => c.numeroId === LINHA_A && c.info.complete)).toBe(false);
  });

  it("falha com commit coalescido pendente: entrega o que já tinha antes de avisar", async () => {
    const bancada = criarBancada();
    const { resultado, commits, avisos } = iniciar(bancada, { esperasNovaTentativaMs: [], escopo: [LINHA_A] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 3000 });
    await assentar();
    expect(commits).toHaveLength(1);

    await passar(50);
    bancada.achar(LINHA_A, 1000).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE) });
    await assentar();
    // Dentro do intervalo: a página 2 espera o timer.
    expect(commits).toHaveLength(1);

    await passar(50);
    bancada.achar(LINHA_A, 2000).falhar(new Error("caiu"));
    await assentar();
    await resultado;

    expect(commits).toHaveLength(2);
    expect(commits[1].ids).toHaveLength(2000);
    expect(commits[1].info.complete).toBe(false);
    expect(avisos).toHaveLength(1);

    // O timer coalescido foi cancelado: nada sai depois.
    await passar(1000);
    expect(commits).toHaveLength(2);
  });

  it("um defeito no callback de commit não vira falha do número nem para os outros", async () => {
    const bancada = criarBancada();
    const commits: string[] = [];
    const avisos: string[] = [];
    const resultado = buscarEscopoCompleto({
      escopo: [LINHA_A, LINHA_B],
      buscarPagina: bancada.buscarPagina,
      isCurrent: () => true,
      aoCommitar: (numeroId) => {
        commits.push(numeroId);
        if (numeroId === LINHA_A) throw new Error("setState quebrou");
      },
      aoFalhar: (numeroId) => avisos.push(numeroId),
    });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, 1), count: 1 });
    bancada.achar(LINHA_B).responder({ data: paginaDe(LINHA_B, 1), count: 1 });
    await assentar();

    expect(await resultado).toMatchObject({ falhas: [] });
    expect(commits.sort()).toEqual([LINHA_A, LINHA_B].sort());
    expect(avisos).toEqual([]);
  });
});

describe("buscarEscopoCompleto — nova tentativa de página (falha transitória)", () => {
  it("fetch que rejeita na página 2: tenta de novo após 400 ms e o número carrega sem aviso", async () => {
    const bancada = criarBancada();
    const { resultado, commits, avisos } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 1500 });
    await assentar();
    bancada.achar(LINHA_A, 1000).falhar(new TypeError("Failed to fetch"));
    await assentar();
    // Ainda esperando: nada de nova requisição, aviso nem encerramento.
    expect(bancada.pendentes()).toEqual([]);
    expect(avisos).toEqual([]);

    await passar(399);
    expect(bancada.pendentes()).toEqual([]);
    await passar(1);
    bancada.achar(LINHA_A, 1000).responder({ data: paginaDe(LINHA_A, 500, Date.parse(AGORA) - 5_000_000) });
    await assentar();

    expect(await resultado).toMatchObject({ falhas: [] });
    expect(avisos).toEqual([]);
    expect(commits[commits.length - 1]).toMatchObject({ numeroId: LINHA_A, info: { complete: true } });
    expect(commits[commits.length - 1].ids).toHaveLength(1500);
  });

  it("5xx sem sucesso: 2 novas tentativas (400 ms e 1200 ms) e só então avisa a falha", async () => {
    const bancada = criarBancada();
    const { resultado, avisos } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    const erro = { message: "upstream indisponível" };
    bancada.achar(LINHA_A).responder({ data: null, error: erro, status: 503 });
    await assentar();
    expect(avisos).toEqual([]);

    await passar(400);
    bancada.achar(LINHA_A).responder({ data: null, error: erro, status: 503 });
    await assentar();
    expect(avisos).toEqual([]);

    await passar(1199);
    expect(bancada.pendentes()).toEqual([]);
    await passar(1);
    bancada.achar(LINHA_A).responder({ data: null, error: erro, status: 503 });
    await assentar();

    expect(bancada.buscarPagina).toHaveBeenCalledTimes(3);
    expect(avisos.map((a) => [a.numeroId, a.erro])).toEqual([[LINHA_A, erro]]);
    expect(avisos[0].em).toBe(Date.parse(AGORA) + 1600);
    expect((await resultado).falhas).toEqual([LINHA_A]);
  });

  it.each([408, 429, 0, undefined])("status %s com erro conta como transitório e tenta de novo", async (status) => {
    const bancada = criarBancada();
    const { resultado, avisos } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: null, error: { message: "x" }, status });
    await assentar();
    await passar(400);
    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, 2), count: 2 });
    await assentar();

    expect(await resultado).toMatchObject({ falhas: [] });
    expect(avisos).toEqual([]);
  });

  it.each([400, 401, 403, 404, 406])("%s é erro de contrato: não repete e avisa na hora", async (status) => {
    const bancada = criarBancada();
    const { resultado, avisos } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    const erro = { message: "contrato" };
    bancada.achar(LINHA_A).responder({ data: null, error: erro, status });
    await assentar();

    expect(avisos.map((a) => [a.numeroId, a.erro, a.em])).toEqual([[LINHA_A, erro, Date.parse(AGORA)]]);
    await passar(5_000);
    expect(bancada.buscarPagina).toHaveBeenCalledTimes(1);
    expect((await resultado).falhas).toEqual([LINHA_A]);
  });

  it("500 com código 57014 (statement timeout): não repete e avisa na hora", async () => {
    const bancada = criarBancada();
    const { resultado, avisos } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    const erro = { message: "canceling statement due to statement timeout", code: "57014" };
    bancada.achar(LINHA_A).responder({ data: null, error: erro, status: 500 });
    await assentar();

    expect(avisos.map((a) => [a.numeroId, a.erro, a.em])).toEqual([[LINHA_A, erro, Date.parse(AGORA)]]);
    await passar(5_000);
    expect(bancada.buscarPagina).toHaveBeenCalledTimes(1);
    expect((await resultado).falhas).toEqual([LINHA_A]);
  });

  it("500 sem código continua transitório: tenta de novo", async () => {
    const bancada = criarBancada();
    const { resultado, avisos } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: null, error: { message: "erro interno", code: "XX000" }, status: 500 });
    await assentar();
    await passar(400);
    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, 2), count: 2 });
    await assentar();

    expect(await resultado).toMatchObject({ falhas: [] });
    expect(avisos).toEqual([]);
  });

  it("busca superada durante a espera: a nova tentativa nem sai e nada é avisado", async () => {
    const bancada = criarBancada();
    const { resultado, avisos, estado } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    bancada.achar(LINHA_A).falhar(new TypeError("Failed to fetch"));
    await assentar();
    estado.atual = false;
    await passar(400);

    expect(bancada.buscarPagina).toHaveBeenCalledTimes(1);
    expect(avisos).toEqual([]);
    expect((await resultado).falhas).toEqual([]);
  });

  it("a espera não segura vaga: com 1 em voo, outro número passa na frente enquanto o primeiro espera", async () => {
    const bancada = criarBancada();
    const { resultado } = iniciar(bancada, { escopo: [LINHA_A, LINHA_B], maxEmVoo: 1 });
    await assentar();

    bancada.achar(LINHA_A).falhar(new TypeError("Failed to fetch"));
    await assentar();
    // A vaga foi liberada na falha: B sai já, sem esperar os 400 ms de A.
    bancada.achar(LINHA_B).responder({ data: paginaDe(LINHA_B, 1), count: 1 });
    await assentar();
    await passar(400);
    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, 1), count: 1 });
    await assentar();

    expect(await resultado).toMatchObject({ falhas: [] });
    expect(bancada.pico()).toBe(1);
  });
});

describe("buscarEscopoCompleto — coalescência dos commits", () => {
  it("no máximo um commit por número a cada 250 ms; o final sai na hora, sem esperar o intervalo", async () => {
    const bancada = criarBancada();
    const { resultado, commits } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    // 6 páginas: 5 cheias + uma curta.
    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 5200 });
    await assentar();
    expect(commits.map((c) => c.em)).toEqual([Date.parse(AGORA)]);

    // Páginas 2..5 chegam dentro do intervalo do primeiro commit.
    for (const [i, from] of [1000, 2000, 3000, 4000].entries()) {
      await passar(50);
      bancada.achar(LINHA_A, from).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE) });
      await assentar();
      expect(commits, `depois da página ${i + 2}`).toHaveLength(1);
    }

    // O intervalo vence em t=250 e sai UM commit com tudo o que chegou até lá.
    await passar(50);
    expect(commits).toHaveLength(2);
    expect(commits[1].em).toBe(Date.parse(AGORA) + 250);
    expect(commits[1].ids).toHaveLength(5000);
    expect(commits[1].info.complete).toBe(false);

    // A última página, 10 ms depois: o commit final não espera outro intervalo.
    await passar(10);
    bancada.achar(LINHA_A, 5000).responder({ data: paginaDe(LINHA_A, 200) });
    await assentar();
    await resultado;

    expect(commits).toHaveLength(3);
    expect(commits[2].em).toBe(Date.parse(AGORA) + 260);
    expect(commits[2].info.complete).toBe(true);
    expect(commits[2].ids).toHaveLength(5200);
  });

  it("com o intervalo já vencido, a página sai na hora", async () => {
    const bancada = criarBancada();
    const { commits } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 3000 });
    await assentar();
    await passar(300);
    bancada.achar(LINHA_A, 1000).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE) });
    await assentar();

    expect(commits).toHaveLength(2);
    expect(commits[1].em).toBe(Date.parse(AGORA) + 300);
  });

  it("cada número tem o seu relógio de coalescência", async () => {
    const bancada = criarBancada();
    const { commits } = iniciar(bancada, { escopo: [LINHA_A, LINHA_B], intervaloCommitMs: 250 });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 3000 });
    bancada.achar(LINHA_B).responder({ data: paginaDe(LINHA_B, LIST_PAGE_SIZE), count: 3000 });
    await assentar();
    expect(commits.map((c) => c.numeroId).sort()).toEqual([LINHA_A, LINHA_B].sort());

    await passar(100);
    bancada.achar(LINHA_A, 1000).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE) });
    await passar(100);
    bancada.achar(LINHA_B, 1000).responder({ data: paginaDe(LINHA_B, LIST_PAGE_SIZE) });
    await assentar();

    // A vence em t=250, B em t=250 também (os dois primeiros commits foram em t=0).
    await passar(50);
    expect(commits).toHaveLength(4);
    expect(commits.slice(2).map((c) => c.numeroId).sort()).toEqual([LINHA_A, LINHA_B].sort());
  });

  it("a porta fechada junta as páginas do número que já passou da página 1", async () => {
    const bancada = criarBancada();
    const { commits } = iniciar(bancada, { escopo: [LINHA_A, LINHA_B] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 2000 });
    await assentar();
    bancada.achar(LINHA_A, 1000).responder({ data: paginaDe(LINHA_A, 500) });
    await assentar();
    expect(commits).toEqual([]);

    // B chega e a porta abre: A sai UMA vez, já completo, com as duas páginas.
    bancada.achar(LINHA_B).responder({ data: paginaDe(LINHA_B, 1), count: 1 });
    await assentar();

    const deA = commits.filter((c) => c.numeroId === LINHA_A);
    expect(deA).toHaveLength(1);
    expect(deA[0].info.complete).toBe(true);
    expect(deA[0].ids).toHaveLength(1500);
  });

  it("o commit é uma cópia: guardar o Map não vê as páginas seguintes", async () => {
    const bancada = criarBancada();
    const { resultado, commits } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 2000 });
    await assentar();
    const primeiro = commits[0].fetched;
    expect(primeiro.size).toBe(LIST_PAGE_SIZE);

    bancada.achar(LINHA_A, 1000).responder({ data: paginaDe(LINHA_A, 10) });
    await assentar();
    await resultado;
    expect(primeiro.size).toBe(LIST_PAGE_SIZE);
  });
});

describe("buscarEscopoCompleto — teto de requisições e intercalação", () => {
  it("nunca passa de 6 páginas em voo e pede todas as primeiras páginas antes das demais", async () => {
    const numeros = Array.from({ length: 16 }, (_, i) => `${String(i).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    const bancada = criarBancada();
    const { resultado, commits } = iniciar(bancada, { escopo: numeros });
    await assentar();

    // Só 6 saíram, e são as primeiras páginas dos 6 primeiros.
    expect(bancada.pendentes()).toHaveLength(6);
    expect(bancada.pendentes().every((p) => p.from === 0)).toBe(true);

    // Responde sempre o pedido mais antigo ainda pendente, até acabar.
    while (bancada.pendentes().length > 0) {
      const pedido = bancada.pendentes()[0];
      const tamanho = pedido.from === 2000 ? 500 : LIST_PAGE_SIZE;
      pedido.responder({ data: paginaDe(pedido.numeroId, tamanho), count: pedido.from === 0 ? 2500 : null });
      await assentar();
    }
    await resultado;

    expect(bancada.pico()).toBeLessThanOrEqual(6);
    expect(bancada.buscarPagina).toHaveBeenCalledTimes(16 * 3);
    // Intercalação: as 16 primeiras páginas saíram antes de qualquer página 2.
    expect(bancada.pedidos.slice(0, 16).every((p) => p.from === 0)).toBe(true);
    expect(bancada.pedidos.slice(16).every((p) => p.from > 0)).toBe(true);

    for (const numeroId of numeros) {
      const finais = commits.filter((c) => c.numeroId === numeroId && c.info.complete);
      expect(finais).toHaveLength(1);
      expect(finais[0].ids).toHaveLength(2500);
    }
  });

  it("o teto é configurável", async () => {
    const bancada = criarBancada();
    iniciar(bancada, { escopo: [LINHA_A, LINHA_B, LINHA_C], maxEmVoo: 2 });
    await assentar();
    expect(bancada.pendentes()).toHaveLength(2);
  });

  it("escopo vazio não pede nada; número repetido no escopo é pedido uma vez", async () => {
    const bancada = criarBancada();
    const vazio = iniciar(bancada, { escopo: [] });
    await expect(vazio.resultado).resolves.toEqual({ maiorUpdatedAt: null, falhas: [] });
    expect(bancada.buscarPagina).not.toHaveBeenCalled();

    iniciar(bancada, { escopo: [LINHA_A, LINHA_A] });
    await assentar();
    expect(bancada.buscarPagina).toHaveBeenCalledTimes(1);
  });
});

describe("buscarEscopoCompleto — cancelamento", () => {
  it("depois que isCurrent() vira false nenhum callback roda e nenhuma página nova sai", async () => {
    const bancada = criarBancada();
    const { resultado, commits, avisos, estado } = iniciar(bancada, { escopo: [LINHA_A, LINHA_B], maxEmVoo: 1 });
    await assentar();

    // maxEmVoo=1: só a página 1 de A saiu; a de B espera na fila.
    expect(bancada.pendentes().map((p) => p.numeroId)).toEqual([LINHA_A]);
    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 3000 });
    await assentar();

    // A busca é superada (troca de escopo) com a de B já em voo.
    estado.atual = false;
    const pedidosAntes = bancada.pedidos.length;
    bancada.achar(LINHA_B).responder({ data: paginaDe(LINHA_B, 2), count: 2 });
    await passar(5000);
    await resultado;

    expect(commits).toEqual([]);
    expect(avisos).toEqual([]);
    // Nada além do que já estava em voo: nem as páginas 2 e 3 de A, nem outras de B.
    expect(bancada.pedidos.length).toBe(pedidosAntes);
  });

  it("cancelar com commit coalescido agendado não entrega nada depois", async () => {
    const bancada = criarBancada();
    const { resultado, commits, estado } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE), count: 3000 });
    await assentar();
    expect(commits).toHaveLength(1);

    await passar(10);
    bancada.achar(LINHA_A, 1000).responder({ data: paginaDe(LINHA_A, LIST_PAGE_SIZE) });
    await assentar();

    estado.atual = false;
    await passar(1000);
    bancada.achar(LINHA_A, 2000).responder({ data: paginaDe(LINHA_A, 10) });
    await assentar();
    await resultado;

    expect(commits).toHaveLength(1);
  });

  it("cancelar antes da porta abrir: o prazo vence e nada é entregue", async () => {
    const bancada = criarBancada();
    const { resultado, commits, estado } = iniciar(bancada, { escopo: [LINHA_A, LINHA_B] });
    await assentar();

    bancada.achar(LINHA_A).responder({ data: paginaDe(LINHA_A, 1), count: 1 });
    await assentar();
    estado.atual = false;
    await passar(2000);
    bancada.achar(LINHA_B).responder({ data: paginaDe(LINHA_B, 1), count: 1 });
    await assentar();
    await resultado;

    expect(commits).toEqual([]);
  });

  it("falha depois de cancelada não é avisada nem entra em `falhas`", async () => {
    const bancada = criarBancada();
    const { resultado, avisos, estado } = iniciar(bancada, { esperasNovaTentativaMs: [], escopo: [LINHA_A] });
    await assentar();
    estado.atual = false;
    bancada.achar(LINHA_A).falhar(new Error("tarde demais"));
    await assentar();

    expect(avisos).toEqual([]);
    expect((await resultado).falhas).toEqual([]);
  });
});

describe("buscarEscopoCompleto — marca d'água do servidor", () => {
  it("maiorUpdatedAt é o maior entre todos os números e páginas, no formato original", async () => {
    const bancada = criarBancada();
    const { resultado } = iniciar(bancada, { escopo: [LINHA_A, LINHA_B] });
    await assentar();

    bancada.achar(LINHA_A).responder({
      data: [linhaCrua(LINHA_A, { updatedAt: "2026-10-21T11:00:00.000000+00:00" })],
      count: 1,
    });
    bancada.achar(LINHA_B).responder({
      data: [
        linhaCrua(LINHA_B, { updatedAt: "2026-10-21T11:30:00.500000+00:00" }),
        linhaCrua(LINHA_B, { updatedAt: "2026-10-21T10:00:00.000000+00:00" }),
      ],
      count: 2,
    });
    await assentar();

    expect((await resultado).maiorUpdatedAt).toBe("2026-10-21T11:30:00.500000+00:00");
  });

  it("sem updated_at nas linhas → null", async () => {
    const bancada = criarBancada();
    const { resultado } = iniciar(bancada, { escopo: [LINHA_A] });
    await assentar();
    bancada.achar(LINHA_A).responder({ data: [{ ...linhaCrua(LINHA_A), updated_at: undefined }], count: 1 });
    await assentar();
    expect((await resultado).maiorUpdatedAt).toBeNull();
  });
});

describe("buscarEscopoCompleto — conversa que mudou de número durante a busca", () => {
  it("o id vem nos dois fetches (A antes da mudança, B depois): a lista fica com uma só", async () => {
    const bancada = criarBancada();
    const { resultado, commits } = iniciar(bancada, { escopo: [LINHA_A, LINHA_B] });
    await assentar();

    const movida = uuid(900);
    const naA = linhaCrua(LINHA_A, { id: movida });
    const naB = linhaCrua(LINHA_B, { id: movida });
    bancada.achar(LINHA_A).responder({ data: [naA, linhaCrua(LINHA_A)], count: 2 });
    bancada.achar(LINHA_B).responder({ data: [naB], count: 1 });
    await assentar();
    await resultado;

    // O que o ConversationsList faz com cada commit.
    const escopo = new Set([LINHA_A, LINHA_B]);
    let estado: Conversation[] = [];
    for (const c of commits) {
      estado = reconcileFetched(estado, c.fetched, {
        numeroId: c.numeroId,
        escopo,
        startedAt: c.info.watermark,
        complete: c.info.complete,
      });
    }

    expect(estado.filter((c) => c.id === movida)).toHaveLength(1);
    expect(new Set(estado.map((c) => c.id)).size).toBe(estado.length);
  });
});

describe("buscarIncremental", () => {
  const desde = "2026-10-21T12:00:00.000000+00:00";

  it("uma requisição com os números do escopo e a marca menos a folga de 2 min", async () => {
    const buscar = vi.fn(async (): Promise<RespostaDePagina> => ({ data: [], count: null, error: null }));

    await buscarIncremental({ escopo: [LINHA_A, LINHA_B, LINHA_A], desde, buscar });

    expect(buscar).toHaveBeenCalledTimes(1);
    expect(buscar).toHaveBeenCalledWith(
      [LINHA_A, LINHA_B],
      new Date(Date.parse(desde) - FOLGA_INCREMENTAL_MS).toISOString(),
    );
    expect(FOLGA_INCREMENTAL_MS).toBe(120_000);
  });

  it("devolve as conversas e a marca d'água das linhas recebidas", async () => {
    const linhas = [
      linhaCrua(LINHA_A, { updatedAt: "2026-10-21T12:03:00.000000+00:00" }),
      linhaCrua(LINHA_B, { updatedAt: "2026-10-21T12:07:00.250000+00:00" }),
    ];
    const resultado = await buscarIncremental({
      escopo: [LINHA_A, LINHA_B],
      desde,
      buscar: async () => ({ data: linhas, count: null, error: null }),
    });

    expect(resultado.rows.map((r) => r.id)).toEqual(linhas.map((l) => l.id));
    expect(resultado.maiorUpdatedAt).toBe("2026-10-21T12:07:00.250000+00:00");
    expect(resultado.precisaCompleto).toBe(false);
  });

  it("nada mudou: sem linhas, sem marca nova e sem pedir o completo", async () => {
    const resultado = await buscarIncremental({
      escopo: [LINHA_A],
      desde,
      buscar: async () => ({ data: [], count: null, error: null }),
    });
    expect(resultado).toEqual({ rows: [], maiorUpdatedAt: null, precisaCompleto: false });
  });

  it("uma página cheia pode estar truncada: pede o completo", async () => {
    const cheia = paginaDe(LINHA_A, LIST_PAGE_SIZE);
    const resultado = await buscarIncremental({
      escopo: [LINHA_A],
      desde,
      buscar: async () => ({ data: cheia, count: null, error: null }),
    });
    expect(resultado.precisaCompleto).toBe(true);
  });

  it("a página cheia conta pelo tamanho cru, mesmo com linha malformada", async () => {
    const cheia = paginaDe(LINHA_A, LIST_PAGE_SIZE);
    cheia[3] = { ...cheia[3], id: "não-é-uuid" };
    const resultado = await buscarIncremental({
      escopo: [LINHA_A],
      desde,
      buscar: async () => ({ data: cheia, count: null, error: null }),
    });
    expect(resultado.precisaCompleto).toBe(true);
    expect(resultado.rows).toHaveLength(LIST_PAGE_SIZE - 1);
  });

  it("marca d'água que não se lê: pede o completo sem ir à rede", async () => {
    const buscar = vi.fn();
    const resultado = await buscarIncremental({ escopo: [LINHA_A], desde: "ontem", buscar });
    expect(resultado).toEqual({ rows: [], maiorUpdatedAt: null, precisaCompleto: true });
    expect(buscar).not.toHaveBeenCalled();
  });

  it("escopo vazio não vai à rede", async () => {
    const buscar = vi.fn();
    const resultado = await buscarIncremental({ escopo: [], desde, buscar });
    expect(resultado).toEqual({ rows: [], maiorUpdatedAt: null, precisaCompleto: false });
    expect(buscar).not.toHaveBeenCalled();
  });

  it("o erro da requisição sobe para quem chamou", async () => {
    const erro = { message: "JWT expirou" };
    await expect(
      buscarIncremental({ escopo: [LINHA_A], desde, buscar: async () => ({ data: null, count: null, error: erro }) }),
    ).rejects.toBe(erro);
  });
});

describe("maisRecente", () => {
  it("escolhe pelo instante, não pelo texto", () => {
    expect(maisRecente("2026-10-21T12:30:00+00:00", "2026-10-21T10:00:00-03:00")).toBe("2026-10-21T10:00:00-03:00");
    expect(maisRecente("2026-10-21T13:00:00+00:00", "2026-10-21T10:00:00-03:00")).toBe("2026-10-21T13:00:00+00:00");
  });

  it("valor que não se lê perde para o que se lê, e null é neutro", () => {
    expect(maisRecente(null, "2026-10-21T12:00:00+00:00")).toBe("2026-10-21T12:00:00+00:00");
    expect(maisRecente("2026-10-21T12:00:00+00:00", null)).toBe("2026-10-21T12:00:00+00:00");
    expect(maisRecente("lixo", "2026-10-21T12:00:00+00:00")).toBe("2026-10-21T12:00:00+00:00");
    expect(maisRecente("2026-10-21T12:00:00+00:00", "lixo")).toBe("2026-10-21T12:00:00+00:00");
    expect(maisRecente(null, null)).toBeNull();
    expect(maisRecente("lixo", null)).toBeNull();
  });
});

describe("decidirModo", () => {
  const agora = Date.parse(AGORA);
  const base = { pedido: "incremental" as const, maiorUpdatedAt: AGORA, ultimoCompletoEm: agora - 60_000, agora };

  it("completo pedido é sempre completo", () => {
    expect(decidirModo({ ...base, pedido: "completo" })).toBe("completo");
  });

  it("incremental com marca d'água do servidor e completo recente continua incremental", () => {
    expect(decidirModo(base)).toBe("incremental");
  });

  it("sem marca d'água do servidor vira completo", () => {
    expect(decidirModo({ ...base, maiorUpdatedAt: null })).toBe("completo");
  });

  it("sem nenhum completo concluído vira completo", () => {
    expect(decidirModo({ ...base, ultimoCompletoEm: 0 })).toBe("completo");
  });

  it("completo mais velho que 10 min vira completo (limpa o que o incremental não vê)", () => {
    expect(decidirModo({ ...base, ultimoCompletoEm: agora - COMPLETO_A_CADA_MS })).toBe("incremental");
    expect(decidirModo({ ...base, ultimoCompletoEm: agora - COMPLETO_A_CADA_MS - 1 })).toBe("completo");
  });

  describe("adiarCompleto (aba escondida)", () => {
    const velho = { ...base, ultimoCompletoEm: agora - COMPLETO_A_CADA_MS - 1 };

    it("o completo periódico espera: com o último completo velho segue incremental", () => {
      expect(decidirModo(velho)).toBe("completo");
      expect(decidirModo({ ...velho, adiarCompleto: true })).toBe("incremental");
    });

    it("sem adiar, o comportamento é o de sempre", () => {
      expect(decidirModo({ ...base, adiarCompleto: false })).toBe("incremental");
    });

    it("não vence o pedido explícito de completo", () => {
      expect(decidirModo({ ...base, pedido: "completo", adiarCompleto: true })).toBe("completo");
    });

    it("não vence a falta de marca d'água do servidor nem de um completo anterior: sem de onde partir", () => {
      expect(decidirModo({ ...base, maiorUpdatedAt: null, adiarCompleto: true })).toBe("completo");
      expect(decidirModo({ ...base, ultimoCompletoEm: 0, adiarCompleto: true })).toBe("completo");
    });
  });

  describe("aposQueda (o canal realtime reassinou)", () => {
    it("com o último completo velho (mais de 2 min) vira completo", () => {
      const velho = { ...base, ultimoCompletoEm: agora - COMPLETO_APOS_QUEDA_MS - 1 };
      expect(decidirModo(velho)).toBe("incremental");
      expect(decidirModo({ ...velho, aposQueda: true })).toBe("completo");
    });

    it("com o último completo recente (até 2 min) segue incremental: tempestade de reconexões não baixa tudo", () => {
      expect(decidirModo({ ...base, ultimoCompletoEm: agora - COMPLETO_APOS_QUEDA_MS, aposQueda: true })).toBe("incremental");
      expect(decidirModo({ ...base, ultimoCompletoEm: agora - 5_000, aposQueda: true })).toBe("incremental");
    });

    it("sem marca d'água ou sem completo anterior continua completo", () => {
      expect(decidirModo({ ...base, maiorUpdatedAt: null, aposQueda: true })).toBe("completo");
      expect(decidirModo({ ...base, ultimoCompletoEm: 0, aposQueda: true })).toBe("completo");
    });

    it("com a aba escondida o completo espera, mesmo depois de uma queda", () => {
      const velho = { ...base, ultimoCompletoEm: agora - COMPLETO_APOS_QUEDA_MS - 1 };
      expect(decidirModo({ ...velho, aposQueda: true, adiarCompleto: true })).toBe("incremental");
    });
  });
});

describe("buscarCoResponsaveis", () => {
  const linhaDe = (conversationId: string, userId: string, numeroId: string | null = LINHA_A) => ({
    conversation_id: conversationId,
    user_id: userId,
    conversations: numeroId === null ? null : { phone_number_id: numeroId },
  });
  const resposta = (data: unknown): RespostaDePagina => ({ data, count: null, error: null });

  it("junta os co-responsáveis por conversa e guarda o número dela", async () => {
    const buscar = vi.fn(async () =>
      resposta([linhaDe("c1", "u1"), linhaDe("c1", "u2"), linhaDe("c2", "u1", LINHA_B)]),
    );

    const retrato = await buscarCoResponsaveis({ escopo: [LINHA_A, LINHA_B], buscar });

    expect(buscar).toHaveBeenCalledTimes(1);
    expect(buscar).toHaveBeenCalledWith([LINHA_A, LINHA_B], 0);
    expect(retrato).toEqual(
      new Map([
        ["c1", { numeroId: LINHA_A, userIds: ["u1", "u2"] }],
        ["c2", { numeroId: LINHA_B, userIds: ["u1"] }],
      ]),
    );
  });

  it("página cheia pede a seguinte, de 1000 em 1000, até uma página curta", async () => {
    const cheia = Array.from({ length: LIST_PAGE_SIZE }, (_, i) => linhaDe(`c${i}`, "u1"));
    const buscar = vi
      .fn<(numeros: string[], from: number) => Promise<RespostaDePagina>>()
      .mockResolvedValueOnce(resposta(cheia))
      .mockResolvedValueOnce(resposta([linhaDe("ultima", "u2")]));

    const retrato = await buscarCoResponsaveis({ escopo: [LINHA_A], buscar });

    expect(buscar.mock.calls.map(([, from]) => from)).toEqual([0, LIST_PAGE_SIZE]);
    expect(retrato.size).toBe(LIST_PAGE_SIZE + 1);
    expect(retrato.get("ultima")?.userIds).toEqual(["u2"]);
  });

  it("uma página cheia e a seguinte vazia fecha o retrato", async () => {
    const cheia = Array.from({ length: LIST_PAGE_SIZE }, (_, i) => linhaDe(`c${i}`, "u1"));
    const buscar = vi
      .fn<(numeros: string[], from: number) => Promise<RespostaDePagina>>()
      .mockResolvedValueOnce(resposta(cheia))
      .mockResolvedValueOnce(resposta([]));

    const retrato = await buscarCoResponsaveis({ escopo: [LINHA_A], buscar });

    expect(buscar).toHaveBeenCalledTimes(2);
    expect(retrato.size).toBe(LIST_PAGE_SIZE);
  });

  it("sem co-responsável nenhum o retrato é vazio (e vale: quem não aparece não tem)", async () => {
    const retrato = await buscarCoResponsaveis({ escopo: [LINHA_A], buscar: async () => resposta([]) });
    expect(retrato.size).toBe(0);
  });

  it("escopo vazio não vai à rede", async () => {
    const buscar = vi.fn();
    await expect(buscarCoResponsaveis({ escopo: [], buscar })).resolves.toEqual(new Map());
    expect(buscar).not.toHaveBeenCalled();
  });

  it("ids repetidos no escopo viram um número só na consulta", async () => {
    const buscar = vi.fn(async () => resposta([]));
    await buscarCoResponsaveis({ escopo: [LINHA_A, LINHA_A, LINHA_B], buscar });
    expect(buscar).toHaveBeenCalledWith([LINHA_A, LINHA_B], 0);
  });

  it("o erro da requisição sobe: retrato parcial não existe", async () => {
    const erro = { message: "statement timeout" };
    const buscar = vi
      .fn<(numeros: string[], from: number) => Promise<RespostaDePagina>>()
      .mockResolvedValueOnce(resposta(Array.from({ length: LIST_PAGE_SIZE }, (_, i) => linhaDe(`c${i}`, "u1"))))
      .mockResolvedValueOnce({ data: null, count: null, error: erro });

    await expect(buscarCoResponsaveis({ escopo: [LINHA_A], buscar })).rejects.toBe(erro);
  });

  it("linha fora do contrato derruba o retrato: descartá-la tiraria o co-responsável de alguém", async () => {
    const buscar = async () => resposta([linhaDe("c1", "u1"), { conversation_id: "c2" }]);
    await expect(buscarCoResponsaveis({ escopo: [LINHA_A], buscar })).rejects.toThrow(/fora do contrato/);
  });

  it("página que não é lista (data nulo, sem erro) derruba o retrato em vez de contar como vazio", async () => {
    await expect(buscarCoResponsaveis({ escopo: [LINHA_A], buscar: async () => resposta(null) })).rejects.toThrow(
      /fora do contrato/,
    );
    await expect(
      buscarCoResponsaveis({ escopo: [LINHA_A], buscar: async () => resposta({ erro: true }) }),
    ).rejects.toThrow(/fora do contrato/);
  });

  it("conversa sem o embed do número entra com número nulo", async () => {
    const retrato = await buscarCoResponsaveis({
      escopo: [LINHA_A],
      buscar: async () => resposta([linhaDe("c1", "u1", null)]),
    });
    expect(retrato.get("c1")).toEqual({ numeroId: null, userIds: ["u1"] });
  });

  it("passou do teto de páginas: lança em vez de devolver um retrato pela metade", async () => {
    const cheia = Array.from({ length: LIST_PAGE_SIZE }, (_, i) => linhaDe(`c${i}`, "u1"));
    const buscar = vi.fn(async () => resposta(cheia));

    await expect(buscarCoResponsaveis({ escopo: [LINHA_A], buscar })).rejects.toThrow(/teto de páginas/);
    expect(buscar).toHaveBeenCalledTimes(100);
  });
});
