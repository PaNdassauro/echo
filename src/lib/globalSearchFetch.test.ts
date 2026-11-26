import { describe, expect, it, vi } from "vitest";
import {
  buscarNosNumeros,
  juntarResultados,
  resultadosDaResposta,
  type GlobalSearchResult,
} from "./globalSearchFetch";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const linha = (id: string, created_at: string, extras: Record<string, unknown> = {}) => ({
  id,
  content: `texto ${id}`,
  created_at,
  direction: "inbound",
  message_type: "text",
  conversation_id: `conv-${id}`,
  contact_name: "Maria",
  contact_phone: "5511999990001",
  is_group: false,
  ...extras,
});

const resultado = (id: string, created_at: string, numero = A): GlobalSearchResult => ({
  id,
  content: "",
  created_at,
  direction: "inbound",
  message_type: "text",
  conversation_id: `conv-${id}`,
  contact_name: "Maria",
  contact_phone: "1",
  is_group: false,
  phone_number_id: numero,
});

describe("resultadosDaResposta", () => {
  it("leva o número consultado quando a RPC não devolve o da linha", () => {
    const [r] = resultadosDaResposta([linha("m1", "2026-10-20T10:00:00Z")], B) ?? [];
    expect(r.phone_number_id).toBe(B);
  });

  it("prefere o número da linha da RPC, se vier", () => {
    const [r] = resultadosDaResposta([linha("m1", "2026-10-20T10:00:00Z", { phone_number_id: A })], B) ?? [];
    expect(r.phone_number_id).toBe(A);
  });

  it("completa o que vem nulo e recusa o que está fora do contrato", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const [r] = resultadosDaResposta([linha("m1", "2026-10-20T10:00:00Z", { contact_name: null, contact_phone: null, is_group: null })], A) ?? [];
    expect([r.contact_name, r.contact_phone, r.is_group]).toEqual(["Desconhecido", "", false]);
    expect(resultadosDaResposta([{ id: 1 }], A)).toBeNull();
    expect(resultadosDaResposta(null, A)).toEqual([]);
  });
});

describe("juntarResultados", () => {
  it("ordena pelas mensagens mais novas, de qualquer número, e corta no limite", () => {
    const lotes = [
      [resultado("a1", "2026-10-20T10:00:00Z", A), resultado("a2", "2026-10-18T10:00:00Z", A)],
      [resultado("b1", "2026-10-21T10:00:00Z", B), resultado("b2", "2026-10-19T10:00:00Z", B)],
    ];
    expect(juntarResultados(lotes).map((r) => r.id)).toEqual(["b1", "a1", "b2", "a2"]);
    expect(juntarResultados(lotes, 3).map((r) => r.id)).toEqual(["b1", "a1", "b2"]);
  });

  it("corta em 50 por padrão e não repete um id", () => {
    const muitos = Array.from({ length: 40 }, (_, i) => resultado(`a${i}`, `2026-10-01T10:${String(i).padStart(2, "0")}:00Z`, A));
    const outros = Array.from({ length: 40 }, (_, i) => resultado(`b${i}`, `2026-10-02T10:${String(i).padStart(2, "0")}:00Z`, B));
    const juntos = juntarResultados([muitos, outros, [muitos[0]]]);
    expect(juntos).toHaveLength(50);
    expect(new Set(juntos.map((r) => r.id)).size).toBe(50);
    // os 40 do B (mais novos) vêm primeiro
    expect(juntos.slice(0, 40).every((r) => r.phone_number_id === B)).toBe(true);
  });
});

describe("buscarNosNumeros", () => {
  it("uma chamada por número, todas com o MESMO sinal, e juntando os resultados", async () => {
    const sinais: AbortSignal[] = [];
    const controller = new AbortController();
    const lote = await buscarNosNumeros(
      [A, B],
      async (numeroId, sinal) => {
        sinais.push(sinal);
        return { data: [linha(`m-${numeroId.slice(0, 1)}`, numeroId === A ? "2026-10-20T10:00:00Z" : "2026-10-21T10:00:00Z")], error: null };
      },
      controller.signal,
    );
    expect(sinais).toHaveLength(2);
    expect(sinais.every((sinal) => sinal === controller.signal)).toBe(true);
    expect(lote.resultados.map((r) => [r.id, r.phone_number_id])).toEqual([
      ["m-b", B],
      ["m-a", A],
    ]);
    expect(lote.falhas).toEqual([]);
  });

  it("no máximo 4 chamadas ao mesmo tempo", async () => {
    let emVoo = 0;
    let pico = 0;
    const ids = Array.from({ length: 9 }, (_, i) => `n${i}`);
    await buscarNosNumeros(
      ids,
      async () => {
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await new Promise((resolve) => setTimeout(resolve, 5));
        emVoo -= 1;
        return { data: [], error: null };
      },
      new AbortController().signal,
    );
    expect(pico).toBe(4);
  });

  it("uma falha entra em `falhas` e os resultados dos outros números ficam", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lote = await buscarNosNumeros(
      [A, B],
      async (numeroId) =>
        numeroId === A
          ? { data: null, error: { message: "timeout" } }
          : { data: [linha("m1", "2026-10-20T10:00:00Z")], error: null },
      new AbortController().signal,
    );
    expect(lote.falhas).toEqual([A]);
    expect(lote.resultados.map((r) => r.id)).toEqual(["m1"]);
  });

  it("abortar o lote cancela o que está em voo e o que esperava vaga nem sai", async () => {
    const controller = new AbortController();
    const chamados: string[] = [];
    const ids = ["n0", "n1", "n2", "n3", "n4", "n5"];
    const promessa = buscarNosNumeros(
      ids,
      (numeroId, sinal) => {
        chamados.push(numeroId);
        return new Promise((resolve) => {
          sinal.addEventListener("abort", () => resolve({ data: null, error: { message: "AbortError" } }));
        });
      },
      controller.signal,
    );
    // 4 em voo, 2 na fila: aborta o lote.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chamados).toEqual(["n0", "n1", "n2", "n3"]);
    controller.abort();
    const lote = await promessa;
    expect(lote.abortado).toBe(true);
    expect(lote.resultados).toEqual([]);
    expect(chamados).toEqual(["n0", "n1", "n2", "n3"]);
  });
});
