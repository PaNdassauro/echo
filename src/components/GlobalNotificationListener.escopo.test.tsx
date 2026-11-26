// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Conversation } from "@/types/conversation";

/**
 * O som da busca de reserva do não-lido, com a lista TROCANDO de número no meio do poll. O
 * NotificationProvider e o GlobalNotificationListener são os reais; o canal global cai logo
 * (CHANNEL_ERROR), então o único caminho do som é a busca de reserva. A RPC de contagem fica
 * retida até o teste responder, para dar tempo à troca de escopo.
 */

afterEach(cleanup);

const LINHA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINHA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EU = "user-1";

type Linhas = Array<{ conversation_id: string; count: number }>;

const h = vi.hoisted(() => ({
  chamadas: [] as Array<{
    linha: string | null;
    respondido: boolean;
    responder: (rows: Linhas) => void;
  }>,
  som: vi.fn(),
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => () => {} }));

vi.mock("@/integrations/supabase/client", () => {
  const consulta = () => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.not = () => c;
    c.eq = () => c;
    c.maybeSingle = () => Promise.resolve({ data: null, error: null });
    c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);
    return c;
  };
  const canal = (nome: string) => {
    const ch = {
      on() {
        return ch;
      },
      subscribe(cb?: (status: string) => void) {
        // O canal global nunca assina: a busca de reserva é o único caminho do som.
        if (nome === "global-notifications" && cb) queueMicrotask(() => cb("CHANNEL_ERROR"));
        return ch;
      },
      async send() {},
    };
    return ch;
  };
  return {
    supabase: {
      channel: canal,
      removeChannel: () => {},
      auth: { getUser: async () => ({ data: { user: { id: EU } } }) },
      from: () => consulta(),
      rpc: (nome: string, args: Record<string, unknown>) => {
        if (nome !== "get_unread_counts") return Promise.resolve({ data: null, error: null });
        // O builder real do supabase-js aceita `.abortSignal()`: o código sob teste o encadeia.
        const promessa = new Promise((resolve) => {
          const chamada = {
            linha: (args.p_phone_number_id as string | null) ?? null,
            respondido: false,
            responder: (rows: Linhas) => {
              if (chamada.respondido) return;
              chamada.respondido = true;
              resolve({ data: rows.map((r) => ({ total_conversations: rows.length, ...r })), error: null });
            },
          };
          h.chamadas.push(chamada);
        });
        return Object.assign(promessa, { abortSignal: () => promessa });
      },
      functions: { invoke: () => Promise.resolve({ error: null }) },
    },
  };
});

vi.mock("@/hooks/useConversationPrefs", () => {
  const estavel = {
    conversationPrefs: new Map(),
    togglePinned: async () => true,
    toggleArchived: async () => true,
    setMutedUntil: async () => true,
    isMuted: () => false,
  };
  return { useConversationPrefsState: () => estavel };
});
vi.mock("@/hooks/useNotificationSound", () => {
  const estavel = { playNotificationSound: (...a: unknown[]) => h.som(...a) };
  return { useNotificationSound: () => estavel };
});
vi.mock("@/hooks/usePushSubscription", () => ({ usePushSubscription: () => undefined }));
vi.mock("@/lib/nativeNotification", () => ({
  ensureNotificationPermission: vi.fn(),
  showNativeNotification: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }));

const { NotificationProvider, useNotifications } = await import("@/contexts/NotificationContext");
const { GlobalNotificationListener } = await import("@/components/GlobalNotificationListener");

type Contexto = ReturnType<typeof useNotifications>;
let ctx: Contexto;
const Sonda = () => {
  ctx = useNotifications();
  return null;
};

const conversa = (id: string, numeroId: string, dono: string | null): Conversation => ({
  id,
  contact_name: id,
  contact_phone: "5511999990001",
  last_message_at: "2026-10-21T12:00:00.000Z",
  status: "active",
  phone_number_id: numeroId,
  assigned_to: dono,
});

const avancar = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** A RPC de contagem ainda sem resposta para esta linha (a mais antiga, se houver mais de uma). */
const pendente = (linha: string | null) => {
  const chamada = h.chamadas.find((x) => x.linha === linha && !x.respondido);
  if (!chamada) throw new Error(`sem chamada pendente de ${linha}`);
  return chamada;
};

const pendentesDe = (linha: string | null) => h.chamadas.filter((x) => x.linha === linha && !x.respondido);

/** Escopo A aplicado (ca1 = 1 não-lida), lista com A e B em memória, poll a 10 s. */
async function prepararEstadoEstavel() {
  render(
    <NotificationProvider>
      <Sonda />
      <GlobalNotificationListener />
    </NotificationProvider>,
  );
  await avancar(0);
  // A busca do mount, sem escopo.
  await act(async () => pendente(null).responder([]));
  // A lista escolheu o número A.
  act(() => ctx.setUnreadScope([LINHA_A]));
  act(() => {
    void ctx.refreshUnreadCounts();
  });
  await avancar(0);
  await act(async () => pendente(LINHA_A).responder([{ conversation_id: "ca1", count: 1 }]));
  // A lista tem as conversas de A e as de B (o cache pintado na troca).
  act(() => ctx.setConversations([conversa("ca1", LINHA_A, EU), conversa("cb1", LINHA_B, EU)]));
  await avancar(0);
  expect(ctx.unreadCounts).toEqual(new Map([["ca1", 1]]));
}

beforeEach(() => {
  h.chamadas.length = 0;
  h.som.mockClear();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("busca de reserva do não-lido com a lista trocando de número", () => {
  it("controle: nada aumentou, não toca", async () => {
    await prepararEstadoEstavel();
    await avancar(10_000);
    await act(async () => pendente(LINHA_A).responder([{ conversation_id: "ca1", count: 1 }]));
    await avancar(0);
    expect(h.som).toHaveBeenCalledTimes(0);
  });

  it("controle: aumento real numa conversa minha em A toca uma vez", async () => {
    await prepararEstadoEstavel();
    await avancar(10_000);
    await act(async () => pendente(LINHA_A).responder([{ conversation_id: "ca1", count: 2 }]));
    await avancar(0);
    expect(h.som).toHaveBeenCalledTimes(1);
  });

  it("troca de A para B com o poll em voo: a não-lida antiga de B não toca", async () => {
    await prepararEstadoEstavel();
    await avancar(10_000);
    expect(pendentesDe(LINHA_A)).toHaveLength(1);

    // A lista troca de número, como o efeito de escopo faz: o poll em voo ainda espera A.
    act(() => ctx.setUnreadScope([LINHA_B]));
    act(() => {
      void ctx.refreshUnreadCounts();
    });

    // A resposta velha (de A) é descartada; a mesma espera do poll recebe a de B.
    await act(async () => pendente(LINHA_A).responder([{ conversation_id: "ca1", count: 1 }]));
    await avancar(0);
    expect(pendentesDe(LINHA_B)).toHaveLength(1);

    // B tem uma não-lida que já estava lá antes da troca: não é mensagem nova.
    await act(async () => pendente(LINHA_B).responder([{ conversation_id: "cb1", count: 2 }]));
    await avancar(0);

    expect(ctx.unreadCounts).toEqual(new Map([["cb1", 2]]));
    expect(h.som).toHaveBeenCalledTimes(0);
  });

  it("poll disparado depois da troca, com a busca de B ainda em voo: não toca", async () => {
    await prepararEstadoEstavel();
    act(() => ctx.setUnreadScope([LINHA_B]));
    act(() => {
      void ctx.refreshUnreadCounts();
    });
    await avancar(0);
    expect(pendentesDe(LINHA_B)).toHaveLength(1);

    // O poll dispara com a busca de B em voo: junta-se a ela.
    await avancar(10_000);
    await act(async () => {
      for (const chamada of pendentesDe(LINHA_B)) chamada.responder([{ conversation_id: "cb1", count: 2 }]);
    });
    await avancar(0);

    expect(h.som).toHaveBeenCalledTimes(0);
  });

  it("depois da troca, o próximo poll (escopo B estável) ainda toca por aumento real em B", async () => {
    await prepararEstadoEstavel();
    await avancar(10_000);
    act(() => ctx.setUnreadScope([LINHA_B]));
    act(() => {
      void ctx.refreshUnreadCounts();
    });
    await act(async () => pendente(LINHA_A).responder([{ conversation_id: "ca1", count: 1 }]));
    await avancar(0);
    await act(async () => pendente(LINHA_B).responder([{ conversation_id: "cb1", count: 2 }]));
    await avancar(0);
    h.som.mockClear();

    await avancar(10_000);
    await act(async () => pendente(LINHA_B).responder([{ conversation_id: "cb1", count: 3 }]));
    await avancar(0);

    expect(h.som).toHaveBeenCalledTimes(1);
  });

  it("A → B → A com o poll em voo, sem aumento: não toca", async () => {
    await prepararEstadoEstavel();
    await avancar(10_000);
    act(() => ctx.setUnreadScope([LINHA_B]));
    act(() => ctx.setUnreadScope([LINHA_A]));
    act(() => {
      void ctx.refreshUnreadCounts();
    });
    await act(async () => pendente(LINHA_A).responder([{ conversation_id: "ca1", count: 1 }]));
    await avancar(0);
    await act(async () => pendente(LINHA_A).responder([{ conversation_id: "ca1", count: 1 }]));
    await avancar(0);

    expect(h.som).toHaveBeenCalledTimes(0);
  });

  it("A → B → A com aumento real em A durante o voo: toca uma vez", async () => {
    await prepararEstadoEstavel();
    await avancar(10_000);
    act(() => ctx.setUnreadScope([LINHA_B]));
    act(() => ctx.setUnreadScope([LINHA_A]));
    act(() => {
      void ctx.refreshUnreadCounts();
    });
    await act(async () => pendente(LINHA_A).responder([{ conversation_id: "ca1", count: 1 }]));
    await avancar(0);
    await act(async () => pendente(LINHA_A).responder([{ conversation_id: "ca1", count: 2 }]));
    await avancar(0);

    expect(h.som).toHaveBeenCalledTimes(1);
  });
});
