import { describe, expect, it, vi } from "vitest";
import {
  buscarTagsDosNumeros,
  idDaConversaDoEventoDeTag,
  mesclarTagsDosNumeros,
  tagsDaResposta,
  type TagsPorConversa,
} from "./conversationTagsFetch";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const tag = (id: string, name = id) => ({ id, name, color: "red", phone_number_id: null });
const linha = (conversation_id: string, tag_id: string) => ({
  conversation_id,
  tag_id,
  tag_name: `tag ${tag_id}`,
  tag_color: "red",
});

describe("tagsDaResposta", () => {
  it("agrupa as tags por conversa", () => {
    const mapa = tagsDaResposta([linha("c1", "t1"), linha("c1", "t2"), linha("c2", "t1")]);
    expect(mapa?.get("c1")?.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(mapa?.get("c2")?.map((t) => t.id)).toEqual(["t1"]);
  });

  it("sem dados é um mapa vazio, e resposta fora do contrato é null (falha, não 'sem tags')", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(tagsDaResposta(null)?.size).toBe(0);
    expect(tagsDaResposta({ erro: true })).toBeNull();
    expect(tagsDaResposta([{ conversation_id: "c1" }])).toBeNull();
  });
});

describe("buscarTagsDosNumeros", () => {
  it("faz uma chamada por número e devolve o de cada um", async () => {
    const buscar = vi.fn(async (numeroId: string) => ({
      data: [linha(`conv-${numeroId}`, "t1")],
      error: null,
    }));
    const resultados = await buscarTagsDosNumeros([A, B], buscar);
    expect(buscar.mock.calls.map((c) => c[0])).toEqual([A, B]);
    expect(resultados.map((r) => [r.numeroId, [...(r.tags?.keys() ?? [])]])).toEqual([
      [A, [`conv-${A}`]],
      [B, [`conv-${B}`]],
    ]);
  });

  it("a falha de um número (erro, exceção ou fora do contrato) não derruba os outros", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const buscar = async (numeroId: string) => {
      if (numeroId === A) return { data: null, error: { message: "timeout" } };
      if (numeroId === B) throw new Error("rede");
      if (numeroId === C) return { data: "lixo", error: null };
      return { data: [linha("c1", "t1")], error: null };
    };
    const resultados = await buscarTagsDosNumeros([A, B, C, "d"], buscar);
    expect(resultados.map((r) => r.tags === null)).toEqual([true, true, true, false]);
  });

  it("no máximo 4 chamadas ao mesmo tempo", async () => {
    let emVoo = 0;
    let pico = 0;
    const buscar = async () => {
      emVoo += 1;
      pico = Math.max(pico, emVoo);
      await new Promise((resolve) => setTimeout(resolve, 5));
      emVoo -= 1;
      return { data: [], error: null };
    };
    await buscarTagsDosNumeros(["1", "2", "3", "4", "5", "6", "7"], buscar);
    expect(pico).toBe(4);
  });
});

describe("mesclarTagsDosNumeros", () => {
  const anterior: TagsPorConversa = new Map([
    ["a1", [tag("antiga-a1")]],
    ["a2", [tag("antiga-a2")]],
    ["b1", [tag("antiga-b1")]],
  ]);
  const linhaDe = new Map<string, string>([
    ["a1", A],
    ["a2", A],
    ["b1", B],
    ["a-nova", A],
  ]);
  const base = {
    anterior,
    linhaDaConversa: (id: string) => linhaDe.get(id),
    escopo: new Set([A, B]),
    completo: true,
  };

  it("o número que respondeu SUBSTITUI o que se sabia dele (conversa sem tag some) e o outro fica", () => {
    const novo = mesclarTagsDosNumeros({
      ...base,
      resultados: [
        { numeroId: A, tags: new Map([["a-nova", [tag("t")]]]) },
        { numeroId: B, tags: new Map([["b1", [tag("nova-b1")]]]) },
      ],
    });
    expect([...novo.keys()].sort()).toEqual(["a-nova", "b1"]);
    expect(novo.get("b1")?.[0].id).toBe("nova-b1");
  });

  it("o número que falhou mantém as tags antigas das conversas dele, e o outro se atualiza", () => {
    const novo = mesclarTagsDosNumeros({
      ...base,
      resultados: [
        { numeroId: A, tags: null },
        { numeroId: B, tags: new Map([["b1", [tag("nova-b1")]]]) },
      ],
    });
    expect(novo.get("a1")?.[0].id).toBe("antiga-a1");
    expect(novo.get("a2")?.[0].id).toBe("antiga-a2");
    expect(novo.get("b1")?.[0].id).toBe("nova-b1");
  });

  it("atualização de um número só (marcar uma tag) não mexe nas conversas dos outros", () => {
    const novo = mesclarTagsDosNumeros({
      ...base,
      completo: false,
      resultados: [{ numeroId: A, tags: new Map([["a1", [tag("antiga-a1"), tag("marcada")]]]) }],
    });
    expect(novo.get("a1")?.map((t) => t.id)).toEqual(["antiga-a1", "marcada"]);
    expect(novo.has("a2")).toBe(false);
    expect(novo.get("b1")?.[0].id).toBe("antiga-b1");
  });

  it("conversa de número fora do escopo sai; a de número desconhecido só sai na busca completa", () => {
    const comOutros: TagsPorConversa = new Map([...anterior, ["fora", [tag("x")]], ["sem-linha", [tag("y")]]]);
    const linhaDaConversa = (id: string) => (id === "fora" ? C : linhaDe.get(id));
    const completa = mesclarTagsDosNumeros({
      ...base,
      anterior: comOutros,
      linhaDaConversa,
      resultados: [{ numeroId: A, tags: new Map() }, { numeroId: B, tags: new Map() }],
    });
    expect(completa.size).toBe(0);
    const parcial = mesclarTagsDosNumeros({
      ...base,
      anterior: comOutros,
      linhaDaConversa,
      completo: false,
      resultados: [{ numeroId: A, tags: new Map() }],
    });
    expect([...parcial.keys()].sort()).toEqual(["b1", "sem-linha"]);
  });
});

describe("idDaConversaDoEventoDeTag", () => {
  it("lê o id do new ou do old, e devolve null quando o evento não o traz", () => {
    expect(idDaConversaDoEventoDeTag({ new: { conversation_id: "c1" }, old: {} })).toBe("c1");
    expect(idDaConversaDoEventoDeTag({ new: {}, old: { conversation_id: "c2" } })).toBe("c2");
    expect(idDaConversaDoEventoDeTag({ new: {}, old: { id: "so-a-chave" } })).toBeNull();
    expect(idDaConversaDoEventoDeTag({})).toBeNull();
  });
});
