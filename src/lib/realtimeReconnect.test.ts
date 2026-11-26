import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeChannel } from "@supabase/supabase-js";

// O client real exige VITE_SUPABASE_URL no import — irrelevante aqui, o
// removeChannel é injetado no teste.
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { JOIN_WATCHDOG_MS, subscribeWithBackoff } from "./realtimeReconnect";
import { isRealtimeDegraded } from "./realtimeHealth";

type StatusCallback = (status: string) => void;

interface FakeChannel {
  subscribe: (cb: StatusCallback) => FakeChannel;
}

function makeHarness() {
  const callbacks: StatusCallback[] = [];
  const removed: FakeChannel[] = [];
  let created = 0;

  const createChannel = () => {
    created += 1;
    const channel: FakeChannel = {
      subscribe: (cb: StatusCallback) => {
        callbacks.push(cb);
        return channel;
      },
    };
    return channel as unknown as RealtimeChannel;
  };

  return {
    createChannel,
    removed,
    createdCount: () => created,
    // Callback de status do canal mais recente.
    lastStatus: (status: string) => callbacks[callbacks.length - 1](status),
    // Callback de status do n-ésimo canal criado (para status atrasado de canal velho).
    statusAt: (index: number) => callbacks[index],
    removeChannel: (channel: RealtimeChannel) => {
      removed.push(channel as unknown as FakeChannel);
    },
  };
}

describe("subscribeWithBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("assina imediatamente e reporta recovered=false no primeiro SUBSCRIBED", () => {
    const harness = makeHarness();
    const onSubscribed = vi.fn();

    const cleanup = subscribeWithBackoff({
      healthKey: "test-first",
      createChannel: harness.createChannel,
      onSubscribed,
      removeChannel: harness.removeChannel,
    });

    expect(harness.createdCount()).toBe(1);
    harness.lastStatus("SUBSCRIBED");
    expect(onSubscribed).toHaveBeenCalledWith(false);
    cleanup();
  });

  it("faz backoff exponencial 1s, 2s, 4s com teto e remove o canal morto antes de cada retry", () => {
    const harness = makeHarness();

    const cleanup = subscribeWithBackoff({
      healthKey: "test-backoff",
      createChannel: harness.createChannel,
      maxDelayMs: 4000,
      removeChannel: harness.removeChannel,
    });

    harness.lastStatus("CHANNEL_ERROR");
    expect(harness.removed).toHaveLength(1);
    expect(harness.createdCount()).toBe(1);
    vi.advanceTimersByTime(999);
    expect(harness.createdCount()).toBe(1);
    vi.advanceTimersByTime(1); // 1s
    expect(harness.createdCount()).toBe(2);

    harness.lastStatus("TIMED_OUT");
    vi.advanceTimersByTime(2000); // 2s
    expect(harness.createdCount()).toBe(3);

    harness.lastStatus("CHANNEL_ERROR");
    vi.advanceTimersByTime(4000); // 4s
    expect(harness.createdCount()).toBe(4);

    // Teto: continuaria em 4s, não 8s.
    harness.lastStatus("CHANNEL_ERROR");
    vi.advanceTimersByTime(4000);
    expect(harness.createdCount()).toBe(5);

    cleanup();
  });

  it("reporta recovered=true após falha, e volta a false no ciclo seguinte", () => {
    const harness = makeHarness();
    const onSubscribed = vi.fn();

    const cleanup = subscribeWithBackoff({
      healthKey: "test-recovered",
      createChannel: harness.createChannel,
      onSubscribed,
      removeChannel: harness.removeChannel,
    });

    harness.lastStatus("CHANNEL_ERROR");
    expect(isRealtimeDegraded()).toBe(true);
    vi.advanceTimersByTime(1000);
    harness.lastStatus("SUBSCRIBED");
    expect(onSubscribed).toHaveBeenLastCalledWith(true);
    expect(isRealtimeDegraded()).toBe(false);

    // Novo SUBSCRIBED sem falha no meio (rejoin silencioso do socket) também é
    // um intervalo sem entrega: recovered=true para ressincronizar.
    harness.lastStatus("SUBSCRIBED");
    expect(onSubscribed).toHaveBeenLastCalledWith(true);

    cleanup();
  });

  it("CLOSED que não pedimos (fechado pelo servidor) vira queda: reporta e reassina", () => {
    const harness = makeHarness();
    const onDown = vi.fn();

    const cleanup = subscribeWithBackoff({
      healthKey: "test-closed",
      createChannel: harness.createChannel,
      onDown,
      removeChannel: harness.removeChannel,
    });

    harness.lastStatus("SUBSCRIBED");
    harness.lastStatus("CLOSED");
    expect(onDown).toHaveBeenCalledTimes(1);
    expect(isRealtimeDegraded()).toBe(true);
    expect(harness.removed).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(harness.createdCount()).toBe(2);
    harness.lastStatus("SUBSCRIBED");
    expect(isRealtimeDegraded()).toBe(false);

    cleanup();
  });

  it("status do canal que já foi descartado é ignorado (o CLOSED do nosso próprio removeChannel)", () => {
    const harness = makeHarness();
    const onDown = vi.fn();

    const cleanup = subscribeWithBackoff({
      healthKey: "test-stale",
      createChannel: harness.createChannel,
      onDown,
      removeChannel: harness.removeChannel,
    });

    const primeiro = harness.statusAt(0);
    primeiro("CHANNEL_ERROR");
    expect(onDown).toHaveBeenCalledTimes(1);
    // O removeChannel do canal morto dispara CLOSED nele: não é queda nova.
    primeiro("CLOSED");
    expect(onDown).toHaveBeenCalledTimes(1);
    expect(harness.removed).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(harness.createdCount()).toBe(2);
    // Status atrasado do canal antigo depois que o novo já assinou.
    harness.lastStatus("SUBSCRIBED");
    primeiro("CHANNEL_ERROR");
    expect(isRealtimeDegraded()).toBe(false);
    expect(harness.createdCount()).toBe(2);

    cleanup();
  });

  it("canal mudo (subscribe sem status nenhum) cai pelo cão de guarda e reassina", () => {
    const harness = makeHarness();

    const cleanup = subscribeWithBackoff({
      healthKey: "test-watchdog",
      createChannel: harness.createChannel,
      removeChannel: harness.removeChannel,
    });

    vi.advanceTimersByTime(JOIN_WATCHDOG_MS - 1);
    expect(isRealtimeDegraded()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isRealtimeDegraded()).toBe(true);
    expect(harness.removed).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(harness.createdCount()).toBe(2);
    harness.lastStatus("SUBSCRIBED");
    expect(isRealtimeDegraded()).toBe(false);

    // Assinou: o cão de guarda não dispara mais.
    vi.advanceTimersByTime(JOIN_WATCHDOG_MS * 2);
    expect(isRealtimeDegraded()).toBe(false);
    expect(harness.createdCount()).toBe(2);

    cleanup();
  });

  it("cleanup cancela retry pendente, remove o canal e reporta saudável", () => {
    const harness = makeHarness();

    const cleanup = subscribeWithBackoff({
      healthKey: "test-cleanup",
      createChannel: harness.createChannel,
      removeChannel: harness.removeChannel,
    });

    harness.lastStatus("CHANNEL_ERROR");
    expect(isRealtimeDegraded()).toBe(true);

    cleanup();
    expect(isRealtimeDegraded()).toBe(false);

    // Retry agendado não dispara depois do cleanup.
    vi.advanceTimersByTime(60_000);
    expect(harness.createdCount()).toBe(1);
  });

  it("ignora status que chega depois do cleanup", () => {
    const harness = makeHarness();
    const onSubscribed = vi.fn();

    const cleanup = subscribeWithBackoff({
      healthKey: "test-late-status",
      createChannel: harness.createChannel,
      onSubscribed,
      removeChannel: harness.removeChannel,
    });

    cleanup();
    harness.lastStatus("SUBSCRIBED");
    expect(onSubscribed).not.toHaveBeenCalled();
    harness.lastStatus("CHANNEL_ERROR");
    vi.advanceTimersByTime(60_000);
    expect(harness.createdCount()).toBe(1);
    expect(isRealtimeDegraded()).toBe(false);
  });
});
