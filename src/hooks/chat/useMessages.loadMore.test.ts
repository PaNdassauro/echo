import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

type Row = { id: string; created_at: string; conversation_id: string; content: string; direction: string; message_type: string };
type Result = { data: Row[]; error: { message: string } | null };

const mocks = vi.hoisted(() => ({
  initial: [] as Row[],
  olderCalls: 0,
  olderResolvers: [] as Array<(r: Result) => void>,
}));

// Query encadeável e "thenable": a consulta do loadMore é a única com `.lte`.
function makeQuery() {
  let isOlder = false;
  const q: Record<string, unknown> = {};
  const chain = () => q;
  for (const m of ["select", "eq", "or", "order", "limit", "in", "neq", "gt", "gte", "lt", "is", "not", "update", "insert", "upsert", "delete", "match"]) {
    q[m] = chain;
  }
  q.lte = () => {
    isOlder = true;
    return q;
  };
  q.then = (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => {
    const p = isOlder
      ? new Promise<Result>((res) => {
          mocks.olderCalls += 1;
          mocks.olderResolvers.push(res);
        })
      : Promise.resolve<Result>({ data: [...mocks.initial].reverse(), error: null });
    return p.then(resolve, reject);
  };
  return q;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => makeQuery(),
    channel: () => ({ on: () => ({}), subscribe: () => ({}) }),
    removeChannel: () => Promise.resolve("ok"),
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
  },
}));
vi.mock("@/lib/realtimeReconnect", () => ({ subscribeWithBackoff: () => () => undefined }));
vi.mock("@/hooks/useRealtimeFallbackPoll", () => ({ useRealtimeFallbackPoll: () => undefined }));

import { useMessages } from "./useMessages";

const row = (n: number): Row => ({
  id: `m${String(n).padStart(4, "0")}`,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  conversation_id: "c1",
  content: `msg ${n}`,
  direction: "inbound",
  message_type: "text",
});
const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => row(from + i));

async function setup() {
  mocks.initial = rows(1000, 200);
  const hook = renderHook(() => useMessages({ conversationId: "c1", userId: "u1" }));
  await act(async () => {
    await hook.result.current.fetchMessages();
  });
  await waitFor(() => expect(hook.result.current.messages).toHaveLength(200));
  return hook;
}

beforeEach(() => {
  mocks.olderCalls = 0;
  mocks.olderResolvers = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useMessages.loadMore", () => {
  it("duas chamadas no mesmo quadro (closure velho) disparam uma só consulta e não duplicam a página", async () => {
    const { result } = await setup();
    const loadMore = result.current.loadMore; // closure congelado, como no listener do Virtuoso
    await act(async () => {
      void loadMore();
      void loadMore();
    });
    expect(mocks.olderCalls).toBe(1);
    await act(async () => {
      mocks.olderResolvers[0]({ data: rows(1, 50).reverse(), error: null });
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(250));
    expect(new Set(result.current.messages.map((m) => m.id)).size).toBe(250);
  });

  it("depois de um erro, novas chamadas esperam o backoff em vez de refazer a consulta a cada faixa", async () => {
    const { result } = await setup();
    const loadMore = result.current.loadMore;
    await act(async () => {
      void loadMore();
    });
    await act(async () => {
      mocks.olderResolvers[0]({ data: [], error: { message: "rede" } });
    });
    await waitFor(() => expect(result.current.isLoadingMore).toBe(false));
    await act(async () => {
      await result.current.loadMore();
      await result.current.loadMore();
    });
    expect(mocks.olderCalls).toBe(1);
  });
});
