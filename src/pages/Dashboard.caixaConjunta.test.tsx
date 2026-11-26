// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { conversationListCache, MAX_LINES } from "@/lib/conversationListCache";

/**
 * Caixa conjunta no Dashboard: o escopo da lista, o modo guardado neste aparelho, o
 * deep link que NUNCA troca a seleção na conjunta, o tema e a ligação que seguem a
 * conversa aberta. O Dashboard é real; a lista, o chat e o diálogo são falsos.
 */

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no
// seguinte.
afterEach(cleanup);

const h = vi.hoisted(() => {
  const linhas = {
    valor: { phoneNumbers: [] as unknown[], isLoading: false, isReady: false } as { phoneNumbers: unknown[]; isLoading: boolean; isReady: boolean; isError?: boolean },
    ouvintes: new Set<() => void>(),
  };
  return {
    ORG: { id: "org-1", name: "Org" },
    LINHA_A: "11111111-aaaa-4aaa-8aaa-111111111111",
    LINHA_B: "22222222-bbbb-4bbb-8bbb-222222222222",
    LINHA_C: "33333333-cccc-4ccc-8ccc-333333333333",
    linhas,
    definirLinhas(proximo: typeof linhas.valor) {
      linhas.valor = proximo;
      linhas.ouvintes.forEach((ouvinte) => ouvinte());
    },
    setLine: vi.fn(),
    tema: vi.fn(),
    toast: vi.fn(),
    // Conversas que o deep link encontra, por id.
    conversas: {} as Record<string, unknown>,
    eqs: [] as Array<[string, unknown]>,
    // O que o Dashboard gravou em `conversations` ao criar uma conversa nova.
    inseridos: [] as Array<Record<string, unknown>>,
    // O escopo (o array em si) que a lista falsa recebeu a cada render.
    escopos: [] as Array<readonly string[]>,
  };
});

vi.mock("@/integrations/supabase/client", () => {
  const consulta = () => {
    const proprios: Array<[string, unknown]> = [];
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = (coluna: string, valor: unknown) => {
      proprios.push([coluna, valor]);
      h.eqs.push([coluna, valor]);
      return c;
    };
    c.in = () => c;
    c.limit = () => c;
    // Criar a conversa: insert(...).select('id').single().
    c.insert = (payload: Record<string, unknown>) => {
      h.inseridos.push(payload);
      return c;
    };
    c.single = () => Promise.resolve({ data: { id: "conv-nova" }, error: null });
    c.maybeSingle = () => {
      const porId = proprios.find(([coluna]) => coluna === "id");
      const data = porId ? (h.conversas[porId[1] as string] ?? null) : null;
      return Promise.resolve({ data, error: null });
    };
    return c;
  };
  return {
    supabase: {
      // conversa_do_telefone_na_linha: nenhuma conversa existente.
      rpc: () => Promise.resolve({ data: [], error: null }),
      auth: {
        getSession: () =>
          Promise.resolve({ data: { session: { user: { id: "user-1", email: "a@x.com" } } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      },
      from: () => consulta(),
    },
  };
});

vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ currentOrganization: h.ORG }),
}));

// Mapa de números controlável: o teste troca o valor e o Dashboard re-renderiza.
vi.mock("@/hooks/useAccessiblePhoneNumbers", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    // A chave real do hook: o Dashboard refaz o mapa da org por ela.
    chaveNumerosAcessiveis: (org: string | null | undefined) => ["numeros-acessiveis", org ?? null],
    // O mapa que está no cache agora (o do hook real é o getQueryData): aqui, o valor vivo do falso.
    numerosAcessiveisEmCache: () => (h.linhas.valor.isReady ? h.linhas.valor.phoneNumbers : null),
    useAccessiblePhoneNumbers: () =>
      useSyncExternalStore(
        (ouvinte) => {
          h.linhas.ouvintes.add(ouvinte);
          return () => h.linhas.ouvintes.delete(ouvinte);
        },
        () => h.linhas.valor,
      ),
  };
});

vi.mock("@/contexts/VoiceCallContext", () => ({ useVoiceCalls: () => ({ setLine: h.setLine }) }));
vi.mock("@/hooks/usePhoneTheme", () => ({ usePhoneTheme: (hue: number | null) => h.tema(hue) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/ResizableListColumn", () => ({
  ResizableListColumn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/layout", () => ({ BottomNavigation: () => null }));
vi.mock("@/components/feedback/FeedbackPopup", () => ({ FeedbackPopup: () => null }));
vi.mock("@/components/FeatureAnnouncementDialog", () => ({ default: () => null }));

interface ListaProps {
  escopo: readonly string[];
  numeroUnico: string | null;
  conjunta?: boolean;
  numerosDaConjunta?: readonly string[];
  metaPhoneNumberId?: string | null;
  isQrConnection?: boolean;
  onSelectConversation: (id: string, name?: string, lineId?: string | null) => void;
  onPhoneSelect: (id: string) => void;
  onSelecionarConjunta?: () => void;
  onEscolherNumeros?: () => void;
  numerosEmErro?: boolean;
  onTentarNumerosNovamente?: () => void;
}

vi.mock("@/components/ConversationsList", () => ({
  default: (props: ListaProps) => {
    h.escopos.push(props.escopo);
    return (
      <div
        data-testid="lista"
        data-numero={props.numeroUnico ?? ""}
        data-escopo={props.escopo.join(",")}
        data-conjunta={String(Boolean(props.conjunta))}
        data-da-conjunta={(props.numerosDaConjunta ?? []).join(",")}
        data-meta={props.metaPhoneNumberId ?? ""}
        data-qr={String(Boolean(props.isQrConnection))}
        data-numeros-em-erro={String(Boolean(props.numerosEmErro))}
      >
        <button onClick={() => props.onTentarNumerosNovamente?.()}>tentar números de novo</button>
        <button onClick={() => props.onSelectConversation("conv-a", "Alfa", h.LINHA_A)}>abrir conversa do A</button>
        <button onClick={() => props.onSelectConversation("conv-b", "Beta", h.LINHA_B)}>abrir conversa do B</button>
        <button onClick={() => props.onPhoneSelect(h.LINHA_A)}>escolher o número A</button>
        <button onClick={() => props.onPhoneSelect(h.LINHA_B)}>escolher o número B</button>
        <button onClick={() => props.onSelecionarConjunta?.()}>escolher a caixa conjunta</button>
        <button onClick={() => props.onEscolherNumeros?.()}>escolher números</button>
      </div>
    );
  },
}));

interface ChatProps {
  conversationId: string | null;
  phoneNumberId?: string | null;
  phoneNumberDbId?: string | null;
  numeroNome?: string | null;
  numeroHue?: number | null;
  onNavigateToConversation?: (phone: string, name: string) => void;
}

vi.mock("@/components/ChatArea", () => ({
  default: (props: ChatProps) => (
    <div
      data-testid="chat"
      data-conversa={props.conversationId ?? ""}
      data-numero={props.phoneNumberDbId ?? ""}
      data-numero-nome={props.numeroNome ?? ""}
      data-numero-hue={props.numeroHue === null || props.numeroHue === undefined ? "" : String(props.numeroHue)}
    >
      {/* O "Iniciar conversa" do cartão de contato. */}
      <button onClick={() => props.onNavigateToConversation?.("5511988887777", "Fulano")}>iniciar conversa</button>
    </div>
  ),
}));

interface DialogoProps {
  open: boolean;
  fora: readonly string[];
  onSalvar: (fora: string[]) => void;
}

vi.mock("@/components/CaixaConjuntaDialog", () => ({
  CaixaConjuntaDialog: ({ open, fora, onSalvar }: DialogoProps) => (
    <div data-testid="dialogo-conjunta" data-aberto={String(open)} data-fora={fora.join(",")}>
      <button onClick={() => onSalvar([h.LINHA_C])}>salvar fora C</button>
      <button onClick={() => onSalvar([])}>salvar sem exclusões</button>
    </div>
  ),
}));

const { default: Dashboard } = await import("./Dashboard");

const linhaA = {
  id: h.LINHA_A,
  displayName: "Comercial",
  themeHue: 176,
  phoneNumber: "5511",
  connectionType: "business_api",
  metaPhoneNumberId: "meta-a",
  sectorIsolationEnabled: false,
};
const linhaB = {
  id: h.LINHA_B,
  displayName: "Suporte",
  themeHue: 195,
  phoneNumber: "5522",
  connectionType: "qr",
  metaPhoneNumberId: "qr_222",
  sectorIsolationEnabled: false,
};

const linhaC = {
  id: h.LINHA_C,
  displayName: "Eventos",
  themeHue: 40,
  phoneNumber: "5533",
  connectionType: "qr",
  metaPhoneNumberId: "qr_333",
  sectorIsolationEnabled: false,
};

const prontas = (...phoneNumbers: unknown[]) => ({ phoneNumbers, isLoading: false, isReady: true });
const carregando = { phoneNumbers: [] as unknown[], isLoading: true, isReady: false };

const embedDe = (linha: { id: string; metaPhoneNumberId: string; themeHue: number; connectionType: string; displayName: string }) => ({
  id: linha.id,
  phone_number_id: linha.metaPhoneNumberId,
  theme_hue: linha.themeHue,
  connection_type: linha.connectionType,
  display_name: linha.displayName,
});

/** Conversa como o deep link a recebe, com o embed do número. */
const conversaNoNumero = (id: string, linha: Parameters<typeof embedDe>[0]) => ({
  id,
  contact_name: `Contato ${id}`,
  phone_number_id: linha.id,
  phone_number: embedDe(linha),
});

// O mesmo client em todo o teste: o Dashboard refaz o mapa de números por ele.
let queryClient: QueryClient;

function montar(caminho = "/dashboard") {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[caminho]}>
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/dashboard/:conversationId" element={<Dashboard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const user = userEvent.setup({ pointerEventsCheck: 0 });
const clicar = (nome: string) => user.click(screen.getByRole("button", { name: nome }));
const ultimoTema = () => h.tema.mock.lastCall?.[0];

beforeEach(() => {
  conversationListCache.clear();
  conversationListCache.setCapacity(MAX_LINES);
  queryClient = new QueryClient();
  localStorage.clear();
  h.definirLinhas(carregando);
  h.conversas = {};
  h.eqs.length = 0;
  h.inseridos.length = 0;
  h.escopos.length = 0;
  h.setLine.mockClear();
  h.tema.mockClear();
  h.toast.mockClear();
});


const chaveModo = `echo_caixa_modo_user-1_${h.ORG.id}`;
const chaveFora = `echo_caixa_fora_user-1_${h.ORG.id}`;
const chaveUltimo = `echo_last_phone_${h.ORG.id}`;

const lista = () => screen.getByTestId("lista");
const dialogo = () => screen.getByTestId("dialogo-conjunta");

/** Os dois números sem exclusão: a conjunta ativa vale os dois. */
const montarNaConjunta = async (opcoes: { fora?: string[]; ultimo?: string } = {}) => {
  localStorage.setItem(chaveModo, "conjunta");
  if (opcoes.fora) localStorage.setItem(chaveFora, JSON.stringify(opcoes.fora));
  if (opcoes.ultimo) localStorage.setItem(chaveUltimo, opcoes.ultimo);
  return montar();
};

describe("Dashboard: caixa conjunta, escopo e armazenamento", () => {
  it("modo guardado como conjunta: a lista recebe todos os números, sem número único e sem sentinela", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    await montarNaConjunta();
    await screen.findByTestId("lista");

    await waitFor(() => expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_B}`));
    expect(lista()).toHaveAttribute("data-conjunta", "true");
    expect(lista()).toHaveAttribute("data-numero", "");
    expect(lista()).toHaveAttribute("data-meta", "");
    expect(lista()).toHaveAttribute("data-qr", "false");
    // O último número único segue sendo um uuid de verdade, e o modo nunca vai para esta chave.
    expect(localStorage.getItem(chaveUltimo)).toBe(h.LINHA_A);
  });

  it("enquanto os números não chegam o escopo espera vazio, sem buscar o último número", async () => {
    localStorage.setItem(chaveUltimo, h.LINHA_B);
    h.definirLinhas(carregando);
    await montarNaConjunta({ ultimo: h.LINHA_B });
    await screen.findByTestId("lista");
    expect(lista()).toHaveAttribute("data-conjunta", "true");
    expect(lista()).toHaveAttribute("data-escopo", "");
    expect(h.escopos.every((escopo) => escopo.length === 0)).toBe(true);

    act(() => h.definirLinhas(prontas(linhaA, linhaB)));
    await waitFor(() => expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_B}`));
  });

  it("as exclusões saem do escopo, e um número novo liberado entra sozinho", async () => {
    h.definirLinhas(prontas(linhaA, linhaB, linhaC));
    await montarNaConjunta({ fora: [h.LINHA_B] });
    await screen.findByTestId("lista");
    await waitFor(() => expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_C}`));
    expect(lista()).toHaveAttribute("data-da-conjunta", `${h.LINHA_A},${h.LINHA_C}`);
  });

  it("com menos de 2 números depois das exclusões cai no modo número, e a escolha fica guardada", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    await montarNaConjunta({ fora: [h.LINHA_B], ultimo: h.LINHA_A });
    await screen.findByTestId("lista");

    await waitFor(() => expect(lista()).toHaveAttribute("data-numero", h.LINHA_A));
    expect(lista()).toHaveAttribute("data-conjunta", "false");
    expect(lista()).toHaveAttribute("data-escopo", h.LINHA_A);
    expect(localStorage.getItem(chaveModo)).toBe("conjunta");
  });

  it("escolher um número sai da conjunta, grava o número e fecha a conversa", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    await montarNaConjunta();
    await screen.findByTestId("lista");
    await clicar("abrir conversa do A");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));

    await clicar("escolher o número B");
    await waitFor(() => expect(lista()).toHaveAttribute("data-conjunta", "false"));
    expect(lista()).toHaveAttribute("data-escopo", h.LINHA_B);
    expect(localStorage.getItem(chaveModo)).toBeNull();
    expect(localStorage.getItem(chaveUltimo)).toBe(h.LINHA_B);
    expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "");
  });

  it("escolher a Caixa conjunta liga o modo, mantém o último número e MANTÉM a conversa aberta se o número dela entra na conjunta", async () => {
    localStorage.setItem(chaveUltimo, h.LINHA_B);
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();
    await screen.findByTestId("lista");
    await clicar("abrir conversa do A");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));

    await clicar("escolher a caixa conjunta");
    await waitFor(() => expect(lista()).toHaveAttribute("data-conjunta", "true"));
    expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_B}`);
    expect(localStorage.getItem(chaveModo)).toBe("conjunta");
    expect(localStorage.getItem(chaveUltimo)).toBe(h.LINHA_B);
    // A conversa é do A, que está na conjunta: fechar interromperia o atendente sem motivo.
    expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a");
  });

  it("escolher a Caixa conjunta FECHA a conversa aberta quando o número dela está fora da conjunta", async () => {
    localStorage.setItem(chaveFora, JSON.stringify([h.LINHA_B]));
    h.definirLinhas(prontas(linhaA, linhaB, linhaC));
    montar();
    await screen.findByTestId("lista");
    await clicar("abrir conversa do B");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));

    await clicar("escolher a caixa conjunta");
    await waitFor(() => expect(lista()).toHaveAttribute("data-conjunta", "true"));
    expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_C}`);
    expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "");
  });

  it("escolher a Caixa conjunta sem 2 números depois das exclusões abre a escolha; salvar liga", async () => {
    localStorage.setItem(chaveFora, JSON.stringify([h.LINHA_B]));
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();
    await screen.findByTestId("lista");
    await waitFor(() => expect(lista()).toHaveAttribute("data-numero", h.LINHA_A));

    await clicar("escolher a caixa conjunta");
    expect(dialogo()).toHaveAttribute("data-aberto", "true");
    expect(localStorage.getItem(chaveModo)).toBeNull();
    expect(lista()).toHaveAttribute("data-conjunta", "false");

    await clicar("salvar sem exclusões");
    await waitFor(() => expect(lista()).toHaveAttribute("data-conjunta", "true"));
    expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_B}`);
    expect(localStorage.getItem(chaveFora)).toBeNull();
    expect(localStorage.getItem(chaveModo)).toBe("conjunta");
  });

  it("escolher a Caixa conjunta com o mapa de números ainda carregando liga o modo, sem abrir o diálogo", async () => {
    h.definirLinhas(carregando);
    montar();
    await screen.findByTestId("lista");

    await clicar("escolher a caixa conjunta");
    // Nada a escolher ainda: o modo fica ligado e o escopo espera os números, sem o aviso de mínimo.
    expect(localStorage.getItem(chaveModo)).toBe("conjunta");
    expect(dialogo()).toHaveAttribute("data-aberto", "false");

    h.definirLinhas(prontas(linhaA, linhaB));
    await waitFor(() => expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_B}`));
    expect(dialogo()).toHaveAttribute("data-aberto", "false");
  });

  it("'Escolher números' na conjunta abre o diálogo; salvar grava as exclusões e reduz o escopo", async () => {
    h.definirLinhas(prontas(linhaA, linhaB, linhaC));
    await montarNaConjunta();
    await screen.findByTestId("lista");
    await waitFor(() => expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_B},${h.LINHA_C}`));

    await clicar("escolher números");
    expect(dialogo()).toHaveAttribute("data-aberto", "true");
    await clicar("salvar fora C");
    await waitFor(() => expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_B}`));
    expect(JSON.parse(localStorage.getItem(chaveFora) ?? "null")).toEqual([h.LINHA_C]);
    expect(localStorage.getItem(chaveModo)).toBe("conjunta");
  });
});

describe("Dashboard: caixa conjunta e o deep link", () => {
  it("na conjunta o deep link abre o chat no número da conversa e NÃO troca a seleção nem o localStorage", async () => {
    h.conversas = { "conv-b": conversaNoNumero("conv-b", linhaB) };
    h.definirLinhas(prontas(linhaA, linhaB));
    await montarNaConjunta({ ultimo: h.LINHA_A });
    // O clique na notificação monta o Dashboard direto na URL da conversa.
    cleanup();
    montar("/dashboard/conv-b");

    const chat = await screen.findByTestId("chat");
    await waitFor(() => expect(chat).toHaveAttribute("data-conversa", "conv-b"));
    expect(chat).toHaveAttribute("data-numero", h.LINHA_B);
    expect(lista()).toHaveAttribute("data-conjunta", "true");
    expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_B}`);
    expect(localStorage.getItem(chaveUltimo)).toBe(h.LINHA_A);
    expect(localStorage.getItem(chaveModo)).toBe("conjunta");
  });

  it("conversa de um número excluído abre por cima da lista conjunta, sem entrar nela", async () => {
    h.conversas = { "conv-c": conversaNoNumero("conv-c", linhaC) };
    h.definirLinhas(prontas(linhaA, linhaB, linhaC));
    montarNaConjunta({ fora: [h.LINHA_C], ultimo: h.LINHA_A });
    cleanup();
    montar("/dashboard/conv-c");

    const chat = await screen.findByTestId("chat");
    await waitFor(() => expect(chat).toHaveAttribute("data-conversa", "conv-c"));
    expect(chat).toHaveAttribute("data-numero", h.LINHA_C);
    expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_B}`);
    expect(localStorage.getItem(chaveUltimo)).toBe(h.LINHA_A);
  });

  it("no modo número o deep link troca de número, como na fase 1", async () => {
    h.conversas = { "conv-b": conversaNoNumero("conv-b", linhaB) };
    localStorage.setItem(chaveUltimo, h.LINHA_A);
    h.definirLinhas(prontas(linhaA, linhaB));
    montar("/dashboard/conv-b");

    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_B));
    expect(localStorage.getItem(chaveUltimo)).toBe(h.LINHA_B);
  });
});

describe("Dashboard: caixa conjunta, tema, ligação e selo", () => {
  it("sem conversa aberta o tema é o padrão (null) e nenhuma linha é vigiada", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    await montarNaConjunta();
    await screen.findByTestId("lista");
    await waitFor(() => expect(lista()).toHaveAttribute("data-conjunta", "true"));

    expect(ultimoTema()).toBeNull();
    expect(h.setLine).toHaveBeenLastCalledWith(null, false, "user-1");
  });

  it("com conversa aberta o tema, a ligação e o selo seguem o número DELA", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    await montarNaConjunta();
    await screen.findByTestId("lista");

    await clicar("abrir conversa do B");
    const chat = await screen.findByTestId("chat");
    await waitFor(() => expect(chat).toHaveAttribute("data-conversa", "conv-b"));
    expect(ultimoTema()).toBe(195);
    expect(h.setLine).toHaveBeenLastCalledWith(h.LINHA_B, true, "user-1");
    expect(chat).toHaveAttribute("data-numero-nome", "Suporte");
    expect(chat).toHaveAttribute("data-numero-hue", "195");

    // Trocar de conversa troca a cor para a do outro número.
    await clicar("abrir conversa do A");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));
    expect(ultimoTema()).toBe(176);
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero-nome", "Comercial");
  });

  it("no modo número o chat leva o selo do número da conversa e o tema é o dele", async () => {
    localStorage.setItem(chaveUltimo, h.LINHA_A);
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();
    await screen.findByTestId("lista");
    await waitFor(() => expect(lista()).toHaveAttribute("data-numero", h.LINHA_A));

    await clicar("abrir conversa do B");
    const chat = await screen.findByTestId("chat");
    await waitFor(() => expect(chat).toHaveAttribute("data-conversa", "conv-b"));
    expect(chat).toHaveAttribute("data-numero-nome", "Suporte");
    expect(chat).toHaveAttribute("data-numero-hue", "195");
    expect(ultimoTema()).toBe(195);
  });
});

describe("Dashboard: caixa conjunta, cache, números em erro e 'Iniciar conversa'", () => {
  it("remontar o Dashboard na conjunta (user ainda nulo) NÃO esvazia o cache de listas dos números", async () => {
    // Capacidade ampliada pela conjunta de 6 números (N + 1), com todos já no cache.
    const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    conversationListCache.setCapacity(ids.length + 1);
    for (const id of ids) conversationListCache.set(id, { rows: [], fetchedAt: Date.now(), complete: true });

    h.definirLinhas(carregando);
    await montarNaConjunta();
    await screen.findByTestId("lista");

    // O primeiro render roda com user nulo (modo "numero"): nada pode cortar o cache para 4.
    expect(conversationListCache.capacity()).toBe(ids.length + 1);
    for (const id of ids) expect(conversationListCache.get(id)).toBeDefined();
  });

  it("mapa de números em erro (sem carregar): a conjunta segura o escopo vazio e o deep link não grava a seleção", async () => {
    h.conversas = { "conv-b": conversaNoNumero("conv-b", linhaB) };
    localStorage.setItem(chaveModo, "conjunta");
    localStorage.setItem(chaveUltimo, h.LINHA_A);
    // Primeira carga falhou: isLoading já é falso, sem dado e sem pronto.
    h.definirLinhas({ phoneNumbers: [], isLoading: false, isReady: false });
    montar("/dashboard/conv-b");

    const chat = await screen.findByTestId("chat");
    await waitFor(() => expect(chat).toHaveAttribute("data-conversa", "conv-b"));
    expect(lista()).toHaveAttribute("data-conjunta", "true");
    expect(lista()).toHaveAttribute("data-escopo", "");
    expect(lista()).toHaveAttribute("data-numero", "");
    expect(localStorage.getItem(chaveUltimo)).toBe(h.LINHA_A);

    // O refetch traz o mapa: a conjunta volta e o número da conversa continua sem virar seleção.
    act(() => h.definirLinhas(prontas(linhaA, linhaB)));
    await waitFor(() => expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_B}`));
    expect(localStorage.getItem(chaveUltimo)).toBe(h.LINHA_A);
    expect(localStorage.getItem(chaveModo)).toBe("conjunta");
  });

  it("modo conjunta guardado mas com 1 número depois das exclusões: o deep link feito com o mapa carregando troca a lista para o número da conversa", async () => {
    h.conversas = { "conv-b": conversaNoNumero("conv-b", linhaB) };
    localStorage.setItem(chaveModo, "conjunta");
    localStorage.setItem(chaveFora, JSON.stringify([h.LINHA_B]));
    localStorage.setItem(chaveUltimo, h.LINHA_A);
    h.definirLinhas(carregando);
    montar("/dashboard/conv-b");

    const chat = await screen.findByTestId("chat");
    await waitFor(() => expect(chat).toHaveAttribute("data-conversa", "conv-b"));
    expect(lista()).toHaveAttribute("data-escopo", "");

    // Os números chegam: só A sobra na conjunta (B está fora), então vale o modo número, no B da conversa.
    act(() => h.definirLinhas(prontas(linhaA, linhaB)));
    await waitFor(() => expect(lista()).toHaveAttribute("data-numero", h.LINHA_B));
    expect(lista()).toHaveAttribute("data-conjunta", "false");
    await waitFor(() => expect(localStorage.getItem(chaveUltimo)).toBe(h.LINHA_B));
  });

  it("deep link pendente com a conjunta valendo ao chegar o mapa: não troca a seleção", async () => {
    h.conversas = { "conv-b": conversaNoNumero("conv-b", linhaB) };
    localStorage.setItem(chaveModo, "conjunta");
    localStorage.setItem(chaveUltimo, h.LINHA_A);
    h.definirLinhas(carregando);
    montar("/dashboard/conv-b");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));

    act(() => h.definirLinhas(prontas(linhaA, linhaB)));
    await waitFor(() => expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_B}`));
    expect(lista()).toHaveAttribute("data-conjunta", "true");
    expect(localStorage.getItem(chaveUltimo)).toBe(h.LINHA_A);
  });

  it("deep link pendente e o usuário escolhe outro número antes de o mapa chegar: vale a escolha, não o número da conversa", async () => {
    h.conversas = { "conv-b": conversaNoNumero("conv-b", linhaB) };
    localStorage.setItem(chaveModo, "conjunta");
    localStorage.setItem(chaveUltimo, h.LINHA_A);
    h.definirLinhas({ phoneNumbers: [], isLoading: false, isReady: false });
    montar("/dashboard/conv-b");
    const chat = await screen.findByTestId("chat");
    await waitFor(() => expect(chat).toHaveAttribute("data-conversa", "conv-b"));

    // O usuário sai da conjunta escolhendo o A (fecha a conversa do deep link) e só então o mapa chega.
    await clicar("escolher o número A");
    await waitFor(() => expect(lista()).toHaveAttribute("data-conjunta", "false"));
    act(() => h.definirLinhas(prontas(linhaA, linhaB)));
    await waitFor(() => expect(lista()).toHaveAttribute("data-numero", h.LINHA_A));
    expect(localStorage.getItem(chaveUltimo)).toBe(h.LINHA_A);
  });

  it("outra aba sai da conjunta escolhendo um número: esta passa para ele e não regrava o antigo", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    localStorage.setItem(chaveUltimo, h.LINHA_A);
    await montarNaConjunta({ ultimo: h.LINHA_A });
    await waitFor(() => expect(lista()).toHaveAttribute("data-conjunta", "true"));

    // A outra aba escolheu o B, na ordem real de produção: grava o número (evento ignorado
    // aqui) e só depois tira o modo. Aqui o armazenamento já reflete as duas, mas o evento do
    // modo é o único que o hook escuta.
    localStorage.setItem(chaveUltimo, h.LINHA_B);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: chaveUltimo }));
    });
    localStorage.removeItem(chaveModo);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: chaveModo }));
    });

    await waitFor(() => expect(lista()).toHaveAttribute("data-conjunta", "false"));
    expect(lista()).toHaveAttribute("data-escopo", h.LINHA_B);
    expect(lista()).toHaveAttribute("data-numero", h.LINHA_B);
    expect(localStorage.getItem(chaveUltimo)).toBe(h.LINHA_B);
  });

  it("conjunta com o mapa de números em erro: a lista recebe numerosEmErro e a nova tentativa refaz o mapa", async () => {
    localStorage.setItem(chaveModo, "conjunta");
    localStorage.setItem(chaveUltimo, h.LINHA_A);
    h.definirLinhas({ phoneNumbers: [], isLoading: false, isReady: false, isError: true });
    const refetch = vi.spyOn(queryClient, "refetchQueries").mockResolvedValue(undefined);
    montar("/dashboard");
    await waitFor(() => expect(lista()).toHaveAttribute("data-numeros-em-erro", "true"));
    expect(lista()).toHaveAttribute("data-escopo", "");

    await clicar("tentar números de novo");
    expect(refetch).toHaveBeenCalledWith({ queryKey: ["numeros-acessiveis", h.ORG.id] });

    // O mapa chega: a falha some e o escopo vira a conjunta.
    act(() => h.definirLinhas(prontas(linhaA, linhaB)));
    await waitFor(() => expect(lista()).toHaveAttribute("data-numeros-em-erro", "false"));
    expect(lista()).toHaveAttribute("data-escopo", `${h.LINHA_A},${h.LINHA_B}`);
  });

  it("modo número com o mapa em erro não mostra a falha dos números (a lista não depende dele)", async () => {
    localStorage.setItem(chaveUltimo, h.LINHA_A);
    h.definirLinhas({ phoneNumbers: [], isLoading: false, isReady: false, isError: true });
    montar("/dashboard");
    await waitFor(() => expect(lista()).toBeInTheDocument());
    expect(lista()).toHaveAttribute("data-numeros-em-erro", "false");
  });

  it("sair da conjunta escolhendo um número grava o echo_last_phone ANTES de tirar o modo", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    localStorage.setItem(chaveUltimo, h.LINHA_A);
    await montarNaConjunta({ ultimo: h.LINHA_A });
    await waitFor(() => expect(lista()).toHaveAttribute("data-conjunta", "true"));

    // A outra aba reage ao evento do modo e lê o último número nesse instante: ele já tem de ser o novo.
    const ordem: string[] = [];
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    setItem.mockImplementation(function (this: Storage, chave: string, valor: string) {
      if (chave === chaveUltimo) ordem.push("ultimo");
      return Object.getPrototypeOf(localStorage).setItem.call(this, chave, valor);
    });
    removeItem.mockImplementation(function (this: Storage, chave: string) {
      if (chave === chaveModo) ordem.push("modo");
      return Object.getPrototypeOf(localStorage).removeItem.call(this, chave);
    });
    try {
      await clicar("escolher o número B");
      await waitFor(() => expect(lista()).toHaveAttribute("data-conjunta", "false"));
    } finally {
      setItem.mockRestore();
      removeItem.mockRestore();
    }
    expect(ordem.indexOf("ultimo")).toBeGreaterThanOrEqual(0);
    expect(ordem.indexOf("modo")).toBeGreaterThan(ordem.indexOf("ultimo"));
  });

  it("'Iniciar conversa' na conjunta, com o número da conversa fora do mapa: não cria conversa no número selecionado (oculto)", async () => {
    // Conversa de um número que o atendente não acessa: o embed vem nulo e a linha não está no mapa.
    h.conversas = {
      "conv-x": { id: "conv-x", contact_name: "Contato x", phone_number_id: h.LINHA_C, phone_number: null },
    };
    h.definirLinhas(prontas(linhaA, linhaB));
    localStorage.setItem(chaveModo, "conjunta");
    localStorage.setItem(chaveUltimo, h.LINHA_A);
    montar("/dashboard/conv-x");
    const chat = await screen.findByTestId("chat");
    await waitFor(() => expect(chat).toHaveAttribute("data-conversa", "conv-x"));
    expect(lista()).toHaveAttribute("data-conjunta", "true");

    await clicar("iniciar conversa");
    await waitFor(() => expect(h.toast).toHaveBeenCalled());
    expect(h.toast.mock.lastCall?.[0]).toMatchObject({ title: "Não foi possível abrir a conversa", variant: "destructive" });
    expect(h.inseridos).toHaveLength(0);
    expect(h.eqs.some(([coluna, valor]) => coluna === "phone_number_id" && valor === h.LINHA_A)).toBe(false);
  });

  it("'Iniciar conversa' no modo número com o número da conversa fora do mapa segue usando o selecionado, como antes", async () => {
    h.conversas = {
      "conv-x": { id: "conv-x", contact_name: "Contato x", phone_number_id: h.LINHA_C, phone_number: null },
    };
    h.definirLinhas(prontas(linhaA, linhaB));
    localStorage.setItem(chaveUltimo, h.LINHA_A);
    montar("/dashboard/conv-x");
    const chat = await screen.findByTestId("chat");
    await waitFor(() => expect(chat).toHaveAttribute("data-conversa", "conv-x"));
    await waitFor(() => expect(lista()).toHaveAttribute("data-numero", h.LINHA_A));

    await clicar("iniciar conversa");
    await waitFor(() => expect(h.inseridos).toHaveLength(1));
    expect(h.inseridos[0].phone_number_id).toBe(h.LINHA_A);
  });
});
