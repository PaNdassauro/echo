import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMinuteVersion, subscribeMinute } from "./minuteTicker";

describe("minuteTicker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("não tica sem subscriber e tica a cada minuto com um", () => {
    const before = getMinuteVersion();
    vi.advanceTimersByTime(120_000);
    expect(getMinuteVersion()).toBe(before);

    const listener = vi.fn();
    const unsubscribe = subscribeMinute(listener);
    vi.advanceTimersByTime(59_999);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getMinuteVersion()).toBe(before + 1);
    unsubscribe();
  });

  it("um único intervalo serve vários subscribers e para no último unsubscribe", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeMinute(a);
    const offB = subscribeMinute(b);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(60_000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    expect(vi.getTimerCount()).toBe(1);
    offB();
    expect(vi.getTimerCount()).toBe(0);

    const after = getMinuteVersion();
    vi.advanceTimersByTime(60_000);
    expect(getMinuteVersion()).toBe(after);
  });
});
