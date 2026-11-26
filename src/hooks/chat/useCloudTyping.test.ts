import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCloudTyping } from "./useCloudTyping";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: invokeMock,
    },
  },
}));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ data: { success: true }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useCloudTyping", () => {
  it("dispara a edge function whatsapp-typing-start com conversationId e phoneNumberId", async () => {
    const { result } = renderHook(() => useCloudTyping());

    await act(async () => {
      await result.current.notifyCloudTyping("conv-123", "phone-456");
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("whatsapp-typing-start", {
      body: {
        conversationId: "conv-123",
        phoneNumberId: "phone-456",
      },
    });
  });

  it("ignora chamadas com conversationId nulo ou indefinido", async () => {
    const { result } = renderHook(() => useCloudTyping());

    await act(async () => {
      await result.current.notifyCloudTyping(null, "phone-456");
      await result.current.notifyCloudTyping(undefined, "phone-456");
      await result.current.notifyCloudTyping("", "phone-456");
    });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("aplica throttle na mesma conversa dentro da janela configurada", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCloudTyping({ throttleMs: 20_000 }));

    await act(async () => {
      await result.current.notifyCloudTyping("conv-123", "phone-456");
      await result.current.notifyCloudTyping("conv-123", "phone-456");
      await result.current.notifyCloudTyping("conv-123", "phone-456");
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Avança 10s (ainda dentro dos 20s)
    vi.advanceTimersByTime(10_000);

    await act(async () => {
      await result.current.notifyCloudTyping("conv-123", "phone-456");
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Avança mais 11s (passou de 20s)
    vi.advanceTimersByTime(11_000);

    await act(async () => {
      await result.current.notifyCloudTyping("conv-123", "phone-456");
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("não bloqueia conversas diferentes pelo throttle de outra", async () => {
    const { result } = renderHook(() => useCloudTyping());

    await act(async () => {
      await result.current.notifyCloudTyping("conv-1", "phone-456");
      await result.current.notifyCloudTyping("conv-2", "phone-456");
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "whatsapp-typing-start", {
      body: { conversationId: "conv-1", phoneNumberId: "phone-456" },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "whatsapp-typing-start", {
      body: { conversationId: "conv-2", phoneNumberId: "phone-456" },
    });
  });

  it("resetCloudTyping permite disparar imediatamente para a conversa resetada", async () => {
    const { result } = renderHook(() => useCloudTyping());

    await act(async () => {
      await result.current.notifyCloudTyping("conv-1", "phone-456");
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.resetCloudTyping("conv-1");
    });

    await act(async () => {
      await result.current.notifyCloudTyping("conv-1", "phone-456");
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("falha na edge function não lança exceção para o chamador", async () => {
    invokeMock.mockRejectedValueOnce(new Error("Network error"));
    const { result } = renderHook(() => useCloudTyping());

    await expect(
      act(async () => {
        await result.current.notifyCloudTyping("conv-1", "phone-456");
      })
    ).resolves.not.toThrow();

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
