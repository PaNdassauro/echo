import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLUNAS_CO_RESPONSAVEIS, LIST_COLUMNS, parseCoResponsaveis, parseListPage } from "./conversationListQuery";

const LINHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Linha crua como o PostgREST a devolve para o select de LIST_COLUMNS. */
const linhaCrua = (n: number, extras: Record<string, unknown> = {}) => ({
  id: uuid(n),
  contact_name: `Contato ${n}`,
  contact_phone: "5511999990001",
  last_message_at: "2026-10-21T12:00:00+00:00",
  status: "active",
  phone_number_id: LINHA,
  sector_id: null,
  assigned_to: null,
  is_group: false,
  contact_avatar_url: null,
  contact_avatar_updated_at: null,
  updated_at: "2026-10-21T12:00:00.123456+00:00",
  profiles: null,
  conversation_assignees: [],
  ...extras,
});

describe("parseListPage", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("devolve as conversas e o maior updated_at do servidor, no formato original", () => {
    const { rows, maiorUpdatedAt } = parseListPage([
      linhaCrua(1, { updated_at: "2026-10-21T12:00:00.100000+00:00" }),
      linhaCrua(2, { updated_at: "2026-10-21T12:05:00.250000+00:00" }),
      linhaCrua(3, { updated_at: "2026-10-21T12:01:00.000000+00:00" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(maiorUpdatedAt).toBe("2026-10-21T12:05:00.250000+00:00");
  });

  it("não deixa o updated_at entrar na Conversation", () => {
    const { rows } = parseListPage([linhaCrua(1)]);
    expect(rows[0]).not.toHaveProperty("updated_at");
  });

  it("compara por instante, não por texto (fusos diferentes)", () => {
    const { maiorUpdatedAt } = parseListPage([
      linhaCrua(1, { updated_at: "2026-10-21T12:30:00+00:00" }),
      linhaCrua(2, { updated_at: "2026-10-21T10:00:00-03:00" }), // 13:00 UTC
    ]);
    expect(maiorUpdatedAt).toBe("2026-10-21T10:00:00-03:00");
  });

  it("linha malformada é descartada e o updated_at dela não conta", () => {
    const { rows, maiorUpdatedAt } = parseListPage([
      linhaCrua(1, { updated_at: "2026-10-21T12:00:00+00:00" }),
      { ...linhaCrua(2, { updated_at: "2030-01-01T00:00:00+00:00" }), id: "não-é-uuid" },
    ]);
    expect(rows.map((r) => r.id)).toEqual([uuid(1)]);
    expect(maiorUpdatedAt).toBe("2026-10-21T12:00:00+00:00");
  });

  it("data que não se lê não vira marca d'água", () => {
    const { maiorUpdatedAt } = parseListPage([
      linhaCrua(1, { updated_at: "ontem à tarde" }),
      linhaCrua(2, { updated_at: "2026-10-21T12:00:00+00:00" }),
    ]);
    expect(maiorUpdatedAt).toBe("2026-10-21T12:00:00+00:00");
  });

  it("sem updated_at em nenhuma linha → null, e as conversas entram do mesmo jeito", () => {
    const { rows, maiorUpdatedAt } = parseListPage([
      linhaCrua(1, { updated_at: undefined }),
      linhaCrua(2, { updated_at: null }),
    ]);
    expect(rows).toHaveLength(2);
    expect(maiorUpdatedAt).toBeNull();
  });

  it("resposta que não é lista → vazio", () => {
    expect(parseListPage(null)).toEqual({ rows: [], maiorUpdatedAt: null });
    expect(parseListPage({ erro: true })).toEqual({ rows: [], maiorUpdatedAt: null });
  });
});

describe("LIST_COLUMNS", () => {
  it("pede updated_at: a revalidação incremental lê a marca d'água dele", () => {
    expect(LIST_COLUMNS.split(",").map((c) => c.trim())).toContain("updated_at");
  });
});

describe("parseCoResponsaveis", () => {
  const linha = (conversationId: string, userId: string, numeroId: string | null = LINHA) => ({
    conversation_id: conversationId,
    user_id: userId,
    conversations: numeroId === null ? null : { phone_number_id: numeroId },
  });

  it("devolve conversa, usuário e o número da conversa (o embed muitos-para-um vem como objeto)", () => {
    expect(parseCoResponsaveis([linha(uuid(1), uuid(9)), linha(uuid(2), uuid(8), null)])).toEqual([
      { conversationId: uuid(1), userId: uuid(9), numeroId: LINHA },
      { conversationId: uuid(2), userId: uuid(8), numeroId: null },
    ]);
  });

  it("sem o embed (ou com o número nulo) o número fica nulo", () => {
    expect(parseCoResponsaveis([{ conversation_id: uuid(1), user_id: uuid(9) }])[0].numeroId).toBeNull();
    expect(
      parseCoResponsaveis([{ conversation_id: uuid(1), user_id: uuid(9), conversations: { phone_number_id: null } }])[0].numeroId,
    ).toBeNull();
  });

  it("o que não é lista derruba a página: tratá-la como vazia apagaria todos os co-responsáveis", () => {
    expect(() => parseCoResponsaveis(null)).toThrow(/fora do contrato/);
    expect(() => parseCoResponsaveis({ erro: true })).toThrow(/fora do contrato/);
    expect(parseCoResponsaveis([])).toEqual([]);
  });

  it("uma linha fora do contrato derruba a página: o retrato vale por completo, descartá-la tiraria o co-responsável de alguém", () => {
    expect(() => parseCoResponsaveis([linha(uuid(1), uuid(9)), { conversation_id: uuid(2) }])).toThrow(/fora do contrato/);
    expect(() => parseCoResponsaveis([{ conversation_id: 7, user_id: uuid(9) }])).toThrow(/fora do contrato/);
  });
});

describe("COLUNAS_CO_RESPONSAVEIS", () => {
  it("traz o número da conversa por um embed !inner (a RLS que esconde a conversa tira a linha)", () => {
    expect(COLUNAS_CO_RESPONSAVEIS).toContain("conversations!inner(phone_number_id)");
    expect(COLUNAS_CO_RESPONSAVEIS.split(",").map((c) => c.trim())).toEqual(
      expect.arrayContaining(["conversation_id", "user_id"]),
    );
  });
});
