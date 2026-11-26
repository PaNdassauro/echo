// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Conversation } from "@/types/conversation";

/**
 * O NotificationProvider real com a lista de conversas feita de VÁRIOS números: a
 * contagem de não-lido vai por número (cada chamada com o próprio teto), uma busca
 * por vez, e "marcar tudo como lido" só mexe no escopo da tela. O supabase é falso e
 * devolve só o que o teste libera.
 */

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no seguinte.
afterEach(cleanup);

const LINHA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINHA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINHA_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const h = vi.hoisted(() => ({
  /** Cada chamada de get_unread_counts, com o que o teste decide responder. */
  chamadas: [] as Array<{
    linha: string | null;
    respondido: boolean;
    responder: (rows: Array<{ conversation_id: string; count: number; total_conversations?: number }>) => void;
    falhar: (mensagem: string) => void;
  }>,
  emVoo: 0,
  picoEmVoo: 0,
  /** mark_conversations_read: os ids de cada chamada. */
  marcadas: [] as string[][],
  /** O que o select de uma conversa por id devolve. */
  conversaPorId: {} as Record<string, unknown>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const consulta = (tabela: string) => {
    const c: Record<string, unknown> = {};
    const proprios: Array<[string, unknown]> = [];
    c.select = () => c;
    c.not = () => c;
    c.eq = (coluna: string, valor: unknown) => {
      proprios.push([coluna, valor]);
      return c;
    };
    c.maybeSingle = () => {
      const id = proprios.find(([coluna]) => coluna === "id")?.[1] as string | undefined;
      return Promise.resolve({ data: id ? (h.conversaPorId[id] ?? null) : null, error: null });
    };
    // `await supabase.from(...).select(...)`: conversation_reads e afins voltam vazias.
    c.then = (resolve: (valor: unknown) => unknown, reject: (erro: unknown) => unknown) =>
      Promise.resolve({ data: tabela === "conversation_reads" ? [] : [], error: null }).then(resolve, reject);
    return c;
  };

  return {
    supabase: {
      from: (tabela: string) => consulta(tabela),
      rpc: (nome: string, args: Record<string, unknown>) => {
        if (nome === "mark_conversations_read") {
          h.marcadas.push(args.p_conversation_ids as string[]);
          return Promise.resolve({ error: null });
        }
        if (nome !== "get_unread_counts") return Promise.resolve({ data: null, error: null });

        // O builder real do supabase-js aceita `.abortSignal()`: o código sob teste o encadeia.
        const promessa = new Promise((resolve) => {
          h.emVoo += 1;
          h.picoEmVoo = Math.max(h.picoEmVoo, h.emVoo);
          const chamada = {
            linha: (args.p_phone_number_id as string | null) ?? null,
            respondido: false,
            responder: (rows: Array<{ conversation_id: string; count: number; total_conversations?: number }>) => {
              if (chamada.respondido) return;
              chamada.respondido = true;
              h.emVoo -= 1;
              resolve({
                data: rows.map((r) => ({ total_conversations: rows.length, ...r })),
                error: null,
              });
            },
            falhar: (mensagem: string) => {
              if (chamada.respondido) return;
              chamada.respondido = true;
              h.emVoo -= 1;
              resolve({ data: null, error: { message: mensagem } });
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

// Fixar/arquivar/silenciar tem suas próprias consultas: aqui não interessam.
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

const { NotificationProvider, useNotifications } = await import("./NotificationContext");

type Contexto = ReturnType<typeof useNotifications>;
let ctx: Contexto;

const Sonda = () => {
  ctx = useNotifications();
  return null;
};

const montar = () =>
  render(
    <NotificationProvider>
      <Sonda />
    </NotificationProvider>,
  );

const assentar = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const conversa = (id: string, numeroId: string | null, extras: Partial<Conversation> = {}): Conversation => ({
  id,
  contact_name: id,
  contact_phone: "5511999990001",
  last_message_at: "2026-10-21T12:00:00.000Z",
  status: "active",
  phone_number_id: numeroId,
  assigned_to: null,
  ...extras,
});

/** As chamadas ainda sem resposta, de um número. */
const pendente = (linha: string | null) => {
  const chamada = h.chamadas.find((c) => c.linha === linha && !c.respondido);
  if (!chamada) throw new Error(`sem chamada pendente de ${linha}`);
  return chamada;
};

beforeEach(() => {
  h.chamadas.length = 0;
  h.marcadas.length = 0;
  h.emVoo = 0;
  h.picoEmVoo = 0;
  h.conversaPorId = {};
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotificationProvider — contagem de não-lido por número", () => {
  it("sem número no escopo faz UMA chamada, sem filtro, como sempre", async () => {
    montar();
    await assentar();

    expect(h.chamadas.map((c) => c.linha)).toEqual([null]);
    await act(async () => pendente(null).responder([{ conversation_id: "c1", count: 2 }]));
    expect(ctx.unreadCounts.get("c1")).toBe(2);
  });

  it("com vários números faz uma chamada por número e junta as respostas", async () => {
    montar();
    await assentar();
    await act(async () => pendente(null).responder([]));

    act(() => ctx.setUnreadScope([LINHA_A, LINHA_B]));
    let resultado: Promise<Map<string, number> | undefined> | undefined;
    act(() => {
      resultado = ctx.refreshUnreadCounts();
    });
    await assentar();

    expect(h.chamadas.slice(1).map((c) => c.linha).sort()).toEqual([LINHA_A, LINHA_B].sort());

    await act(async () => {
      pendente(LINHA_A).responder([{ conversation_id: "ca", count: 3 }]);
      pendente(LINHA_B).responder([{ conversation_id: "cb", count: 1 }]);
    });
    const mapa = await resultado;

    expect(mapa).toEqual(
      new Map([
        ["ca", 3],
        ["cb", 1],
      ]),
    );
    expect(ctx.unreadCounts).toEqual(mapa);
  });

  it("no máximo 4 chamadas em voo ao mesmo tempo", async () => {
    const numeros = Array.from({ length: 9 }, (_, i) => `${String(i).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    montar();
    await assentar();
    await act(async () => pendente(null).responder([]));
    h.picoEmVoo = 0;

    act(() => ctx.setUnreadScope(numeros));
    let resultado: Promise<Map<string, number> | undefined> | undefined;
    act(() => {
      resultado = ctx.refreshUnreadCounts();
    });
    await assentar();
    expect(h.emVoo).toBe(4);

    // Vai liberando uma a uma, sempre a mais antiga.
    while (h.chamadas.some((c) => !c.respondido)) {
      const proxima = h.chamadas.find((c) => !c.respondido);
      await act(async () => proxima?.responder([]));
    }
    await resultado;

    expect(h.picoEmVoo).toBe(4);
    expect(h.chamadas.slice(1)).toHaveLength(9);
  });

  it("chamadas durante o voo dividem a mesma busca", async () => {
    montar();
    await assentar();
    await act(async () => pendente(null).responder([]));

    act(() => ctx.setUnreadScope([LINHA_A, LINHA_B]));
    const antes = h.chamadas.length;
    let primeira: Promise<unknown> | undefined;
    let segunda: Promise<unknown> | undefined;
    act(() => {
      primeira = ctx.refreshUnreadCounts();
      segunda = ctx.refreshUnreadCounts();
    });
    await assentar();

    expect(segunda).toBe(primeira);
    // Duas chamadas ao refresh, uma ida ao banco por número.
    expect(h.chamadas.length - antes).toBe(2);

    await act(async () => {
      pendente(LINHA_A).responder([]);
      pendente(LINHA_B).responder([]);
    });
    await primeira;
  });

  it("chamada fresca no meio do voo: a foto antiga não vale e o que entrou depois dela aparece", async () => {
    montar();
    await assentar();
    await act(async () => pendente(null).responder([]));

    act(() => ctx.setUnreadScope([LINHA_A]));
    let emVoo: Promise<Map<string, number> | undefined> | undefined;
    act(() => {
      emVoo = ctx.refreshUnreadCounts();
    });
    await assentar();
    const antes = h.chamadas.length;

    // O canal reassinou: pede uma busca iniciada agora, com o voo da foto antiga ainda a caminho.
    let fresca: Promise<Map<string, number> | undefined> | undefined;
    act(() => {
      fresca = ctx.refreshUnreadCounts({ fresca: true });
    });
    expect(fresca).toBe(emVoo);

    // A foto antiga (sem "nova") chega: não vai ao estado, e a busca se refaz.
    await act(async () => pendente(LINHA_A).responder([{ conversation_id: "antiga", count: 1 }]));
    await assentar();
    expect(ctx.unreadCounts.has("antiga")).toBe(false);
    // Uma ida nova ao banco, além da que já estava em voo.
    expect(h.chamadas.length - antes).toBe(1);

    await act(async () =>
      pendente(LINHA_A).responder([
        { conversation_id: "antiga", count: 1 },
        { conversation_id: "nova", count: 1 },
      ]),
    );
    await expect(fresca).resolves.toEqual(
      new Map([
        ["antiga", 1],
        ["nova", 1],
      ]),
    );
    expect(ctx.unreadCounts.get("nova")).toBe(1);
  });

  it("um número que falha mantém as contagens que já tinha; o que respondeu é atualizado", async () => {
    montar();
    await assentar();
    await act(async () => pendente(null).responder([]));

    // A lista em memória diz de que número é cada conversa.
    act(() => ctx.setConversations([conversa("ca1", LINHA_A), conversa("ca2", LINHA_A), conversa("cb1", LINHA_B)]));
    act(() => ctx.setUnreadScope([LINHA_A, LINHA_B]));

    let primeira: Promise<unknown> | undefined;
    act(() => {
      primeira = ctx.refreshUnreadCounts();
    });
    await assentar();
    await act(async () => {
      pendente(LINHA_A).responder([
        { conversation_id: "ca1", count: 2 },
        { conversation_id: "ca2", count: 1 },
      ]);
      pendente(LINHA_B).responder([{ conversation_id: "cb1", count: 4 }]);
    });
    await primeira;
    expect(ctx.unreadCounts).toEqual(
      new Map([
        ["ca1", 2],
        ["ca2", 1],
        ["cb1", 4],
      ]),
    );

    // Segunda busca: A falha, B responde que a conversa foi lida.
    let segunda: Promise<Map<string, number> | undefined> | undefined;
    act(() => {
      segunda = ctx.refreshUnreadCounts();
    });
    await assentar();
    await act(async () => {
      pendente(LINHA_A).falhar("timeout");
      pendente(LINHA_B).responder([]);
    });
    const mapa = await segunda;

    expect(mapa).toEqual(
      new Map([
        ["ca1", 2],
        ["ca2", 1],
      ]),
    );
    expect(ctx.unreadCounts).toEqual(mapa);
  });

  it("todos os números falharam: devolve undefined e o mapa fica como estava", async () => {
    montar();
    await assentar();
    await act(async () => pendente(null).responder([{ conversation_id: "c1", count: 2 }]));
    expect(ctx.unreadCounts.get("c1")).toBe(2);

    act(() => ctx.setUnreadScope([LINHA_A, LINHA_B]));
    let resultado: Promise<Map<string, number> | undefined> | undefined;
    act(() => {
      resultado = ctx.refreshUnreadCounts();
    });
    await assentar();
    await act(async () => {
      pendente(LINHA_A).falhar("a");
      pendente(LINHA_B).falhar("b");
    });

    await expect(resultado).resolves.toBeUndefined();
    expect(ctx.unreadCounts.get("c1")).toBe(2);
  });

  it("resposta truncada de um número avisa o número, não os outros", async () => {
    const aviso = vi.spyOn(console, "warn");
    montar();
    await assentar();
    await act(async () => pendente(null).responder([]));

    act(() => ctx.setUnreadScope([LINHA_A, LINHA_B]));
    let resultado: Promise<unknown> | undefined;
    act(() => {
      resultado = ctx.refreshUnreadCounts();
    });
    await assentar();
    await act(async () => {
      pendente(LINHA_A).responder([{ conversation_id: "ca", count: 1, total_conversations: 1500 }]);
      pendente(LINHA_B).responder([{ conversation_id: "cb", count: 1, total_conversations: 1 }]);
    });
    await resultado;

    const truncadas = aviso.mock.calls.filter(([mensagem]) => String(mensagem).includes("truncada"));
    expect(truncadas).toHaveLength(1);
    expect(String(truncadas[0][0])).toContain(LINHA_A);
  });

  it("o escopo mudou durante o voo: a resposta velha não chega ao estado e a busca se refaz", async () => {
    montar();
    await assentar();
    await act(async () => pendente(null).responder([]));

    act(() => ctx.setUnreadScope([LINHA_A]));
    let resultado: Promise<Map<string, number> | undefined> | undefined;
    act(() => {
      resultado = ctx.refreshUnreadCounts();
    });
    await assentar();

    // Troca de números com a busca de A em voo.
    act(() => ctx.setUnreadScope([LINHA_B]));
    let junto: Promise<unknown> | undefined;
    act(() => {
      junto = ctx.refreshUnreadCounts();
    });
    expect(junto).toBe(resultado);

    await act(async () => pendente(LINHA_A).responder([{ conversation_id: "ca", count: 9 }]));
    // A resposta de A nunca aparece.
    expect(ctx.unreadCounts.has("ca")).toBe(false);

    await assentar();
    await act(async () => pendente(LINHA_B).responder([{ conversation_id: "cb", count: 1 }]));

    await expect(resultado).resolves.toEqual(new Map([["cb", 1]]));
    expect(ctx.unreadCounts).toEqual(new Map([["cb", 1]]));
  });

  it("repetir o mesmo escopo não invalida a busca em voo", async () => {
    montar();
    await assentar();
    await act(async () => pendente(null).responder([]));

    act(() => ctx.setUnreadScope([LINHA_B, LINHA_A]));
    let resultado: Promise<unknown> | undefined;
    act(() => {
      resultado = ctx.refreshUnreadCounts();
    });
    await assentar();
    const chamadasAntes = h.chamadas.length;

    // Mesmo conjunto, outra ordem.
    act(() => ctx.setUnreadScope([LINHA_A, LINHA_B]));
    await act(async () => {
      pendente(LINHA_A).responder([]);
      pendente(LINHA_B).responder([]);
    });
    await resultado;

    expect(h.chamadas.length).toBe(chamadasAntes);
  });
});

describe("NotificationProvider — marcar tudo como lido", () => {
  async function montarComEscopo() {
    montar();
    await assentar();
    await act(async () => pendente(null).responder([]));
    act(() =>
      ctx.setConversations([
        conversa("ca1", LINHA_A),
        conversa("ca2", LINHA_A),
        conversa("cb1", LINHA_B),
        conversa("cc1", LINHA_C),
      ]),
    );
    act(() => ctx.setUnreadScope([LINHA_A, LINHA_B]));
    let busca: Promise<unknown> | undefined;
    act(() => {
      busca = ctx.refreshUnreadCounts();
    });
    await assentar();
    await act(async () => {
      pendente(LINHA_A).responder([
        { conversation_id: "ca1", count: 2 },
        { conversation_id: "ca2", count: 1 },
      ]);
      pendente(LINHA_B).responder([{ conversation_id: "cb1", count: 3 }]);
    });
    await busca;
  }

  it("marca só as conversas dos números do escopo, e deixa as de fora no mapa", async () => {
    await montarComEscopo();
    // O realtime incrementa conversas de qualquer número, também as de fora do escopo
    // e as que a lista nem tem.
    act(() => ctx.incrementUnread("cc1"));
    act(() => ctx.incrementUnread("fantasma"));
    act(() => ctx.setUnreadScope([LINHA_A]));

    let contagem = -1;
    await act(async () => {
      contagem = await ctx.markAllAsRead();
    });

    // Só A: ca1 e ca2. B ficou fora do escopo novo; cc1 e a fantasma nunca foram dele.
    expect(contagem).toBe(2);
    expect(h.marcadas.flat().sort()).toEqual(["ca1", "ca2"]);
    expect(ctx.unreadCounts.has("ca1")).toBe(false);
    expect(ctx.unreadCounts.has("ca2")).toBe(false);
    expect(ctx.unreadCounts.get("cb1")).toBe(3);
    expect(ctx.unreadCounts.get("cc1")).toBe(1);
    expect(ctx.unreadCounts.get("fantasma")).toBe(1);
  });

  it("com vários números no escopo marca os de todos eles", async () => {
    await montarComEscopo();
    act(() => ctx.incrementUnread("cc1"));

    let contagem = -1;
    await act(async () => {
      contagem = await ctx.markAllAsRead();
    });

    expect(contagem).toBe(3);
    expect(h.marcadas.flat().sort()).toEqual(["ca1", "ca2", "cb1"]);
    expect(Array.from(ctx.unreadCounts.keys())).toEqual(["cc1"]);
  });

  it("nada a marcar no escopo devolve 0 e não chama o servidor", async () => {
    await montarComEscopo();
    act(() => ctx.setUnreadScope([LINHA_C]));

    let contagem = -1;
    await act(async () => {
      contagem = await ctx.markAllAsRead();
    });

    expect(contagem).toBe(0);
    expect(h.marcadas).toEqual([]);
    expect(ctx.unreadCounts.size).toBe(3);
  });

  it("sem número escolhido a lista não filtra: valem as conversas em memória, de qualquer número", async () => {
    montar();
    await assentar();
    await act(async () =>
      pendente(null).responder([
        { conversation_id: "c1", count: 1 },
        { conversation_id: "c2", count: 2 },
        { conversation_id: "fora-da-memoria", count: 3 },
      ]),
    );
    act(() => ctx.setConversations([conversa("c1", LINHA_A), conversa("c2", LINHA_B)]));

    let contagem = -1;
    await act(async () => {
      contagem = await ctx.markAllAsRead();
    });

    expect(contagem).toBe(2);
    expect(h.marcadas.flat().sort()).toEqual(["c1", "c2"]);
    // A que a lista nem tem não é da tela: fica.
    expect(Array.from(ctx.unreadCounts.keys())).toEqual(["fora-da-memoria"]);
  });

  it("conversa do escopo que a lista ainda não tem (carregando) não entra na conta", async () => {
    await montarComEscopo();
    // O realtime a contou, mas o fetch do número ainda não a trouxe.
    act(() => ctx.incrementUnread("ainda-nao-carregou"));

    let contagem = -1;
    await act(async () => {
      contagem = await ctx.markAllAsRead();
    });

    expect(contagem).toBe(3);
    expect(h.marcadas.flat()).not.toContain("ainda-nao-carregou");
    expect(ctx.unreadCounts.get("ainda-nao-carregou")).toBe(1);
  });
});

describe("NotificationProvider — conversas fora do escopo", () => {
  const linhaDoServidor = (id: string, numeroId: string) => ({
    id,
    contact_name: id,
    contact_phone: "5511999990001",
    last_message_at: "2026-10-21T12:00:00.000Z",
    status: "active",
    phone_number_id: numeroId,
    sector_id: null,
    assigned_to: null,
    is_group: false,
    contact_avatar_url: null,
    profiles: null,
    conversation_assignees: [],
  });
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const mensagem = (conversationId: string) => ({
    conversation_id: conversationId,
    content: "oi",
    message_type: "text",
    direction: "inbound" as const,
    created_at: "2026-10-21T12:01:00.000Z",
  });

  it("mensagem de conversa nova só entra na lista se o número dela é do escopo", async () => {
    montar();
    await assentar();
    await act(async () => pendente(null).responder([]));
    h.conversaPorId = {
      [uuid(1)]: linhaDoServidor(uuid(1), LINHA_B),
      [uuid(2)]: linhaDoServidor(uuid(2), LINHA_A),
    };

    act(() => ctx.setUnreadScope([LINHA_A]));
    await act(async () => {
      await ctx.handleNewMessage(mensagem(uuid(1)));
    });
    expect(ctx.conversations).toEqual([]);

    await act(async () => {
      await ctx.handleNewMessage(mensagem(uuid(2)));
    });
    expect(ctx.conversations.map((c) => c.id)).toEqual([uuid(2)]);

    // Agora B entra no escopo: a mesma mensagem passa a valer.
    act(() => ctx.setUnreadScope([LINHA_A, LINHA_B]));
    await act(async () => {
      await ctx.handleNewMessage(mensagem(uuid(1)));
    });
    expect(ctx.conversations.map((c) => c.id).sort()).toEqual([uuid(1), uuid(2)].sort());
  });

  it("sem escopo nenhuma conversa nova entra", async () => {
    montar();
    await assentar();
    await act(async () => pendente(null).responder([]));
    h.conversaPorId = { [uuid(1)]: linhaDoServidor(uuid(1), LINHA_A) };

    await act(async () => {
      await ctx.handleNewMessage(mensagem(uuid(1)));
    });
    expect(ctx.conversations).toEqual([]);
  });

  it("o refresh de uma conversa a coloca (ou tira) conforme o número dela esteja no escopo", async () => {
    montar();
    await assentar();
    await act(async () => pendente(null).responder([]));
    h.conversaPorId = { [uuid(1)]: linhaDoServidor(uuid(1), LINHA_B) };

    act(() => ctx.setUnreadScope([LINHA_A, LINHA_B]));
    await act(async () => {
      await ctx.refreshConversationById(uuid(1));
    });
    expect(ctx.conversations.map((c) => c.id)).toEqual([uuid(1)]);

    // O escopo encolhe: a conversa do B some no próximo refresh dela.
    act(() => ctx.setUnreadScope([LINHA_A]));
    await act(async () => {
      await ctx.refreshConversationById(uuid(1));
    });
    expect(ctx.conversations).toEqual([]);
  });
});
