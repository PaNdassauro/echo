import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ReconnectingBanner, RECONNECT_GRACE_MS } from "./ReconnectingBanner";
import { reportChannelHealth } from "@/lib/realtimeHealth";

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no
// seguinte.
afterEach(cleanup);

const CANAL = "teste-banner";

describe("ReconnectingBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // O realtimeHealth é um store de módulo: devolver o canal saudável para o
    // próximo teste não herdar a degradação.
    reportChannelHealth(CANAL, true);
    vi.useRealTimers();
  });

  const faixa = () => screen.getByRole("status", { hidden: true });
  const visivel = () => faixa().getAttribute("aria-hidden") === "false";

  it("não aparece num blip que reassina antes da carência", () => {
    render(<ReconnectingBanner />);
    expect(visivel()).toBe(false);

    act(() => reportChannelHealth(CANAL, false));
    act(() => vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1));
    expect(visivel()).toBe(false);

    act(() => reportChannelHealth(CANAL, true));
    act(() => vi.advanceTimersByTime(60_000));
    expect(visivel()).toBe(false);
  });

  it("aparece quando a queda dura a carência inteira e some na hora ao recuperar", () => {
    render(<ReconnectingBanner />);

    act(() => reportChannelHealth(CANAL, false));
    act(() => vi.advanceTimersByTime(RECONNECT_GRACE_MS));
    expect(visivel()).toBe(true);

    act(() => reportChannelHealth(CANAL, true));
    expect(visivel()).toBe(false);
  });

  it("queda nova depois de recuperar conta a carência do zero", () => {
    render(<ReconnectingBanner />);

    act(() => reportChannelHealth(CANAL, false));
    act(() => vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1));
    act(() => reportChannelHealth(CANAL, true));
    act(() => reportChannelHealth(CANAL, false));
    act(() => vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1));
    expect(visivel()).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(visivel()).toBe(true);
  });
});
