import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatLineId,
  lineMetaFromEmbed,
  resolveChatLine,
  resolveSelectedLineId,
  type ChatTarget,
  type LineMeta,
} from "./numeroDaConversa";

const linhaA: LineMeta = {
  id: "aaaa",
  metaPhoneNumberId: "qr_111",
  themeHue: 176,
  connectionType: "qr",
  displayName: "Suporte",
};
const linhaB: LineMeta = {
  id: "bbbb",
  metaPhoneNumberId: "meta-222",
  themeHue: 195,
  connectionType: "business_api",
  displayName: "Comercial",
};

const mapa = (...linhas: LineMeta[]) => new Map(linhas.map((linha) => [linha.id, linha]));

describe("resolveChatLine", () => {
  it("devolve o número do mapa quando a conversa é a do alvo", () => {
    const alvo: ChatTarget = { conversationId: "c1", lineId: "bbbb", fallback: null };
    expect(resolveChatLine(alvo, "c1", mapa(linhaA, linhaB))).toBe(linhaB);
  });

  it("nunca devolve o número da conversa anterior para outra conversa", () => {
    const alvo: ChatTarget = { conversationId: "c1", lineId: "bbbb", fallback: linhaB };
    expect(resolveChatLine(alvo, "c2", mapa(linhaA, linhaB))).toBeNull();
  });

  it("sem conversa ou sem alvo devolve null", () => {
    const alvo: ChatTarget = { conversationId: "c1", lineId: "aaaa", fallback: null };
    expect(resolveChatLine(alvo, null, mapa(linhaA))).toBeNull();
    expect(resolveChatLine(null, "c1", mapa(linhaA))).toBeNull();
  });

  it("usa o embed do deep link quando o mapa não tem o número (linha inativa)", () => {
    const alvo: ChatTarget = { conversationId: "c1", lineId: "bbbb", fallback: linhaB };
    expect(resolveChatLine(alvo, "c1", mapa(linhaA))).toBe(linhaB);
  });

  it("o mapa vence o embed quando os dois existem", () => {
    const embedVelho: LineMeta = { ...linhaB, themeHue: 10, displayName: "Nome antigo" };
    const alvo: ChatTarget = { conversationId: "c1", lineId: "bbbb", fallback: embedVelho };
    expect(resolveChatLine(alvo, "c1", mapa(linhaB))).toBe(linhaB);
  });

  it("sem mapa nem embed devolve null em vez de chutar o número selecionado", () => {
    const alvo: ChatTarget = { conversationId: "c1", lineId: "bbbb", fallback: null };
    expect(resolveChatLine(alvo, "c1", mapa(linhaA))).toBeNull();
  });

  it("ignora um embed que é de outro número", () => {
    const alvo: ChatTarget = { conversationId: "c1", lineId: "bbbb", fallback: linhaA };
    expect(resolveChatLine(alvo, "c1", mapa())).toBeNull();
  });
});

describe("chatLineId", () => {
  const alvo: ChatTarget = { conversationId: "c1", lineId: "aaaa", fallback: null };

  it("devolve o id do número só para a conversa do alvo", () => {
    expect(chatLineId(alvo, "c1")).toBe("aaaa");
    expect(chatLineId(alvo, "c2")).toBeNull();
    expect(chatLineId(alvo, null)).toBeNull();
    expect(chatLineId(null, "c1")).toBeNull();
  });
});

describe("lineMetaFromEmbed", () => {
  afterEach(() => vi.restoreAllMocks());

  it("converte o embed do número", () => {
    expect(
      lineMetaFromEmbed({
        id: "aaaa",
        phone_number_id: "qr_111",
        theme_hue: 176,
        connection_type: "qr",
        display_name: "Suporte",
      }),
    ).toEqual(linhaA);
  });

  it("aceita cor e tipo de conexão nulos", () => {
    expect(
      lineMetaFromEmbed({
        id: "aaaa",
        phone_number_id: "meta-1",
        theme_hue: null,
        connection_type: null,
        display_name: "Sem cor",
      }),
    ).toEqual({
      id: "aaaa",
      metaPhoneNumberId: "meta-1",
      themeHue: null,
      connectionType: null,
      displayName: "Sem cor",
    });
  });

  it("embed ausente devolve null sem ruído", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(lineMetaFromEmbed(null)).toBeNull();
    expect(lineMetaFromEmbed(undefined)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("embed fora do contrato devolve null e avisa", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(lineMetaFromEmbed({ id: "aaaa" })).toBeNull();
    expect(lineMetaFromEmbed([{ id: "aaaa" }])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("resolveSelectedLineId", () => {
  const lineIds = ["aaaa", "bbbb", "cccc"];

  it("mantém o número atual se ele ainda vale", () => {
    expect(resolveSelectedLineId({ selectedId: "bbbb", savedId: "cccc", lineIds })).toBe("bbbb");
  });

  it("usa o salvo quando o atual é nulo", () => {
    expect(resolveSelectedLineId({ selectedId: null, savedId: "cccc", lineIds })).toBe("cccc");
  });

  it("usa o salvo quando o atual não está mais na lista (outra org, linha removida)", () => {
    expect(resolveSelectedLineId({ selectedId: "zzzz", savedId: "cccc", lineIds })).toBe("cccc");
  });

  it("cai no primeiro quando nem o atual nem o salvo valem", () => {
    expect(resolveSelectedLineId({ selectedId: "zzzz", savedId: "yyyy", lineIds })).toBe("aaaa");
    expect(resolveSelectedLineId({ selectedId: null, savedId: null, lineIds })).toBe("aaaa");
  });

  it("org sem número resolve para null, inclusive com id salvo velho", () => {
    expect(resolveSelectedLineId({ selectedId: "bbbb", savedId: "cccc", lineIds: [] })).toBeNull();
  });
});
