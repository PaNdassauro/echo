import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRealtimeFallbackPoll } from "./useRealtimeFallbackPoll";
import { reportChannelHealth } from "@/lib/realtimeHealth";

// O projeto não roda vitest com `globals`.
afterEach(cleanup);

const CANAL = "teste-fallback-poll";

describe("useRealtimeFallbackPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // realtimeHealth é store de módulo: não deixar degradação para o próximo teste.
    reportChannelHealth(CANAL, true);
    vi.useRealTimers();
  });

  it("com o realtime saudável, busca no intervalo lento", async () => {
    const poll = vi.fn();
    renderHook(() => useRealtimeFallbackPoll(poll, { degradedMs: 1000, healthyMs: 10_000 }));

    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(poll).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("com canal caído, acelera; quando volta, desacelera", async () => {
    const poll = vi.fn();
    renderHook(() => useRealtimeFallbackPoll(poll, { degradedMs: 1000, healthyMs: 10_000 }));

    act(() => reportChannelHealth(CANAL, false));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(poll).toHaveBeenCalledTimes(3);

    act(() => reportChannelHealth(CANAL, true));
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(poll).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it("healthyMs 0 só busca enquanto o realtime está caído", async () => {
    const poll = vi.fn();
    renderHook(() => useRealtimeFallbackPoll(poll, { degradedMs: 1000, healthyMs: 0 }));

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(poll).not.toHaveBeenCalled();

    act(() => reportChannelHealth(CANAL, false));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("não empilha: a próxima busca só é agendada quando a anterior termina", async () => {
    let resolve: () => void = () => {};
    const poll = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    renderHook(() => useRealtimeFallbackPoll(poll, { degradedMs: 1000, healthyMs: 1000 }));

    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(poll).toHaveBeenCalledTimes(1);
    // Busca lenta: 10 s depois ainda é a mesma.
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => { resolve(); });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("erro na busca não para o ciclo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const poll = vi.fn().mockRejectedValueOnce(new Error("rede")).mockResolvedValue(undefined);
    renderHook(() => useRealtimeFallbackPoll(poll, { degradedMs: 1000, healthyMs: 1000 }));

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("enabled=false e unmount param a busca, e usa sempre o callback mais novo", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ cb, enabled }) => useRealtimeFallbackPoll(cb, { degradedMs: 1000, healthyMs: 1000, enabled }),
      { initialProps: { cb: first, enabled: false } },
    );

    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(first).not.toHaveBeenCalled();

    rerender({ cb: first, enabled: true });
    rerender({ cb: second, enabled: true });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(second).toHaveBeenCalledTimes(1);
  });
});
