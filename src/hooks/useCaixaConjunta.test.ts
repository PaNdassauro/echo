import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chaveForaDaCaixa, chaveModoDaCaixa, lerForaDaCaixa, useCaixaConjunta } from "./useCaixaConjunta";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("lerForaDaCaixa", () => {
  it("lê a lista de uuids", () => {
    expect(lerForaDaCaixa(JSON.stringify([A, B]))).toEqual([A, B]);
  });

  it.each([null, "", "isso não é json", "{}", JSON.stringify(["não-é-uuid"]), JSON.stringify([A, 3])])(
    "valor fora do contrato (%s) vira lista vazia",
    (bruto) => {
      expect(lerForaDaCaixa(bruto)).toEqual([]);
    },
  );
});

describe("useCaixaConjunta", () => {
  it("sem nada guardado: modo número e nenhuma exclusão", () => {
    const { result } = renderHook(() => useCaixaConjunta(ORG, USER));
    expect(result.current.modo).toBe("numero");
    expect(result.current.fora).toEqual([]);
  });

  it("já nasce no modo guardado, no primeiro render (montagem nova por clique em push)", () => {
    localStorage.setItem(chaveModoDaCaixa(USER, ORG), "conjunta");
    localStorage.setItem(chaveForaDaCaixa(USER, ORG), JSON.stringify([B]));
    const modos: string[] = [];
    renderHook(() => {
      const caixa = useCaixaConjunta(ORG, USER);
      modos.push(caixa.modo);
      return caixa;
    });
    expect(modos[0]).toBe("conjunta");
  });

  it("usuário que chega depois do primeiro render (getSession assíncrono) relê a escolha dele", () => {
    localStorage.setItem(chaveModoDaCaixa(USER, ORG), "conjunta");
    const { result, rerender } = renderHook(({ user }) => useCaixaConjunta(ORG, user), {
      initialProps: { user: null as string | null },
    });
    expect(result.current.modo).toBe("numero");
    rerender({ user: USER });
    expect(result.current.modo).toBe("conjunta");
  });

  it("escolher a conjunta e voltar ao número grava e remove só a chave do modo", () => {
    localStorage.setItem(`echo_last_phone_${ORG}`, A);
    const { result } = renderHook(() => useCaixaConjunta(ORG, USER));

    act(() => result.current.escolherConjunta());
    expect(result.current.modo).toBe("conjunta");
    expect(localStorage.getItem(chaveModoDaCaixa(USER, ORG))).toBe("conjunta");

    act(() => result.current.escolherNumero());
    expect(result.current.modo).toBe("numero");
    expect(localStorage.getItem(chaveModoDaCaixa(USER, ORG))).toBeNull();
    // O último número nunca é tocado (e nunca recebe o sentinela).
    expect(localStorage.getItem(`echo_last_phone_${ORG}`)).toBe(A);
  });

  it("salva e limpa as exclusões", () => {
    const { result } = renderHook(() => useCaixaConjunta(ORG, USER));
    act(() => result.current.salvarFora([B, B]));
    expect(result.current.fora).toEqual([B]);
    expect(JSON.parse(localStorage.getItem(chaveForaDaCaixa(USER, ORG)) ?? "null")).toEqual([B]);

    act(() => result.current.salvarFora([]));
    expect(result.current.fora).toEqual([]);
    expect(localStorage.getItem(chaveForaDaCaixa(USER, ORG))).toBeNull();
  });

  it("a escolha é por usuário e por organização", () => {
    localStorage.setItem(chaveModoDaCaixa(USER, ORG), "conjunta");
    const { result } = renderHook(() => useCaixaConjunta(ORG, "outro-usuario"));
    expect(result.current.modo).toBe("numero");
  });

  it("acompanha a outra aba pelo evento storage", () => {
    const { result } = renderHook(() => useCaixaConjunta(ORG, USER));
    localStorage.setItem(chaveModoDaCaixa(USER, ORG), "conjunta");
    localStorage.setItem(chaveForaDaCaixa(USER, ORG), JSON.stringify([A]));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: chaveModoDaCaixa(USER, ORG) }));
    });
    expect(result.current.modo).toBe("conjunta");
    expect(result.current.fora).toEqual([A]);
  });

  it("ignora o evento storage de outra chave", () => {
    const { result } = renderHook(() => useCaixaConjunta(ORG, USER));
    localStorage.setItem(chaveModoDaCaixa(USER, ORG), "conjunta");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "outra_chave" }));
    });
    expect(result.current.modo).toBe("numero");
  });

  it("sem localStorage (lança) não quebra: vale só na sessão", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("negado");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("negado");
    });
    const { result } = renderHook(() => useCaixaConjunta(ORG, USER));
    expect(result.current.modo).toBe("numero");
    act(() => result.current.escolherConjunta());
    expect(result.current.modo).toBe("conjunta");
    act(() => result.current.salvarFora([A]));
    expect(result.current.fora).toEqual([A]);
  });

  it("salvar as exclusões e ligar a conjunta no mesmo handler: um não desfaz o outro", () => {
    const { result } = renderHook(() => useCaixaConjunta(ORG, USER));
    act(() => result.current.salvarFora([B]));
    act(() => {
      result.current.salvarFora([]);
      result.current.escolherConjunta();
    });
    expect(result.current.fora).toEqual([]);
    expect(result.current.modo).toBe("conjunta");
  });

  it("referência de `fora` estável quando o conteúdo não muda", () => {
    const { result } = renderHook(() => useCaixaConjunta(ORG, USER));
    act(() => result.current.salvarFora([A]));
    const antes = result.current.fora;
    act(() => result.current.salvarFora([A]));
    expect(result.current.fora).toBe(antes);
  });
});
