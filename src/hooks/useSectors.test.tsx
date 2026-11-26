import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Setores são da ORGANIZAÇÃO: trocar de número não pode refazer as consultas
 * delas, e o isolamento por setor vem do mapa de números acessíveis (o hook real,
 * com a busca falsa). Só o número que o mapa não lista (desativado, aberto por deep
 * link) cai na leitura pela PK, e essa é uma query só, em cache (`useNumeroPorId`).
 */

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no
// seguinte.
afterEach(cleanup);

const h = vi.hoisted(() => ({
  // Consultas das tabelas da ORGANIZAÇÃO (setores, vínculos, setor padrão), uma por chamada.
  tabelas: [] as string[],
  // Números ativos que a busca do mapa devolve (colunas do banco), e quantas vezes ela rodou.
  numeros: [] as Array<{ id: string; sector_isolation_enabled: boolean } & Record<string, unknown>>,
  pedidosDoMapa: 0,
  // Segura a resposta do mapa até o teste liberar (primeira carga em voo).
  segurarMapa: false,
  liberarMapa: [] as Array<() => void>,
  // Leituras de `phone_numbers` pela PK, e o que cada PK responde (ausente = linha que a RLS não mostra).
  leiturasPorPk: [] as string[],
  isolamentoPorPk: {} as Record<string, boolean>,
  erroNaPk: false,
  org: { id: "org-1" },
}));

vi.mock("@/integrations/supabase/client", () => {
  const consulta = (tabela: string) => {
    if (tabela !== "phone_numbers") h.tabelas.push(tabela);
    let id: string | null = null;
    const resultado = (): Promise<unknown> => {
      if (tabela === "phone_numbers") {
        if (id === null) {
          // O mapa: os números ativos da organização.
          h.pedidosDoMapa += 1;
          const resposta = { data: h.numeros, error: null };
          if (!h.segurarMapa) return Promise.resolve(resposta);
          return new Promise((resolve) => h.liberarMapa.push(() => resolve(resposta)));
        }
        if (h.erroNaPk) return Promise.resolve({ data: null, error: new Error("falhou") });
        const achada = id in h.isolamentoPorPk;
        const data = achada ? { display_name: id, sector_isolation_enabled: h.isolamentoPorPk[id] } : null;
        return Promise.resolve({ data, error: null });
      }
      return Promise.resolve({ data: tabela === "organization_members" ? null : [], error: null });
    };
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = (coluna: string, valor: string) => {
      if (tabela === "phone_numbers" && coluna === "id") {
        id = valor;
        h.leiturasPorPk.push(valor);
      }
      return c;
    };
    c.order = () => resultado();
    c.maybeSingle = () => resultado();
    // `sector_members` termina no `eq`, então a consulta também precisa ser aguardável.
    c.then = (resolver: (valor: unknown) => unknown, rejeitar?: (erro: unknown) => unknown) =>
      resultado().then(resolver, rejeitar);
    return c;
  };
  return { supabase: { from: consulta, functions: { invoke: vi.fn() } } };
});

vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ currentOrganization: h.org }),
}));

const { useSectors } = await import("./useSectors");
const { useActionButton } = await import("./useActionButton");
const { chaveNumerosAcessiveis } = await import("./useAccessiblePhoneNumbers");

const linha = (id: string, sectorIsolationEnabled: boolean) => ({
  id,
  display_name: id,
  theme_hue: 176,
  phone_number: "",
  connection_type: "qr",
  phone_number_id: `qr_${id}`,
  sector_isolation_enabled: sectorIsolationEnabled,
});

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  // A leitura de reserva pede 1 retry; sem espera entre as tentativas o teste de erro não demora.
  queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  h.tabelas.length = 0;
  h.pedidosDoMapa = 0;
  h.segurarMapa = false;
  h.liberarMapa.length = 0;
  h.leiturasPorPk.length = 0;
  h.isolamentoPorPk = {};
  h.erroNaPk = false;
  h.numeros = [linha("A", false), linha("B", true)];
});

describe("useSectors", () => {
  it("trocar só o número não refaz as consultas da organização", async () => {
    const { result, rerender } = renderHook(({ numero }) => useSectors(numero, "user-1"), {
      wrapper,
      initialProps: { numero: "A" as string | null },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const consultasIniciais = h.tabelas.length;
    expect(h.tabelas).toEqual(expect.arrayContaining(["sectors", "sector_members", "organization_members"]));
    // O isolamento vem do mapa, buscado uma vez: nenhuma leitura própria por número.
    expect(h.pedidosDoMapa).toBe(1);
    expect(h.leiturasPorPk).toEqual([]);

    rerender({ numero: "B" });
    rerender({ numero: null });
    rerender({ numero: "A" });
    await act(async () => undefined);

    expect(h.tabelas).toHaveLength(consultasIniciais);
    expect(h.pedidosDoMapa).toBe(1);
    expect(h.leiturasPorPk).toEqual([]);
  });

  it("o isolamento acompanha o número escolhido, lido do mapa", async () => {
    const { result, rerender } = renderHook(({ numero }) => useSectors(numero, "user-1"), {
      wrapper,
      initialProps: { numero: "A" as string | null },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isolationEnabled).toBe(false);

    rerender({ numero: "B" });
    expect(result.current.isolationEnabled).toBe(true);

    rerender({ numero: null });
    expect(result.current.isolationEnabled).toBe(false);
  });

  it("número fora do mapa (desativado), com o mapa pronto, lê a flag pela PK: o chat não perde o 'Encaminhar para setor'", async () => {
    h.isolamentoPorPk = { desativada: true };
    const { result } = renderHook(() => useSectors("desativada", "user-1"), { wrapper });

    await waitFor(() => expect(result.current.isolationEnabled).toBe(true));
    expect(h.leiturasPorPk).toEqual(["desativada"]);
  });

  it("número fora do mapa que a PK também não mostra conta como sem isolamento, em vez de abrir ou travar a tela", async () => {
    const { result } = renderHook(() => useSectors("desconhecido", "user-1"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(h.leiturasPorPk).toEqual(["desconhecido"]));
    await act(async () => undefined);

    expect(result.current.isolationEnabled).toBe(false);
  });

  it("com o mapa ainda carregando não lê a PK e conta como sem isolamento, e lê quando ele chega sem o número", async () => {
    h.segurarMapa = true;
    h.isolamentoPorPk = { desativada: true };
    const { result } = renderHook(() => useSectors("desativada", "user-1"), { wrapper });
    await waitFor(() => expect(h.tabelas).toContain("sectors"));
    await act(async () => undefined);

    expect(h.leiturasPorPk).toEqual([]);
    expect(result.current.isolationEnabled).toBe(false);

    await act(async () => h.liberarMapa.splice(0).forEach((liberar) => liberar()));

    await waitFor(() => expect(result.current.isolationEnabled).toBe(true));
    expect(h.leiturasPorPk).toEqual(["desativada"]);
  });

  it("falha na leitura pela PK registra o erro e conta como sem isolamento", async () => {
    h.erroNaPk = true;
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useSectors("desativada", "user-1"), { wrapper });

    await waitFor(() => expect(erro).toHaveBeenCalled());

    expect(result.current.isolationEnabled).toBe(false);
    erro.mockRestore();
  });

  it("o chat inteiro (setores e botões de ação do mesmo número) lê a PK de um número fora do mapa uma vez só", async () => {
    h.isolamentoPorPk = { desativada: true };
    const { result } = renderHook(
      () => ({
        setores: useSectors("desativada", "user-1"),
        botoes: useActionButton({ organizationId: h.org.id, phoneNumberDbId: "desativada" }),
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.setores.isolationEnabled).toBe(true));
    await waitFor(() => expect(result.current.botoes.isLoading).toBe(false));
    await act(async () => undefined);

    // Antes eram duas, uma por hook, repetidas a cada revalidação do mapa.
    expect(h.leiturasPorPk).toEqual(["desativada"]);
  });

  it("trocar para outro número fora do mapa não serve a flag do anterior", async () => {
    h.isolamentoPorPk = { desativada: true, outra: false };
    const { result, rerender } = renderHook(({ numero }) => useSectors(numero, "user-1"), {
      wrapper,
      initialProps: { numero: "desativada" as string | null },
    });
    await waitFor(() => expect(result.current.isolationEnabled).toBe(true));

    rerender({ numero: "outra" });

    // Na mesma hora, antes da leitura da nova: o valor guardado é de outro número.
    expect(result.current.isolationEnabled).toBe(false);
    await waitFor(() => expect(h.leiturasPorPk).toEqual(["desativada", "outra"]));
  });

  it("número que entra no mapa depois passa a valer pelo mapa, sem outra leitura", async () => {
    h.numeros = [linha("A", false)];
    h.isolamentoPorPk = { B: false };
    const { result } = renderHook(() => useSectors("B", "user-1"), { wrapper });
    await waitFor(() => expect(h.leiturasPorPk).toEqual(["B"]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isolationEnabled).toBe(false);

    // Um admin libera a B e o mapa é refeito (o deep link faz isso): agora vale a flag dele.
    h.numeros = [linha("A", false), linha("B", true)];
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: chaveNumerosAcessiveis(h.org.id), exact: true });
    });

    await waitFor(() => expect(result.current.isolationEnabled).toBe(true));
    expect(h.leiturasPorPk).toEqual(["B"]);
  });

  it("trocar de usuário refaz as consultas, e o refresh também", async () => {
    const { result, rerender } = renderHook(({ usuario }) => useSectors("A", usuario), {
      wrapper,
      initialProps: { usuario: "user-1" },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const consultasIniciais = h.tabelas.length;

    rerender({ usuario: "user-2" });
    await waitFor(() => expect(h.tabelas.length).toBeGreaterThan(consultasIniciais));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const aposTroca = h.tabelas.length;

    result.current.refresh();
    await waitFor(() => expect(h.tabelas.length).toBeGreaterThan(aposTroca));
  });
});
