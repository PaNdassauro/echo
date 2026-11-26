import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResizableListColumn } from "./ResizableListColumn";
import { LIST_WIDTH_DEFAULT, LIST_WIDTH_MAX } from "@/lib/conversationListWidth";
import { A11Y_CHANGE_EVENT } from "@/lib/accessibilityPrefs";

const STORAGE_KEY = "echo_conversation_list_width";

// jsdom não implementa PointerEvent: sem isto o fireEvent cria um Event cru,
// sem button/clientX, e o handler ignora o arraste.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.body.removeAttribute("style");
  document.documentElement.style.removeProperty("font-size");
});

const renderColumn = () => {
  render(
    <ResizableListColumn>
      <div data-testid="lista" />
    </ResizableListColumn>,
  );
  const handle = screen.getByRole("separator", { name: "Redimensionar lista de conversas" });
  const column = screen.getByTestId("lista").parentElement as HTMLElement;
  return { handle, column };
};

describe("ResizableListColumn", () => {
  it("abre na largura salva", () => {
    localStorage.setItem(STORAGE_KEY, "480");
    const { column, handle } = renderColumn();
    expect(column.style.width).toBe("480px");
    expect(handle.getAttribute("aria-valuenow")).toBe("480");
  });

  it("arrastar muda a largura, prende no máximo e só persiste ao soltar", () => {
    const { handle, column } = renderColumn();
    // jsdom não tem layout: a largura renderizada vem do style.
    column.getBoundingClientRect = () => ({ width: LIST_WIDTH_DEFAULT }) as DOMRect;
    handle.setPointerCapture = () => {};

    fireEvent.pointerDown(handle, { button: 0, clientX: 384, pointerId: 1 });
    expect(document.body.style.cursor).toBe("col-resize");
    fireEvent.pointerMove(handle, { clientX: 434, pointerId: 1 });
    expect(column.style.width).toBe("434px");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    fireEvent.pointerMove(handle, { clientX: 2000, pointerId: 1 });
    expect(column.style.width).toBe(`${LIST_WIDTH_MAX}px`);

    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(String(LIST_WIDTH_MAX));
    expect(document.body.style.cursor).toBe("");
  });

  it("teclado e duplo clique", () => {
    const { handle, column } = renderColumn();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(column.style.width).toBe("400px");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("400");
    fireEvent.doubleClick(handle);
    expect(column.style.width).toBe(`${LIST_WIDTH_DEFAULT}px`);
  });

  it("o mínimo cresce com o texto do app (aria, estilo e teclado)", () => {
    localStorage.setItem(STORAGE_KEY, "250");
    const { handle, column } = renderColumn();
    expect(handle.getAttribute("aria-valuemin")).toBe("240");
    expect(column.style.width).toBe("250px");

    act(() => {
      document.documentElement.style.fontSize = "20px";
      window.dispatchEvent(new Event(A11Y_CHANGE_EVENT));
    });
    expect(handle.getAttribute("aria-valuemin")).toBe("300");
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    expect(column.style.minWidth).toBe("300px");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(column.style.width).toBe("300px");
  });
});
