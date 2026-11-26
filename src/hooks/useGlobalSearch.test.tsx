// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

afterEach(cleanup);

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Chamada {
  numeroId: string;
  termo: string;
  sinal: AbortSignal;
  responder: (resposta: { data: unknown; error: { message: string } | null }) => void;
}

const h = vi.hoisted(() => ({ chamadas: [] as unknown[] }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (_nome: string, args: { p_phone_number_id: string; p_search_term: string }) => ({
      abortSignal: (sinal: AbortSignal) =>
        new Promise((resolve) => {
          const chamada: Chamada = {
            numeroId: args.p_phone_number_id,
            termo: args.p_search_term,
            sinal,
            responder: resolve,
          };
          // O postgrest-js resolve um abort como { error }, não como exceção.
          sinal.addEventListener("abort", () => resolve({ data: null, error: { message: "AbortError" } }));
          h.chamadas.push(chamada);
        }),
    }),
  },
}));

const { useGlobalSearch } = await import("./useGlobalSearch");

const chamadas = () => h.chamadas as Chamada[];
const linha = (id: string, created_at: string) => ({
  id,
  content: id,
  created_at,
  direction: "inbound",
  message_type: "text",
  conversation_id: `conv-${id}`,
  contact_name: "Maria",
  contact_phone: "1",
  is_group: false,
});

beforeEach(() => {
  h.chamadas.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useGlobalSearch — vários números", () => {
  it("uma chamada por número, juntando os resultados pelas mensagens mais novas", async () => {
    const { result } = renderHook(() => useGlobalSearch({ phoneNumberIds: [A, B], debounceMs: 0 }));
    act(() => result.current.setSearchTerm("maria"));
    await waitFor(() => expect(chamadas()).toHaveLength(2));
    expect(chamadas().map((c) => c.numeroId).sort()).toEqual([A, B]);

    await act(async () => {
      chamadas().find((c) => c.numeroId === A)?.responder({ data: [linha("a1", "2026-10-20T10:00:00Z")], error: null });
      chamadas().find((c) => c.numeroId === B)?.responder({ data: [linha("b1", "2026-10-21T10:00:00Z")], error: null });
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.results.map((r) => [r.id, r.phone_number_id])).toEqual([
      ["b1", B],
      ["a1", A],
    ]);
    expect(result.current.error).toBeNull();
  });

  it("um termo novo aborta o lote anterior inteiro, e a resposta velha não sobrescreve a nova", async () => {
    const { result } = renderHook(() => useGlobalSearch({ phoneNumberIds: [A, B], debounceMs: 0 }));
    act(() => result.current.setSearchTerm("mar"));
    await waitFor(() => expect(chamadas()).toHaveLength(2));
    const primeiroLote = [...chamadas()];

    act(() => result.current.setSearchTerm("maria"));
    await waitFor(() => expect(chamadas()).toHaveLength(4));
    expect(primeiroLote.every((c) => c.sinal.aborted)).toBe(true);
    const segundoLote = chamadas().slice(2);
    // um controller por lote: as duas chamadas do lote novo compartilham o sinal, e ele está vivo
    expect(segundoLote[0].sinal).toBe(segundoLote[1].sinal);
    expect(segundoLote[0].sinal.aborted).toBe(false);

    // a resposta atrasada do lote velho chega depois e é descartada
    await act(async () => {
      primeiroLote[0].responder({ data: [linha("velha", "2026-10-22T10:00:00Z")], error: null });
      segundoLote.forEach((c) => c.responder({ data: [linha(`nova-${c.numeroId.slice(0, 1)}`, "2026-10-20T10:00:00Z")], error: null }));
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.results.map((r) => r.id).sort()).toEqual(["nova-a", "nova-b"]);
  });

  it("falha em um número: mostra o que os outros acharam e o aviso de falha", async () => {
    const { result } = renderHook(() => useGlobalSearch({ phoneNumberIds: [A, B], debounceMs: 0 }));
    act(() => result.current.setSearchTerm("maria"));
    await waitFor(() => expect(chamadas()).toHaveLength(2));
    await act(async () => {
      chamadas().find((c) => c.numeroId === A)?.responder({ data: null, error: { message: "timeout" } });
      chamadas().find((c) => c.numeroId === B)?.responder({ data: [linha("b1", "2026-10-21T10:00:00Z")], error: null });
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe("failed");
    expect(result.current.results.map((r) => r.id)).toEqual(["b1"]);
  });

  it("sem número no escopo: erro 'no-phone' e nenhuma chamada", async () => {
    const { result } = renderHook(() => useGlobalSearch({ phoneNumberIds: [], debounceMs: 0 }));
    act(() => result.current.setSearchTerm("maria"));
    await waitFor(() => expect(result.current.error).toBe("no-phone"));
    expect(chamadas()).toHaveLength(0);
  });

  it("limpar (fechar o diálogo) aborta o lote em voo e não deixa 'failed' para trás", async () => {
    const { result } = renderHook(() => useGlobalSearch({ phoneNumberIds: [A], debounceMs: 0 }));
    act(() => result.current.setSearchTerm("maria"));
    await waitFor(() => expect(chamadas()).toHaveLength(1));
    act(() => result.current.clear());
    expect(chamadas()[0].sinal.aborted).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("um array novo com os MESMOS números não muda a busca (a chave decide)", async () => {
    const { result, rerender } = renderHook(({ ids }) => useGlobalSearch({ phoneNumberIds: ids, debounceMs: 0 }), {
      initialProps: { ids: [A, B] },
    });
    const antes = result.current.retry;
    rerender({ ids: [B, A] });
    expect(result.current.retry).toBe(antes);
  });
});
