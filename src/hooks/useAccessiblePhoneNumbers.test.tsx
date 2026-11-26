import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * O mapa de números acessíveis é uma busca só por organização, compartilhada por
 * quem o lê. O que importa aqui: a chave é por organização (nada da org anterior
 * serve à nova), `isReady` só vale com a lista chegada e sem busca em voo,
 * invalidar a chave refaz a busca, e quem monta e desmonta muito pode desligar a
 * revalidação a cada montagem sem acordar os outros observadores. O mapa fica no
 * cache da sessão (sair do Dashboard por mais de 5 min não o apaga), e uma busca
 * que falhou se refaz sozinha a cada 30 s em vez de ficar em erro até alguém
 * trocar de aba.
 *
 * `useNumeroPorId` completa o mapa: o número que ele não lista (desativado) é lido
 * pela PK, uma vez para todos os consumidores, e só com o mapa pronto.
 */

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no
// seguinte.
afterEach(cleanup);

const h = vi.hoisted(() => ({
  pedidos: [] as string[],
  // Filtros de cada contagem de números (select head count), na ordem das chamadas.
  contagens: [] as Array<Array<[string, unknown]>>,
  contagemDeNumeros: 0 as number | null,
  falharContagem: false,
  falhar: false,
  // Libera a próxima resposta pendente, para o teste observar o "em voo".
  liberar: [] as Array<() => void>,
  segurar: false,
  linhasPorOrg: {} as Record<string, unknown[]>,
  // Leituras de `phone_numbers` pela PK (useNumeroPorId), na ordem, e o que cada id
  // responde (ausente = a RLS esconde a linha).
  leiturasPorPk: [] as string[],
  numerosPorPk: {} as Record<string, { display_name: string; sector_isolation_enabled: boolean; sector_follows_owner?: boolean }>,
  falharPk: false,
}));

vi.mock("@/integrations/supabase/client", () => {
  const consulta = () => {
    let organizacao = "";
    let idDaPk = "";
    const filtros: Array<[string, unknown]> = [];
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = (coluna: string, valor: string) => {
      filtros.push([coluna, valor]);
      if (coluna === "organization_id") organizacao = valor;
      if (coluna === "id") idDaPk = valor;
      return c;
    };
    c.maybeSingle = () => {
      h.leiturasPorPk.push(idDaPk);
      if (h.falharPk) return Promise.resolve({ data: null, error: new Error("falhou") });
      return Promise.resolve({ data: h.numerosPorPk[idDaPk] ?? null, error: null });
    };
    // A contagem termina no último `eq`, sem `order`: o `await` cai aqui.
    c.then = (resolver: (valor: unknown) => unknown, rejeitar?: (erro: unknown) => unknown) => {
      h.contagens.push(filtros);
      const resposta = h.falharContagem
        ? { count: null, error: new Error("falhou") }
        : { count: h.contagemDeNumeros, error: null };
      return Promise.resolve(resposta).then(resolver, rejeitar);
    };
    c.order = () => {
      h.pedidos.push(organizacao);
      const resposta = () =>
        h.falhar
          ? { data: null, error: new Error("falhou") }
          : { data: h.linhasPorOrg[organizacao] ?? [], error: null };
      if (!h.segurar) return Promise.resolve(resposta());
      return new Promise((resolve) => {
        h.liberar.push(() => resolve(resposta()));
      });
    };
    return c;
  };
  return { supabase: { from: consulta } };
});

const {
  useAccessiblePhoneNumbers,
  useNumeroPorId,
  numerosAcessiveisEmCache,
  contarNumerosAtivos,
  chaveNumerosAcessiveis,
  invalidarNumerosAcessiveis,
  NUMEROS_ACESSIVEIS_KEY,
} = await import("./useAccessiblePhoneNumbers");

const linhaDoBanco = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  display_name: `Número ${id}`,
  theme_hue: 195,
  phone_number: "+55 (11) 99999-0000",
  connection_type: "qr",
  phone_number_id: `qr_${id}`,
  sector_isolation_enabled: false,
  sector_follows_owner: false,
  ...extra,
});

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  // O hook pede 1 retry; sem espera entre as tentativas o teste de erro não demora.
  queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  h.pedidos.length = 0;
  h.contagens.length = 0;
  h.contagemDeNumeros = 0;
  h.falharContagem = false;
  h.falhar = false;
  h.segurar = false;
  h.liberar.length = 0;
  h.leiturasPorPk.length = 0;
  h.numerosPorPk = {};
  h.falharPk = false;
  h.linhasPorOrg = {
    "org-1": [linhaDoBanco("A"), linhaDoBanco("B", { sector_isolation_enabled: true, sector_follows_owner: true, connection_type: "business_api" })],
    "org-2": [linhaDoBanco("C")],
  };
});

describe("useAccessiblePhoneNumbers", () => {
  it("converte as linhas e traz o id da Meta, o isolamento por setor e o só quem assumiu vê", async () => {
    const { result } = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.phoneNumbers).toEqual([
      {
        id: "A",
        displayName: "Número A",
        themeHue: 195,
        phoneNumber: "5511999990000",
        connectionType: "qr",
        metaPhoneNumberId: "qr_A",
        sectorIsolationEnabled: false,
        sectorFollowsOwner: false,
      },
      {
        id: "B",
        displayName: "Número B",
        themeHue: 195,
        phoneNumber: "5511999990000",
        connectionType: "business_api",
        metaPhoneNumberId: "qr_B",
        sectorIsolationEnabled: true,
        sectorFollowsOwner: true,
      },
    ]);
    expect(result.current.isLoading).toBe(false);
  });

  it("um consumidor a mais não faz outra busca na mesma organização enquanto uma está em voo", async () => {
    h.segurar = true;
    const primeiro = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });
    const segundo = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });

    expect(primeiro.result.current.isLoading).toBe(true);
    expect(primeiro.result.current.isReady).toBe(false);
    expect(h.pedidos).toEqual(["org-1"]);

    await act(async () => h.liberar.splice(0).forEach((liberar) => liberar()));
    await waitFor(() => expect(segundo.result.current.isReady).toBe(true));
    expect(primeiro.result.current.phoneNumbers).toHaveLength(2);
    expect(h.pedidos).toEqual(["org-1"]);
  });

  it("trocar de organização não serve a lista da anterior nem fica pronto antes da nova chegar", async () => {
    const { result, rerender } = renderHook(({ org }) => useAccessiblePhoneNumbers(org), {
      wrapper,
      initialProps: { org: "org-1" },
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.phoneNumbers.map((n) => n.id)).toEqual(["A", "B"]);

    h.segurar = true;
    rerender({ org: "org-2" });

    expect(result.current.phoneNumbers).toEqual([]);
    expect(result.current.isReady).toBe(false);

    await act(async () => h.liberar.splice(0).forEach((liberar) => liberar()));
    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.phoneNumbers.map((n) => n.id)).toEqual(["C"]);
  });

  it("sem organização não busca nada e devolve sempre a mesma lista vazia", () => {
    const { result, rerender } = renderHook(() => useAccessiblePhoneNumbers(null), { wrapper });
    const primeira = result.current.phoneNumbers;

    rerender();

    expect(h.pedidos).toEqual([]);
    expect(result.current.isReady).toBe(false);
    expect(result.current.phoneNumbers).toBe(primeira);
  });

  it("desligado pelo segundo argumento também não busca", () => {
    renderHook(() => useAccessiblePhoneNumbers("org-1", false), { wrapper });

    expect(h.pedidos).toEqual([]);
  });

  it("erro na primeira carga deixa a lista vazia e o mapa fora de 'pronto', para ninguém tratar falha como org sem número", async () => {
    h.falhar = true;
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });

    await waitFor(() => expect(erro).toHaveBeenCalled());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.phoneNumbers).toEqual([]);
    expect(result.current.isReady).toBe(false);
    erro.mockRestore();
  });

  it("erro numa revalidação mantém a última lista boa e tira o mapa de 'pronto'", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });
    await waitFor(() => expect(result.current.isReady).toBe(true));

    h.falhar = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: NUMEROS_ACESSIVEIS_KEY });
    });
    // Com a busca em voo `isReady` já é falso: espera o erro assentar de verdade.
    await waitFor(() => expect(queryClient.getQueryState(chaveNumerosAcessiveis("org-1"))?.status).toBe("error"));

    // O chat aberto tira o id de envio dessa lista (resolveChatLine): perdê-la por
    // uma falha de rede passageira deixaria a conversa sem número.
    expect(result.current.phoneNumbers.map((n) => n.id)).toEqual(["A", "B"]);
    expect(result.current.isReady).toBe(false);
    expect(result.current.isLoading).toBe(false);
    erro.mockRestore();
  });

  it("invalidar o prefixo da chave refaz a busca e traz a mudança feita em Configurações", async () => {
    const { result } = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });
    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.phoneNumbers[0].themeHue).toBe(195);

    h.linhasPorOrg["org-1"] = [linhaDoBanco("A", { theme_hue: 40 })];
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: NUMEROS_ACESSIVEIS_KEY });
    });

    await waitFor(() => expect(result.current.phoneNumbers).toHaveLength(1));
    expect(result.current.phoneNumbers[0].themeHue).toBe(40);
    expect(h.pedidos).toEqual(["org-1", "org-1"]);
  });

  it("montar de novo revalida mesmo com a lista fresca, para pegar mudança de outro admin", async () => {
    const primeira = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });
    await waitFor(() => expect(primeira.result.current.isReady).toBe(true));
    primeira.unmount();

    h.linhasPorOrg["org-1"] = [linhaDoBanco("A", { display_name: "Renomeado" })];
    const segunda = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });

    // O que está em cache aparece na hora, mas ainda não conta como pronto.
    expect(segunda.result.current.isReady).toBe(false);
    await waitFor(() => expect(segunda.result.current.isReady).toBe(true));
    expect(segunda.result.current.phoneNumbers[0].displayName).toBe("Renomeado");
    expect(h.pedidos).toEqual(["org-1", "org-1"]);
  });

  it("o mapa fica no cache da sessão: passar de 5 min fora do Dashboard não o apaga, e voltar já o encontra", async () => {
    const primeiro = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });
    await waitFor(() => expect(primeiro.result.current.isReady).toBe(true));

    // O gcTime padrão agenda a remoção quando o último observador sai. O relógio
    // falso só entra agora, para capturar esse timer (e nenhum outro).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      primeiro.unmount();
      vi.advanceTimersByTime(5 * 60_000 + 1);
    } finally {
      vi.useRealTimers();
    }
    expect(numerosAcessiveisEmCache(queryClient, "org-1")?.map((numero) => numero.id)).toEqual(["A", "B"]);

    // A lista de conversas sobrevive à volta e o atendente clica nela antes do GET:
    // o chat precisa do número já na primeira renderização.
    h.segurar = true;
    const segunda = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });

    expect(segunda.result.current.isLoading).toBe(false);
    expect(segunda.result.current.phoneNumbers.map((numero) => numero.id)).toEqual(["A", "B"]);
    // Pintar o que está em cache não é decidir com ele: só fica pronto depois da revalidação.
    expect(segunda.result.current.isReady).toBe(false);

    await act(async () => h.liberar.splice(0).forEach((liberar) => liberar()));
    await waitFor(() => expect(segunda.result.current.isReady).toBe(true));
  });
});

describe("useAccessiblePhoneNumbers: busca que falhou", () => {
  // Só o intervalo é falso: o `waitFor` do Testing Library também sonda por
  // setInterval, então com este relógio a espera é o mesmo laço com setTimeout.
  const esperarAte = async (condicao: () => boolean, limiteMs = 2000) => {
    const inicio = Date.now();
    while (!condicao() && Date.now() - inicio < limiteMs) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  };
  const status = () => queryClient.getQueryState(chaveNumerosAcessiveis("org-1"))?.status;
  const passar30s = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refaz sozinha a cada 30 s enquanto falha, e fica pronta quando o banco volta, sem foco nem remontagem", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.falhar = true;
    const { result } = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });
    await esperarAte(() => status() === "error");

    // O retry (1) já gastou: a busca desistiu, e o mapa não está pronto.
    expect(status()).toBe("error");
    expect(result.current.isReady).toBe(false);
    const aoDesistir = h.pedidos.length;

    // Um ciclo com o banco ainda fora: tenta de novo e segue em erro.
    await passar30s();
    await esperarAte(() => h.pedidos.length > aoDesistir && status() === "error");
    expect(h.pedidos.length).toBeGreaterThan(aoDesistir);
    expect(status()).toBe("error");
    expect(result.current.isReady).toBe(false);

    // O banco volta: o ciclo seguinte recupera o mapa.
    h.falhar = false;
    await passar30s();
    await esperarAte(() => result.current.isReady);
    expect(status()).toBe("success");
    expect(result.current.isReady).toBe(true);
    expect(result.current.phoneNumbers.map((numero) => numero.id)).toEqual(["A", "B"]);

    // Com o mapa bom não há intervalo: nenhuma busca a mais.
    const aoRecuperar = h.pedidos.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    await esperarAte(() => false, 30);
    expect(h.pedidos).toHaveLength(aoRecuperar);
    erro.mockRestore();
  });

  it("mapa que carregou bem nunca entra no intervalo", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { result } = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });
    await esperarAte(() => result.current.isReady);
    expect(result.current.isReady).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    await esperarAte(() => false, 30);

    expect(h.pedidos).toEqual(["org-1"]);
  });
});

describe("invalidarNumerosAcessiveis", () => {
  it("refaz o mapa e a leitura de reserva por id, as duas sob o mesmo prefixo", async () => {
    h.numerosPorPk = { X: { display_name: "Linha antiga", sector_isolation_enabled: false } };
    const { result } = renderHook(() => useNumeroPorId("org-1", "X"), { wrapper });
    await waitFor(() =>
      expect(result.current.linha).toEqual({ displayName: "Linha antiga", sectorIsolationEnabled: false, sectorFollowsOwner: false }),
    );
    expect(h.pedidos).toEqual(["org-1"]);
    expect(h.leiturasPorPk).toEqual(["X"]);

    // O que Configurações faz depois de gravar a linha.
    h.numerosPorPk = { X: { display_name: "Renomeada", sector_isolation_enabled: true } };
    await act(async () => {
      await invalidarNumerosAcessiveis(queryClient);
    });

    await waitFor(() =>
      expect(result.current.linha).toEqual({ displayName: "Renomeada", sectorIsolationEnabled: true, sectorFollowsOwner: false }),
    );
    expect(h.pedidos).toEqual(["org-1", "org-1"]);
    expect(h.leiturasPorPk).toEqual(["X", "X"]);
  });
});

describe("useAccessiblePhoneNumbers: revalidarAoMontar desligado", () => {
  const useSemRevalidar = () => useAccessiblePhoneNumbers("org-1", true, { revalidarAoMontar: false });

  it("com a lista fresca, montar não busca de novo nem acorda o outro observador", async () => {
    let renders = 0;
    const principal = renderHook(
      () => {
        renders += 1;
        return useAccessiblePhoneNumbers("org-1");
      },
      { wrapper },
    );
    await waitFor(() => expect(principal.result.current.isReady).toBe(true));
    const pedidos = h.pedidos.length;
    const rendersAntes = renders;

    // O chat do mobile monta a cada conversa aberta: cada GET renderizaria o Dashboard.
    const quieto = renderHook(useSemRevalidar, { wrapper });
    await act(async () => undefined);

    expect(quieto.result.current.phoneNumbers).toHaveLength(2);
    expect(quieto.result.current.isReady).toBe(true);
    expect(h.pedidos).toHaveLength(pedidos);
    expect(renders).toBe(rendersAntes);
    expect(principal.result.current.isReady).toBe(true);
  });

  it("o padrão (ligado) busca de novo ao montar e acorda o outro observador, que é o que o Dashboard quer", async () => {
    let renders = 0;
    const principal = renderHook(
      () => {
        renders += 1;
        return useAccessiblePhoneNumbers("org-1");
      },
      { wrapper },
    );
    await waitFor(() => expect(principal.result.current.isReady).toBe(true));
    const pedidos = h.pedidos.length;
    const rendersAntes = renders;

    renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });

    await waitFor(() => expect(h.pedidos).toHaveLength(pedidos + 1));
    await waitFor(() => expect(principal.result.current.isReady).toBe(true));
    expect(renders).toBeGreaterThan(rendersAntes);
  });

  it("invalidar a chave ainda refaz a busca para ele", async () => {
    const quieto = renderHook(useSemRevalidar, { wrapper });
    await waitFor(() => expect(quieto.result.current.isReady).toBe(true));
    expect(h.pedidos).toEqual(["org-1"]);

    h.linhasPorOrg["org-1"] = [linhaDoBanco("A", { display_name: "Renomeado" })];
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: NUMEROS_ACESSIVEIS_KEY });
    });

    await waitFor(() => expect(quieto.result.current.phoneNumbers[0]?.displayName).toBe("Renomeado"));
    expect(h.pedidos).toEqual(["org-1", "org-1"]);
  });

  it("com a lista velha (passou o staleTime), ele também busca ao montar", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const primeiro = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });
      await waitFor(() => expect(primeiro.result.current.isReady).toBe(true));
      primeiro.unmount();

      // Passam 6 min: a lista em cache já é mais velha que o staleTime de 5.
      vi.setSystemTime(Date.now() + 6 * 60_000);
      h.linhasPorOrg["org-1"] = [linhaDoBanco("A", { display_name: "Depois de 6 min" })];
      const quieto = renderHook(useSemRevalidar, { wrapper });

      await waitFor(() => expect(h.pedidos).toHaveLength(2));
      await waitFor(() => expect(quieto.result.current.phoneNumbers[0]?.displayName).toBe("Depois de 6 min"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useNumeroPorId", () => {
  // O mapa só lista números ativos: o X é um número DESATIVADO, que só a PK enxerga.
  const linhaDoX = { displayName: "Linha antiga", sectorIsolationEnabled: true, sectorFollowsOwner: false };

  beforeEach(() => {
    h.numerosPorPk = { X: { display_name: "Linha antiga", sector_isolation_enabled: true } };
  });

  /** Libera as respostas do mapa que o teste segurou (`h.segurar`). */
  const liberarMapa = () => act(async () => h.liberar.splice(0).forEach((liberar) => liberar()));

  it("número que está no mapa vem do mapa, sem leitura pela PK", async () => {
    const { result } = renderHook(() => useNumeroPorId("org-1", "B"), { wrapper });

    await waitFor(() => expect(result.current.linha).toMatchObject({ displayName: "Número B", sectorIsolationEnabled: true }));
    await act(async () => undefined);

    expect(result.current.isLoading).toBe(false);
    expect(h.leiturasPorPk).toEqual([]);
  });

  it("número fora do mapa (desativado) é lido pela PK, uma vez só mesmo com dois consumidores", async () => {
    const primeiro = renderHook(() => useNumeroPorId("org-1", "X"), { wrapper });
    const segundo = renderHook(() => useNumeroPorId("org-1", "X"), { wrapper });

    await waitFor(() => expect(primeiro.result.current.linha).toEqual(linhaDoX));
    await waitFor(() => expect(segundo.result.current.linha).toEqual(linhaDoX));

    expect(h.leiturasPorPk).toEqual(["X"]);
  });

  it("com o mapa ainda carregando não lê a PK, e lê quando ele chega sem o número", async () => {
    h.segurar = true;
    const { result } = renderHook(() => useNumeroPorId("org-1", "X"), { wrapper });
    await act(async () => undefined);

    expect(result.current.isLoading).toBe(true);
    expect(result.current.linha).toBeUndefined();
    expect(h.leiturasPorPk).toEqual([]);

    await liberarMapa();

    await waitFor(() => expect(result.current.linha).toEqual(linhaDoX));
    expect(h.leiturasPorPk).toEqual(["X"]);
  });

  it("revalidar só o mapa não repete a leitura enquanto o dado da PK está fresco", async () => {
    // A mesma passagem por "buscando" que o foco da janela, o montar de novo e o deep link provocam.
    const mapaPronto: boolean[] = [];
    const { result } = renderHook(
      () => {
        mapaPronto.push(useAccessiblePhoneNumbers("org-1", true, { revalidarAoMontar: false }).isReady);
        return useNumeroPorId("org-1", "X");
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.linha).toEqual(linhaDoX));
    expect(h.leiturasPorPk).toEqual(["X"]);

    h.segurar = true;
    let refazendo: Promise<unknown> = Promise.resolve();
    act(() => {
      refazendo = queryClient.refetchQueries({ queryKey: chaveNumerosAcessiveis("org-1"), exact: true });
    });
    // Sem passar por um render "buscando" o caso passaria sem provar nada.
    await waitFor(() => expect(mapaPronto[mapaPronto.length - 1]).toBe(false));
    await liberarMapa();
    await act(async () => {
      await refazendo;
    });
    await waitFor(() => expect(mapaPronto[mapaPronto.length - 1]).toBe(true));

    expect(h.pedidos).toEqual(["org-1", "org-1"]);
    expect(h.leiturasPorPk).toEqual(["X"]);
  });

  it("invalidar o prefixo do mapa (Configurações) refaz a leitura, e a edição chega", async () => {
    const { result } = renderHook(() => useNumeroPorId("org-1", "X"), { wrapper });
    await waitFor(() => expect(result.current.linha).toEqual(linhaDoX));

    h.numerosPorPk = { X: { display_name: "Renomeada", sector_isolation_enabled: false } };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: NUMEROS_ACESSIVEIS_KEY });
    });

    await waitFor(() => expect(result.current.linha).toEqual({ displayName: "Renomeada", sectorIsolationEnabled: false, sectorFollowsOwner: false }));
    expect(h.leiturasPorPk).toEqual(["X", "X"]);
  });

  it("falha na leitura registra o erro e deixa o número indefinido, sem derrubar o chat", async () => {
    h.falharPk = true;
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useNumeroPorId("org-1", "X"), { wrapper });

    await waitFor(() => expect(erro).toHaveBeenCalledWith("[useNumeroPorId] Falha ao ler o número:", expect.any(Error)));

    expect(result.current.linha).toBeUndefined();
    erro.mockRestore();
  });

  it("número que nem a PK mostra (a RLS o esconde) fica indefinido", async () => {
    const { result } = renderHook(() => useNumeroPorId("org-1", "escondido"), { wrapper });

    await waitFor(() => expect(h.leiturasPorPk).toEqual(["escondido"]));
    await act(async () => undefined);

    expect(result.current.linha).toBeUndefined();
  });

  it("trocar para outro número fora do mapa não serve os dados do anterior", async () => {
    h.numerosPorPk = { ...h.numerosPorPk, Y: { display_name: "Outra", sector_isolation_enabled: false } };
    const { result, rerender } = renderHook(({ numero }) => useNumeroPorId("org-1", numero), {
      wrapper,
      initialProps: { numero: "X" as string | null },
    });
    await waitFor(() => expect(result.current.linha).toEqual(linhaDoX));

    rerender({ numero: "Y" });

    // Na mesma hora, antes da leitura do novo: o dado guardado é do outro número.
    expect(result.current.linha).toBeUndefined();
    await waitFor(() => expect(result.current.linha).toEqual({ displayName: "Outra", sectorIsolationEnabled: false, sectorFollowsOwner: false }));

    rerender({ numero: null });
    expect(result.current.linha).toBeUndefined();
    expect(h.leiturasPorPk).toEqual(["X", "Y"]);
  });
});

describe("numerosAcessiveisEmCache", () => {
  it("devolve o mapa que está no cache da organização, e null antes de ele carregar", async () => {
    expect(numerosAcessiveisEmCache(queryClient, "org-1")).toBeNull();

    const { result } = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });
    await waitFor(() => expect(result.current.isReady).toBe(true));

    expect(numerosAcessiveisEmCache(queryClient, "org-1")?.map((numero) => numero.id)).toEqual(["A", "B"]);
    // Cada organização tem o seu: o de uma não serve à outra, nem à ausência de organização.
    expect(numerosAcessiveisEmCache(queryClient, "org-2")).toBeNull();
    expect(numerosAcessiveisEmCache(queryClient, null)).toBeNull();
  });

  it("já traz a lista nova na continuação de `await refetchQueries`", async () => {
    // É o que o deep link do Dashboard precisa: os observadores do React Query são
    // avisados depois (num setTimeout), então o que o hook entregou ao render ainda
    // pode ser a lista velha quando a continuação roda. O cache já está novo.
    const { result } = renderHook(() => useAccessiblePhoneNumbers("org-1"), { wrapper });
    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(numerosAcessiveisEmCache(queryClient, "org-1")).toHaveLength(2);

    h.linhasPorOrg["org-1"] = [linhaDoBanco("A"), linhaDoBanco("B"), linhaDoBanco("C")];
    let doCache: string[] = [];
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: chaveNumerosAcessiveis("org-1"), exact: true });
      doCache = (numerosAcessiveisEmCache(queryClient, "org-1") ?? []).map((numero) => numero.id);
    });

    expect(doCache).toEqual(["A", "B", "C"]);
    await waitFor(() => expect(result.current.phoneNumbers).toHaveLength(3));
  });
});

describe("contarNumerosAtivos", () => {
  it("conta só os números ativos da organização", async () => {
    h.contagemDeNumeros = 3;

    await expect(contarNumerosAtivos("org-1")).resolves.toBe(3);

    // O mesmo recorte do mapa: org + is_active. Sem o is_active, uma org só com
    // números desativados contaria > 0 e a lista esperaria para sempre.
    expect(h.contagens).toEqual([
      [
        ["organization_id", "org-1"],
        ["is_active", true],
      ],
    ]);
  });

  it("org sem número ativo conta zero", async () => {
    h.contagemDeNumeros = 0;

    await expect(contarNumerosAtivos("org-1")).resolves.toBe(0);
  });

  it("falha na consulta devolve null e registra o erro", async () => {
    h.falharContagem = true;
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(contarNumerosAtivos("org-1")).resolves.toBeNull();

    expect(erro).toHaveBeenCalledTimes(1);
    erro.mockRestore();
  });
});
