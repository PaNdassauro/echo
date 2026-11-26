// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router-dom";

/**
 * O chat aberto usa o número da CONVERSA, e o Dashboard resolve sozinho o
 * número selecionado. Aqui o Dashboard é real; a lista, o chat e as buscas são
 * falsos e só expõem o que o Dashboard lhes entrega.
 *
 * O invariante que mais importa: em nenhum render o ChatArea recebe uma
 * conversa com o número de OUTRA (mandar pelo número errado não dá erro).
 */

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no
// seguinte.
afterEach(cleanup);

const h = vi.hoisted(() => {
  const linhas = {
    valor: { phoneNumbers: [] as unknown[], isLoading: false, isReady: false },
    ouvintes: new Set<() => void>(),
  };
  return {
    ORG: { id: "org-1", name: "Org" },
    LINHA_A: "11111111-aaaa",
    LINHA_B: "22222222-bbbb",
    linhas,
    definirLinhas(proximo: typeof linhas.valor) {
      linhas.valor = proximo;
      linhas.ouvintes.forEach((ouvinte) => ouvinte());
    },
    mobile: { valor: false },
    setLine: vi.fn(),
    tema: vi.fn(),
    toast: vi.fn(),
    // Conversas que o deep link encontra, por id, e o resultado da busca por telefone.
    conversas: {} as Record<string, unknown>,
    achada: null as null | { id: string; visivel?: boolean; dono?: string | null },
    // Linhas (uuid) para as quais o Dashboard chamou conversa_do_telefone_na_linha.
    rpcs: [] as string[],
    eqs: [] as Array<[string, unknown]>,
    // O que o Dashboard gravou em `conversations` ao criar uma conversa nova.
    inseridos: [] as Array<Record<string, unknown>>,
    // Números que o atendente não acessa: a RLS recusa o insert neles (42501).
    semAcesso: [] as string[],
    // Todo render do ChatArea falso: o par (conversa, número) que ele recebeu.
    renders: [] as Array<{ conversa: string; numeroDb: string; metaId: string }>,
    // Todo número selecionado que a lista falsa recebeu, em ordem: mostra por onde a seleção passou.
    selecionados: [] as Array<string | null>,
    // O escopo (o array em si) que a lista falsa recebeu a cada render.
    escopos: [] as Array<readonly string[]>,
    // Busca da conversa por id que só termina quando o teste libera (deep link em voo).
    retidas: {} as Record<string, Promise<void>>,
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
    c.single = () => {
      const ultimo = h.inseridos[h.inseridos.length - 1];
      if (ultimo && h.semAcesso.includes(String(ultimo.phone_number_id))) {
        return Promise.resolve({
          data: null,
          error: { code: "42501", message: 'new row violates row-level security policy for table "conversations"' },
        });
      }
      return Promise.resolve({ data: { id: "conv-nova" }, error: null });
    };
    c.maybeSingle = () => {
      const porId = proprios.find(([coluna]) => coluna === "id");
      const data = porId ? (h.conversas[porId[1] as string] ?? null) : h.achada;
      const retida = porId ? h.retidas[porId[1] as string] : undefined;
      return (retida ?? Promise.resolve()).then(() => ({ data, error: null }));
    };
    return c;
  };
  return {
    supabase: {
      auth: {
        getSession: () =>
          Promise.resolve({ data: { session: { user: { id: "user-1", email: "a@x.com" } } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      },
      from: () => consulta(),
      // conversa_do_telefone_na_linha: 0 ou 1 linha, a partir de h.achada.
      rpc: (nome: string, args: { p_phone_number_id: string }) => {
        if (nome !== "conversa_do_telefone_na_linha") return Promise.resolve({ data: null, error: { message: "rpc inesperada" } });
        h.rpcs.push(args.p_phone_number_id);
        const data = h.achada
          ? [{ conversation_id: (h.achada.visivel ?? true) ? h.achada.id : null, visivel: h.achada.visivel ?? true, dono: h.achada.dono ?? null }]
          : [];
        return Promise.resolve({ data, error: null });
      },
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
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => h.mobile.valor }));
vi.mock("@/components/ResizableListColumn", () => ({
  ResizableListColumn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/layout", () => ({ BottomNavigation: () => null }));
vi.mock("@/components/feedback/FeedbackPopup", () => ({ FeedbackPopup: () => null }));
vi.mock("@/components/FeatureAnnouncementDialog", () => ({ default: () => null }));

interface ListaProps {
  escopo: readonly string[];
  numeroUnico: string | null;
  metaPhoneNumberId?: string | null;
  isQrConnection?: boolean;
  onSelectConversation: (id: string, name?: string, lineId?: string | null) => void;
  onPhoneSelect: (id: string) => void;
}

vi.mock("@/components/ConversationsList", () => ({
  default: (props: ListaProps) => {
    h.selecionados.push(props.numeroUnico);
    h.escopos.push(props.escopo);
    return (
      <div
        data-testid="lista"
        data-numero={props.numeroUnico ?? ""}
        data-escopo={props.escopo.join(",")}
        data-meta={props.metaPhoneNumberId ?? ""}
        data-qr={String(Boolean(props.isQrConnection))}
      >
        <button onClick={() => props.onSelectConversation("conv-a", "Alfa", h.LINHA_A)}>abrir conversa do A</button>
        <button onClick={() => props.onSelectConversation("conv-b", "Beta", h.LINHA_B)}>abrir conversa do B</button>
        <button onClick={() => props.onSelectConversation("conv-sem-numero", "Sem número")}>
          abrir conversa sem número
        </button>
        <button onClick={() => props.onPhoneSelect(h.LINHA_B)}>escolher o número B</button>
      </div>
    );
  },
}));

interface ChatProps {
  conversationId: string | null;
  phoneNumberId?: string | null;
  phoneNumberDbId?: string | null;
  isQrConnection?: boolean;
  isFreeTextChannel?: boolean;
  onNavigateToConversation?: (phone: string, name: string) => void;
  onMobileBack?: () => void;
}

vi.mock("@/components/ChatArea", () => ({
  default: (props: ChatProps) => {
    h.renders.push({
      conversa: props.conversationId ?? "",
      numeroDb: props.phoneNumberDbId ?? "",
      metaId: props.phoneNumberId ?? "",
    });
    return (
      <div
        data-testid="chat"
        data-conversa={props.conversationId ?? ""}
        data-numero={props.phoneNumberDbId ?? ""}
        data-meta={props.phoneNumberId ?? ""}
        data-qr={String(Boolean(props.isQrConnection))}
        data-livre={String(Boolean(props.isFreeTextChannel))}
      >
        <button onClick={() => props.onNavigateToConversation?.("5511999990000", "Fulano")}>iniciar conversa</button>
        <button onClick={() => props.onMobileBack?.()}>voltar</button>
      </div>
    );
  },
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

const chaveSalva = `echo_last_phone_${h.ORG.id}`;

// O mesmo client em todo o teste: o Dashboard refaz o mapa de números por ele.
let queryClient: QueryClient;

// Como o GlobalNotificationListener, a busca e o histórico do navegador: navega
// por fora do Dashboard, sem passar pela lista.
let navegar: NavigateFunction = () => undefined;
const Navegador = () => {
  navegar = useNavigate();
  return null;
};

function montar(caminho = "/dashboard") {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[caminho]}>
        <Navegador />
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
  queryClient = new QueryClient();
  localStorage.clear();
  h.definirLinhas(carregando);
  h.mobile.valor = false;
  h.conversas = {};
  h.achada = null;
  h.rpcs.length = 0;
  h.eqs.length = 0;
  h.inseridos.length = 0;
  h.semAcesso.length = 0;
  h.renders.length = 0;
  h.selecionados.length = 0;
  h.escopos.length = 0;
  h.retidas = {};
  h.setLine.mockClear();
  h.tema.mockClear();
  h.toast.mockClear();
});

describe("Dashboard: número selecionado", () => {
  it("sem número salvo, escolhe o primeiro quando a lista de números chega e grava a escolha", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();

    const lista = await screen.findByTestId("lista");
    await waitFor(() => expect(lista).toHaveAttribute("data-numero", h.LINHA_A));
    expect(localStorage.getItem(chaveSalva)).toBe(h.LINHA_A);
  });

  it("a lista recebe o escopo com só o número selecionado — o mesmo array enquanto o conjunto não muda", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();

    const lista = await screen.findByTestId("lista");
    await waitFor(() => expect(lista).toHaveAttribute("data-numero", h.LINHA_A));
    expect(lista).toHaveAttribute("data-escopo", h.LINHA_A);

    // O mapa de números chega de novo (nome, cor…): o Dashboard renderiza, o conjunto é o mesmo.
    const antes = h.escopos[h.escopos.length - 1];
    const rendersAntes = h.escopos.length;
    act(() => h.definirLinhas(prontas({ ...linhaA }, { ...linhaB })));
    await waitFor(() => expect(h.escopos.length).toBeGreaterThan(rendersAntes));
    expect(h.escopos[h.escopos.length - 1]).toBe(antes);

    // Trocar de número troca o conjunto.
    await clicar("escolher o número B");
    await waitFor(() => expect(lista).toHaveAttribute("data-escopo", h.LINHA_B));
    expect(h.escopos[h.escopos.length - 1]).toEqual([h.LINHA_B]);
  });

  it("sem número selecionado o escopo é vazio, e nunca um valor inventado", async () => {
    h.definirLinhas(prontas());
    montar();

    const lista = await screen.findByTestId("lista");
    await waitFor(() => expect(lista).toHaveAttribute("data-numero", ""));
    expect(lista).toHaveAttribute("data-escopo", "");
    expect(h.escopos.every((escopo) => escopo.length === 0)).toBe(true);
  });

  it("mantém o número salvo quando ele ainda vale, com id da Meta e canal vindos do mapa", async () => {
    localStorage.setItem(chaveSalva, h.LINHA_B);
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();

    const lista = await screen.findByTestId("lista");
    await waitFor(() => expect(lista).toHaveAttribute("data-meta", "qr_222"));
    expect(lista).toHaveAttribute("data-numero", h.LINHA_B);
    expect(lista).toHaveAttribute("data-qr", "true");
    expect(localStorage.getItem(chaveSalva)).toBe(h.LINHA_B);
  });

  it("número salvo que não existe mais cai no primeiro e regrava", async () => {
    localStorage.setItem(chaveSalva, "numero-removido");
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();

    const lista = await screen.findByTestId("lista");
    await waitFor(() => expect(lista).toHaveAttribute("data-numero", h.LINHA_A));
    expect(localStorage.getItem(chaveSalva)).toBe(h.LINHA_A);
  });

  it("org sem número fica sem seleção e esquece o id salvo", async () => {
    localStorage.setItem(chaveSalva, h.LINHA_A);
    h.definirLinhas(prontas());
    montar();

    const lista = await screen.findByTestId("lista");
    await waitFor(() => expect(lista).toHaveAttribute("data-numero", ""));
    expect(localStorage.getItem(chaveSalva)).toBeNull();
  });

  it("não decide nada enquanto a lista de números não chegou, e decide quando ela chega", async () => {
    localStorage.setItem(chaveSalva, "numero-removido");
    montar();

    const lista = await screen.findByTestId("lista");
    // O salvo entra de forma otimista, para a lista já buscar por ele.
    expect(lista).toHaveAttribute("data-numero", "numero-removido");
    expect(localStorage.getItem(chaveSalva)).toBe("numero-removido");

    act(() => h.definirLinhas(prontas(linhaA, linhaB)));

    await waitFor(() => expect(lista).toHaveAttribute("data-numero", h.LINHA_A));
    expect(localStorage.getItem(chaveSalva)).toBe(h.LINHA_A);
  });

  it("escolher outro número pelo seletor fecha a conversa aberta", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();
    await screen.findByTestId("lista");

    await clicar("abrir conversa do A");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));

    await clicar("escolher o número B");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", ""));
    expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_B);
    expect(localStorage.getItem(chaveSalva)).toBe(h.LINHA_B);
  });
});

describe("Dashboard: o chat segue o número da conversa", () => {
  it("abre a conversa de outro número com o id da Meta, o canal e a cor DELA", async () => {
    localStorage.setItem(chaveSalva, h.LINHA_A);
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();
    await screen.findByTestId("lista");
    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));

    await clicar("abrir conversa do B");

    const chat = await screen.findByTestId("chat");
    await waitFor(() => expect(chat).toHaveAttribute("data-conversa", "conv-b"));
    expect(chat).toHaveAttribute("data-numero", h.LINHA_B);
    expect(chat).toHaveAttribute("data-meta", "qr_222");
    expect(chat).toHaveAttribute("data-qr", "true");
    expect(chat).toHaveAttribute("data-livre", "true");
    // A lista segue no número selecionado: só o chat mudou de número.
    expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A);
    expect(ultimoTema()).toBe(195);
    expect(h.setLine).toHaveBeenLastCalledWith(h.LINHA_B, true, "user-1");
  });

  it("trocar de conversa troca o número do chat no mesmo render, sem par misto", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();
    await screen.findByTestId("lista");

    await clicar("abrir conversa do B");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));
    await clicar("abrir conversa do A");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));

    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_A);
    expect(screen.getByTestId("chat")).toHaveAttribute("data-qr", "false");
    expect(ultimoTema()).toBe(176);

    const numeroDaConversa: Record<string, string> = { "conv-a": h.LINHA_A, "conv-b": h.LINHA_B };
    for (const { conversa, numeroDb } of h.renders) {
      if (conversa) expect(numeroDb).toBe(numeroDaConversa[conversa]);
    }
  });

  it("conversa que a lista não achou navega e o deep link descobre o número, sem usar o da anterior", async () => {
    h.conversas["conv-sem-numero"] = conversaNoNumero("conv-sem-numero", linhaA);
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();
    await screen.findByTestId("lista");

    await clicar("abrir conversa do B");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));

    await clicar("abrir conversa sem número");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-sem-numero"));

    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_A);
    expect(screen.getByTestId("chat")).toHaveAttribute("data-qr", "false");
    expect(h.renders.some((r) => r.conversa === "conv-sem-numero" && r.numeroDb !== h.LINHA_A)).toBe(false);
  });
});

describe("Dashboard: o número do chat quando a linha sai do mapa no meio da sessão", () => {
  /** O mapa refeito sem o número B: um admin o desativou com a conversa do B aberta. */
  const desativarB = () => {
    act(() => h.definirLinhas({ phoneNumbers: [linhaA, linhaB], isLoading: false, isReady: false }));
    act(() => h.definirLinhas(prontas(linhaA)));
  };

  it.each([
    ["desktop", false],
    ["mobile", true],
  ])(
    "%s: a conversa aberta pela lista segue com o número, o canal e a cor com que abriu",
    async (_nome, mobile) => {
      h.mobile.valor = mobile;
      localStorage.setItem(chaveSalva, h.LINHA_B);
      h.definirLinhas(prontas(linhaA, linhaB));
      montar();
      await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_B));
      await clicar("abrir conversa do B");
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));

      desativarB();

      // A resolução tira a lista de B...
      await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));
      // ...mas o chat aberto mantém o que tinha. Sem o id de envio o texto falharia
      // ("phoneNumberId is required"), e numa linha QR valeria a janela de 24h.
      const chat = screen.getByTestId("chat");
      expect(chat).toHaveAttribute("data-conversa", "conv-b");
      expect(chat).toHaveAttribute("data-numero", h.LINHA_B);
      expect(chat).toHaveAttribute("data-meta", "qr_222");
      expect(chat).toHaveAttribute("data-qr", "true");
      expect(chat).toHaveAttribute("data-livre", "true");
      expect(ultimoTema()).toBe(195);
      expect(h.setLine).toHaveBeenLastCalledWith(h.LINHA_B, true, "user-1");
    },
  );

  it("o clique que veio antes de o mapa chegar também guarda o retrato, assim que a linha aparece nele", async () => {
    localStorage.setItem(chaveSalva, h.LINHA_B);
    montar();
    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_B));

    await clicar("abrir conversa do B");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));
    // Sem o mapa o chat já tem o id interno (a conversa é do número selecionado, que a
    // lista conhece antes do mapa); o id da Meta, o canal e a cor esperam por ele.
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);
    expect(screen.getByTestId("chat")).toHaveAttribute("data-meta", "");
    expect(screen.getByTestId("chat")).toHaveAttribute("data-qr", "false");

    act(() => h.definirLinhas(prontas(linhaA, linhaB)));
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-meta", "qr_222"));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);

    desativarB();
    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b");
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);
    expect(screen.getByTestId("chat")).toHaveAttribute("data-meta", "qr_222");
  });

  it("sem o mapa, a conversa de OUTRO número que o selecionado fica sem número: o id do selecionado não é o dela", async () => {
    localStorage.setItem(chaveSalva, h.LINHA_A);
    montar();
    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));

    await clicar("abrir conversa do B");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));

    // Mandar pelo A uma conversa do B não daria erro: sairia pelo número errado.
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", "");
    expect(h.renders.some((r) => r.conversa === "conv-b" && r.numeroDb !== "")).toBe(false);
  });

  it("com o mapa pronto, o retrato sai no próprio clique: abrir a conversa não rende a tela de novo só para guardá-lo", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();
    await screen.findByTestId("lista");
    h.renders.length = 0;

    await clicar("abrir conversa do B");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));
    await act(async () => undefined);

    expect(h.renders.filter((r) => r.conversa === "conv-b")).toHaveLength(1);
  });

  it("enquanto a linha está no mapa o mapa manda: o retrato não prende nome e cor velhos", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();
    await screen.findByTestId("lista");
    await clicar("abrir conversa do B");
    await waitFor(() => expect(ultimoTema()).toBe(195));

    act(() => h.definirLinhas(prontas(linhaA, { ...linhaB, themeHue: 40 })));

    await waitFor(() => expect(ultimoTema()).toBe(40));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);
  });
});

describe("Dashboard: deep link", () => {
  it("abre a conversa no número dela e a resolução automática não a fecha", async () => {
    localStorage.setItem(chaveSalva, h.LINHA_A);
    h.conversas["conv-dl"] = conversaNoNumero("conv-dl", linhaB);
    montar("/dashboard/conv-dl");

    // Os números ainda carregam: o embed do deep link já dá o número do chat.
    const chat = await screen.findByTestId("chat");
    await waitFor(() => expect(chat).toHaveAttribute("data-conversa", "conv-dl"));
    expect(chat).toHaveAttribute("data-numero", h.LINHA_B);
    expect(chat).toHaveAttribute("data-meta", "qr_222");
    expect(chat).toHaveAttribute("data-qr", "true");
    expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_B);
    // A escolha só é gravada depois que a lista de números confirma que o número vale.
    expect(localStorage.getItem(chaveSalva)).toBe(h.LINHA_A);

    // A corrida de antes: o seletor terminava a busca dele e escolher número
    // fechava a conversa. Agora a lista de números chegar não toca nela.
    act(() => h.definirLinhas(prontas(linhaA, linhaB)));
    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-meta", "qr_222"));

    expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-dl");
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);
    expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_B);
    expect(localStorage.getItem(chaveSalva)).toBe(h.LINHA_B);
  });

  it("conversa de número fora do mapa usa o embed, e a lista volta ao número salvo sem fechá-la nem sobrescrevê-lo", async () => {
    const desativada = {
      id: "33333333-cccc",
      displayName: "Antiga",
      themeHue: 40,
      phoneNumber: "5533",
      connectionType: "qr",
      metaPhoneNumberId: "qr_333",
      sectorIsolationEnabled: false,
    };
    localStorage.setItem(chaveSalva, h.LINHA_B);
    h.conversas["conv-dl"] = conversaNoNumero("conv-dl", desativada);
    h.definirLinhas(prontas(linhaA, linhaB));
    montar("/dashboard/conv-dl");

    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-dl"));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", desativada.id);
    expect(screen.getByTestId("chat")).toHaveAttribute("data-meta", "qr_333");
    expect(screen.getByTestId("chat")).toHaveAttribute("data-qr", "true");

    // O número da conversa não está na lista de números: a seleção volta ao que o
    // atendente tinha salvo (B), e não cai no primeiro nem regrava o salvo.
    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_B));
    expect(localStorage.getItem(chaveSalva)).toBe(h.LINHA_B);
    expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-dl");
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", desativada.id);
    // A lista nunca passou pela linha desativada: cada passada refaz a busca, zera
    // os filtros de tag e de atendente e leva o skeleton.
    expect(h.selecionados).not.toContain(desativada.id);
  });

  it("conversa que a RLS libera numa linha que o atendente não acessa (embed nulo) não troca a lista nem o número salvo", async () => {
    const semAcesso = "99999999-sem-acesso";
    localStorage.setItem(chaveSalva, h.LINHA_B);
    h.conversas["conv-sem-numero"] = {
      id: "conv-sem-numero",
      contact_name: "Atribuída a mim",
      phone_number_id: semAcesso,
      phone_number: null,
    };
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();
    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_B));

    // O toast de uma conversa atribuída a ele numa linha que ele não vê.
    await clicar("abrir conversa sem número");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-sem-numero"));

    // A lista nunca passou pelo número inacessível nem pulou para o primeiro (A)...
    expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_B);
    expect(h.selecionados).not.toContain(semAcesso);
    expect(h.selecionados).not.toContain(h.LINHA_A);
    // ...e o número que ele tinha escolhido continua salvo.
    expect(localStorage.getItem(chaveSalva)).toBe(h.LINHA_B);
    // O chat não herda o número de outra conversa: sem o número dela, fica sem número.
    expect(screen.getByTestId("chat")).not.toHaveAttribute("data-numero", h.LINHA_B);
    expect(screen.getByTestId("chat")).not.toHaveAttribute("data-numero", h.LINHA_A);
  });

  describe("com o mapa de números possivelmente velho", () => {
    it("com o mapa pronto e sem a linha da conversa, refaz o mapa da org antes de selecionar, e a lista fica no número dela", async () => {
      localStorage.setItem(chaveSalva, h.LINHA_A);
      h.conversas["conv-sem-numero"] = conversaNoNumero("conv-sem-numero", linhaB);
      // Outro admin liberou B depois da última busca: o mapa em cache só tem A.
      h.definirLinhas(prontas(linhaA));
      // A revalidação traz B, como o refetch de verdade faria.
      const refazer = vi.spyOn(queryClient, "refetchQueries").mockImplementation(async () => {
        h.definirLinhas(prontas(linhaA, linhaB));
      });
      montar();
      await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));
      h.selecionados.length = 0;

      await clicar("abrir conversa sem número");
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-sem-numero"));

      expect(refazer).toHaveBeenCalledExactlyOnceWith({ queryKey: ["numeros-acessiveis", h.ORG.id], exact: true });
      expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);
      // A resolução decidiu com o mapa novo: a lista foi para B e não pulou de volta para A.
      await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_B));
      const primeiroB = h.selecionados.indexOf(h.LINHA_B);
      expect(primeiroB).toBeGreaterThan(-1);
      expect(h.selecionados.slice(primeiroB)).not.toContain(h.LINHA_A);
      expect(localStorage.getItem(chaveSalva)).toBe(h.LINHA_B);
    });

    it("embed nulo (a RLS esconde a linha): não refaz o mapa, que não a traria, e abre a conversa sem esperar por ele", async () => {
      h.conversas["conv-sem-numero"] = {
        id: "conv-sem-numero",
        contact_name: "Atribuída a mim",
        phone_number_id: "99999999-sem-acesso",
        phone_number: null,
      };
      h.definirLinhas(prontas(linhaA, linhaB));
      const refazer = vi.spyOn(queryClient, "refetchQueries");
      montar();
      await screen.findByTestId("lista");

      await clicar("abrir conversa sem número");
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-sem-numero"));

      // O mapa e o embed passam pela mesma RLS: se o embed veio nulo, o mapa não tem a linha.
      expect(refazer).not.toHaveBeenCalled();
    });

    it("com o número da conversa já no mapa não refaz nada", async () => {
      h.conversas["conv-sem-numero"] = conversaNoNumero("conv-sem-numero", linhaB);
      h.definirLinhas(prontas(linhaA, linhaB));
      const refazer = vi.spyOn(queryClient, "refetchQueries");
      montar();
      await screen.findByTestId("lista");

      await clicar("abrir conversa sem número");
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-sem-numero"));

      expect(refazer).not.toHaveBeenCalled();
    });

    it("com o mapa ainda carregando não espera por ele: o embed já abre a conversa", async () => {
      h.conversas["conv-dl"] = conversaNoNumero("conv-dl", linhaB);
      const refazer = vi.spyOn(queryClient, "refetchQueries");

      montar("/dashboard/conv-dl");

      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-dl"));
      expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);
      expect(refazer).not.toHaveBeenCalled();
    });

    it("uma busca de deep link que volta depois de a URL mudar não seleciona a conversa velha", async () => {
      let liberar: () => void = () => undefined;
      h.retidas["conv-lenta"] = new Promise<void>((resolve) => {
        liberar = resolve;
      });
      h.conversas["conv-lenta"] = conversaNoNumero("conv-lenta", linhaB);
      h.conversas["conv-rapida"] = conversaNoNumero("conv-rapida", linhaA);
      h.definirLinhas(prontas(linhaA, linhaB));
      montar();
      await screen.findByTestId("lista");

      act(() => navegar("/dashboard/conv-lenta"));
      act(() => navegar("/dashboard/conv-rapida"));
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-rapida"));

      // A resposta da URL velha chega por último e não pode atropelar a nova.
      await act(async () => liberar());

      expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-rapida");
      expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_A);
      expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A);
    });

    it("a revalidação do mapa que volta depois de a URL mudar também não seleciona a conversa velha", async () => {
      let terminar: () => void = () => undefined;
      vi.spyOn(queryClient, "refetchQueries").mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            terminar = resolve;
          }),
      );
      h.conversas["conv-lenta"] = conversaNoNumero("conv-lenta", linhaB);
      h.conversas["conv-rapida"] = conversaNoNumero("conv-rapida", linhaA);
      // O mapa pronto só tem A: abrir a conversa do B dispara (e segura) a revalidação.
      h.definirLinhas(prontas(linhaA));
      montar();
      await screen.findByTestId("lista");

      act(() => navegar("/dashboard/conv-lenta"));
      await waitFor(() => expect(queryClient.refetchQueries).toHaveBeenCalledTimes(1));
      act(() => navegar("/dashboard/conv-rapida"));
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-rapida"));

      await act(async () => terminar());

      expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-rapida");
      expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_A);
    });
  });

  describe("voltar a uma conversa que já foi aberta pela lista", () => {
    const idsBuscados = (conversa: string) => h.eqs.filter(([coluna, valor]) => coluna === "id" && valor === conversa);

    /** Abre a conversa do A pela lista e a fecha com Esc. A lista não busca por id. */
    async function abrirEFechar() {
      h.conversas["conv-a"] = conversaNoNumero("conv-a", linhaA);
      h.definirLinhas(prontas(linhaA, linhaB));
      montar();
      await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));

      await clicar("abrir conversa do A");
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));
      expect(idsBuscados("conv-a")).toHaveLength(0);

      // No body, não no document: o handler faz target.closest.
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", ""));
    }

    it("o toast (navigate direto) abre a conversa de novo depois de fechada", async () => {
      await abrirEFechar();

      act(() => navegar("/dashboard/conv-a"));

      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));
      expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_A);
      expect(idsBuscados("conv-a")).toHaveLength(1);
    });

    it("depois de trocar de número pelo seletor (que fecha a conversa), o toast reabre a conversa", async () => {
      h.conversas["conv-a"] = conversaNoNumero("conv-a", linhaA);
      h.definirLinhas(prontas(linhaA, linhaB));
      montar();
      await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));
      await clicar("abrir conversa do A");
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));
      await clicar("escolher o número B");
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", ""));

      act(() => navegar("/dashboard/conv-a"));

      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));
      expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_A);
      // O deep link leva a lista de volta ao número da conversa.
      await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));
    });

    it("mobile: depois de voltar para a lista, o toast reabre a conversa", async () => {
      h.mobile.valor = true;
      h.conversas["conv-a"] = conversaNoNumero("conv-a", linhaA);
      h.definirLinhas(prontas(linhaA, linhaB));
      montar();
      await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));
      await clicar("abrir conversa do A");
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));
      await clicar("voltar");

      act(() => navegar("/dashboard/conv-a"));

      await waitFor(() => expect(idsBuscados("conv-a")).toHaveLength(1));
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));
      expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_A);
    });

    it("voltar e avançar no histórico reabre a conversa", async () => {
      h.conversas["conv-a"] = conversaNoNumero("conv-a", linhaA);
      h.definirLinhas(prontas(linhaA, linhaB));
      montar();
      await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));
      await clicar("abrir conversa do A");
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));

      act(() => navegar(-1));
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", ""));

      act(() => navegar(1));
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));
      expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_A);
    });

    it("fechar pelo app (Esc) não deixa o Voltar do histórico reabrir a conversa", async () => {
      await abrirEFechar();

      act(() => navegar(-1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      // Reabrir montaria o chat de novo, que marca a conversa como lida.
      expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "");
      expect(idsBuscados("conv-a")).toHaveLength(0);
    });

    it("mobile: fechar pelo botão Voltar não deixa o Voltar do histórico reabrir a conversa", async () => {
      h.mobile.valor = true;
      h.conversas["conv-a"] = conversaNoNumero("conv-a", linhaA);
      h.definirLinhas(prontas(linhaA, linhaB));
      montar();
      await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));
      await clicar("abrir conversa do A");
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));
      await clicar("voltar");
      await waitFor(() => expect(screen.queryByTestId("chat")).toBeNull(), { timeout: 2000 });

      act(() => navegar(-1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(screen.queryByTestId("chat")).toBeNull();
      expect(idsBuscados("conv-a")).toHaveLength(0);
    });

    it("clicar na lista de novo, depois de fechar, abre a conversa sem buscá-la por id", async () => {
      await abrirEFechar();

      await clicar("abrir conversa do A");

      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-a"));
      expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_A);
      expect(idsBuscados("conv-a")).toHaveLength(0);
    });
  });
});

const CONV_ACHADA = "33333333-3333-4333-8333-333333333333";

describe("Dashboard: abrir conversa pelo telefone (cartão de contato)", () => {
  it("procura e abre pelo número da conversa aberta, não pelo selecionado", async () => {
    localStorage.setItem(chaveSalva, h.LINHA_A);
    h.definirLinhas(prontas(linhaA, linhaB));
    h.achada = { id: CONV_ACHADA };
    montar();
    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));

    await clicar("abrir conversa do B");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));
    h.eqs.length = 0;

    await clicar("iniciar conversa");

    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", CONV_ACHADA));
    expect(h.rpcs).toEqual([h.LINHA_B]);
    // A conversa achada abre no mesmo número de onde o atendente chamou.
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);
    expect(screen.getByTestId("chat")).toHaveAttribute("data-qr", "true");
  });

  it("conversa que já é de outra pessoa: avisa quem é a dona, não abre nem cria", async () => {
    localStorage.setItem(chaveSalva, h.LINHA_A);
    h.definirLinhas(prontas(linhaA, linhaB));
    h.achada = { id: CONV_ACHADA, visivel: false, dono: "Ana" };
    montar();
    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));
    await clicar("abrir conversa do B");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));

    await clicar("iniciar conversa");

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Esta conversa já está com Ana",
          description: "Peça para quem está atendendo compartilhar ou transferir a conversa com você.",
          variant: "destructive",
        }),
      ),
    );
    expect(h.inseridos).toHaveLength(0);
    expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b");
  });

  it("sem conversa no número do chat, CRIA nele (e não no selecionado) e abre a nova no mesmo número", async () => {
    localStorage.setItem(chaveSalva, h.LINHA_A);
    h.definirLinhas(prontas(linhaA, linhaB));
    h.achada = null;
    montar();
    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));

    await clicar("abrir conversa do B");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));

    await clicar("iniciar conversa");

    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-nova"));
    // Mandar pelo número errado não dá erro: o insert tem de levar o número do chat (B).
    expect(h.inseridos).toHaveLength(1);
    expect(h.inseridos[0]).toMatchObject({ phone_number_id: h.LINHA_B });
    expect(String(h.inseridos[0].whatsapp_id)).toMatch(new RegExp(`_${h.LINHA_B}$`));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);
    // A lista segue no número selecionado.
    expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A);
  });

  describe("conversa aberta numa linha que o atendente não acessa (embed nulo)", () => {
    const semAcesso = "99999999-sem-acesso";

    /** Abre, como o toast, a conversa atribuída a ele numa linha que a RLS esconde: o chat só sabe o id cru dela. */
    async function abrirConversaDeLinhaAlheia() {
      localStorage.setItem(chaveSalva, h.LINHA_B);
      h.semAcesso.push(semAcesso);
      h.conversas["conv-sem-numero"] = {
        id: "conv-sem-numero",
        contact_name: "Atribuída a mim",
        phone_number_id: semAcesso,
        phone_number: null,
      };
      h.definirLinhas(prontas(linhaA, linhaB));
      montar();
      await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_B));

      await clicar("abrir conversa sem número");
      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-sem-numero"));
      h.eqs.length = 0;
    }

    it("cria a conversa no número selecionado, e não na linha alheia, onde a RLS sempre recusa", async () => {
      h.achada = null;
      await abrirConversaDeLinhaAlheia();

      await clicar("iniciar conversa");

      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-nova"));
      expect(h.rpcs).toEqual([h.LINHA_B]);
      // Um insert na linha alheia daria 42501 e o toast de erro, e tentar de novo não resolveria.
      expect(h.inseridos).toHaveLength(1);
      expect(h.inseridos[0]).toMatchObject({ phone_number_id: h.LINHA_B });
      expect(h.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Não foi possível abrir a conversa" }));
      expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Conversa criada" }));
      expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);
    });

    it("abre a conversa que já existe no número selecionado", async () => {
      h.achada = { id: CONV_ACHADA };
      await abrirConversaDeLinhaAlheia();

      await clicar("iniciar conversa");

      await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", CONV_ACHADA));
      expect(h.rpcs).toEqual([h.LINHA_B]);
      expect(h.inseridos).toHaveLength(0);
      expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);
    });
  });

  it("sem conversa aberta não há número do chat: avisa e não consulta nada", async () => {
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();
    await screen.findByTestId("chat");

    await clicar("iniciar conversa");

    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Nenhum número selecionado" }));
    expect(h.eqs).toHaveLength(0);
  });
});

describe("Dashboard: mobile", () => {
  it("o painel que sai ainda recebe o número da conversa que saiu, não o selecionado", async () => {
    localStorage.setItem(chaveSalva, h.LINHA_A);
    h.mobile.valor = true;
    h.definirLinhas(prontas(linhaA, linhaB));
    montar();
    await waitFor(() => expect(screen.getByTestId("lista")).toHaveAttribute("data-numero", h.LINHA_A));

    await clicar("abrir conversa do B");
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b"));
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);

    await clicar("voltar");

    // Durante o slide-out o painel segue montado com a conversa e o número dela.
    expect(screen.getByTestId("chat")).toHaveAttribute("data-conversa", "conv-b");
    expect(screen.getByTestId("chat")).toHaveAttribute("data-numero", h.LINHA_B);
    // Mas o tema e a ligação já não seguem uma conversa que não está aberta.
    expect(ultimoTema()).toBe(176);
    expect(h.setLine).toHaveBeenLastCalledWith(h.LINHA_A, false, "user-1");

    await waitFor(() => expect(screen.queryByTestId("chat")).toBeNull(), { timeout: 2000 });
  });
});
