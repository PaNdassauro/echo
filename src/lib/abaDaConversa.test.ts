import { describe, expect, it } from "vitest";
import { abasDaConversa, estaNaAba, filaDaConversa, iaContandoRede, type ContextoDaAba } from "./abaDaConversa";

const EU = "11111111-1111-4111-8111-111111111111";
const OUTRO = "22222222-2222-4222-8222-222222222222";
const DESDE = "2026-10-09T12:00:00.000Z";

type Conversa = Parameters<typeof abasDaConversa>[0];

const conv = (overrides: Partial<Conversa> = {}): Conversa => ({
  status: "active",
  assigned_to: null,
  co_assignee_ids: [],
  disparo_desde: null,
  ...overrides,
});

const ctx = (overrides: Partial<ContextoDaAba> = {}): ContextoDaAba => ({
  userId: EU,
  ...overrides,
});

describe("filaDaConversa — precedência", () => {
  it("encerrada vence tudo, inclusive disparo", () => {
    expect(filaDaConversa(conv({ status: "closed", disparo_desde: DESDE }))).toBe("closed");
  });

  it("disparo vence as abas normais", () => {
    expect(filaDaConversa(conv({ disparo_desde: DESDE }))).toBe("disparos");
  });

  it("sem marca nenhuma é fila normal", () => {
    expect(filaDaConversa(conv())).toBe("normal");
  });
});

describe("abasDaConversa", () => {
  it("disparo sem dono fica só em Disparos (fora de Todos e Aguardando)", () => {
    expect(abasDaConversa(conv({ disparo_desde: DESDE }), ctx())).toEqual(["disparos"]);
  });

  it("disparo com dono não conta em Meus nem em Compartilhados", () => {
    expect(abasDaConversa(conv({ disparo_desde: DESDE, assigned_to: EU }), ctx())).toEqual(["disparos"]);
    expect(
      abasDaConversa(conv({ disparo_desde: DESDE, assigned_to: OUTRO, co_assignee_ids: [EU] }), ctx()),
    ).toEqual(["disparos"]);
  });

  it("com busca, o disparo aparece também em Todos (e só lá)", () => {
    expect(abasDaConversa(conv({ disparo_desde: DESDE }), ctx({ buscando: true }))).toEqual(["disparos", "all"]);
  });

  it("encerrada com disparo fica só em Encerrados, mesmo buscando", () => {
    expect(
      abasDaConversa(conv({ status: "closed", disparo_desde: DESDE }), ctx({ buscando: true })),
    ).toEqual(["closed"]);
  });

  it("marca limpa pelo banco devolve a conversa às abas normais", () => {
    expect(abasDaConversa(conv({ disparo_desde: null }), ctx())).toEqual(["all", "waiting"]);
    expect(abasDaConversa(conv({ disparo_desde: null, assigned_to: EU }), ctx())).toEqual(["all", "mine"]);
  });

  it("compartilhada comigo vai para Compartilhados, não para Meus", () => {
    expect(abasDaConversa(conv({ assigned_to: OUTRO, co_assignee_ids: [EU] }), ctx())).toEqual(["all", "shared"]);
  });

  it("de outra pessoa fica só em Todos", () => {
    expect(abasDaConversa(conv({ assigned_to: OUTRO }), ctx())).toEqual(["all"]);
  });
});

describe("Com a IA", () => {
  const AGORA = Date.parse(DESDE);
  const MIN = 60 * 1000;
  const daIa = (overrides: Partial<Conversa> = {}) =>
    conv({ ia_desde: DESDE, ia_sem_resposta_desde: null, ...overrides });
  const semResposta = (minutos: number) => new Date(AGORA - minutos * MIN).toISOString();

  it("conversa que a IA atende fica só em Com a IA, fora de Todos e Aguardando", () => {
    expect(abasDaConversa(daIa(), ctx({ agora: AGORA }))).toEqual(["ia"]);
  });

  it("o contato acabou de escrever: continua com a IA", () => {
    expect(abasDaConversa(daIa({ ia_sem_resposta_desde: semResposta(9) }), ctx({ agora: AGORA }))).toEqual(["ia"]);
  });

  it("o contato escreveu e a IA não respondeu em 10 minutos: volta para Aguardando", () => {
    expect(abasDaConversa(daIa({ ia_sem_resposta_desde: semResposta(10) }), ctx({ agora: AGORA }))).toEqual(["all", "waiting"]);
  });

  it("a IA respondeu (o banco zera a marca): volta para Com a IA", () => {
    expect(abasDaConversa(daIa({ ia_sem_resposta_desde: null }), ctx({ agora: AGORA }))).toEqual(["ia"]);
  });

  it("data ilegível: volta para o time", () => {
    expect(abasDaConversa(daIa({ ia_sem_resposta_desde: "ontem" }), ctx({ agora: AGORA }))).toEqual(["all", "waiting"]);
  });

  it("o relógio da lista só anda com a rede correndo", () => {
    expect(iaContandoRede(daIa({ ia_sem_resposta_desde: semResposta(3) }), AGORA)).toBe(true);
    expect(iaContandoRede(daIa({ ia_sem_resposta_desde: semResposta(11) }), AGORA)).toBe(false);
    expect(iaContandoRede(daIa(), AGORA)).toBe(false);
    expect(iaContandoRede(daIa({ ia_desde: null, ia_sem_resposta_desde: semResposta(3) }), AGORA)).toBe(false);
  });

  it("com busca aparece também em Todos", () => {
    expect(abasDaConversa(daIa(), ctx({ agora: AGORA, buscando: true }))).toEqual(["ia", "all"]);
  });

  it("vem antes de Disparos e depois de Encerrados", () => {
    expect(filaDaConversa(daIa({ disparo_desde: DESDE }), AGORA)).toBe("ia");
    expect(filaDaConversa(daIa({ status: "closed" }), AGORA)).toBe("closed");
  });

  it("marca limpa pelo banco (a IA passou para alguém) devolve às abas normais", () => {
    expect(abasDaConversa(daIa({ ia_desde: null, assigned_to: EU }), ctx({ agora: AGORA }))).toEqual(["all", "mine"]);
  });
});

describe("estaNaAba", () => {
  it("responde pela mesma regra", () => {
    const disparo = conv({ disparo_desde: DESDE });
    expect(estaNaAba(disparo, "disparos", ctx())).toBe(true);
    expect(estaNaAba(disparo, "all", ctx())).toBe(false);
    expect(estaNaAba(disparo, "waiting", ctx())).toBe(false);
    expect(estaNaAba(disparo, "all", ctx({ buscando: true }))).toBe(true);
    expect(estaNaAba(disparo, "waiting", ctx({ buscando: true }))).toBe(false);
  });
});
