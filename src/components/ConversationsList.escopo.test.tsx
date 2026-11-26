// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import type { User } from "@supabase/supabase-js";
import type { Conversation } from "@/types/conversation";

/**
 * A lista real contra um servidor falso: o que ela pede, o que mostra e quando
 * revalida com um conjunto de números no escopo. As linhas, os diálogos e o
 * contexto de notificação são falsos (só expõem o que a lista lhes entrega); o
 * "servidor" é um banco de conversas em memória que entende os filtros que a lista usa
 * (`.eq`, `.in`, `.gt`, `.order`, `.range`, `count`).
 */

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no seguinte.
afterEach(cleanup);

const LINHA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINHA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINHA_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

interface LinhaDoBanco {
  id: string;
  contact_name: string;
  contact_phone: string;
  last_message_at: string;
  updated_at: string;
  status: string;
  phone_number_id: string;
  sector_id: null;
  assigned_to: string | null;
  is_group: boolean;
  contact_avatar_url: null;
  contact_avatar_updated_at: null;
  profiles: null;
  conversation_assignees: Array<{ user_id: string }>;
}

interface Consulta {
  tipo: "pagina" | "incremental";
  numeros: string[];
  from: number;
  comCount: boolean;
  atualizadoApos?: string;
}

const h = vi.hoisted(() => {
  const loja = {
    conversations: [] as unknown[],
    unreadCounts: new Map<string, number>(),
    markedUnread: new Set<string>(),
    prefs: new Map<string, { pinned_at: string | null; archived_at: string | null; muted_until: string | null }>(),
    ouvintes: new Set<() => void>(),
    versao: 0,
  };
  return {
    loja,
    emitir() {
      loja.versao += 1;
      loja.ouvintes.forEach((ouvinte) => ouvinte());
    },
    banco: [] as unknown[],
    consultas: [] as unknown[],
    /** Números cujas consultas de página falham. */
    falhando: new Set<string>(),
    /** Se as consultas incrementais falham. */
    incrementalFalha: { valor: false },
    /** Quando preenchido, a resposta das consultas espera esta promessa. */
    retida: { valor: null as Promise<void> | null },
    /** O mesmo, para as consultas de página de UM número (a página 1 de B demora, a de A não). */
    retidaPorNumero: new Map<string, Promise<void>>(),
    /** Quando preenchido, as consultas de página a partir de `de` esperam esta promessa (a primeira passa). */
    retidaAPartirDe: { valor: null as null | { de: number; promessa: Promise<void> } },
    /** A tabela de co-responsáveis do servidor. */
    coResponsaveis: [] as Array<{ conversation_id: string; user_id: string; numeroId: string }>,
    /** Cada leitura do retrato de co-responsáveis (os números pedidos e a página). */
    consultasCo: [] as Array<{ numeros: string[]; from: number }>,
    /** Se a leitura do retrato de co-responsáveis falha. */
    coFalha: { valor: false },
    poll: { valor: null as null | (() => unknown) },
    canal: {
        status: null as null | ((status: string) => void),
        /** Os callbacks do postgres_changes de cada tabela, para o teste fazer o realtime falar. */
        conversas: null as null | ((payload: unknown) => void),
        assignees: null as null | ((payload: unknown) => void),
    },
    mobile: { valor: false },
    /** O pedido de recarga que o contexto entrega à lista (o teste manda um pelo `emitir`). */
    pedido: { valor: { seq: 0, conversationId: null } as { seq: number; conversationId: string | null } },
    setUnreadScope: vi.fn(),
    refreshUnreadCounts: vi.fn(() => Promise.resolve(undefined)),
    refreshConversationById: vi.fn((_id: string) => Promise.resolve()),
    toast: vi.fn(),
    selecionadas: [] as string[],
  };
});

vi.mock("@/integrations/supabase/client", () => {
  const vazio = () => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.in = () => c;
    c.order = () => c;
    c.then = (resolve: (valor: unknown) => unknown, reject: (erro: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);
    return c;
  };

  // `conversation_assignees` com o embed do número da conversa, como o retrato pede.
  const coResponsaveis = () => {
    let numeros: string[] = [];
    let faixa: [number, number] = [0, 999];
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.in = (_coluna: string, valores: string[]) => ((numeros = valores), c);
    c.order = () => c;
    c.range = (de: number, ate: number) => ((faixa = [de, ate]), c);
    c.then = (resolve: (valor: unknown) => unknown, reject: (erro: unknown) => unknown) => {
      h.consultasCo.push({ numeros, from: faixa[0] });
      const executar = async () => {
        // O servidor lê quando a consulta chega; a resposta é que pode demorar.
        const linhas = h.coResponsaveis
          .filter((linha) => numeros.includes(linha.numeroId))
          .slice(faixa[0], faixa[1] + 1)
          .map((linha) => ({
            conversation_id: linha.conversation_id,
            user_id: linha.user_id,
            conversations: { phone_number_id: linha.numeroId },
          }));
        const retida = h.retida.valor;
        if (retida) await retida;
        if (h.coFalha.valor) return { data: null, count: null, error: { message: "co-responsáveis caiu" } };
        return { data: linhas, count: null, error: null };
      };
      return executar().then(resolve, reject);
    };
    return c;
  };

  const conversas = () => {
    const filtros: Array<["eq" | "in" | "gt", string, unknown]> = [];
    const ordem: Array<[string, boolean]> = [];
    let faixa: [number, number] = [0, 999];
    let comCount = false;
    const c: Record<string, unknown> = {};
    c.select = (_colunas: string, opcoes?: { count?: string }) => {
      comCount = opcoes?.count === "exact";
      return c;
    };
    c.eq = (coluna: string, valor: unknown) => (filtros.push(["eq", coluna, valor]), c);
    c.in = (coluna: string, valores: unknown) => (filtros.push(["in", coluna, valores]), c);
    c.gt = (coluna: string, valor: unknown) => (filtros.push(["gt", coluna, valor]), c);
    c.order = (coluna: string, opcoes?: { ascending?: boolean }) => (ordem.push([coluna, opcoes?.ascending !== false]), c);
    c.range = (de: number, ate: number) => ((faixa = [de, ate]), c);
    c.then = (resolve: (valor: unknown) => unknown, reject: (erro: unknown) => unknown) => {
      const eq = filtros.find(([tipo, coluna]) => tipo === "eq" && coluna === "phone_number_id");
      const em = filtros.find(([tipo, coluna]) => tipo === "in" && coluna === "phone_number_id");
      const gt = filtros.find(([tipo]) => tipo === "gt");
      const numeros = eq ? [String(eq[2])] : ((em?.[2] as string[] | undefined) ?? []);
      const consulta: Consulta = {
        tipo: gt ? "incremental" : "pagina",
        numeros,
        from: faixa[0],
        comCount,
        atualizadoApos: gt ? String(gt[2]) : undefined,
      };
      h.consultas.push(consulta);

      const executar = async () => {
        // O servidor lê no instante em que a consulta chega; o que demora é a resposta. É o que
        // deixa o teste mexer no banco (ou no realtime) entre a leitura e o commit.
        let linhas = (h.banco as LinhaDoBanco[]).filter((linha) => numeros.includes(linha.phone_number_id));
        if (gt) linhas = linhas.filter((linha) => Date.parse(linha.updated_at) > Date.parse(String(gt[2])));
        for (const [coluna, crescente] of [...ordem].reverse()) {
          linhas = [...linhas].sort((a, b) => {
            const va = String((a as unknown as Record<string, unknown>)[coluna]);
            const vb = String((b as unknown as Record<string, unknown>)[coluna]);
            return crescente ? va.localeCompare(vb) : vb.localeCompare(va);
          });
        }
        const resposta = { data: linhas.slice(faixa[0], faixa[1] + 1), count: comCount ? linhas.length : null, error: null };

        const retida = h.retida.valor;
        const retidaDoNumero = eq ? h.retidaPorNumero.get(String(eq[2])) : undefined;
        if (retida) await retida;
        if (retidaDoNumero) await retidaDoNumero;
        const retidaAPartir = h.retidaAPartirDe.valor;
        if (retidaAPartir && consulta.from >= retidaAPartir.de) await retidaAPartir.promessa;
        if (!gt && eq && h.falhando.has(String(eq[2]))) {
          // Como na produção: o PostgREST devolve o statement timeout como 500 com código 57014,
          // que não é repetido (o 5xx comum tem nova tentativa, coberta em conversationListFetch.test.ts).
          return { data: null, count: null, error: { message: "statement timeout", code: "57014" }, status: 500 };
        }
        if (gt && h.incrementalFalha.valor) {
          return { data: null, count: null, error: { message: "incremental caiu" } };
        }
        return resposta;
      };
      return executar().then(resolve, reject);
    };
    return c;
  };

  const canalFalso = () => {
    const canal: Record<string, unknown> = {};
    canal.on = (_tipo: string, filtro: { table?: string }, aoMudar: (payload: unknown) => void) => {
      if (filtro?.table === "conversations") h.canal.conversas = aoMudar;
      if (filtro?.table === "conversation_assignees") h.canal.assignees = aoMudar;
      return canal;
    };
    canal.subscribe = (aoMudarStatus?: (status: string) => void) => {
      h.canal.status = aoMudarStatus ?? null;
      aoMudarStatus?.("SUBSCRIBED");
      return canal;
    };
    return canal;
  };

  return {
    supabase: {
      from: (tabela: string) => {
        if (tabela === "conversations") return conversas();
        if (tabela === "conversation_assignees") return coResponsaveis();
        return vazio();
      },
      rpc: () => Promise.resolve({ data: [], error: null }),
      channel: () => canalFalso(),
      removeChannel: () => undefined,
    },
  };
});

// Contexto de notificação falso, sobre uma loja externa: a lista escreve a lista de
// conversas nele (como no real) e o teste mexe no não-lido.
vi.mock("@/contexts/NotificationContext", async () => {
  const { useSyncExternalStore, useMemo } = await import("react");
  return {
    useNotifications: () => {
      useSyncExternalStore(
        (ouvinte) => {
          h.loja.ouvintes.add(ouvinte);
          return () => h.loja.ouvintes.delete(ouvinte);
        },
        () => h.loja.versao,
      );
      return useMemo(
        () => ({
          conversations: h.loja.conversations,
          setConversations: (atualizacao: unknown) => {
            h.loja.conversations =
              typeof atualizacao === "function"
                ? (atualizacao as (prev: unknown[]) => unknown[])(h.loja.conversations)
                : (atualizacao as unknown[]);
            h.emitir();
          },
          unreadCounts: h.loja.unreadCounts,
          markedUnread: h.loja.markedUnread,
          resetUnread: (id: string) => {
            if (h.loja.unreadCounts.has(id)) {
              h.loja.unreadCounts = new Map(h.loja.unreadCounts);
              h.loja.unreadCounts.delete(id);
              h.emitir();
            }
            return Promise.resolve();
          },
          markConversationUnread: () => Promise.resolve(true),
          markAllAsRead: () => Promise.resolve(0),
          refreshUnreadCounts: h.refreshUnreadCounts,
          setUnreadScope: h.setUnreadScope,
          conversationRefreshRequest: h.pedido.valor,
          refreshConversationById: h.refreshConversationById,
          findConversation: (id: string) => (h.loja.conversations as Array<{ id: string }>).find((c) => c.id === id),
          failedCounts: new Map(),
          resetFailed: () => undefined,
          conversationPrefs: h.loja.prefs,
          togglePinned: () => Promise.resolve(true),
          toggleArchived: () => Promise.resolve(true),
          setMutedUntil: () => Promise.resolve(true),
          isMuted: () => false,
        }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [h.loja.versao],
      );
    },
  };
});

vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ currentOrganization: { id: "org-1", name: "Org" } }),
}));
vi.mock("@/contexts/VoiceCallContext", () => ({ useVoiceCalls: () => ({ canCall: false }) }));
vi.mock("@/hooks/useVoiceCallsEnabled", () => ({ useVoiceCallsEnabled: () => [false, () => undefined] }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => h.mobile.valor }));
// O gesto de puxar não existe no jsdom: o botão chama o `onRefresh` que a lista entrega.
vi.mock("@/components/ui/pull-to-refresh", () => ({
  PullToRefresh: ({ onRefresh, children }: { onRefresh: () => Promise<void>; children: React.ReactNode }) => (
    <div>
      <button type="button" data-testid="puxar" onClick={() => void onRefresh()}>
        puxar
      </button>
      {children}
    </div>
  ),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => () => undefined }));
vi.mock("@/hooks/useRealtimeFallbackPoll", () => ({
  useRealtimeFallbackPoll: (poll: () => unknown) => {
    h.poll.valor = poll;
  },
}));
vi.mock("@/lib/realtimeHealth", () => ({ reportChannelHealth: () => undefined }));
vi.mock("@/lib/nativeNotification", () => ({
  ensureNotificationPermission: () => Promise.resolve("default"),
  notificationPermission: () => "default",
}));
vi.mock("@/hooks/chat/useConversation", () => ({
  useConversation: () => ({ transferConversation: async () => false, releaseConversation: async () => false }),
}));
vi.mock("@/hooks/useSectors", () => {
  const estavel = {
    sectors: [],
    byId: new Map(),
    mySectorIds: [],
    defaultSectorId: null,
    isolationEnabled: false,
  };
  return { useSectors: () => estavel };
});
vi.mock("@/hooks/useAccessiblePhoneNumbers", () => {
  const numeros = {
    phoneNumbers: [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", displayName: "Vendas" },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", displayName: "Suporte" },
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", displayName: "Financeiro" },
    ],
    isLoading: false,
    isReady: true,
  };
  return {
    contarNumerosAtivos: async () => 1,
    useAccessiblePhoneNumbers: () => numeros,
  };
});

// A lista virtualizada não mede nada no jsdom: renderiza todas as linhas.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({ data, itemContent }: { data: unknown[]; itemContent: (index: number, item: unknown) => React.ReactNode }) => (
    <div data-testid="virtuoso">{data.map((item, index) => itemContent(index, item))}</div>
  ),
}));

vi.mock("./ConversationRow", () => ({
  ConversationRow: ({
    conversation,
    actions,
  }: {
    conversation: { id: string; contact_name: string; phone_number_id: string };
    actions: { select: (id: string) => void };
  }) => (
    <button
      type="button"
      data-testid="linha"
      data-numero={conversation.phone_number_id}
      data-id={conversation.id}
      onClick={() => actions.select(conversation.id)}
    >
      {conversation.contact_name}
    </button>
  ),
}));

vi.mock("./PhoneNumberSelector", () => ({ default: () => null }));
vi.mock("./StartConversationDialog", () => ({ default: () => null }));
vi.mock("./CreateGroupDialog", () => ({ default: () => null }));
vi.mock("./SectorPickerDialog", () => ({ default: () => null }));
vi.mock("./GlobalSearchDialog", () => ({ GlobalSearchDialog: () => null }));
vi.mock("./TransferConversationDialog", () => ({ TransferConversationDialog: () => null }));
vi.mock("./StatusIndicator", () => ({ StatusIndicator: () => null }));
vi.mock("./ConversationFilterPopover", () => ({ ConversationFilterPopover: () => null }));

const { default: ConversationsList } = await import("./ConversationsList");
const { conversationListCache } = await import("@/lib/conversationListCache");

let contador = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const minutos = (n: number) => new Date(Date.parse("2026-10-21T12:00:00.000Z") + n * 60_000).toISOString();

const linhaDoBanco = (
  numeroId: string,
  nome: string,
  extras: Partial<LinhaDoBanco> & { minuto?: number; atualizadoMinuto?: number } = {},
): LinhaDoBanco => {
  const { minuto = 0, atualizadoMinuto = minuto, ...resto } = extras;
  return {
    id: uuid(++contador),
    contact_name: nome,
    contact_phone: String(5511900000000 + contador),
    last_message_at: minutos(minuto),
    updated_at: minutos(atualizadoMinuto),
    status: "active",
    phone_number_id: numeroId,
    sector_id: null,
    assigned_to: null,
    is_group: false,
    contact_avatar_url: null,
    contact_avatar_updated_at: null,
    profiles: null,
    conversation_assignees: [],
    ...resto,
  };
};

const usuario = { id: "user-1", email: "a@x.com" } as User;

interface PropsDaLista {
  escopo: readonly string[];
  numeroUnico?: string | null;
  selectedConversationId?: string | null;
}

function Lista({ escopo, numeroUnico = escopo.length === 1 ? escopo[0] : null, selectedConversationId = null }: PropsDaLista) {
  return (
    <ConversationsList
      userId="user-1"
      user={usuario}
      onSignOut={() => undefined}
      selectedConversationId={selectedConversationId}
      onSelectConversation={(id) => h.selecionadas.push(id)}
      escopo={escopo}
      numeroUnico={numeroUnico}
      onPhoneSelect={() => undefined}
    />
  );
}

const renderizar = (props: PropsDaLista) => render(<Lista {...props} />);

const linhasNaTela = () => screen.queryAllByTestId("linha").map((linha) => linha.textContent);
const ordemNaTela = () => screen.queryAllByTestId("linha").map((linha) => linha.getAttribute("data-id"));

/** Consultas feitas desde o último `limparConsultas`. */
const consultas = () => h.consultas as Consulta[];
const limparConsultas = () => {
  h.consultas.length = 0;
};
const paginas = () => consultas().filter((c) => c.tipo === "pagina");
const incrementais = () => consultas().filter((c) => c.tipo === "incremental");

/** Espera a lista sair do skeleton e das cargas (páginas, rodapé). */
const carregada = async () => {
  await waitFor(() => expect(screen.queryByText("Carregando mais…")).not.toBeInTheDocument());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const assentar = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Segura as respostas das consultas que SAEM a partir daqui: o servidor já leu, a resposta é
 * que demora. `soltarNovas` deixa passar as consultas seguintes e mantém presas as que já
 * esperam; `liberar` solta tudo.
 */
const segurar = () => {
  let resolver: () => void = () => undefined;
  const promessa = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  h.retida.valor = promessa;
  return {
    soltarNovas: () => {
      if (h.retida.valor === promessa) h.retida.valor = null;
    },
    liberar: () => {
      if (h.retida.valor === promessa) h.retida.valor = null;
      resolver();
    },
  };
};

const ficarVisivel = () =>
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

/** A rede do navegador (`navigator.onLine` é só leitura no jsdom): redefinida para o teste. */
const naRede = (online: boolean) => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });

/** Segura só as páginas a partir de `de` (a primeira passa; as seguintes esperam `liberar`). */
const segurarAPartirDe = (de: number) => {
  let resolver: () => void = () => undefined;
  const promessa = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  h.retidaAPartirDe.valor = { de, promessa };
  return {
    liberar: () => {
      if (h.retidaAPartirDe.valor?.promessa === promessa) h.retidaAPartirDe.valor = null;
      resolver();
    },
  };
};

/** O realtime fala: um postgres_changes de `conversations`. */
const eventoDeConversa = (
  evento: { eventType: "UPDATE" | "INSERT"; linha: LinhaDoBanco; mudancas?: Partial<LinhaDoBanco> } | { eventType: "DELETE"; id: string },
) =>
  act(() => {
    h.canal.conversas?.(
      evento.eventType === "DELETE"
        ? { eventType: "DELETE", old: { id: evento.id } }
        : { eventType: evento.eventType, new: { ...evento.linha, ...evento.mudancas }, old: { id: evento.linha.id } },
    );
  });

/** A conversa como a lista a guarda em memória (o estado do contexto). */
const emMemoria = (id: string) => (h.loja.conversations as Conversation[]).find((conv) => conv.id === id);

beforeEach(() => {
  contador = 0;
  h.loja.conversations = [];
  h.loja.unreadCounts = new Map();
  h.loja.markedUnread = new Set();
  h.loja.prefs = new Map();
  h.loja.versao += 1;
  h.banco = [];
  h.consultas.length = 0;
  h.falhando.clear();
  h.incrementalFalha.valor = false;
  h.retida.valor = null;
  h.retidaPorNumero.clear();
  h.retidaAPartirDe.valor = null;
  h.pedido.valor = { seq: 0, conversationId: null };
  h.coResponsaveis = [];
  h.consultasCo.length = 0;
  h.coFalha.valor = false;
  h.poll.valor = null;
  h.canal.status = null;
  h.canal.conversas = null;
  h.canal.assignees = null;
  h.mobile.valor = false;
  h.selecionadas.length = 0;
  h.setUnreadScope.mockClear();
  h.refreshUnreadCounts.mockClear();
  h.refreshConversationById.mockClear();
  h.toast.mockClear();
  conversationListCache.clear();
  conversationListCache.setCapacity(4);
  localStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConversationsList — escopo de um número (comportamento de sempre)", () => {
  it("busca o número com count na página 1, mostra as conversas e avisa o não-lido", async () => {
    h.banco = [linhaDoBanco(LINHA_A, "Ana", { minuto: 3 }), linhaDoBanco(LINHA_A, "Bia", { minuto: 2 }), linhaDoBanco(LINHA_B, "Outra", { minuto: 9 })];
    renderizar({ escopo: [LINHA_A] });
    await carregada();

    // Mais nova primeiro, e só as do número.
    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Bia"]));
    expect(paginas()).toEqual([{ tipo: "pagina", numeros: [LINHA_A], from: 0, comCount: true, atualizadoApos: undefined }]);
    expect(h.setUnreadScope).toHaveBeenLastCalledWith([LINHA_A]);
  });

  it("a lista só mostra o que é do escopo, mesmo que o estado traga conversas de outro número", async () => {
    h.banco = [linhaDoBanco(LINHA_A, "Ana")];
    h.loja.conversations = [
      { ...linhaDoBanco(LINHA_B, "Intrusa"), last_message_preview: undefined },
    ];
    renderizar({ escopo: [LINHA_A] });
    await carregada();

    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana"]));
  });

  it("página 1 cheia: pede as demais sem count e fecha o conjunto", async () => {
    h.banco = Array.from({ length: 1200 }, (_, i) => linhaDoBanco(LINHA_A, `Conv ${i}`, { minuto: i }));
    renderizar({ escopo: [LINHA_A] });
    await waitFor(() => expect(linhasNaTela()).toHaveLength(1200), { timeout: 4000 });

    expect(paginas().map((p) => [p.from, p.comCount])).toEqual([
      [0, true],
      [1000, false],
    ]);
  });

  it("re-renderizar com outro array de MESMO conteúdo não busca de novo", async () => {
    h.banco = [linhaDoBanco(LINHA_A, "Ana")];
    const { rerender } = renderizar({ escopo: [LINHA_A] });
    await carregada();
    const antes = consultas().length;
    h.refreshUnreadCounts.mockClear();

    rerender(<Lista escopo={[LINHA_A]} />);
    rerender(<Lista escopo={[...[LINHA_A]]} />);
    await carregada();

    expect(consultas().length).toBe(antes);
    expect(h.refreshUnreadCounts).not.toHaveBeenCalled();
  });

  it("sem número escolhido não busca conversas (só confere se a org tem números)", async () => {
    renderizar({ escopo: [], numeroUnico: null });
    await carregada();
    expect(consultas()).toEqual([]);
  });
});

describe("ConversationsList — vários números no escopo", () => {
  beforeEach(() => {
    h.banco = [
      linhaDoBanco(LINHA_A, "Ana", { minuto: 5 }),
      linhaDoBanco(LINHA_A, "Alice", { minuto: 1 }),
      linhaDoBanco(LINHA_B, "Beto", { minuto: 4 }),
      linhaDoBanco(LINHA_C, "Carla", { minuto: 9 }),
    ];
  });

  it("busca um número por vez e junta tudo numa lista só, ordenada pela atividade", async () => {
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();

    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Beto", "Alice"]));
    expect(paginas().map((p) => p.numeros).sort()).toEqual([[LINHA_A], [LINHA_B]].sort());
    expect(paginas().every((p) => p.comCount && p.from === 0)).toBe(true);
    expect(h.setUnreadScope).toHaveBeenLastCalledWith([LINHA_A, LINHA_B]);
    // Uma conversa de um número fora do escopo nunca aparece.
    expect(linhasNaTela()).not.toContain("Carla");
  });

  it("a mesma conversa nos dois números (mudou de A para B durante a busca) aparece uma vez só", async () => {
    const movida = linhaDoBanco(LINHA_A, "Movida", { minuto: 7 });
    h.banco = [movida, linhaDoBanco(LINHA_B, "Beto", { minuto: 4 })];
    // O banco devolve a conversa pelos dois números, como no meio da mudança.
    const copiaNoB = { ...movida, phone_number_id: LINHA_B };
    h.banco = [movida, copiaNoB, linhaDoBanco(LINHA_B, "Beto", { minuto: 4 })];

    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();

    await waitFor(() => expect(linhasNaTela().filter((nome) => nome === "Movida")).toHaveLength(1));
    expect(new Set(ordemNaTela()).size).toBe(ordemNaTela().length);
  });

  it("trocar do escopo [A] para [A, B] pinta A do cache na hora e busca os dois", async () => {
    const { rerender } = renderizar({ escopo: [LINHA_A] });
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Alice"]));
    limparConsultas();

    // Retém as respostas: o que aparece até lá vem do cache.
    let liberar: () => void = () => undefined;
    h.retida.valor = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    rerender(<Lista escopo={[LINHA_A, LINHA_B]} />);

    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Alice"]));
    expect(screen.queryByTestId("virtuoso")).toBeInTheDocument();

    await act(async () => {
      h.retida.valor = null;
      liberar();
    });
    await carregada();

    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Beto", "Alice"]));
    expect(paginas().map((p) => p.numeros[0]).sort()).toEqual([LINHA_A, LINHA_B].sort());
  });

  it("sem nenhum número do escopo em cache, o skeleton cobre a espera", async () => {
    let liberar: () => void = () => undefined;
    h.retida.valor = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    const { container } = renderizar({ escopo: [LINHA_A, LINHA_B] });

    await waitFor(() => expect(container.querySelector(".animate-pulse")).not.toBeNull());
    expect(linhasNaTela()).toEqual([]);

    await act(async () => {
      h.retida.valor = null;
      liberar();
    });
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toHaveLength(3));
  });

  it("a capacidade do cache acompanha o tamanho do escopo e volta ao piso", async () => {
    const seis = [LINHA_A, LINHA_B, LINHA_C, uuid(901), uuid(902), uuid(903)];
    const { rerender } = renderizar({ escopo: seis });
    await carregada();
    expect(conversationListCache.capacity()).toBe(7);

    rerender(<Lista escopo={[LINHA_A]} />);
    await carregada();
    expect(conversationListCache.capacity()).toBe(4);
  });

  it("encolher o escopo não perde do cache o número que continua", async () => {
    const { rerender } = renderizar({ escopo: [LINHA_A, LINHA_B, LINHA_C, uuid(901), uuid(902), uuid(903)] });
    await carregada();

    rerender(<Lista escopo={[LINHA_B]} />);
    await carregada();

    expect(conversationListCache.get(LINHA_B)?.rows.map((r) => r.contact_name)).toEqual(["Beto"]);
  });

  it("encolher de [A, B] para [A] tira as conversas de B da tela na hora e do estado no primeiro commit", async () => {
    const { rerender } = renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Beto", "Alice"]));

    let liberar: () => void = () => undefined;
    h.retida.valor = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    rerender(<Lista escopo={[LINHA_A]} />);

    // Com a busca ainda em voo, B já não aparece.
    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Alice"]));

    await act(async () => {
      h.retida.valor = null;
      liberar();
    });
    await carregada();

    expect(linhasNaTela()).toEqual(["Ana", "Alice"]);
    expect((h.loja.conversations as LinhaDoBanco[]).every((c) => c.phone_number_id === LINHA_A)).toBe(true);
  });

  it("a conversa que está nos caches de dois números pinta uma vez só, com a versão do cache mais novo", async () => {
    const noCache = (numeroId: string, nome: string): Conversation => ({
      id: uuid(777),
      contact_name: nome,
      contact_phone: "5511999990001",
      last_message_at: minutos(3),
      status: "active",
      phone_number_id: numeroId,
      sector_id: null,
      assigned_to: null,
      is_group: false,
      co_assignee_ids: [],
    });
    conversationListCache.set(LINHA_A, { rows: [noCache(LINHA_A, "Movida (antes)")], fetchedAt: 1_000, complete: true });
    conversationListCache.set(LINHA_B, { rows: [noCache(LINHA_B, "Movida (depois)")], fetchedAt: 2_000, complete: true });
    h.banco = [];
    let liberar: () => void = () => undefined;
    h.retida.valor = new Promise<void>((resolve) => {
      liberar = resolve;
    });

    renderizar({ escopo: [LINHA_A, LINHA_B] });

    await waitFor(() => expect(linhasNaTela()).toEqual(["Movida (depois)"]));
    await act(async () => {
      h.retida.valor = null;
      liberar();
    });
    await carregada();
  });

  it("o espelho só grava no cache os números que já têm commit", async () => {
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();

    await waitFor(() => expect(conversationListCache.get(LINHA_A)).toBeDefined());
    // B falhou sem nunca carregar: não há retrato dele a guardar.
    expect(conversationListCache.get(LINHA_B)).toBeUndefined();
  });
});

describe("ConversationsList — número que falha", () => {
  beforeEach(() => {
    h.banco = [linhaDoBanco(LINHA_A, "Ana", { minuto: 5 }), linhaDoBanco(LINHA_B, "Beto", { minuto: 4 })];
  });

  it("mantém as conversas dos que carregaram e avisa qual falhou, com o botão de tentar novamente", async () => {
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();

    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana"]));
    const faixa = await screen.findByRole("status");
    expect(faixa).toHaveTextContent("Não foi possível carregar Suporte");
    expect(within(faixa).getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();
  });

  it("um aviso por lote, não um por número", async () => {
    h.falhando.add(LINHA_A);
    h.falhando.add(LINHA_B);
    h.banco = [linhaDoBanco(LINHA_C, "Carla")];
    renderizar({ escopo: [LINHA_A, LINHA_B, LINHA_C] });
    await carregada();

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Vendas e Suporte"));
    expect(h.toast).toHaveBeenCalledTimes(1);
    // O texto é fixo: o erro cru do banco ("statement timeout") não chega à tela.
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "destructive",
        title: "Não foi possível carregar todas as conversas",
        description: "Verifique a conexão e tente novamente.",
      }),
    );
  });

  it("tentar novamente refaz a busca, e a faixa sai quando o número carrega", async () => {
    const usuarioEvento = userEvent.setup();
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await screen.findByRole("status");

    h.falhando.delete(LINHA_B);
    limparConsultas();
    await usuarioEvento.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await carregada();

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(linhasNaTela()).toEqual(["Ana", "Beto"]);
    // Um fetch completo do escopo, não o incremental.
    expect(paginas().length).toBeGreaterThan(0);
    expect(incrementais()).toEqual([]);
  });

  it("todos falharam e a lista está vazia: o estado de erro de sempre, sem faixa e sem aviso", async () => {
    h.falhando.add(LINHA_A);
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();

    expect(await screen.findByText("Não foi possível carregar as conversas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tentar novamente/ })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("um número só que falha com a lista vazia também cai no estado de erro", async () => {
    h.falhando.add(LINHA_A);
    renderizar({ escopo: [LINHA_A] });
    await carregada();
    expect(await screen.findByText("Não foi possível carregar as conversas")).toBeInTheDocument();
  });

  it("uma nova tentativa não mostra a faixa enquanto corre: o que chega entra, e a faixa só volta se ela falhar", async () => {
    const usuarioEvento = userEvent.setup();
    h.banco = Array.from({ length: 1200 }, (_, i) => linhaDoBanco(LINHA_A, `Conversa ${i}`, { minuto: i }));
    h.falhando.add(LINHA_A);
    renderizar({ escopo: [LINHA_A] });
    await carregada();
    expect(await screen.findByText("Não foi possível carregar as conversas")).toBeInTheDocument();

    // A rede voltou: a primeira página chega, a segunda demora.
    h.falhando.delete(LINHA_A);
    const segunda = segurarAPartirDe(1000);
    await usuarioEvento.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(linhasNaTela()).toHaveLength(1000));
    // Antes, a faixa ficava até a última página, com o botão desligado.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    segunda.liberar();
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toHaveLength(1200));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("o botão 'Tentar novamente' do estado de erro fica desligado enquanto uma busca de fundo corre", async () => {
    h.falhando.add(LINHA_A);
    renderizar({ escopo: [LINHA_A] });
    await carregada();
    expect(await screen.findByText("Não foi possível carregar as conversas")).toBeInTheDocument();

    // A rede volta pelo `online`: a busca de fundo segura o botão até terminar.
    h.falhando.delete(LINHA_A);
    const retida = segurar();
    await act(async () => {
      ficarVisivel();
      window.dispatchEvent(new Event("online"));
      await assentar();
    });
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeDisabled();

    retida.liberar();
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana"]));
  });

  it("tentar novamente que falha de novo avisa com um toast, e a faixa volta", async () => {
    const usuarioEvento = userEvent.setup();
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await screen.findByRole("status");
    h.toast.mockClear();

    await usuarioEvento.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Suporte");
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
  });
});

describe("ConversationsList — revalidação incremental", () => {
  beforeEach(() => {
    h.banco = [
      linhaDoBanco(LINHA_A, "Ana", { minuto: 5, atualizadoMinuto: 10 }),
      linhaDoBanco(LINHA_B, "Beto", { minuto: 4, atualizadoMinuto: 30 }),
    ];
  });

  async function carregarOsDois() {
    const montado = renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toHaveLength(2));
    limparConsultas();
    return montado;
  }

  it("o poll busca só o que mudou, numa requisição, a partir da marca d'água do servidor menos 2 min", async () => {
    await carregarOsDois();
    // Algo muda em B depois do último que a lista viu.
    h.banco = [...h.banco, linhaDoBanco(LINHA_B, "Nova", { minuto: 8, atualizadoMinuto: 40 })];

    await act(async () => {
      await h.poll.valor?.();
    });

    expect(paginas()).toEqual([]);
    expect(incrementais()).toHaveLength(1);
    expect(incrementais()[0].numeros.sort()).toEqual([LINHA_A, LINHA_B].sort());
    // Maior updated_at visto (minuto 30) menos 2 minutos.
    expect(incrementais()[0].atualizadoApos).toBe(new Date(Date.parse(minutos(30)) - 120_000).toISOString());
    await waitFor(() => expect(linhasNaTela()).toContain("Nova"));
  });

  it("atualiza a conversa que mudou e não tira as que não vieram", async () => {
    await carregarOsDois();
    h.banco = (h.banco as LinhaDoBanco[]).map((linha) =>
      linha.contact_name === "Ana" ? { ...linha, contact_name: "Ana Maria", updated_at: minutos(50), last_message_at: minutos(20) } : linha,
    );

    await act(async () => {
      await h.poll.valor?.();
    });

    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana Maria", "Beto"]));
  });

  it("a marca d'água avança com o que o servidor devolveu", async () => {
    await carregarOsDois();
    h.banco = [...h.banco, linhaDoBanco(LINHA_A, "Nova", { minuto: 8, atualizadoMinuto: 60 })];
    await act(async () => {
      await h.poll.valor?.();
    });
    limparConsultas();

    await act(async () => {
      await h.poll.valor?.();
    });

    expect(incrementais()[0].atualizadoApos).toBe(new Date(Date.parse(minutos(60)) - 120_000).toISOString());
  });

  describe("com a aba escondida", () => {
    const DONO_NOVO = uuid(900);

    it("o poll segue no incremental (uma requisição, nenhuma página) e o dono novo chega à lista em memória", async () => {
      await carregarOsDois();
      const escondida = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      // Uma integração (API) atribui a Ana a alguém e o UPDATE se perde no realtime: o gate de notificação lê o
      // dono da lista em memória, e uma lista congelada com a aba escondida o deixaria velho.
      h.banco = (h.banco as LinhaDoBanco[]).map((linha) =>
        linha.contact_name === "Ana" ? { ...linha, assigned_to: DONO_NOVO, updated_at: minutos(50) } : linha,
      );

      await act(async () => {
        await h.poll.valor?.();
      });
      escondida.mockRestore();

      expect(paginas()).toEqual([]);
      expect(incrementais()).toHaveLength(1);
      expect((h.loja.conversations as Conversation[]).find((conv) => conv.contact_name === "Ana")?.assigned_to).toBe(DONO_NOVO);
    });

    it("com o último completo velho (mais de 10 min) continua incremental: o completo espera a volta da aba", async () => {
      await carregarOsDois();
      const escondida = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      const agora = Date.now();
      const relogio = vi.spyOn(Date, "now").mockReturnValue(agora + 11 * 60_000);

      await act(async () => {
        await h.poll.valor?.();
      });
      relogio.mockRestore();
      escondida.mockRestore();

      expect(paginas()).toEqual([]);
      expect(incrementais()).toHaveLength(1);
    });

    it("sem marca d'água do servidor nem completo anterior, escondida ou não, o poll faz o completo", async () => {
      h.banco = [];
      renderizar({ escopo: [LINHA_A, LINHA_B] });
      await carregada();
      limparConsultas();
      const escondida = vi.spyOn(document, "hidden", "get").mockReturnValue(true);

      await act(async () => {
        await h.poll.valor?.();
      });
      await carregada();
      escondida.mockRestore();

      expect(incrementais()).toEqual([]);
      expect(paginas().length).toBe(2);
    });
  });

  it("sem marca d'água do servidor (todos os números vazios) o poll faz o completo", async () => {
    h.banco = [];
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    limparConsultas();

    await act(async () => {
      await h.poll.valor?.();
    });
    await carregada();

    expect(incrementais()).toEqual([]);
    expect(paginas().length).toBe(2);
  });

  it("completo velho (mais de 10 min) vira completo no poll", async () => {
    await carregarOsDois();
    const agora = Date.now();
    const relogio = vi.spyOn(Date, "now").mockReturnValue(agora + 11 * 60_000);

    await act(async () => {
      await h.poll.valor?.();
    });
    await carregada();
    relogio.mockRestore();

    expect(incrementais()).toEqual([]);
    expect(paginas().map((p) => p.numeros[0]).sort()).toEqual([LINHA_A, LINHA_B].sort());
  });

  it("o completo periódico que falha em um número mostra a faixa, mas não faz barulho (é segundo plano)", async () => {
    await carregarOsDois();
    h.falhando.add(LINHA_B);
    const agora = Date.now();
    const relogio = vi.spyOn(Date, "now").mockReturnValue(agora + 11 * 60_000);

    await act(async () => {
      await h.poll.valor?.();
    });
    await carregada();
    relogio.mockRestore();

    expect(await screen.findByRole("status")).toHaveTextContent("Não foi possível carregar Suporte");
    expect(h.toast).not.toHaveBeenCalled();
    // O que já estava em memória de B continua na tela.
    expect(linhasNaTela()).toEqual(["Ana", "Beto"]);
  });

  it("uma resposta cheia (1000) pode estar truncada: refaz o completo", async () => {
    await carregarOsDois();
    h.banco = [
      ...(h.banco as LinhaDoBanco[]),
      ...Array.from({ length: 1000 }, (_, i) => linhaDoBanco(LINHA_A, `Quente ${i}`, { minuto: 1, atualizadoMinuto: 100 + i })),
    ];

    await act(async () => {
      await h.poll.valor?.();
    });
    await waitFor(() => expect(linhasNaTela()).toHaveLength(1002), { timeout: 4000 });

    expect(incrementais()).toHaveLength(1);
    expect(paginas().length).toBeGreaterThanOrEqual(2);
  });

  it("falha do incremental é silenciosa: nem aviso nem faixa", async () => {
    await carregarOsDois();
    h.incrementalFalha.valor = true;

    await act(async () => {
      await h.poll.valor?.();
    });

    expect(h.toast).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(linhasNaTela()).toEqual(["Ana", "Beto"]);
  });

  it("o poll com um completo em voo não busca de novo", async () => {
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    let liberar: () => void = () => undefined;
    h.retida.valor = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const antes = consultas().length;

    await act(async () => {
      await h.poll.valor?.();
    });
    expect(consultas().length).toBe(antes);

    await act(async () => {
      h.retida.valor = null;
      liberar();
    });
    await carregada();
  });

  it("um completo preso há mais de 1 min (requisição pendurada) é refeito pelo poll", async () => {
    h.retida.valor = new Promise<void>(() => undefined); // nunca responde
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(paginas().length).toBe(2);
    limparConsultas();

    const agora = Date.now();
    const relogio = vi.spyOn(Date, "now").mockReturnValue(agora + 30_000);
    await act(async () => {
      await h.poll.valor?.();
    });
    // Ainda dentro do prazo: espera.
    expect(consultas()).toEqual([]);

    relogio.mockReturnValue(agora + 61_000);
    await act(async () => {
      // O completo novo também fica retido: o poll não volta, então só se espera o pedido sair.
      void h.poll.valor?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    relogio.mockRestore();

    expect(paginas().map((p) => p.numeros[0]).sort()).toEqual([LINHA_A, LINHA_B].sort());
    expect(incrementais()).toEqual([]);
  });

  it("reassinar o canal com o último completo recente (menos de 2 min) busca o incremental", async () => {
    await carregarOsDois();

    await act(async () => {
      h.canal.status?.("SUBSCRIBED");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await carregada();

    expect(incrementais()).toHaveLength(1);
    expect(paginas()).toEqual([]);
  });

  it("voltar à aba depois de pouco tempo busca o incremental", async () => {
    await carregarOsDois();

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(incrementais()).toHaveLength(1);
    expect(paginas()).toEqual([]);
  });

  it("voltar depois de mais de 5 min refaz o completo", async () => {
    await carregarOsDois();
    const agora = Date.now();
    const relogio = vi.spyOn(Date, "now");

    await act(async () => {
      relogio.mockReturnValue(agora);
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      relogio.mockReturnValue(agora + 6 * 60_000);
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await carregada();
    relogio.mockRestore();

    expect(incrementais()).toEqual([]);
    expect(paginas().map((p) => p.numeros[0]).sort()).toEqual([LINHA_A, LINHA_B].sort());
  });

  it("voltar a ficar online refaz o completo", async () => {
    await carregarOsDois();

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      window.dispatchEvent(new Event("online"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await carregada();

    expect(incrementais()).toEqual([]);
    expect(paginas().length).toBe(2);
  });

  it("um poll sem nada novo deixa a lista com a mesma referência: o React não refaz a lista", async () => {
    await carregarOsDois();
    const antes = h.loja.conversations;

    await act(async () => {
      await h.poll.valor?.();
    });

    expect(incrementais()).toHaveLength(1);
    expect(h.loja.conversations).toBe(antes);
  });

  it("voltar depois de mais de 5 min com um número falhando: a faixa avisa, sem toast (é segundo plano)", async () => {
    await carregarOsDois();
    h.falhando.add(LINHA_B);
    const agora = Date.now();
    const relogio = vi.spyOn(Date, "now");

    await act(async () => {
      relogio.mockReturnValue(agora);
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      relogio.mockReturnValue(agora + 6 * 60_000);
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await assentar();
    });
    relogio.mockRestore();

    expect(await screen.findByRole("status")).toHaveTextContent("Suporte");
    expect(linhasNaTela()).toHaveLength(2);
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("o `online` com um número falhando: a faixa avisa, sem toast", async () => {
    await carregarOsDois();
    h.falhando.add(LINHA_B);

    await act(async () => {
      ficarVisivel();
      window.dispatchEvent(new Event("online"));
      await assentar();
    });

    expect(await screen.findByRole("status")).toHaveTextContent("Suporte");
    expect(linhasNaTela()).toHaveLength(2);
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("com a rede caída, voltar à aba não busca nada: quando a rede volta, o `online` refaz tudo", async () => {
    await carregarOsDois();
    const agora = Date.now();
    const relogio = vi.spyOn(Date, "now");
    naRede(false);
    try {
      await act(async () => {
        relogio.mockReturnValue(agora);
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        relogio.mockReturnValue(agora + 6 * 60_000);
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        await assentar();
      });
      expect(consultas()).toEqual([]);
    } finally {
      relogio.mockRestore();
      naRede(true);
    }
  });

  it("um pedido de recarga do contexto sem conversa é de fundo: a falha vira faixa, sem toast", async () => {
    await carregarOsDois();
    h.falhando.add(LINHA_B);

    act(() => {
      h.pedido.valor = { seq: 1, conversationId: null };
      h.emitir();
    });

    expect(await screen.findByRole("status")).toHaveTextContent("Suporte");
    expect(h.toast).not.toHaveBeenCalled();
  });
});

/** Carrega o escopo e espera as `quantas` linhas na tela; zera o registro de consultas. */
async function carregarEscopo(escopo: readonly string[], quantas: number) {
  const montado = renderizar({ escopo });
  await carregada();
  await waitFor(() => expect(linhasNaTela()).toHaveLength(quantas));
  limparConsultas();
  return montado;
}

describe("ConversationsList — conversa que o realtime tirou da lista durante a busca", () => {
  let fantasma: LinhaDoBanco;

  beforeEach(() => {
    // Atualizada pouco antes da marca d'água (minuto 30): o incremental a devolve.
    fantasma = linhaDoBanco(LINHA_B, "Fantasma", { minuto: 3, atualizadoMinuto: 29 });
    h.banco = [
      linhaDoBanco(LINHA_A, "Ana", { minuto: 5, atualizadoMinuto: 10 }),
      linhaDoBanco(LINHA_B, "Beto", { minuto: 4, atualizadoMinuto: 30 }),
      fantasma,
    ];
  });

  /** O poll sai e o servidor lê; a resposta fica retida até `liberar`. */
  async function pollRetido() {
    const retida = segurar();
    let poll: Promise<unknown> | undefined;
    await act(async () => {
      poll = h.poll.valor?.() as Promise<unknown>;
      await assentar();
    });
    return { liberar: () => act(async () => { retida.liberar(); await poll; }) };
  }

  /** O `online` dispara o completo; as páginas ficam retidas até `liberar`. */
  async function completoRetido() {
    const retida = segurar();
    await act(async () => {
      ficarVisivel();
      window.dispatchEvent(new Event("online"));
      await assentar();
    });
    return {
      liberar: async () => {
        await act(async () => {
          retida.liberar();
          await assentar();
        });
        await carregada();
      },
    };
  }

  it("DELETE entre a leitura e o commit do incremental: ela não ressuscita", async () => {
    await carregarEscopo([LINHA_A, LINHA_B], 3);
    const resposta = await pollRetido();
    expect(incrementais()).toHaveLength(1);

    // Antes de a resposta chegar, ela é apagada: o realtime a tira da lista.
    h.banco = (h.banco as LinhaDoBanco[]).filter((linha) => linha.id !== fantasma.id);
    eventoDeConversa({ eventType: "DELETE", id: fantasma.id });
    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Beto"]));

    await resposta.liberar();
    expect(linhasNaTela()).toEqual(["Ana", "Beto"]);
    expect(emMemoria(fantasma.id)).toBeUndefined();

    // E os incrementais seguintes, que já não a recebem, também não a trazem de volta.
    await act(async () => {
      await h.poll.valor?.();
    });
    expect(linhasNaTela()).toEqual(["Ana", "Beto"]);
  });

  it("DELETE entre a leitura e o commit do completo: ela não ressuscita", async () => {
    await carregarEscopo([LINHA_A, LINHA_B], 3);
    const resposta = await completoRetido();
    expect(paginas().length).toBeGreaterThan(0);

    h.banco = (h.banco as LinhaDoBanco[]).filter((linha) => linha.id !== fantasma.id);
    eventoDeConversa({ eventType: "DELETE", id: fantasma.id });
    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Beto"]));

    await resposta.liberar();
    expect(linhasNaTela()).toEqual(["Ana", "Beto"]);
  });

  it("UPDATE que a leva para um número fora do escopo: também não volta pelo snapshot de antes", async () => {
    await carregarEscopo([LINHA_A, LINHA_B], 3);
    const resposta = await pollRetido();

    h.banco = (h.banco as LinhaDoBanco[]).map((linha) => (linha.id === fantasma.id ? { ...linha, phone_number_id: LINHA_C } : linha));
    eventoDeConversa({ eventType: "UPDATE", linha: fantasma, mudancas: { phone_number_id: LINHA_C } });
    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Beto"]));

    await resposta.liberar();
    expect(linhasNaTela()).toEqual(["Ana", "Beto"]);
  });

  it("o mesmo no completo: a que mudou de número para fora do escopo não volta", async () => {
    await carregarEscopo([LINHA_A, LINHA_B], 3);
    const resposta = await completoRetido();

    h.banco = (h.banco as LinhaDoBanco[]).map((linha) => (linha.id === fantasma.id ? { ...linha, phone_number_id: LINHA_C } : linha));
    eventoDeConversa({ eventType: "UPDATE", linha: fantasma, mudancas: { phone_number_id: LINHA_C } });
    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Beto"]));

    await resposta.liberar();
    expect(linhasNaTela()).toEqual(["Ana", "Beto"]);
  });

  it("UPDATE que a traz de volta ao escopo derruba a marca: ela aparece uma vez só, com o dado novo", async () => {
    await carregarEscopo([LINHA_A, LINHA_B], 3);
    const resposta = await pollRetido();

    // Sai e volta (de B para C e de C para A) enquanto a resposta demora.
    eventoDeConversa({ eventType: "UPDATE", linha: fantasma, mudancas: { phone_number_id: LINHA_C } });
    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Beto"]));
    h.banco = (h.banco as LinhaDoBanco[]).map((linha) =>
      linha.id === fantasma.id ? { ...linha, phone_number_id: LINHA_A, contact_name: "Fantasma (agora no A)" } : linha,
    );
    eventoDeConversa({
      eventType: "UPDATE",
      linha: fantasma,
      mudancas: { phone_number_id: LINHA_A, contact_name: "Fantasma (agora no A)", last_message_at: minutos(40) },
    });
    await waitFor(() => expect(linhasNaTela()).toContain("Fantasma (agora no A)"));

    await resposta.liberar();
    expect(linhasNaTela().filter((nome) => nome?.startsWith("Fantasma"))).toEqual(["Fantasma (agora no A)"]);
    expect(new Set(ordemNaTela()).size).toBe(ordemNaTela().length);
  });

  it("controle: o DELETE de um co-responsável de conversa que chega no fetch não a impede de entrar (tocar não é remover)", async () => {
    await carregarEscopo([LINHA_A, LINHA_B], 3);
    const nova = linhaDoBanco(LINHA_A, "Nova", { minuto: 9, atualizadoMinuto: 40 });
    h.banco = [...(h.banco as LinhaDoBanco[]), nova];
    const resposta = await pollRetido();
    expect(incrementais()).toHaveLength(1);

    // O co-responsável sai da conversa nova, que ainda não está em memória: só a marca como tocada.
    act(() => {
      h.canal.assignees?.({
        eventType: "DELETE",
        old: { id: uuid(998), conversation_id: nova.id, user_id: uuid(997) },
      });
    });
    await resposta.liberar();

    expect(linhasNaTela()).toContain("Nova");
  });

  it("sem nenhum evento, o que o incremental traz entra como sempre", async () => {
    await carregarEscopo([LINHA_A, LINHA_B], 3);
    const nova = linhaDoBanco(LINHA_B, "Nova", { minuto: 8, atualizadoMinuto: 60 });
    h.banco = [...(h.banco as LinhaDoBanco[]), nova];

    await act(async () => {
      await h.poll.valor?.();
    });

    await waitFor(() => expect(linhasNaTela()).toContain("Nova"));
  });
});

describe("ConversationsList — agendamento do incremental (voo único e descarte pelo completo)", () => {
  beforeEach(() => {
    h.banco = [
      linhaDoBanco(LINHA_A, "Ana", { minuto: 5, atualizadoMinuto: 10 }),
      linhaDoBanco(LINHA_B, "Beto", { minuto: 4, atualizadoMinuto: 30 }),
    ];
  });

  it("poll, reassinar do canal e volta da aba com um incremental em voo dividem a MESMA requisição", async () => {
    await carregarEscopo([LINHA_A, LINHA_B], 2);
    h.banco = [...(h.banco as LinhaDoBanco[]), linhaDoBanco(LINHA_B, "Nova de B", { minuto: 8, atualizadoMinuto: 40 })];
    const retida = segurar();

    await act(async () => {
      void h.poll.valor?.();
      h.canal.status?.("SUBSCRIBED");
      ficarVisivel();
      document.dispatchEvent(new Event("visibilitychange"));
      await assentar();
    });

    expect(incrementais()).toHaveLength(1);

    await act(async () => {
      retida.liberar();
      await assentar();
    });
    await carregada();
    expect(linhasNaTela().filter((nome) => nome === "Nova de B")).toHaveLength(1);

    // Terminou: a vaga voltou, e o próximo disparo sai de novo.
    await act(async () => {
      await h.poll.valor?.();
    });
    expect(incrementais()).toHaveLength(2);
  });

  describe("trocar de escopo com um incremental em voo", () => {
    beforeEach(() => {
      // A novidade de B (minuto 90) é do escopo ANTIGO e não pode vazar para o novo.
      h.banco = [
        ...(h.banco as LinhaDoBanco[]),
        linhaDoBanco(LINHA_C, "Carla", { minuto: 9, atualizadoMinuto: 20 }),
      ];
    });

    async function trocarComIncrementalEmVoo() {
      const { rerender } = await carregarEscopo([LINHA_A, LINHA_B], 2);
      h.banco = [...(h.banco as LinhaDoBanco[]), linhaDoBanco(LINHA_B, "Novidade de B", { minuto: 8, atualizadoMinuto: 90 })];

      const retida = segurar();
      let antigo: Promise<unknown> | undefined;
      await act(async () => {
        antigo = h.poll.valor?.() as Promise<unknown>;
        await assentar();
      });
      expect(incrementais()).toHaveLength(1);

      // O escopo novo carrega sem esperar: só o incremental antigo continua preso.
      retida.soltarNovas();
      rerender(<Lista escopo={[LINHA_C]} />);
      await carregada();
      await waitFor(() => expect(linhasNaTela()).toEqual(["Carla"]));
      return { retida, antigo: () => antigo };
    }

    it("o incremental antigo responde por último e não mexe na lista nem na marca d'água do escopo novo", async () => {
      const { retida, antigo } = await trocarComIncrementalEmVoo();

      await act(async () => {
        retida.liberar();
        await antigo();
      });

      // Sem o descarte, o reconcile do escopo velho esvaziaria a tela e a marca viraria a do escopo antigo.
      expect(linhasNaTela()).toEqual(["Carla"]);
      expect((h.loja.conversations as Conversation[]).map((conv) => conv.contact_name)).toEqual(["Carla"]);

      limparConsultas();
      await act(async () => {
        await h.poll.valor?.();
      });
      expect(incrementais()).toHaveLength(1);
      expect(incrementais()[0].numeros).toEqual([LINHA_C]);
      expect(incrementais()[0].atualizadoApos).toBe(new Date(Date.parse(minutos(20)) - 120_000).toISOString());
    });

    it("o escopo novo não reaproveita a requisição do antigo: o próximo poll sai com o próprio incremental", async () => {
      const { retida, antigo } = await trocarComIncrementalEmVoo();
      limparConsultas();

      // O incremental antigo segue preso; o poll do escopo novo tem de sair mesmo assim.
      await act(async () => {
        await h.poll.valor?.();
      });
      expect(incrementais()).toHaveLength(1);
      expect(incrementais()[0].numeros).toEqual([LINHA_C]);

      await act(async () => {
        retida.liberar();
        await antigo();
      });
    });

    it("quando o antigo termina depois, ele não solta a vaga do novo: um novo poll não abre um terceiro", async () => {
      const { retida, antigo } = await trocarComIncrementalEmVoo();
      limparConsultas();

      // O incremental do escopo novo fica preso também (as consultas novas voltam a esperar).
      const retidaNova = segurar();
      let novo: Promise<unknown> | undefined;
      await act(async () => {
        novo = h.poll.valor?.() as Promise<unknown>;
        await assentar();
      });
      expect(incrementais()).toHaveLength(1);

      // O antigo termina primeiro. Se soltasse a vaga do novo, o próximo poll abriria outro.
      await act(async () => {
        retida.liberar();
        await antigo();
      });
      await act(async () => {
        void h.poll.valor?.();
        await assentar();
      });
      expect(incrementais()).toHaveLength(1);

      await act(async () => {
        retidaNova.liberar();
        await novo;
      });
    });
  });
});

describe("ConversationsList — o número que falhou é refeito pela revalidação de fundo", () => {
  beforeEach(() => {
    h.banco = [
      linhaDoBanco(LINHA_A, "Ana", { minuto: 5, atualizadoMinuto: 10 }),
      linhaDoBanco(LINHA_A, "Alice", { minuto: 1, atualizadoMinuto: 5 }),
      linhaDoBanco(LINHA_B, "Beto", { minuto: 4, atualizadoMinuto: 30 }),
      // Antiga demais para o incremental: só um completo do B a traz.
      linhaDoBanco(LINHA_B, "Beatriz", { minuto: 2, atualizadoMinuto: 6 }),
    ];
  });

  const dispararOnline = () =>
    act(async () => {
      ficarVisivel();
      window.dispatchEvent(new Event("online"));
      await assentar();
    });

  const paginasDe = () => paginas().map((pagina) => pagina.numeros[0]);

  it("um número só: o completo do `online` falha com o último completo bom recente, e o poll seguinte o refaz", async () => {
    await carregarEscopo([LINHA_A], 2);
    h.falhando.add(LINHA_A);
    await dispararOnline();
    await carregada();
    expect(await screen.findByRole("status")).toHaveTextContent("Não foi possível carregar Vendas");

    // A rede voltou. Antes o poll caía no incremental e a faixa ficava até o completo de 10 min.
    h.falhando.delete(LINHA_A);
    limparConsultas();
    await act(async () => {
      await h.poll.valor?.();
    });
    await carregada();

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    // Todos os números do escopo falharam: nada a incrementar, direto no completo.
    expect(incrementais()).toEqual([]);
    expect(paginasDe()).toEqual([LINHA_A]);
  });

  it("aba 'Meus' vazia: o estado de erro sai quando o número volta, e fica o estado vazio de verdade", async () => {
    const usuarioEvento = userEvent.setup();
    await carregarEscopo([LINHA_A], 2);
    // "Meus": nenhuma conversa tem dono.
    await usuarioEvento.click(screen.getAllByRole("tab")[2]);
    expect(await screen.findByText(/Nenhuma conversa nesta aba ainda/)).toBeInTheDocument();

    h.falhando.add(LINHA_A);
    await dispararOnline();
    await carregada();
    expect(await screen.findByText("Não foi possível carregar as conversas")).toBeInTheDocument();

    h.falhando.delete(LINHA_A);
    await act(async () => {
      await h.poll.valor?.();
    });
    await carregada();

    await waitFor(() => expect(screen.queryByText("Não foi possível carregar as conversas")).not.toBeInTheDocument());
    expect(screen.getByText(/Nenhuma conversa nesta aba ainda/)).toBeInTheDocument();
  });

  it("dois números, B falhou na primeira carga: o poll refaz só o B e as conversas antigas dele chegam", async () => {
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Alice"]));
    expect(await screen.findByRole("status")).toHaveTextContent("Não foi possível carregar Suporte");

    h.falhando.delete(LINHA_B);
    limparConsultas();
    // O aviso da carga inicial já saiu; o que importa é que o poll não faça barulho.
    h.toast.mockClear();
    await act(async () => {
      await h.poll.valor?.();
    });
    await carregada();

    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Beto", "Beatriz", "Alice"]));
    // Um incremental dos dois e as páginas SÓ do B: o A não é baixado de novo.
    expect(incrementais()).toHaveLength(1);
    expect(paginasDe()).toEqual([LINHA_B]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("B falhou no `online` depois de carregado: o poll refaz só o B e o que estava em memória fica", async () => {
    await carregarEscopo([LINHA_A, LINHA_B], 4);
    h.falhando.add(LINHA_B);
    await dispararOnline();
    await carregada();
    expect(await screen.findByRole("status")).toHaveTextContent("Suporte");
    expect(linhasNaTela()).toHaveLength(4);

    h.falhando.delete(LINHA_B);
    limparConsultas();
    await act(async () => {
      await h.poll.valor?.();
    });
    await carregada();

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(paginasDe()).toEqual([LINHA_B]);
    expect(linhasNaTela()).toHaveLength(4);
  });

  it("B segue falhando: todo poll repete só o B, sem aviso, e a faixa continua", async () => {
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await screen.findByRole("status");
    limparConsultas();
    h.toast.mockClear();

    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        await h.poll.valor?.();
      });
      await carregada();
    }

    expect(paginasDe()).toEqual([LINHA_B, LINHA_B]);
    expect(incrementais()).toHaveLength(2);
    expect(h.toast).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Não foi possível carregar Suporte");
    // O incremental traz o recente do B (Beto); as conversas antigas (Beatriz) só vêm com a página.
    expect(linhasNaTela()).toEqual(["Ana", "Beto", "Alice"]);
  });

  it("o refazer do B não adia o completo periódico do escopo todo (continua em 10 min do último completo)", async () => {
    const inicio = Date.now();
    const relogio = vi.spyOn(Date, "now").mockReturnValue(inicio);
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await screen.findByRole("status");

    // 1 min depois o B volta e o poll o refaz.
    h.falhando.delete(LINHA_B);
    relogio.mockReturnValue(inicio + 60_000);
    await act(async () => {
      await h.poll.valor?.();
    });
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toHaveLength(4));
    limparConsultas();

    // 10 min e meio depois do completo de verdade (e só 9 min e meio depois do refazer do B).
    relogio.mockReturnValue(inicio + 10 * 60_000 + 30_000);
    await act(async () => {
      await h.poll.valor?.();
    });
    await carregada();
    relogio.mockRestore();

    expect(incrementais()).toEqual([]);
    expect(paginasDe().sort()).toEqual([LINHA_A, LINHA_B].sort());
  });

  it("o 'Tentar novamente' de um número só, que refaz o escopo inteiro, conta como completo e não pede outro logo depois", async () => {
    const usuarioEvento = userEvent.setup();
    const inicio = Date.now();
    const relogio = vi.spyOn(Date, "now").mockReturnValue(inicio);
    await carregarEscopo([LINHA_A], 2);

    // 11 min depois a rede cai: o completo do `online` falha, e o último completo bom já é velho.
    relogio.mockReturnValue(inicio + 11 * 60_000);
    h.falhando.add(LINHA_A);
    await dispararOnline();
    await carregada();
    await screen.findByRole("status");

    // A rede volta e a pessoa toca em "Tentar novamente": é um completo do escopo todo.
    h.falhando.delete(LINHA_A);
    await usuarioEvento.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await carregada();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    limparConsultas();

    // O poll de 1 min depois já tem um completo recente: segue incremental.
    relogio.mockReturnValue(inicio + 12 * 60_000);
    await act(async () => {
      await h.poll.valor?.();
    });
    relogio.mockRestore();

    expect(paginas()).toEqual([]);
    expect(incrementais()).toHaveLength(1);
  });

  it("com um completo em voo o poll não dispara o refazer", async () => {
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await screen.findByRole("status");
    h.falhando.delete(LINHA_B);

    // Um completo do usuário (volta online) está em voo, com as respostas retidas.
    const retida = segurar();
    await dispararOnline();
    limparConsultas();

    await act(async () => {
      await h.poll.valor?.();
    });
    expect(consultas()).toEqual([]);

    await act(async () => {
      retida.liberar();
      await assentar();
    });
    await carregada();
  });

  it("incremental que escala para completo com o B pendente: o B não é baixado duas vezes", async () => {
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await screen.findByRole("status");
    h.falhando.delete(LINHA_B);
    // Uma rajada no A: o incremental volta cheio (1000) e pede o completo do escopo.
    h.banco = [
      ...(h.banco as LinhaDoBanco[]),
      ...Array.from({ length: 1000 }, (_, i) => linhaDoBanco(LINHA_A, `Quente ${i}`, { minuto: 1, atualizadoMinuto: 100 + i })),
    ];
    limparConsultas();

    await act(async () => {
      await h.poll.valor?.();
    });
    await waitFor(() => expect(linhasNaTela()).toHaveLength(1004), { timeout: 4000 });
    await carregada();

    expect(incrementais()).toHaveLength(1);
    // A primeira página do B (a que traz o count) saiu uma vez só.
    expect(paginas().filter((pagina) => pagina.numeros[0] === LINHA_B && pagina.from === 0)).toHaveLength(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("'Tentar novamente' refaz só o número que falhou, sem baixar o outro", async () => {
    const usuarioEvento = userEvent.setup();
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await screen.findByRole("status");

    h.falhando.delete(LINHA_B);
    limparConsultas();
    await usuarioEvento.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await carregada();

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(paginasDe()).toEqual([LINHA_B]);
    expect(linhasNaTela()).toEqual(["Ana", "Beto", "Beatriz", "Alice"]);
  });

  it("um completo que começa no meio do incremental dispensa o refazer: o B sai uma vez só", async () => {
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await screen.findByRole("status");
    h.falhando.delete(LINHA_B);
    limparConsultas();

    // O incremental sai e fica preso.
    const doIncremental = segurar();
    let poll: Promise<unknown> | undefined;
    await act(async () => {
      poll = h.poll.valor?.() as Promise<unknown>;
      await assentar();
    });
    expect(incrementais()).toHaveLength(1);

    // No meio dele o usuário volta online: o completo do escopo todo sai (e fica preso por outro motivo).
    doIncremental.soltarNovas();
    const doCompleto = segurar();
    await dispararOnline();

    // O incremental termina com o completo ainda em voo e o B ainda na faixa: refazer o B agora o
    // pediria por cima do completo que já o está pedindo.
    await act(async () => {
      doIncremental.liberar();
      await poll;
    });
    expect(paginas().filter((pagina) => pagina.numeros[0] === LINHA_B && pagina.from === 0)).toHaveLength(1);

    await act(async () => {
      doCompleto.liberar();
      await assentar();
    });
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toEqual(["Ana", "Beto", "Beatriz", "Alice"]));
    expect(paginas().filter((pagina) => pagina.numeros[0] === LINHA_B && pagina.from === 0)).toHaveLength(1);
  });
});

describe("ConversationsList — co-responsáveis que o incremental não enxerga", () => {
  const USUARIO_X = uuid(7001);
  const USUARIO_Y = uuid(7002);
  let ana: LinhaDoBanco;
  let beto: LinhaDoBanco;

  beforeEach(() => {
    ana = linhaDoBanco(LINHA_A, "Ana", { minuto: 5, atualizadoMinuto: 10 });
    beto = linhaDoBanco(LINHA_B, "Beto", { minuto: 4, atualizadoMinuto: 30, conversation_assignees: [{ user_id: USUARIO_Y }] });
    // A mais recente do escopo: a marca d'água fica longe da Ana e do Beto, e o incremental não os devolve.
    h.banco = [ana, beto, linhaDoBanco(LINHA_A, "Recente", { minuto: 9, atualizadoMinuto: 100 })];
    h.coResponsaveis = [{ conversation_id: beto.id, user_id: USUARIO_Y, numeroId: LINHA_B }];
  });

  /**
   * No servidor, X entra como co-responsável da Ana e Y sai do Beto. Nenhum `updated_at` anda:
   * `conversation_assignees` não tem gatilho que toque `conversations`.
   */
  const mudarCoResponsaveisNoServidor = () => {
    h.banco = (h.banco as LinhaDoBanco[]).map((linha) => {
      if (linha.id === ana.id) return { ...linha, conversation_assignees: [{ user_id: USUARIO_X }] };
      if (linha.id === beto.id) return { ...linha, conversation_assignees: [] };
      return linha;
    });
    h.coResponsaveis = [{ conversation_id: ana.id, user_id: USUARIO_X, numeroId: LINHA_A }];
  };
  const coDe = (id: string) => emMemoria(id)?.co_assignee_ids;

  async function carregarOsDois() {
    await carregarEscopo([LINHA_A, LINHA_B], 3);
    expect(coDe(ana.id)).toEqual([]);
    expect(coDe(beto.id)).toEqual([USUARIO_Y]);
  }

  const reflete = () => {
    expect(coDe(ana.id)).toEqual([USUARIO_X]);
    expect(coDe(beto.id)).toEqual([]);
  };

  it("o poll pega a inclusão e a remoção, numa revalidação só e sem baixar a lista", async () => {
    await carregarOsDois();
    mudarCoResponsaveisNoServidor();

    await act(async () => {
      await h.poll.valor?.();
    });

    reflete();
    expect(paginas()).toEqual([]);
    expect(incrementais()).toHaveLength(1);
    // O retrato é de todos os números do escopo, numa leitura só.
    expect(h.consultasCo).toEqual([{ numeros: [LINHA_A, LINHA_B], from: 0 }]);
  });

  it("a volta rápida à aba também", async () => {
    await carregarOsDois();
    mudarCoResponsaveisNoServidor();

    await act(async () => {
      ficarVisivel();
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await assentar();
    });
    await carregada();

    reflete();
    expect(paginas()).toEqual([]);
  });

  it("reassinar o canal logo depois de um completo (incremental) também", async () => {
    await carregarOsDois();
    mudarCoResponsaveisNoServidor();

    await act(async () => {
      h.canal.status?.("SUBSCRIBED");
      await assentar();
    });
    await carregada();

    reflete();
    expect(paginas()).toEqual([]);
    expect(incrementais()).toHaveLength(1);
  });

  it("reassinar o canal depois de uma queda longa (último completo com mais de 2 min) refaz o completo", async () => {
    await carregarOsDois();
    mudarCoResponsaveisNoServidor();
    const relogio = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3 * 60_000);

    await act(async () => {
      h.canal.status?.("SUBSCRIBED");
      await assentar();
    });
    await carregada();
    relogio.mockRestore();

    reflete();
    expect(incrementais()).toEqual([]);
    expect(paginas().map((pagina) => pagina.numeros[0]).sort()).toEqual([LINHA_A, LINHA_B].sort());
  });

  it("reassinar com a aba escondida espera a volta: segue incremental, mesmo com o último completo velho", async () => {
    await carregarOsDois();
    const escondida = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const relogio = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3 * 60_000);

    await act(async () => {
      h.canal.status?.("SUBSCRIBED");
      await assentar();
    });
    await carregada();
    relogio.mockRestore();
    escondida.mockRestore();

    expect(paginas()).toEqual([]);
    expect(incrementais()).toHaveLength(1);
  });

  it("controle: o completo (volta a ficar online) traz as duas mudanças pelo embed", async () => {
    await carregarOsDois();
    mudarCoResponsaveisNoServidor();

    await act(async () => {
      ficarVisivel();
      window.dispatchEvent(new Event("online"));
      await assentar();
    });
    await carregada();

    reflete();
    expect(incrementais()).toEqual([]);
  });

  it("o que o realtime aplicou durante a leitura não é desfeito pelo retrato, que é mais velho", async () => {
    await carregarOsDois();
    const retida = segurar();
    let poll: Promise<unknown> | undefined;
    await act(async () => {
      poll = h.poll.valor?.() as Promise<unknown>;
      await assentar();
    });

    // O servidor registra X como co-responsável da Ana e o realtime entrega o INSERT, as duas
    // coisas DEPOIS de o retrato ter sido lido (sem X).
    act(() => h.canal.assignees?.({ eventType: "INSERT", new: { id: uuid(7100), conversation_id: ana.id, user_id: USUARIO_X } }));
    expect(coDe(ana.id)).toEqual([USUARIO_X]);

    await act(async () => {
      retida.liberar();
      await poll;
    });

    expect(coDe(ana.id)).toEqual([USUARIO_X]);
  });

  it("a conversa que o próprio incremental trouxe fica com o embed que veio com ela", async () => {
    await carregarOsDois();
    // A Ana teve atividade: o incremental a devolve, com X no embed. O retrato (lido na mesma hora)
    // ainda não o tem; como o embed da linha é tão novo quanto ele, o retrato não a sobrescreve.
    h.banco = (h.banco as LinhaDoBanco[]).map((linha) =>
      linha.id === ana.id ? { ...linha, updated_at: minutos(110), conversation_assignees: [{ user_id: USUARIO_X }] } : linha,
    );
    h.coResponsaveis = [];

    await act(async () => {
      await h.poll.valor?.();
    });

    expect(coDe(ana.id)).toEqual([USUARIO_X]);
  });

  it("conversa que o retrato cita e a lista não tem é rebuscada pelo id (compartilhada comigo agora)", async () => {
    await carregarOsDois();
    const nova = uuid(7200);
    h.coResponsaveis = [{ conversation_id: nova, user_id: USUARIO_X, numeroId: LINHA_A }];

    await act(async () => {
      await h.poll.valor?.();
    });

    expect(h.refreshConversationById).toHaveBeenCalledWith(nova);
  });

  it("mas não a de um número que a lista ainda não carregou: o completo dele a traz junto", async () => {
    h.falhando.add(LINHA_B);
    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await screen.findByRole("status");
    h.coResponsaveis = [{ conversation_id: uuid(7201), user_id: USUARIO_X, numeroId: LINHA_B }];
    h.refreshConversationById.mockClear();

    await act(async () => {
      await h.poll.valor?.();
    });

    expect(h.refreshConversationById).not.toHaveBeenCalled();
  });

  it("falha na leitura do retrato é silenciosa: a lista fica como está e o resto da revalidação vale", async () => {
    await carregarOsDois();
    mudarCoResponsaveisNoServidor();
    h.coFalha.valor = true;
    h.banco = [...(h.banco as LinhaDoBanco[]), linhaDoBanco(LINHA_A, "Nova", { minuto: 8, atualizadoMinuto: 120 })];

    await act(async () => {
      await h.poll.valor?.();
    });

    expect(h.toast).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("retrato de co-responsáveis falhou"), expect.anything());
    await waitFor(() => expect(linhasNaTela()).toContain("Nova"));
    // O que o retrato diria não foi aplicado.
    expect(coDe(ana.id)).toEqual([]);
    expect(coDe(beto.id)).toEqual([USUARIO_Y]);
  });

  it("DELETE de co-responsável sem identidade no canal: o retrato refaz os co-responsáveis do escopo", async () => {
    await carregarOsDois();
    mudarCoResponsaveisNoServidor();

    // REPLICA IDENTITY DEFAULT: só o id da linha apagada, sem conversa nem usuário.
    act(() => h.canal.assignees?.({ eventType: "DELETE", old: { id: uuid(7300) } }));

    await waitFor(reflete, { timeout: 3000 });
    expect(paginas()).toEqual([]);
  });
});

describe("ConversationsList — o skeleton só sai quando todos os números resolveram", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const skeleton = (container: HTMLElement) => container.querySelector(".animate-pulse");
  const vazio = () => screen.queryByText(/Nenhuma conversa nesta aba ainda/);

  /** A página 1 do número só responde quando o teste soltar. */
  const reter = (numeroId: string) => {
    let liberar: () => void = () => undefined;
    h.retidaPorNumero.set(
      numeroId,
      new Promise<void>((resolve) => {
        liberar = resolve;
      }),
    );
    return () => act(async () => liberar());
  };

  /** Passa do prazo da primeira pintura (1,5 s): o que já chegou é entregue. */
  const passarDoPrazo = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(1_700);
    });

  it("A vazio chega antes do prazo e B demora: o skeleton fica até o B chegar, sem 'Nenhuma conversa'", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.banco = [linhaDoBanco(LINHA_B, "Beto", { minuto: 4 })];
    const liberarB = reter(LINHA_B);

    const { container } = renderizar({ escopo: [LINHA_A, LINHA_B] });
    await passarDoPrazo();

    expect(skeleton(container)).not.toBeNull();
    expect(vazio()).not.toBeInTheDocument();
    expect(linhasNaTela()).toEqual([]);

    await liberarB();
    await waitFor(() => expect(linhasNaTela()).toEqual(["Beto"]));
    expect(skeleton(container)).toBeNull();
  });

  it("A vazio e B que falha tarde: o skeleton fica até a falha, e então vem o estado de erro", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.banco = [];
    h.falhando.add(LINHA_B);
    const liberarB = reter(LINHA_B);

    const { container } = renderizar({ escopo: [LINHA_A, LINHA_B] });
    await passarDoPrazo();
    expect(skeleton(container)).not.toBeNull();
    expect(vazio()).not.toBeInTheDocument();

    await liberarB();
    expect(await screen.findByText("Não foi possível carregar as conversas")).toBeInTheDocument();
    expect(skeleton(container)).toBeNull();
  });

  it("A só com encerradas e B lento: a aba 'Todas' está vazia, mas ainda não é hora de dizer isso", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.banco = [
      linhaDoBanco(LINHA_A, "Fechada 1", { minuto: 2, status: "closed" }),
      linhaDoBanco(LINHA_A, "Fechada 2", { minuto: 1, status: "closed" }),
      linhaDoBanco(LINHA_B, "Beto", { minuto: 4 }),
    ];
    const liberarB = reter(LINHA_B);

    const { container } = renderizar({ escopo: [LINHA_A, LINHA_B] });
    await passarDoPrazo();

    expect(skeleton(container)).not.toBeNull();
    expect(vazio()).not.toBeInTheDocument();

    await liberarB();
    await waitFor(() => expect(linhasNaTela()).toEqual(["Beto"]));
  });

  it("cache vazio de A e B sem cache: o skeleton cobre a espera, e não o estado vazio", async () => {
    conversationListCache.set(LINHA_A, { rows: [], fetchedAt: 1_000, complete: true });
    h.banco = [linhaDoBanco(LINHA_B, "Beto", { minuto: 4 })];
    const solta = segurar();

    const { container } = renderizar({ escopo: [LINHA_A, LINHA_B] });
    await act(async () => {
      await assentar();
    });

    expect(skeleton(container)).not.toBeNull();
    expect(vazio()).not.toBeInTheDocument();

    await act(async () => {
      solta.liberar();
      await assentar();
    });
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toEqual(["Beto"]));
  });

  it("cache vazio de todos os números do escopo: o estado vazio vale na hora (é o que se sabe)", async () => {
    conversationListCache.set(LINHA_A, { rows: [], fetchedAt: 1_000, complete: true });
    conversationListCache.set(LINHA_B, { rows: [], fetchedAt: 1_000, complete: true });
    h.banco = [];
    segurar();

    const { container } = renderizar({ escopo: [LINHA_A, LINHA_B] });
    await act(async () => {
      await assentar();
    });

    expect(vazio()).toBeInTheDocument();
    expect(skeleton(container)).toBeNull();
  });

  it("um número só e vazio: o estado vazio aparece na hora, sem esperar prazo nenhum", async () => {
    h.banco = [];
    const { container } = renderizar({ escopo: [LINHA_A] });

    expect(await screen.findByText(/Nenhuma conversa nesta aba ainda/)).toBeInTheDocument();
    expect(skeleton(container)).toBeNull();
  });

  it("os dois números vazios: o estado vazio vem quando os dois responderam", async () => {
    h.banco = [];
    const { container } = renderizar({ escopo: [LINHA_A, LINHA_B] });

    expect(await screen.findByText(/Nenhuma conversa nesta aba ainda/)).toBeInTheDocument();
    expect(skeleton(container)).toBeNull();
  });
});

describe("ConversationsList — puxar para atualizar (mobile)", () => {
  beforeEach(() => {
    h.mobile.valor = true;
    h.banco = [linhaDoBanco(LINHA_A, "Ana", { minuto: 5 }), linhaDoBanco(LINHA_B, "Beto", { minuto: 4 })];
  });

  const puxar = async () => {
    await act(async () => {
      screen.getByTestId("puxar").click();
      await assentar();
    });
    await carregada();
  };
  const titulos = () => h.toast.mock.calls.map(([aviso]) => (aviso as { title: string }).title);

  it("sem falha: só a confirmação", async () => {
    await carregarEscopo([LINHA_A, LINHA_B], 2);

    await puxar();

    expect(titulos()).toEqual(["Atualizado"]);
  });

  it("um dos números falha com conversas na tela: só o aviso da falha, sem confirmar em seguida", async () => {
    await carregarEscopo([LINHA_A, LINHA_B], 2);
    h.falhando.add(LINHA_B);

    await puxar();

    expect(titulos()).toEqual(["Não foi possível carregar todas as conversas"]);
    expect(screen.getByRole("status")).toHaveTextContent("Suporte");
  });

  it("um número só que falha com conversas em memória: o mesmo", async () => {
    await carregarEscopo([LINHA_A], 1);
    h.falhando.add(LINHA_A);

    await puxar();

    expect(titulos()).toEqual(["Não foi possível carregar todas as conversas"]);
  });

  it("falha com a lista vazia: nenhum aviso (o estado de erro da lista já fala), e nada de 'Atualizado' por cima", async () => {
    h.falhando.add(LINHA_A);
    renderizar({ escopo: [LINHA_A] });
    await carregada();
    expect(await screen.findByText("Não foi possível carregar as conversas")).toBeInTheDocument();
    h.toast.mockClear();

    await puxar();

    expect(titulos()).toEqual([]);
    expect(screen.getByText("Não foi possível carregar as conversas")).toBeInTheDocument();
  });

  it("depois da falha, puxar de novo com a rede de volta confirma", async () => {
    await carregarEscopo([LINHA_A, LINHA_B], 2);
    h.falhando.add(LINHA_B);
    await puxar();
    h.falhando.delete(LINHA_B);
    h.toast.mockClear();

    await puxar();

    expect(titulos()).toEqual(["Atualizado"]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("ConversationsList — ordenação", () => {
  // O comparador de antes, copiado: a ordenação nova tem de dar a MESMA ordem.
  const ordemAntiga = (
    linhas: Array<{ id: string; last_message_at: string }>,
    {
      pinnedAt,
      unread,
      marked,
      notificationsFirst,
      congelada,
    }: {
      pinnedAt: Map<string, string>;
      unread: Map<string, number>;
      marked: Set<string>;
      notificationsFirst: boolean;
      congelada: string | null;
    },
  ) => {
    const efetivo = (id: string) => {
      const peso = (unread.get(id) || 0) > 0 ? (unread.get(id) as number) : marked.has(id) ? 1 : 0;
      return peso || (id === congelada ? 1 : 0);
    };
    return [...linhas]
      .sort((a, b) => {
        const pinA = pinnedAt.get(a.id);
        const pinB = pinnedAt.get(b.id);
        if (pinA && !pinB) return -1;
        if (!pinA && pinB) return 1;
        if (pinA && pinB) return Date.parse(pinA) - Date.parse(pinB);
        if (notificationsFirst) {
          const unreadA = efetivo(a.id);
          const unreadB = efetivo(b.id);
          if (unreadA > 0 && unreadB === 0) return -1;
          if (unreadA === 0 && unreadB > 0) return 1;
        }
        const dateA = new Date(a.last_message_at || 0).getTime();
        const dateB = new Date(b.last_message_at || 0).getTime();
        return dateB - dateA;
      })
      .map((linha) => linha.id);
  };

  it("dá a mesma ordem do comparador antigo, com empates, fixadas, não-lidas e marcadas à mão", async () => {
    // Semente fixa: pseudo-aleatório determinístico.
    let semente = 20261021;
    const aleatorio = () => {
      semente = (semente * 1664525 + 1013904223) % 4294967296;
      return semente / 4294967296;
    };
    // Poucos minutos distintos para forçar empates de last_message_at.
    h.banco = Array.from({ length: 80 }, (_, i) =>
      linhaDoBanco([LINHA_A, LINHA_B][i % 2], `Conv ${i}`, { minuto: Math.floor(aleatorio() * 8) }),
    );
    const todas = h.banco as LinhaDoBanco[];

    const unread = new Map<string, number>();
    const marked = new Set<string>();
    const pinnedAt = new Map<string, string>();
    const instantesDeFixacao = [minutos(100), minutos(101), minutos(102)];
    for (const linha of todas) {
      const sorteio = aleatorio();
      if (sorteio < 0.2) unread.set(linha.id, 1 + Math.floor(aleatorio() * 5));
      else if (sorteio < 0.3) marked.add(linha.id);
      // Fixadas, algumas no MESMO instante (empate entre fixadas).
      if (aleatorio() < 0.12) {
        const quando = instantesDeFixacao[Math.floor(aleatorio() * instantesDeFixacao.length)];
        pinnedAt.set(linha.id, quando);
        h.loja.prefs.set(linha.id, { pinned_at: quando, archived_at: null, muted_until: null });
      }
    }
    h.loja.unreadCounts = unread;
    h.loja.markedUnread = marked;

    renderizar({ escopo: [LINHA_A, LINHA_B] });
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toHaveLength(80));

    // O desempate de uma ordenação estável depende da ordem de ENTRADA: a do estado da lista.
    const entrada = h.loja.conversations as Array<{ id: string; last_message_at: string }>;
    const esperado = ordemAntiga(entrada, { pinnedAt, unread, marked, notificationsFirst: true, congelada: null });
    expect(ordemNaTela()).toEqual(esperado);
    expect(pinnedAt.size).toBeGreaterThan(0);
    expect(unread.size + marked.size).toBeGreaterThan(0);
  });

  it("no modo cronológico as não-lidas não sobem", async () => {
    localStorage.setItem("conversationSortMode", "chronological");
    h.banco = [
      linhaDoBanco(LINHA_A, "Velha com não-lida", { minuto: 1 }),
      linhaDoBanco(LINHA_A, "Recente", { minuto: 9 }),
    ];
    h.loja.unreadCounts = new Map([[(h.banco as LinhaDoBanco[])[0].id, 4]]);

    renderizar({ escopo: [LINHA_A] });
    await carregada();

    await waitFor(() => expect(linhasNaTela()).toEqual(["Recente", "Velha com não-lida"]));
  });

  it("a conversa clicada com não-lidas continua ordenando como não-lida; trocar de conversa a solta", async () => {
    const usuarioEvento = userEvent.setup();
    h.banco = [
      linhaDoBanco(LINHA_A, "Velha com não-lida", { minuto: 1 }),
      linhaDoBanco(LINHA_A, "Recente", { minuto: 9 }),
      linhaDoBanco(LINHA_A, "Meio", { minuto: 5 }),
    ];
    const velha = (h.banco as LinhaDoBanco[])[0];
    h.loja.unreadCounts = new Map([[velha.id, 3]]);

    const { rerender } = renderizar({ escopo: [LINHA_A] });
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toEqual(["Velha com não-lida", "Recente", "Meio"]));

    // Clicar: a lista marca como lida (zera o contador) e o pai passa a seleção.
    await usuarioEvento.click(screen.getByText("Velha com não-lida"));
    rerender(<Lista escopo={[LINHA_A]} selectedConversationId={velha.id} />);
    await waitFor(() => expect(h.loja.unreadCounts.has(velha.id)).toBe(false));
    expect(linhasNaTela()).toEqual(["Velha com não-lida", "Recente", "Meio"]);

    // Abre outra (sem não-lidas): a primeira volta para o lugar da data.
    const meio = (h.banco as LinhaDoBanco[])[2];
    await usuarioEvento.click(screen.getByText("Meio"));
    rerender(<Lista escopo={[LINHA_A]} selectedConversationId={meio.id} />);
    await waitFor(() => expect(linhasNaTela()).toEqual(["Recente", "Meio", "Velha com não-lida"]));
  });

  it("selecionar sem passar pelo clique (deep link) não herda o congelamento", async () => {
    h.banco = [
      linhaDoBanco(LINHA_A, "Velha", { minuto: 1 }),
      linhaDoBanco(LINHA_A, "Recente", { minuto: 9 }),
    ];
    const { rerender } = renderizar({ escopo: [LINHA_A] });
    await carregada();
    await waitFor(() => expect(linhasNaTela()).toEqual(["Recente", "Velha"]));

    rerender(<Lista escopo={[LINHA_A]} selectedConversationId={(h.banco as LinhaDoBanco[])[0].id} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(linhasNaTela()).toEqual(["Recente", "Velha"]);
  });
});
