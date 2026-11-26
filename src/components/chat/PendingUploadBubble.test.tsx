import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useMemo, useSyncExternalStore } from "react";
import { createUploadQueue, type TransportArgs } from "@/lib/mediaUploadQueue";

const calls: TransportArgs[] = [];
const queue = createUploadQueue(
  (args) =>
    new Promise<void>((_, reject) => {
      calls.push(args);
      args.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }),
  { revokeUrl: () => {} },
);

vi.mock("@/lib/mediaUploadTransport", () => ({
  mediaUploadQueue: queue,
  useConversationUploads: (id: string) => {
    const all = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
    return useMemo(() => all.filter((i) => i.conversationId === id), [all, id]);
  },
}));

const { PendingUploads } = await import("./PendingUploadBubble");

afterEach(() => {
  cleanup();
  queue.getSnapshot().forEach((i) => queue.cancel(i.id));
  calls.length = 0;
});

Element.prototype.scrollIntoView = vi.fn();
window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;

const file = (name: string) => new File(["x".repeat(2048)], name, { type: "application/pdf" });

describe("PendingUploads", () => {
  it("mostra só os envios da conversa e o X cancela", () => {
    act(() => {
      queue.enqueue([
        { conversationId: "c1", file: file("contrato.pdf"), previewUrl: "", caption: "segue", fields: {} },
        { conversationId: "c2", file: file("outro.pdf"), previewUrl: "", caption: "", fields: {} },
      ]);
    });
    render(<PendingUploads conversationId="c1" />);

    expect(screen.getByText("contrato.pdf")).toBeTruthy();
    expect(screen.getByText("segue")).toBeTruthy();
    expect(screen.queryByText("outro.pdf")).toBeNull();

    act(() => calls[0].onProgress(1024, 2048));
    expect(screen.getByText(/50%/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar envio de contrato.pdf" }));
    expect(screen.queryByText("contrato.pdf")).toBeNull();
    expect(calls[0].signal.aborted).toBe(true);
  });

  it("a prévia nasce com a caixa final: medida quando há tamanho, fallback quando não", () => {
    // jsdom não tem layout: o contrato é o data-media-box, o mesmo que o
    // MessageBubble desenha para a mensagem real.
    const image = new File(["x"], "clipboard.png", { type: "image/png" });
    act(() => {
      queue.enqueue([
        { conversationId: "c1", file: image, previewUrl: "blob:medida", caption: "", fields: {}, mediaSize: { width: 1200, height: 800 } },
        { conversationId: "c1", file: image, previewUrl: "blob:sem", caption: "", fields: {} },
      ]);
    });
    const { container } = render(<PendingUploads conversationId="c1" />);
    expect(container.querySelector('[data-media-box="300x200"]')).not.toBeNull();
    expect(container.querySelector('[data-media-box="240x240"]')).not.toBeNull();
    expect(container.querySelector("img.h-64")).toBeNull();
  });

  it("com onGrow pede o fim uma vez e não usa scrollIntoView; progresso não repete", () => {
    const spy = vi.mocked(Element.prototype.scrollIntoView);
    spy.mockClear();
    const onGrow = vi.fn();
    render(<PendingUploads conversationId="c1" onGrow={onGrow} />);
    act(() => {
      queue.enqueue([{ conversationId: "c1", file: file("a.pdf"), previewUrl: "", caption: "", fields: {} }]);
    });
    expect(onGrow).toHaveBeenCalledTimes(1);
    act(() => calls[0].onProgress(1024, 2048));
    expect(onGrow).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("sem onGrow cai no scrollIntoView", () => {
    const spy = vi.mocked(Element.prototype.scrollIntoView);
    spy.mockClear();
    render(<PendingUploads conversationId="c1" />);
    act(() => {
      queue.enqueue([{ conversationId: "c1", file: file("a.pdf"), previewUrl: "", caption: "", fields: {} }]);
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("depois do último byte o botão fica desabilitado", () => {
    act(() => {
      queue.enqueue([{ conversationId: "c1", file: file("a.pdf"), previewUrl: "", caption: "", fields: {} }]);
    });
    render(<PendingUploads conversationId="c1" />);
    act(() => calls[0].onUploaded());

    const button = screen.getByRole("button", { name: "Enviando a.pdf" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Enviando…")).toBeTruthy();
  });
});
