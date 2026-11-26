import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * O placeholder {phone_number.display_name} sai do mapa de números acessíveis (o
 * hook real, com a busca falsa), sem uma consulta por número. Número fora do mapa
 * (desativado) cai na leitura pela PK, em cache e dividida com o `useSectors` do
 * mesmo chat (`useNumeroPorId`).
 */

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no
// seguinte.
afterEach(cleanup);

const h = vi.hoisted(() => ({
  // Leituras de `phone_numbers` pela PK (o id lido), na ordem, e o nome que cada uma devolve.
  consultasDeNumero: [] as string[],
  nomePorId: {} as Record<string, string>,
  // Números ativos que a busca do mapa devolve (colunas do banco).
  numeros: [] as Array<Record<string, unknown>>,
  // Segura a resposta do mapa até o teste liberar (primeira carga em voo).
  segurarMapa: false,
  liberarMapa: [] as Array<() => void>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const consulta = (tabela: string) => {
    const resultados: Record<string, unknown> = {
      organization_action_buttons: {
        data: [
          {
            id: "botao-1",
            position: 0,
            label: "Abrir no painel",
            button_type: "link",
            url: "https://painel.exemplo/{phone_number.display_name}/{phone_number.id}",
            icon: "link",
            is_active: true,
          },
        ],
        error: null,
      },
      action_button_phone_numbers: { data: [], error: null },
    };
    const c: Record<string, unknown> = {};
    let id: string | null = null;
    c.select = () => c;
    // O mapa termina no `order`; os botões também, e seguem aguardáveis pelo `then`.
    c.order = () => {
      if (tabela !== "phone_numbers") return c;
      const resposta = { data: h.numeros, error: null };
      if (!h.segurarMapa) return Promise.resolve(resposta);
      return new Promise((resolve) => h.liberarMapa.push(() => resolve(resposta)));
    };
    c.in = () => c;
    c.eq = (coluna: string, valor: string) => {
      if (tabela === "phone_numbers" && coluna === "id") {
        id = valor;
        h.consultasDeNumero.push(valor);
      }
      return c;
    };
    c.maybeSingle = () => {
      const nome = id ? h.nomePorId[id] : undefined;
      const data = nome ? { display_name: nome, sector_isolation_enabled: false } : null;
      return Promise.resolve({ data, error: null });
    };
    c.then = (resolver: (valor: unknown) => unknown, rejeitar?: (erro: unknown) => unknown) =>
      Promise.resolve(resultados[tabela] ?? { data: [], error: null }).then(resolver, rejeitar);
    return c;
  };
  return { supabase: { from: consulta, functions: { invoke: vi.fn() } } };
});

const { useActionButton } = await import("./useActionButton");

const linha = (id: string, displayName: string) => ({
  id,
  display_name: displayName,
  theme_hue: 176,
  phone_number: "",
  connection_type: "qr",
  phone_number_id: `qr_${id}`,
  sector_isolation_enabled: false,
});

const contexto = { conversationId: "conv-1", userId: "user-1" };

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

let abrir: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  h.consultasDeNumero.length = 0;
  h.nomePorId = {};
  h.numeros = [linha("A", "Comercial"), linha("B", "Suporte")];
  h.segurarMapa = false;
  h.liberarMapa.length = 0;
  abrir = vi.fn();
  vi.stubGlobal("open", abrir);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Clica no botão de link e confere a URL aberta, esperando o nome do número assentar. */
async function urlAbertaPeloBotao(phoneNumberDbId: string, esperada: string) {
  const { result } = renderHook(() => useActionButton({ organizationId: "org-1", phoneNumberDbId }), { wrapper });
  await waitFor(() => expect(result.current.buttons).toHaveLength(1));
  await waitFor(async () => {
    abrir.mockClear();
    await result.current.handleButtonClick(result.current.buttons[0], contexto);
    expect(abrir.mock.calls[0]?.[0]).toBe(esperada);
  });
}

describe("useActionButton: nome do número no link", () => {
  it("usa o nome do mapa e não consulta o banco por número", async () => {
    await urlAbertaPeloBotao("B", "https://painel.exemplo/Suporte/B");

    expect(h.consultasDeNumero).toEqual([]);
  });

  it("número fora do mapa (desativado) busca o nome pela PK, como antes", async () => {
    h.nomePorId = { X: "Linha antiga" };

    await urlAbertaPeloBotao("X", "https://painel.exemplo/Linha%20antiga/X");

    expect(h.consultasDeNumero).toEqual(["X"]);
  });

  it("enquanto o mapa não chegou, não dispara a consulta de reserva, e a dispara quando ele chega sem o número", async () => {
    h.segurarMapa = true;
    h.nomePorId = { X: "Linha antiga" };

    const { result } = renderHook(() => useActionButton({ organizationId: "org-1", phoneNumberDbId: "X" }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.buttons).toHaveLength(1));
    await act(async () => undefined);

    expect(h.consultasDeNumero).toEqual([]);

    await act(async () => h.liberarMapa.splice(0).forEach((liberar) => liberar()));

    await waitFor(() => expect(h.consultasDeNumero).toEqual(["X"]));
  });
});
