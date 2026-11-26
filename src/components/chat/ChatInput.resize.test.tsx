import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import ChatInput from "./ChatInput";

vi.mock("@/hooks/useQuickReplies", () => ({ useQuickReplies: () => ({ quickReplies: [] }) }));

// jsdom não tem layout nem ResizeObserver: o teste controla largura e
// scrollHeight do campo e dispara o observer à mão.
let observerCallback: (() => void) | null = null;
class FakeResizeObserver {
  constructor(cb: () => void) {
    observerCallback = cb;
  }
  observe() {}
  disconnect() {
    observerCallback = null;
  }
}

let width = 576;
let scrollHeight = 44;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Object.defineProperty(HTMLTextAreaElement.prototype, "offsetWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  observerCallback = null;
  width = 576;
  scrollHeight = 44;
});

describe("ChatInput: altura do campo", () => {
  it("medido estreito (placeholder quebrando), volta ao normal quando a largura volta", () => {
    width = 32;
    scrollHeight = 380;
    render(<ChatInput onSubmit={() => {}} placeholder="Digite sua mensagem..." />);
    const textarea = screen.getByPlaceholderText("Digite sua mensagem...") as HTMLTextAreaElement;
    expect(textarea.style.height).toBe("200px");

    width = 576;
    scrollHeight = 44;
    act(() => observerCallback?.());
    expect(textarea.style.height).toBe("44px");
  });

  it("não remede quando só a altura muda (sem laço com a própria medida)", () => {
    render(<ChatInput onSubmit={() => {}} placeholder="Digite sua mensagem..." />);
    const textarea = screen.getByPlaceholderText("Digite sua mensagem...") as HTMLTextAreaElement;
    expect(textarea.style.height).toBe("44px");

    scrollHeight = 120; // a largura não mudou: o observer ignora
    act(() => observerCallback?.());
    expect(textarea.style.height).toBe("44px");
  });
});
