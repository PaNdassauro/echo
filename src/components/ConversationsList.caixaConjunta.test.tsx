// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";

/**
 * A lista real com DOIS números no escopo (e um, como controle): tags por número, filtro de
 * tag e de setor agrupados por nome, "Assumir" pelo setor do número da conversa e
 * refresh por id. As linhas, o
 * popover de filtro e os diálogos são falsos e só expõem o que a lista lhes entrega.
 */

afterEach(cleanup);

const LINHA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINHA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
// Id de setor precisa ser uuid: a linha do banco passa por um schema Zod que recusa o resto.
const SETOR_A_VENDAS = "dddddddd-dddd-4ddd-8ddd-00000000000a";
const SETOR_B_VENDAS = "dddddddd-dddd-4ddd-8ddd-00000000000b";
const SETOR_B_POS = "dddddddd-dddd-4ddd-8ddd-00000000000c";
const SETOR_LEGADO = "dddddddd-dddd-4ddd-8ddd-00000000000d";

interface LinhaDoBanco {
  id: string;
  contact_name: string;
  contact_phone: string;
  last_message_at: string;
  updated_at: string;
  status: string;
  phone_number_id: string;
  sector_id: string | null;
  assigned_to: string | null;
  is_group: boolean;
  contact_avatar_url: null;
  contact_avatar_updated_at: null;
  profiles: null;
  conversation_assignees: Array<{ user_id: string }>;
}

interface SetorFalso {
  id: string;
  name: string;
  color: string | null;
  organization_id: string;
  phone_number_id: string | null;
}

const h = vi.hoisted(() => {
  const loja = {
    conversations: [] as unknown[],
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
    /** A tabela `tags` (as tags da org, cada uma de uma linha). */
    tagsDaOrg: [] as Array<{ id: string; name: string; color: string; phone_number_id: string }>,
    /** O que `get_conversation_tags_for_user` devolve por número. */
    tagsDosNumeros: new Map<string, Array<{ conversation_id: string; tag_id: string; tag_name: string; tag_color: string }>>(),
    tagsFalhando: new Set<string>(),
    chamadasDeTags: [] as string[],
    /** As gravações em `conversations` (o "Assumir"). */
    atualizacoes: [] as Array<{ valores: Record<string, unknown>; id: string }>,
    /** Os números do mapa de números acessíveis. */
    numeros: [] as unknown[],
    setores: {
      sectors: [] as unknown[],
      byId: new Map<string, unknown>(),
      mySectorIds: [] as string[],
      defaultSectorId: null as string | null,
      isolationEnabled: false,
    },
    canal: { tags: null as null | ((payload: unknown) => void) },
    refreshConversationById: vi.fn((_id: string) => Promise.resolve()),
    toast: vi.fn(),
    contarNumeros: vi.fn(async (_organizationId: string) => 1),
    refreshUnreadCounts: vi.fn(() => Promise.resolve(undefined)),
    dialogos: {
      aoCriarConversa: null as null | ((id?: string) => void),
      aoCriarGrupo: null as null | ((jid: string, id?: string) => void),
    },
    linhasDeTransferencia: { aoAtualizar: null as null | (() => void) },
  };
});

vi.mock("@/integrations/supabase/client", () => {
  const conversas = () => {
    const filtros: Array<["eq" | "in", string, unknown]> = [];
    let atualizar: Record<string, unknown> | null = null;
    let faixa: [number, number] = [0, 999];
    let comCount = false;
    const c: Record<string, unknown> = {};
    c.select = (_colunas: string, opcoes?: { count?: string }) => {
      comCount = opcoes?.count === "exact";
      return c;
    };
    c.update = (valores: Record<string, unknown>) => ((atualizar = valores), c);
    c.eq = (coluna: string, valor: unknown) => (filtros.push(["eq", coluna, valor]), c);
    c.in = (coluna: string, valores: unknown) => (filtros.push(["in", coluna, valores]), c);
    c.gt = () => c;
    c.order = () => c;
    c.range = (de: number, ate: number) => ((faixa = [de, ate]), c);
    c.then = (resolve: (valor: unknown) => unknown, reject: (erro: unknown) => unknown) => {
      if (atualizar) {
        const id = String(filtros.find(([, coluna]) => coluna === "id")?.[2]);
        h.atualizacoes.push({ valores: atualizar, id });
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      const eq = filtros.find(([tipo, coluna]) => tipo === "eq" && coluna === "phone_number_id");
      const em = filtros.find(([tipo, coluna]) => tipo === "in" && coluna === "phone_number_id");
      const numeros = eq ? [String(eq[2])] : ((em?.[2] as string[] | undefined) ?? []);
      const linhas = (h.banco as LinhaDoBanco[])
        .filter((linha) => numeros.includes(linha.phone_number_id))
        .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
      return Promise.resolve({
        data: linhas.slice(faixa[0], faixa[1] + 1),
        count: comCount ? linhas.length : null,
        error: null,
      }).then(resolve, reject);
    };
    return c;
  };

  const generica = (dados: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const metodo of ["select", "eq", "in", "order", "range", "insert", "delete", "update"]) c[metodo] = () => c;
    c.then = (resolve: (valor: unknown) => unknown, reject: (erro: unknown) => unknown) =>
      Promise.resolve({ data: dados, error: null }).then(resolve, reject);
    return c;
  };

  const canalFalso = () => {
    const canal: Record<string, unknown> = {};
    canal.on = (_tipo: string, filtro: { table?: string }, aoMudar: (payload: unknown) => void) => {
      if (filtro?.table === "conversation_tags") h.canal.tags = aoMudar;
      return canal;
    };
    canal.subscribe = (aoMudarStatus?: (status: string) => void) => {
      aoMudarStatus?.("SUBSCRIBED");
      return canal;
    };
    return canal;
  };

  return {
    supabase: {
      from: (tabela: string) => {
        if (tabela === "conversations") return conversas();
        if (tabela === "tags") return generica(h.tagsDaOrg);
        return generica([]);
      },
      rpc: (nome: string, args: { p_phone_number_id?: string }) => {
        if (nome === "get_conversation_tags_for_user") {
          const numero = String(args.p_phone_number_id);
          h.chamadasDeTags.push(numero);
          if (h.tagsFalhando.has(numero)) return Promise.resolve({ data: null, error: { message: "statement timeout" } });
          return Promise.resolve({ data: h.tagsDosNumeros.get(numero) ?? [], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      channel: () => canalFalso(),
      removeChannel: () => undefined,
    },
  };
});

vi.mock("@/contexts/NotificationContext", async () => {
  const { useSyncExternalStore, useMemo } = await import("react");
  // Estável como o setter do contexto real: a lista o tem nos deps de um effect que refaz as tags.
  const setConversations = (atualizacao: unknown) => {
    h.loja.conversations =
      typeof atualizacao === "function"
        ? (atualizacao as (prev: unknown[]) => unknown[])(h.loja.conversations)
        : (atualizacao as unknown[]);
    h.emitir();
  };
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
          setConversations,
          unreadCounts: new Map(),
          markedUnread: new Set(),
          resetUnread: () => Promise.resolve(),
          markConversationUnread: () => Promise.resolve(true),
          markAllAsRead: () => Promise.resolve(0),
          refreshUnreadCounts: h.refreshUnreadCounts,
          setUnreadScope: () => undefined,
          conversationRefreshRequest: { seq: 0, conversationId: null },
          refreshConversationById: h.refreshConversationById,
          findConversation: (id: string) => (h.loja.conversations as Array<{ id: string }>).find((c) => c.id === id),
          failedCounts: new Map(),
          resetFailed: () => undefined,
          conversationPrefs: new Map(),
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
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/ui/pull-to-refresh", () => ({
  PullToRefresh: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("react-router-dom", () => ({ useNavigate: () => () => undefined }));
vi.mock("@/hooks/useRealtimeFallbackPoll", () => ({ useRealtimeFallbackPoll: () => undefined }));
vi.mock("@/lib/realtimeHealth", () => ({ reportChannelHealth: () => undefined }));
vi.mock("@/lib/nativeNotification", () => ({
  ensureNotificationPermission: () => Promise.resolve("default"),
  notificationPermission: () => "default",
}));
vi.mock("@/hooks/chat/useConversation", () => ({
  useConversation: ({ onConversationUpdate }: { onConversationUpdate?: () => void }) => {
    h.linhasDeTransferencia.aoAtualizar = onConversationUpdate ?? null;
    return { transferConversation: async () => false, releaseConversation: async () => false };
  },
}));
vi.mock("@/hooks/useSectors", () => ({ useSectors: () => h.setores }));
vi.mock("@/hooks/useAccessiblePhoneNumbers", () => ({
  contarNumerosAtivos: (organizationId: string) => h.contarNumeros(organizationId),
  useAccessiblePhoneNumbers: () => ({ phoneNumbers: h.numeros, isLoading: false, isReady: true }),
}));
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({ data, itemContent }: { data: unknown[]; itemContent: (index: number, item: unknown) => React.ReactNode }) => (
    <div data-testid="virtuoso">{data.map((item, index) => itemContent(index, item))}</div>
  ),
}));

vi.mock("./ConversationRow", () => ({
  ConversationRow: ({
    conversation,
    sectorIsolationEnabled,
    convTags,
    tagsForLine,
    numeroNome,
    numeroHue,
    actions,
  }: {
    conversation: { id: string; contact_name: string; phone_number_id: string };
    sectorIsolationEnabled: boolean;
    numeroNome?: string | null;
    numeroHue?: number | null;
    convTags: Array<{ name: string }>;
    tagsForLine: Array<{ id: string }>;
    actions: {
      addTag: (id: string, tagId: string, e: unknown) => void;
      resolveAndAssign: (id: string) => void;
      transfer: (id: string) => void;
    };
  }) => (
    <div
      data-testid="linha"
      data-nome={conversation.contact_name}
      data-numero={conversation.phone_number_id}
      data-isolamento={String(sectorIsolationEnabled)}
      data-numero-nome={numeroNome ?? ""}
      data-numero-hue={numeroHue === null || numeroHue === undefined ? "" : String(numeroHue)}
      data-tags={convTags.map((tag) => tag.name).join("|")}
      data-tags-da-linha={tagsForLine.map((tag) => tag.id).join("|")}
    >
      {conversation.contact_name}
      <button type="button" aria-label={`marcar ${conversation.contact_name}`} data-testid={`marcar-${conversation.contact_name}`} onClick={() => actions.addTag(conversation.id, "tag-x", { stopPropagation: () => undefined })} />
      <button type="button" aria-label={`assumir ${conversation.contact_name}`} data-testid={`assumir-${conversation.contact_name}`} onClick={() => actions.resolveAndAssign(conversation.id)} />
      <button type="button" aria-label={`transferir ${conversation.contact_name}`} data-testid={`transferir-${conversation.contact_name}`} onClick={() => actions.transfer(conversation.id)} />
    </div>
  ),
}));

vi.mock("./PhoneNumberSelector", () => ({
  default: ({ conjunta, numerosDaConjunta }: { conjunta?: boolean; numerosDaConjunta?: readonly string[] }) => (
    <div data-testid="seletor-de-numero" data-conjunta={String(!!conjunta)} data-numeros={(numerosDaConjunta ?? []).join(",")} />
  ),
}));
vi.mock("./StartConversationDialog", () => ({
  default: ({
    onConversationCreated,
    numerosPossiveis,
    numeroPreferidoId,
  }: {
    onConversationCreated?: (id?: string) => void;
    numerosPossiveis?: ReadonlyArray<{ id: string }>;
    numeroPreferidoId?: string | null;
  }) => {
    h.dialogos.aoCriarConversa = onConversationCreated ?? null;
    return (
      <div
        data-testid="dialogo-conversa"
        data-possiveis={numerosPossiveis ? numerosPossiveis.map((n) => n.id).join(",") : "sem-lista"}
        data-preferido={numeroPreferidoId ?? ""}
      />
    );
  },
}));
vi.mock("./CreateGroupDialog", () => ({
  default: ({
    onGroupCreated,
    numerosPossiveis,
    phoneNumberId,
    numeroPreferidoId,
  }: {
    onGroupCreated?: (jid: string, id?: string) => void;
    numerosPossiveis?: ReadonlyArray<{ id: string }>;
    phoneNumberId?: string | null;
    numeroPreferidoId?: string | null;
  }) => {
    h.dialogos.aoCriarGrupo = onGroupCreated ?? null;
    return (
      <div
        data-testid="dialogo-grupo"
        data-possiveis={numerosPossiveis ? numerosPossiveis.map((n) => n.id).join(",") : "sem-lista"}
        data-numero={phoneNumberId ?? ""}
        data-preferido={numeroPreferidoId ?? ""}
      />
    );
  },
}));
vi.mock("./SectorPickerDialog", () => ({
  default: ({ open, sectors }: { open: boolean; sectors: Array<{ id: string; name: string }> }) =>
    open ? <div data-testid="seletor-de-setor">{sectors.map((setor) => setor.name).join("|")}</div> : null,
}));
vi.mock("./GlobalSearchDialog", () => ({
  GlobalSearchDialog: ({
    phoneNumberIds,
    numerosPorId,
  }: {
    phoneNumberIds: readonly string[];
    numerosPorId?: ReadonlyMap<string, { nome: string }>;
  }) => (
    <div
      data-testid="busca-global"
      data-numeros={phoneNumberIds.join(",")}
      data-selos={numerosPorId ? Array.from(numerosPorId.values()).map((n) => n.nome).join("|") : "sem-selo"}
    />
  ),
}));
vi.mock("./TransferConversationDialog", () => ({ TransferConversationDialog: () => null }));
vi.mock("./StatusIndicator", () => ({ StatusIndicator: () => null }));
vi.mock("./ConversationFilterPopover", () => ({
  ConversationFilterPopover: ({
    groups,
  }: {
    groups: Array<{ key: string; options: Array<{ id: string; label: string }>; selected: string[]; onChange: (ids: string[]) => void }>;
  }) => (
    <div>
      {groups.map((grupo) => (
        <div key={grupo.key} data-testid={`grupo-${grupo.key}`}>
          {grupo.options.map((opcao) => (
            <button
              key={opcao.id}
              type="button"
              data-testid={`opcao-${grupo.key}`}
              data-id={opcao.id}
              onClick={() => grupo.onChange([opcao.id])}
            >
              {opcao.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  ),
}));

const { default: ConversationsList } = await import("./ConversationsList");
const { conversationListCache } = await import("@/lib/conversationListCache");

let contador = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const conversa = (numeroId: string, nome: string, extras: Partial<LinhaDoBanco> = {}): LinhaDoBanco => {
  contador += 1;
  return {
    id: uuid(contador),
    contact_name: nome,
    contact_phone: String(5511900000000 + contador),
    last_message_at: new Date(Date.parse("2026-10-21T12:00:00.000Z") - contador * 60_000).toISOString(),
    updated_at: "2026-10-21T12:00:00.000Z",
    status: "active",
    phone_number_id: numeroId,
    sector_id: null,
    assigned_to: null,
    is_group: false,
    contact_avatar_url: null,
    contact_avatar_updated_at: null,
    profiles: null,
    conversation_assignees: [],
    ...extras,
  };
};

const setor = (id: string, name: string, phone_number_id: string | null): SetorFalso => ({
  id,
  name,
  color: null,
  organization_id: "org-1",
  phone_number_id,
});

const usuario = { id: "user-1", email: "a@x.com" } as User;

function Lista({
  escopo,
  numeroUnico = escopo.length === 1 ? escopo[0] : null,
  conjunta = false,
  isQrConnection = true,
  selectedConversationId = null,
  numeroDaConversaAberta = null,
  numerosEmErro = false,
  escopoPendente = false,
  onTentarNumerosNovamente,
}: {
  escopo: readonly string[];
  numeroUnico?: string | null;
  conjunta?: boolean;
  isQrConnection?: boolean;
  selectedConversationId?: string | null;
  numeroDaConversaAberta?: string | null;
  numerosEmErro?: boolean;
  escopoPendente?: boolean;
  onTentarNumerosNovamente?: () => void;
}) {
  return (
    <ConversationsList
      userId="user-1"
      user={usuario}
      onSignOut={() => undefined}
      selectedConversationId={selectedConversationId}
      onSelectConversation={() => undefined}
      escopo={escopo}
      numeroUnico={numeroUnico}
      onPhoneSelect={() => undefined}
      isQrConnection={isQrConnection}
      conjunta={conjunta}
      numerosDaConjunta={conjunta ? escopo : undefined}
      numeroDaConversaAberta={numeroDaConversaAberta}
      numerosEmErro={numerosEmErro}
      escopoPendente={escopoPendente}
      onTentarNumerosNovamente={onTentarNumerosNovamente}
    />
  );
}

const renderizar = (escopo: readonly string[], extras: Partial<Parameters<typeof Lista>[0]> = {}) => {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={cliente}>
      <Lista escopo={escopo} {...extras} />
    </QueryClientProvider>,
  );
};

const linha = (nome: string) => {
  const achada = screen.getAllByTestId("linha").find((el) => el.getAttribute("data-nome") === nome);
  if (!achada) throw new Error(`linha ${nome} não está na tela`);
  return achada;
};
const nomesNaTela = () => screen.queryAllByTestId("linha").map((el) => el.getAttribute("data-nome"));
const opcoesDe = (grupo: string) => screen.queryAllByTestId(`opcao-${grupo}`).map((el) => el.textContent);

const carregada = async (quantas: number) => {
  await waitFor(() => expect(nomesNaTela(), "linhas na tela").toHaveLength(quantas));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  contador = 0;
  h.loja.conversations = [];
  h.loja.versao += 1;
  h.banco = [];
  h.tagsDaOrg = [];
  h.tagsDosNumeros = new Map();
  h.tagsFalhando = new Set();
  h.chamadasDeTags = [];
  h.atualizacoes = [];
  h.numeros = [
    { id: LINHA_A, displayName: "Vendas", sectorIsolationEnabled: false },
    { id: LINHA_B, displayName: "Suporte", sectorIsolationEnabled: false },
  ];
  h.setores = { sectors: [], byId: new Map(), mySectorIds: [], defaultSectorId: null, isolationEnabled: false };
  h.canal.tags = null;
  h.dialogos.aoCriarConversa = null;
  h.dialogos.aoCriarGrupo = null;
  h.linhasDeTransferencia.aoAtualizar = null;
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

describe("tags por número", () => {
  const preparar = () => {
    const maria = conversa(LINHA_A, "Maria");
    const joao = conversa(LINHA_B, "João");
    h.banco = [maria, joao];
    h.tagsDaOrg = [
      { id: "tag-a-vip", name: "Vip", color: "red", phone_number_id: LINHA_A },
      { id: "tag-a-pago", name: "Pago", color: "blue", phone_number_id: LINHA_A },
      { id: "tag-b-vip", name: "vip ", color: "green", phone_number_id: LINHA_B },
    ];
    h.tagsDosNumeros.set(LINHA_A, [{ conversation_id: maria.id, tag_id: "tag-a-vip", tag_name: "Vip", tag_color: "red" }]);
    h.tagsDosNumeros.set(LINHA_B, [{ conversation_id: joao.id, tag_id: "tag-b-vip", tag_name: "vip ", tag_color: "green" }]);
    return { maria, joao };
  };

  it("uma busca de tags por número, e cada conversa recebe as tags do seu número", async () => {
    preparar();
    renderizar([LINHA_A, LINHA_B]);
    await carregada(2);
    await waitFor(() => expect(linha("Maria").getAttribute("data-tags")).toBe("Vip"));
    expect(linha("João").getAttribute("data-tags")).toBe("vip ");
    expect([...h.chamadasDeTags].sort()).toEqual([LINHA_A, LINHA_B].sort());
  });

  it("as linhas recebem as tags dos números do escopo (as de fora não)", async () => {
    preparar();
    h.tagsDaOrg.push({ id: "tag-c", name: "Outra", color: "x", phone_number_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    renderizar([LINHA_A, LINHA_B]);
    await carregada(2);
    await waitFor(() => expect(linha("Maria").getAttribute("data-tags-da-linha")).toContain("tag-a-vip"));
    expect(linha("Maria").getAttribute("data-tags-da-linha")).toBe("tag-a-vip|tag-a-pago|tag-b-vip");
  });

  it("com dois números o filtro mostra uma opção por nome (Vip e vip juntos); com um, uma por tag", async () => {
    preparar();
    const { unmount } = renderizar([LINHA_A, LINHA_B]);
    await carregada(2);
    await waitFor(() => expect(opcoesDe("tags")).toEqual(["Vip", "Pago"]));
    unmount();

    cleanup();
    conversationListCache.clear();
    preparar();
    renderizar([LINHA_A]);
    await carregada(1);
    await waitFor(() => expect(opcoesDe("tags")).toEqual(["Vip", "Pago"]));
    expect(screen.getAllByTestId("opcao-tags").map((el) => el.getAttribute("data-id"))).toEqual(["tag-a-vip", "tag-a-pago"]);
  });

  it("marcar a opção agrupada 'Vip' mostra as conversas com a tag Vip de QUALQUER dos números", async () => {
    const { maria } = preparar();
    h.banco.push(conversa(LINHA_A, "Sem tag"));
    void maria;
    renderizar([LINHA_A, LINHA_B]);
    await carregada(3);
    await waitFor(() => expect(opcoesDe("tags")).toContain("Vip"));
    fireEvent.click(screen.getAllByTestId("opcao-tags").find((el) => el.textContent === "Vip")!);
    await waitFor(() => expect(nomesNaTela().sort()).toEqual(["João", "Maria"]));
  });

  it("um número que falha mantém as tags antigas das conversas dele, e o aviso sai uma vez por lote", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      preparar();
      renderizar([LINHA_A, LINHA_B]);
      await carregada(2);
      await waitFor(() => expect(linha("Maria").getAttribute("data-tags")).toBe("Vip"));
      h.toast.mockClear();

      // Agora o número A falha e o B passa a ter outra tag: o realtime pede o escopo todo.
      h.tagsFalhando.add(LINHA_A);
      const joao = (h.banco as LinhaDoBanco[]).find((c) => c.contact_name === "João")!;
      h.tagsDosNumeros.set(LINHA_B, [{ conversation_id: joao.id, tag_id: "tag-b-nova", tag_name: "Nova", tag_color: "x" }]);
      act(() => h.canal.tags?.({ eventType: "DELETE", old: { id: "so-a-chave" } }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400 + 500 + 1000 + 50);
      });

      await waitFor(() => expect(linha("João").getAttribute("data-tags")).toBe("Nova"));
      expect(linha("Maria").getAttribute("data-tags")).toBe("Vip");
      const avisos = h.toast.mock.calls.filter(([arg]) => (arg as { title: string }).title.includes("tags das conversas"));
      expect(avisos).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marcar uma tag refaz só as tags do número da conversa", async () => {
    preparar();
    renderizar([LINHA_A, LINHA_B]);
    await carregada(2);
    await waitFor(() => expect(linha("Maria").getAttribute("data-tags")).toBe("Vip"));
    h.chamadasDeTags.length = 0;

    await act(async () => {
      fireEvent.click(screen.getByTestId("marcar-João"));
    });
    await waitFor(() => expect(h.chamadasDeTags).toEqual([LINHA_B]));
  });

  it("o realtime de uma tag de uma conversa conhecida refaz só o número dela", async () => {
    const { maria } = preparar();
    renderizar([LINHA_A, LINHA_B]);
    await carregada(2);
    await waitFor(() => expect(h.canal.tags).not.toBeNull());
    h.chamadasDeTags.length = 0;

    act(() => h.canal.tags?.({ eventType: "INSERT", new: { conversation_id: maria.id, tag_id: "tag-a-pago" }, old: {} }));
    await waitFor(() => expect(h.chamadasDeTags).toEqual([LINHA_A]), { timeout: 2000 });
  });
});

describe("setores por número", () => {
  const preparar = () => {
    h.banco = [conversa(LINHA_A, "Maria"), conversa(LINHA_B, "João")];
    h.setores = {
      sectors: [
        setor(SETOR_A_VENDAS, "Vendas", LINHA_A),
        setor(SETOR_B_VENDAS, "vendas", LINHA_B),
        setor(SETOR_B_POS, "Pós-venda", LINHA_B),
        setor(SETOR_LEGADO, "Legado", null),
      ],
      byId: new Map(),
      mySectorIds: [],
      defaultSectorId: null,
      isolationEnabled: false,
    };
  };

  it("sem nenhum número com isolamento o grupo de setores não aparece", async () => {
    preparar();
    renderizar([LINHA_A, LINHA_B]);
    await carregada(2);
    expect(screen.queryByTestId("grupo-sectors")).not.toBeInTheDocument();
    expect(linha("Maria").getAttribute("data-isolamento")).toBe("false");
  });

  it("o grupo aparece se UM número do escopo tem isolamento, e a linha de cada conversa diz o do número dela", async () => {
    preparar();
    h.numeros = [
      { id: LINHA_A, displayName: "Vendas", sectorIsolationEnabled: true },
      { id: LINHA_B, displayName: "Suporte", sectorIsolationEnabled: false },
    ];
    renderizar([LINHA_A, LINHA_B]);
    await carregada(2);
    expect(screen.getByTestId("grupo-sectors")).toBeInTheDocument();
    expect(linha("Maria").getAttribute("data-isolamento")).toBe("true");
    expect(linha("João").getAttribute("data-isolamento")).toBe("false");
    // só os setores do A (e o legado): os do B, sem isolamento, ficam de fora
    expect(opcoesDe("sectors")).toEqual(["Sem setor (triagem)", "Vendas", "Legado"]);
  });

  it("com isolamento nos dois, junta por nome (Vendas e vendas viram uma opção) e a seleção casa os dois ids", async () => {
    preparar();
    h.numeros = [
      { id: LINHA_A, displayName: "Vendas", sectorIsolationEnabled: true },
      { id: LINHA_B, displayName: "Suporte", sectorIsolationEnabled: true },
    ];
    const emVendasA = conversa(LINHA_A, "Na Vendas A", { sector_id: SETOR_A_VENDAS });
    const emVendasB = conversa(LINHA_B, "Na Vendas B", { sector_id: SETOR_B_VENDAS });
    const emPos = conversa(LINHA_B, "No Pós", { sector_id: SETOR_B_POS });
    h.banco.push(emVendasA, emVendasB, emPos);
    renderizar([LINHA_A, LINHA_B]);
    await carregada(5);
    expect(opcoesDe("sectors")).toEqual(["Sem setor (triagem)", "Vendas", "Pós-venda", "Legado"]);

    fireEvent.click(screen.getAllByTestId("opcao-sectors").find((el) => el.textContent === "Vendas")!);
    await waitFor(() => expect(nomesNaTela().sort()).toEqual(["Na Vendas A", "Na Vendas B"]));
  });

  it("'Sem setor (triagem)' com 2+ números mostra só o sem setor dos números COM isolamento", async () => {
    preparar();
    h.numeros = [
      { id: LINHA_A, displayName: "Vendas", sectorIsolationEnabled: true },
      { id: LINHA_B, displayName: "Suporte", sectorIsolationEnabled: false },
    ];
    // Maria (A, isolamento, sem setor) e João (B, sem isolamento, sem setor) vêm de preparar()
    h.banco.push(conversa(LINHA_A, "Na Vendas A", { sector_id: SETOR_A_VENDAS }));
    renderizar([LINHA_A, LINHA_B]);
    await carregada(3);

    fireEvent.click(screen.getAllByTestId("opcao-sectors").find((el) => el.textContent === "Sem setor (triagem)")!);
    await waitFor(() => expect(nomesNaTela()).toEqual(["Maria"]));
  });

  it("'Sem setor (triagem)' com um número só, com isolamento, segue mostrando o sem setor dele", async () => {
    preparar();
    h.numeros = [
      { id: LINHA_A, displayName: "Vendas", sectorIsolationEnabled: true },
      { id: LINHA_B, displayName: "Suporte", sectorIsolationEnabled: false },
    ];
    h.banco.push(conversa(LINHA_A, "Na Vendas A", { sector_id: SETOR_A_VENDAS }));
    renderizar([LINHA_A]);
    await carregada(2);

    fireEvent.click(screen.getAllByTestId("opcao-sectors").find((el) => el.textContent === "Sem setor (triagem)")!);
    await waitFor(() => expect(nomesNaTela()).toEqual(["Maria"]));
  });

  it("'Assumir' decide o setor pelo número da conversa: o isolamento e os setores são os dele", async () => {
    preparar();
    h.numeros = [
      { id: LINHA_A, displayName: "Vendas", sectorIsolationEnabled: true },
      { id: LINHA_B, displayName: "Suporte", sectorIsolationEnabled: false },
    ];
    // sou do setor de A e dos dois de B; sem padrão
    h.setores.mySectorIds = [SETOR_A_VENDAS, SETOR_B_VENDAS, SETOR_B_POS];
    renderizar([LINHA_A, LINHA_B]);
    await carregada(2);

    // Conversa do B (sem isolamento): assume sem setor nenhum, sem perguntar.
    await act(async () => {
      fireEvent.click(screen.getByTestId("assumir-João"));
    });
    await waitFor(() => expect(h.atualizacoes).toHaveLength(1));
    expect(h.atualizacoes[0].valores).toEqual({ assigned_to: "user-1" });
    expect(screen.queryByTestId("seletor-de-setor")).not.toBeInTheDocument();

    // Conversa do A (isolamento, um setor meu no A): assume já no setor do A.
    await act(async () => {
      fireEvent.click(screen.getByTestId("assumir-Maria"));
    });
    await waitFor(() => expect(h.atualizacoes).toHaveLength(2));
    expect(h.atualizacoes[1].valores).toEqual({ assigned_to: "user-1", sector_id: SETOR_A_VENDAS });
  });

  it("'Assumir' com dois setores meus no número da conversa e nenhum padrão: pergunta, só com os setores DELE", async () => {
    preparar();
    h.numeros = [
      { id: LINHA_A, displayName: "Vendas", sectorIsolationEnabled: true },
      { id: LINHA_B, displayName: "Suporte", sectorIsolationEnabled: true },
    ];
    h.setores.mySectorIds = [SETOR_A_VENDAS, SETOR_B_VENDAS, SETOR_B_POS];
    renderizar([LINHA_A, LINHA_B]);
    await carregada(2);

    await act(async () => {
      fireEvent.click(screen.getByTestId("assumir-João"));
    });
    const seletor = await screen.findByTestId("seletor-de-setor");
    expect(seletor).toHaveTextContent("vendas|Pós-venda");
    expect(h.atualizacoes).toHaveLength(0);
  });
});

describe("busca global", () => {
  it("recebe todos os números do escopo", async () => {
    h.banco = [conversa(LINHA_A, "Maria")];
    renderizar([LINHA_B, LINHA_A]);
    await carregada(1);
    expect(screen.getByTestId("busca-global").getAttribute("data-numeros")).toBe(`${LINHA_A},${LINHA_B}`);
  });

  it("o botão de buscar fica desligado com o escopo vazio e ligado com números", async () => {
    const { unmount } = renderizar([]);
    expect(screen.getByLabelText("Buscar em mensagens (Ctrl+K)")).toBeDisabled();
    unmount();
    renderizar([LINHA_A, LINHA_B]);
    expect(screen.getByLabelText("Buscar em mensagens (Ctrl+K)")).toBeEnabled();
  });
});

describe("refresh por id", () => {
  it("conversa criada com id: rebusca só ela; sem id (importação), refaz a lista", async () => {
    h.banco = [conversa(LINHA_A, "Maria")];
    renderizar([LINHA_A]);
    await carregada(1);

    act(() => h.dialogos.aoCriarConversa?.("conv-nova"));
    expect(h.refreshConversationById).toHaveBeenCalledWith("conv-nova");

    h.refreshConversationById.mockClear();
    act(() => h.dialogos.aoCriarConversa?.());
    expect(h.refreshConversationById).not.toHaveBeenCalled();
  });

  it("grupo criado com o id da conversa: rebusca só ela; sem id (já existia), refaz a lista", async () => {
    h.banco = [conversa(LINHA_A, "Maria")];
    renderizar([LINHA_A]);
    await carregada(1);

    act(() => h.dialogos.aoCriarGrupo?.("grupo@g.us", "conv-do-grupo"));
    expect(h.refreshConversationById).toHaveBeenCalledWith("conv-do-grupo");

    h.refreshConversationById.mockClear();
    act(() => h.dialogos.aoCriarGrupo?.("grupo@g.us"));
    expect(h.refreshConversationById).not.toHaveBeenCalled();
  });

  it("transferência pelo menu: rebusca só a conversa transferida", async () => {
    const maria = conversa(LINHA_A, "Maria");
    h.banco = [maria, conversa(LINHA_B, "João")];
    renderizar([LINHA_A, LINHA_B]);
    await carregada(2);

    fireEvent.click(screen.getByTestId("transferir-Maria"));
    act(() => h.linhasDeTransferencia.aoAtualizar?.());
    expect(h.refreshConversationById).toHaveBeenCalledTimes(1);
    expect(h.refreshConversationById).toHaveBeenCalledWith(maria.id);
  });
});


describe("caixa conjunta na tela", () => {
  beforeEach(() => {
    h.numeros = [
      { id: LINHA_A, displayName: "Vendas", themeHue: 200, connectionType: "business_api", metaPhoneNumberId: "meta-a", sectorIsolationEnabled: false },
      { id: LINHA_B, displayName: "Suporte", themeHue: null, connectionType: "qr", metaPhoneNumberId: "qr_b", sectorIsolationEnabled: false },
    ];
  });

  it("na conjunta cada linha leva o nome e a cor do número dela; no modo número, nenhum selo", async () => {
    h.banco = [conversa(LINHA_A, "Maria"), conversa(LINHA_B, "João")];
    const { unmount } = renderizar([LINHA_A, LINHA_B], { conjunta: true });
    await carregada(2);
    expect(linha("Maria").getAttribute("data-numero-nome")).toBe("Vendas");
    expect(linha("Maria").getAttribute("data-numero-hue")).toBe("200");
    expect(linha("João").getAttribute("data-numero-nome")).toBe("Suporte");
    expect(linha("João").getAttribute("data-numero-hue")).toBe("");
    unmount();

    h.banco = [conversa(LINHA_A, "Maria")];
    renderizar([LINHA_A]);
    await carregada(1);
    expect(linha("Maria").getAttribute("data-numero-nome")).toBe("");
  });

  it("conjunta esperando o mapa que falhou: mostra a falha com 'Tentar novamente', sem skeleton nem vazio falso, e não confere a contagem", async () => {
    h.contarNumeros.mockClear();
    const tentar = vi.fn();
    renderizar([], { conjunta: true, numerosEmErro: true, onTentarNumerosNovamente: tentar });
    expect(await screen.findByText("Não foi possível carregar os números")).toBeTruthy();
    expect(screen.queryByText(/Nenhuma conversa/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Nova conversa" }).getAttribute("title")).toBe("Nova conversa");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.contarNumeros).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Tentar novamente/ }));
    expect(tentar).toHaveBeenCalledTimes(1);
  });

  it("escopo pendente (o mapa da conjunta ainda não chegou): não conta não-lidos nem busca a org inteira", async () => {
    h.contarNumeros.mockClear();
    h.refreshUnreadCounts.mockClear();
    renderizar([], { conjunta: true, escopoPendente: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.refreshUnreadCounts).not.toHaveBeenCalled();
    expect(h.contarNumeros).not.toHaveBeenCalled();
  });

  it("sem escopo pendente, a lista vazia segue contando os não-lidos", async () => {
    h.refreshUnreadCounts.mockClear();
    renderizar([]);
    await waitFor(() => expect(h.refreshUnreadCounts).toHaveBeenCalled());
  });

  it("passa a conjunta e os números dela ao seletor", async () => {
    h.banco = [conversa(LINHA_A, "Maria")];
    renderizar([LINHA_A, LINHA_B], { conjunta: true });
    await carregada(1);
    const seletor = screen.getByTestId("seletor-de-numero");
    expect(seletor.getAttribute("data-conjunta")).toBe("true");
    expect(seletor.getAttribute("data-numeros")).toBe(`${LINHA_A},${LINHA_B}`);
  });

  it("a busca global leva o mapa de números em qualquer modo (selo no resultado)", async () => {
    h.banco = [conversa(LINHA_A, "Maria")];
    const { unmount } = renderizar([LINHA_A, LINHA_B], { conjunta: true });
    await carregada(1);
    expect(screen.getByTestId("busca-global").getAttribute("data-selos")).toBe("Vendas|Suporte");
    unmount();
    renderizar([LINHA_A]);
    await carregada(1);
    // No modo número a busca também leva o mapa: o selo aparece no resultado, e as LINHAS da lista seguem sem selo.
    expect(screen.getByTestId("busca-global").getAttribute("data-selos")).toBe("Vendas|Suporte");
  });

  it("os diálogos recebem os números do escopo (grupo só os QR) e o número da conversa aberta como padrão", async () => {
    const maria = conversa(LINHA_B, "Maria");
    h.banco = [maria, conversa(LINHA_A, "João")];
    h.loja.conversations = [];
    renderizar([LINHA_A, LINHA_B], { conjunta: true, numeroUnico: null, isQrConnection: false });
    await carregada(2);
    expect(screen.getByTestId("dialogo-conversa").getAttribute("data-possiveis")).toBe(`${LINHA_A},${LINHA_B}`);
    // Grupo só existe em número QR: o B. O Grupos aparece porque há um QR no escopo.
    expect(screen.getByTestId("dialogo-grupo").getAttribute("data-possiveis")).toBe(LINHA_B);
    expect(screen.getByTestId("dialogo-grupo").getAttribute("data-numero")).toBe("");
    expect(screen.getByLabelText("Grupos")).toBeTruthy();
    // Sem conversa aberta não há número preferido.
    expect(screen.getByTestId("dialogo-conversa").getAttribute("data-preferido")).toBe("");
  });

  it("o número padrão dos diálogos é o da conversa aberta", async () => {
    const maria = conversa(LINHA_B, "Maria");
    h.banco = [maria, conversa(LINHA_A, "João")];
    renderizar([LINHA_A, LINHA_B], { conjunta: true, numeroUnico: null, isQrConnection: false, selectedConversationId: maria.id, numeroDaConversaAberta: LINHA_B });
    await carregada(2);
    expect(screen.getByTestId("dialogo-conversa").getAttribute("data-preferido")).toBe(LINHA_B);
    expect(screen.getByTestId("dialogo-grupo").getAttribute("data-preferido")).toBe(LINHA_B);
  });

  it("deep link: a conversa aberta ainda não está na lista, e o padrão segue o número dela", async () => {
    h.banco = [conversa(LINHA_A, "João")];
    renderizar([LINHA_A, LINHA_B], { conjunta: true, numeroUnico: null, isQrConnection: false, selectedConversationId: "conv-do-deep-link", numeroDaConversaAberta: LINHA_B });
    await carregada(1);
    expect(screen.getByTestId("dialogo-conversa").getAttribute("data-preferido")).toBe(LINHA_B);
    expect(screen.getByTestId("dialogo-grupo").getAttribute("data-preferido")).toBe(LINHA_B);
  });

  it("sem número QR no escopo da conjunta não há Grupos nem o diálogo de grupo", async () => {
    h.numeros = [
      { id: LINHA_A, displayName: "Vendas", themeHue: 200, connectionType: "business_api", metaPhoneNumberId: "meta-a", sectorIsolationEnabled: false },
      { id: LINHA_B, displayName: "Outra API", themeHue: 10, connectionType: "business_api", metaPhoneNumberId: "meta-b", sectorIsolationEnabled: false },
    ];
    h.banco = [conversa(LINHA_A, "Maria")];
    renderizar([LINHA_A, LINHA_B], { conjunta: true, numeroUnico: null, isQrConnection: false });
    await carregada(1);
    expect(screen.queryByLabelText("Grupos")).toBeNull();
    expect(screen.queryByTestId("dialogo-grupo")).toBeNull();
  });

  it("no modo número os diálogos seguem com as props do número (sem a lista de números)", async () => {
    h.banco = [conversa(LINHA_B, "Maria")];
    renderizar([LINHA_B]);
    await carregada(1);
    expect(screen.getByTestId("dialogo-conversa").getAttribute("data-possiveis")).toBe("sem-lista");
    expect(screen.getByTestId("dialogo-grupo").getAttribute("data-possiveis")).toBe("sem-lista");
    expect(screen.getByTestId("dialogo-grupo").getAttribute("data-numero")).toBe(LINHA_B);
  });
});
