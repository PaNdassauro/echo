// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router-dom";

/**
 * Deep link com o hook REAL de números (React Query de verdade, supabase falso com
 * atraso de rede). O teste com o hook falso (Dashboard.numeroDoChat.test.tsx) não
 * enxerga o que muda depois de `await queryClient.refetchQueries`: ali não existe o
 * render "buscando", e os refs do Dashboard (linesReadyRef, linesByIdRef) ficam
 * como estavam. No app real, a continuação do await roda ANTES de o React Query
 * avisar os observadores (setTimeout 0): linesReadyRef ainda é false, e o mapa do
 * ref, o velho. Só o cache (`getQueryData`) está novo.
 *
 * A lista falsa tem o mesmo efeito de troca de número da real (o de escopo, em
 * ConversationsList.tsx): a cada troca do número selecionado ele roda, zera os
 * filtros e dispara a busca.
 *
 * Também cobre a busca do mapa que FALHA: a lista segue funcionando com o número
 * salvo, e o chat aberto por ela não pode ficar sem o id interno do número.
 */

afterEach(cleanup);

const h = vi.hoisted(() => ({
  ORG: { id: "org-1", name: "Org" },
  A: "11111111-aaaa",
  B: "22222222-bbbb",
  C: "33333333-cccc",
  D: "44444444-dddd",
  servidor: { numeros: [] as unknown[], falhar: false },
  atrasoRede: 25,
  conversas: {} as Record<string, unknown>,
  // Número selecionado de cada vez que o efeito de linha da lista rodou.
  efeitos: [] as Array<string | null>,
  // Referências ESTÁVEIS: `toast` está nas deps do effect do deep link, e um vi.fn() novo a
  // cada render o reiniciaria (e cancelaria a revalidação em voo) em todo render.
  setLine: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => {
  const espera = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const numeros = () => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.order = () => c;
    // `await` na consulta: devolve as linhas do "servidor" depois do atraso de rede.
    c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      espera(h.atrasoRede)
        .then(() =>
          h.servidor.falhar ? { data: null, error: { message: "banco fora" } } : { data: h.servidor.numeros, error: null },
        )
        .then(resolve, reject);
    return c;
  };
  const conversas = () => {
    const proprios: Array<[string, unknown]> = [];
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = (coluna: string, valor: unknown) => {
      proprios.push([coluna, valor]);
      return c;
    };
    c.maybeSingle = () => {
      const porId = proprios.find(([coluna]) => coluna === "id");
      const data = porId ? (h.conversas[porId[1] as string] ?? null) : null;
      return espera(5).then(() => ({ data, error: null }));
    };
    return c;
  };
  return {
    supabase: {
      auth: {
        getSession: () => Promise.resolve({ data: { session: { user: { id: "user-1", email: "a@x.com" } } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      },
      from: (tabela: string) => (tabela === "phone_numbers" ? numeros() : conversas()),
    },
  };
});

vi.mock("@/contexts/OrganizationContext", () => ({ useOrganization: () => ({ currentOrganization: h.ORG }) }));
vi.mock("@/contexts/VoiceCallContext", () => ({ useVoiceCalls: () => ({ setLine: h.setLine }) }));
vi.mock("@/hooks/usePhoneTheme", () => ({ usePhoneTheme: () => undefined }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/ResizableListColumn", () => ({
  ResizableListColumn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/layout", () => ({ BottomNavigation: () => null }));
vi.mock("@/components/feedback/FeedbackPopup", () => ({ FeedbackPopup: () => null }));
vi.mock("@/components/FeatureAnnouncementDialog", () => ({ default: () => null }));

vi.mock("@/components/ConversationsList", () => {
  const ListaFalsa = ({
    numeroUnico,
    onPhoneSelect,
    onSelectConversation,
  }: {
    numeroUnico: string | null;
    onPhoneSelect: (id: string) => void;
    onSelectConversation: (id: string, name?: string, lineId?: string | null) => void;
  }) => {
    const [filtroTag, setFiltroTag] = useState<string[]>([]);
    // Só a troca de número re-dispara, como o effect da lista real.
    useEffect(() => {
      h.efeitos.push(numeroUnico);
      setFiltroTag([]);
    }, [numeroUnico]);
    return (
      <div data-testid="lista" data-numero={numeroUnico ?? ""} data-filtro={filtroTag.join(",")}>
        <button onClick={() => setFiltroTag(["vip"])}>aplicar filtro</button>
        <button onClick={() => onPhoneSelect(h.B)}>escolher o número B</button>
        <button onClick={() => onSelectConversation("conv-a", "Alfa", h.A)}>abrir conversa do A</button>
        <button onClick={() => onSelectConversation("conv-b", "Beta", h.B)}>abrir conversa do B</button>
      </div>
    );
  };
  return { default: ListaFalsa };
});

vi.mock("@/components/ChatArea", () => ({
  default: (props: { conversationId: string | null; phoneNumberId?: string | null; phoneNumberDbId?: string | null }) => (
    <div
      data-testid="chat"
      data-conversa={props.conversationId ?? ""}
      data-numero={props.phoneNumberDbId ?? ""}
      data-meta={props.phoneNumberId ?? ""}
    />
  ),
}));

const { default: Dashboard } = await import("./Dashboard");

const linhaDoServidor = (id: string, nome: string, tipo: string, metaId: string) => ({
  id,
  display_name: nome,
  theme_hue: 176,
  phone_number: "5511",
  connection_type: tipo,
  phone_number_id: metaId,
  sector_isolation_enabled: false,
});

const conversaNoNumero = (id: string, numeroId: string, nome: string, metaId: string) => ({
  id,
  contact_name: `Contato ${id}`,
  phone_number_id: numeroId,
  phone_number: { id: numeroId, phone_number_id: metaId, theme_hue: 40, connection_type: "qr", display_name: nome },
});

let queryClient: QueryClient;
let navegar: NavigateFunction = () => undefined;
const Navegador = () => {
  navegar = useNavigate();
  return null;
};

const chaveSalva = `echo_last_phone_${h.ORG.id}`;
const user = userEvent.setup({ pointerEventsCheck: 0 });
const aguardar = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/** Monta o Dashboard em /dashboard e espera a lista no número A com o mapa de números assentado. */
async function montarNaLinhaA() {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Navegador />
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/dashboard/:conversationId" element={<Dashboard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.A));
  await aguardar(150);
}

beforeEach(() => {
  queryClient = new QueryClient();
  localStorage.clear();
  h.servidor.numeros = [
    linhaDoServidor(h.A, "Comercial", "business_api", "meta-a"),
    linhaDoServidor(h.B, "Suporte", "qr", "qr_222"),
  ];
  h.servidor.falhar = false;
  h.conversas = {};
  h.efeitos.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Dashboard: deep link com o mapa de números real", () => {
  it("conversa de linha fora do mapa (desativada): a lista nem passa por ela e os filtros ficam", async () => {
    localStorage.setItem(chaveSalva, h.A);
    h.conversas["conv-dl"] = conversaNoNumero("conv-dl", h.C, "Antiga", "qr_333");
    await montarNaLinhaA();
    await user.click(screen.getByRole("button", { name: "aplicar filtro" }));
    expect(screen.getByTestId("lista")).toHaveAttribute("data-filtro", "vip");
    h.efeitos.length = 0;

    act(() => navegar("/dashboard/conv-dl"));
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-dl"));
    await aguardar(150);

    // O chat abre pelo embed, no número da conversa.
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.C);
    // A lista segue onde estava: o efeito de linha (busca, skeleton, filtros zerados,
    // contagem de não-lido) não roda nem para a linha desativada nem de volta para a A.
    expect(h.efeitos).toEqual([]);
    expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.A);
    expect(screen.getByTestId("lista")).toHaveAttribute("data-filtro", "vip");
  });

  it("sem localStorage (modo privado), a conversa de linha fora do mapa não tira o atendente do número em que estava", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    h.conversas["conv-dl"] = conversaNoNumero("conv-dl", h.C, "Antiga", "qr_333");
    await montarNaLinhaA();
    await user.click(screen.getByRole("button", { name: "escolher o número B" }));
    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.B));
    h.efeitos.length = 0;

    act(() => navegar("/dashboard/conv-dl"));
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-dl"));
    await aguardar(150);

    // Sem número salvo a resolução cairia no PRIMEIRO (A) se a seleção passasse pela linha inválida.
    expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.B);
    expect(h.efeitos).toEqual([]);
  });

  it("linha liberada depois da última busca do mapa: revalida, e a lista termina nela sem voltar", async () => {
    localStorage.setItem(chaveSalva, h.A);
    h.conversas["conv-d"] = conversaNoNumero("conv-d", h.D, "Nova", "qr_444");
    await montarNaLinhaA();
    // Um admin libera a D depois de o Dashboard ter carregado o mapa.
    h.servidor.numeros = [...h.servidor.numeros, linhaDoServidor(h.D, "Nova", "qr", "qr_444")];
    h.efeitos.length = 0;

    act(() => navegar("/dashboard/conv-d"));
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-d"));
    await aguardar(200);

    expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.D);
    expect(h.efeitos).toEqual([h.D]);
    expect(localStorage.getItem(chaveSalva)).toBe(h.D);
  });

  it("conversa de linha que já está no mapa: a lista vai para o número dela, como sempre", async () => {
    localStorage.setItem(chaveSalva, h.A);
    h.conversas["conv-b"] = conversaNoNumero("conv-b", h.B, "Suporte", "qr_222");
    await montarNaLinhaA();
    h.efeitos.length = 0;

    act(() => navegar("/dashboard/conv-b"));
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));
    await aguardar(150);

    expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.B);
    expect(h.efeitos).toEqual([h.B]);
    expect(localStorage.getItem(chaveSalva)).toBe(h.B);
  });
});

describe("Dashboard: a busca do mapa de números falha na carga", () => {
  const chaveDoMapa = ["numeros-acessiveis", h.ORG.id];

  it("o chat aberto pela lista segue com o id interno do número selecionado, e o resto chega quando o mapa volta", async () => {
    // Sem espera entre o retry e a desistência (o hook pede 1 retry, com 1 s de atraso padrão).
    queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    localStorage.setItem(chaveSalva, h.A);
    h.servidor.falhar = true;
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/dashboard"]}>
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/dashboard/:conversationId" element={<Dashboard />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(queryClient.getQueryState(chaveDoMapa)?.status).toBe("error"));
    // A lista segue funcionando: busca pelo número salvo, que o mapa nem chegou a confirmar.
    expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.A);

    await user.click(screen.getByRole("button", { name: "abrir conversa do A" }));
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));

    // Texto, agendamento e botões de ação dependem só do id interno: sem ele o
    // envio falha com "phoneNumberId is required". O id da Meta espera pelo mapa.
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.A);
    expect(screen.getByTestId("chat")).toHaveAttribute("data-meta", "");

    // Conversa de OUTRO número: o id do selecionado não é o dela, e emprestá-lo
    // mandaria a mensagem pelo número errado sem dar erro.
    await user.click(screen.getByRole("button", { name: "abrir conversa do B" }));
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", "");

    // O banco volta: com o mapa, o chat ganha o id da Meta e o resto.
    h.servidor.falhar = false;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: chaveDoMapa, exact: true });
    });
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.B));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-meta", "qr_222");

    await user.click(screen.getByRole("button", { name: "abrir conversa do A" }));
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-meta", "meta-a"));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.A);
    erro.mockRestore();
  });
});
