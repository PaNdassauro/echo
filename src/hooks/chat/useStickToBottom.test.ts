import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useStickToBottom } from "./useStickToBottom";

// jsdom não tem layout: o teste controla a geometria do scroller e dispara o
// ResizeObserver e os eventos à mão.
let resize: (() => void) | null = null;
const observed: Array<{ target: Element; options?: ResizeObserverOptions }> = [];
class FakeResizeObserver {
  constructor(cb: () => void) {
    resize = cb;
  }
  observe(target: Element, options?: ResizeObserverOptions) {
    observed.push({ target, options });
  }
  disconnect() {
    resize = null;
  }
}

const CLIENT = 500;
let content = 2000;
let top = 0;
let el: HTMLDivElement;
let now = 1000;
const max = () => content - CLIENT;

function makeScroller() {
  const node = document.createElement("div");
  node.appendChild(document.createElement("div")).appendChild(document.createElement("div"));
  Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => content });
  Object.defineProperty(node, "clientHeight", { configurable: true, get: () => CLIENT });
  Object.defineProperty(node, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, max()));
    },
  });
  node.scrollTo = ((opts: ScrollToOptions) => {
    node.scrollTop = opts.top ?? 0;
    node.dispatchEvent(new Event("scroll"));
  }) as typeof node.scrollTo;
  document.body.appendChild(node);
  return node;
}

/** Scroll vindo de fora do usuário (Virtuoso, layout). */
const programmaticScroll = (to: number) => {
  el.scrollTop = to;
  el.dispatchEvent(new Event("scroll"));
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  now = 1000;
  observed.length = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  content = 2000;
  top = max();
  el = makeScroller();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  el.remove();
});

describe("useStickToBottom", () => {
  it("grudado no fim, conteúdo crescendo (imagem carregou) volta ao fim real", () => {
    renderHook(() => useStickToBottom(el));
    content = 2200;
    resize?.();
    expect(top).toBe(max());
  });

  it("grudado, algo que não é o usuário sobe a lista: volta ao fim (o salto para o meio da bolha)", () => {
    renderHook(() => useStickToBottom(el));
    programmaticScroll(max() - 200);
    expect(top).toBe(max());
  });

  it("roda para cima solta, e aí nada puxa de volta", () => {
    renderHook(() => useStickToBottom(el));
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    programmaticScroll(max() - 300);
    expect(top).toBe(max() - 300);

    content = 2400;
    resize?.();
    expect(top).toBe(1500 - 300);
  });

  it("roda para BAIXO até o fim não solta: o puxão logo em seguida volta ao fim", () => {
    renderHook(() => useStickToBottom(el));
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    programmaticScroll(max() - 200);
    expect(top).toBe(max());
  });

  it("tecla para cima solta; para baixo não", () => {
    renderHook(() => useStickToBottom(el));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
    programmaticScroll(max() - 200);
    expect(top).toBe(max());

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
    programmaticScroll(max() - 200);
    expect(top).toBe(max() - 200);
  });

  it("barra segurada: não briga durante o arraste; soltou sem subir, volta ao fim", () => {
    renderHook(() => useStickToBottom(el));
    el.dispatchEvent(new MouseEvent("pointerdown", { clientY: 480 }));
    programmaticScroll(max() - 200); // puxão com a mão na barra
    expect(top).toBe(max() - 200);
    content = 2300;
    resize?.();
    expect(top).toBe(1500 - 200);

    window.dispatchEvent(new MouseEvent("pointerup", { clientY: 490 }));
    expect(top).toBe(max());
  });

  it("barra arrastada para cima e solta: fica onde a mão deixou", () => {
    renderHook(() => useStickToBottom(el));
    el.dispatchEvent(new MouseEvent("pointerdown", { clientY: 480 }));
    programmaticScroll(800);
    window.dispatchEvent(new MouseEvent("pointerup", { clientY: 300 }));
    expect(top).toBe(800);
  });

  it("arrastou de cima até o fim e soltou: gruda (puxão depois volta ao fim)", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(200);
    el.dispatchEvent(new MouseEvent("pointerdown", { clientY: 100 }));
    programmaticScroll(max());
    programmaticScroll(max() - 200);
    window.dispatchEvent(new MouseEvent("pointerup", { clientY: 490 }));
    expect(top).toBe(max());

    programmaticScroll(max() - 200);
    expect(top).toBe(max());
  });

  it("pointerup perdido: o primeiro movimento sem botão encerra o arraste", () => {
    renderHook(() => useStickToBottom(el));
    el.dispatchEvent(new MouseEvent("pointerdown", { clientY: 480 }));
    programmaticScroll(max() - 200);
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 480, buttons: 0 }));
    expect(top).toBe(max());
  });

  it("dedo descendo (conteúdo subindo) solta; subindo não", () => {
    renderHook(() => useStickToBottom(el));
    const touch = (type: string, y: number) =>
      el.dispatchEvent(Object.assign(new Event(type), { touches: [{ clientY: y }] }));
    touch("touchstart", 300);
    touch("touchmove", 250); // dedo subindo = rolando para baixo
    programmaticScroll(max() - 200);
    expect(top).toBe(max());

    touch("touchmove", 320); // dedo descendo = rolando para cima
    programmaticScroll(max() - 200);
    expect(top).toBe(max() - 200);
  });

  it("unpin (citação, divisor, busca) deixa o scroll programático ficar onde foi", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(400);
    expect(top).toBe(400);
  });

  it("scrollToEnd mira o fim real e gruda ao chegar", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(100);
    result.current.scrollToEnd("auto");
    expect(top).toBe(max());

    programmaticScroll(max() - 150);
    expect(top).toBe(max());
  });

  it("filhos do viewport observados como border-box", () => {
    renderHook(() => useStickToBottom(el));
    const viewport = el.firstElementChild as Element;
    const child = observed.find((o) => o.target === viewport.firstElementChild);
    expect(child?.options).toEqual({ box: "border-box" });
  });

  it("ctrl+roda (pinça) não solta: subida sem gesto depois volta ao fim", () => {
    renderHook(() => useStickToBottom(el));
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true }));
    programmaticScroll(max() - 200);
    expect(top).toBe(max());
  });

  it("scrollToEnd auto a partir do meio + rodapé cresce antes de qualquer scroll → fim novo (digitando)", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(300);
    const spy = vi.spyOn(el, "scrollTo").mockImplementation(() => {
      /* o scroll nem chega a acontecer antes do rodapé crescer */
    });
    result.current.scrollToEnd("auto");
    spy.mockRestore();
    content = 2100;
    resize?.();
    expect(top).toBe(max());
  });

  it("scrollToEnd smooth + crescimento em 1500ms → scrollTo smooth de novo com o scrollHeight novo", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(1700); // perto do destino velho (dentro de uma tela)
    const calls: ScrollToOptions[] = [];
    vi.spyOn(el, "scrollTo").mockImplementation(((opts: ScrollToOptions) => {
      calls.push(opts);
    }) as typeof el.scrollTo);
    result.current.scrollToEnd("smooth");
    expect(calls).toEqual([{ top: 2000, behavior: "smooth" }]);

    now += 1000;
    content = 2300;
    resize?.();
    expect(calls[1]).toEqual({ top: 2300, behavior: "smooth" });
  });

  it("depois de 1500ms o crescimento vai direto ao fim", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(300);
    const spy = vi.spyOn(el, "scrollTo").mockImplementation((() => {}) as typeof el.scrollTo);
    result.current.scrollToEnd("smooth");
    spy.mockClear();

    now += 1600;
    content = 2300;
    resize?.();
    expect(spy).not.toHaveBeenCalled();
    expect(top).toBe(max());
  });

  it("roda para cima durante o seek solta e o crescimento não puxa", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(300);
    const spy = vi.spyOn(el, "scrollTo").mockImplementation((() => {}) as typeof el.scrollTo);
    result.current.scrollToEnd("smooth");
    spy.mockClear();

    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    programmaticScroll(250);
    content = 2300;
    resize?.();
    expect(spy).not.toHaveBeenCalled();
    expect(top).toBe(250);
  });

  it("unpin + scroll programático que chega ao fim dentro de 1500 ms não gruda e a subida seguinte não é revertida", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(max()); // posicionamento do Virtuoso caindo no fim
    now += 200;
    programmaticScroll(max() - 300); // a navegação sobe até o alvo
    expect(top).toBe(max() - 300);
  });

  it("depois de 1500 ms, chegar ao fim gruda de novo", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(400);
    now += 1600;
    programmaticScroll(max());
    programmaticScroll(max() - 200);
    expect(top).toBe(max());
  });

  it("roda para baixo até o fim gruda mesmo dentro da janela", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(400);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    programmaticScroll(max());
    programmaticScroll(max() - 200);
    expect(top).toBe(max());
  });

  it("scrollToEnd dentro da janela gruda por intenção", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(400);
    result.current.scrollToEnd("auto");
    programmaticScroll(max() - 200);
    expect(top).toBe(max());
  });

  it("scrollToEnd suave de muito longe (mais de 3 telas) vai direto e gruda", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    content = 5000; // 4500 px até o fim = 9 telas
    programmaticScroll(0);
    const calls: ScrollToOptions[] = [];
    vi.spyOn(el, "scrollTo").mockImplementation(((opts: ScrollToOptions) => {
      calls.push(opts);
      el.scrollTop = opts.top ?? 0;
      el.dispatchEvent(new Event("scroll"));
    }) as typeof el.scrollTo);
    result.current.scrollToEnd("smooth");
    expect(calls).toEqual([{ top: 5000, behavior: "auto" }]);
    expect(top).toBe(max());
    // Grudou: o crescimento seguinte (linhas medidas) vai direto ao fim novo.
    content = 5600;
    resize?.();
    expect(top).toBe(max());
  });

  it("seek longo: crescimento longe do destino não reinicia a animação suave", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(100);
    const calls: ScrollToOptions[] = [];
    vi.spyOn(el, "scrollTo").mockImplementation(((opts: ScrollToOptions) => {
      calls.push(opts);
    }) as typeof el.scrollTo);
    result.current.scrollToEnd("smooth");
    now += 400;
    content = 2300;
    resize?.();
    content = 2600;
    resize?.();
    expect(calls).toHaveLength(1);
  });

  it("seek longo: passa de 1500 ms em movimento sem estalar para o fim", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(100);
    const spy = vi.spyOn(el, "scrollTo").mockImplementation((() => {}) as typeof el.scrollTo);
    result.current.scrollToEnd("smooth");
    spy.mockClear();
    now += 1200;
    programmaticScroll(600); // animação ainda rolando
    now += 1200;
    content = 2300;
    resize?.();
    expect(top).toBe(600);
  });

  it("unpin sem movimento (já no fim): passada a janela, o crescimento é seguido", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    now += 2000;
    vi.advanceTimersByTime(2000);
    content = 2200;
    resize?.();
    expect(top).toBe(max());
    vi.useRealTimers();
  });

  it("unpin, scroll ao fim dentro da janela, janela fecha: gruda e segue o crescimento", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(400);
    programmaticScroll(max());
    now += 2000;
    vi.advanceTimersByTime(2000);
    content = 2200;
    resize?.();
    expect(top).toBe(max());
    vi.useRealTimers();
  });

  it("unpin e a lista longe do fim quando a janela fecha: continua solta", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(400);
    now += 2000;
    vi.advanceTimersByTime(2000);
    content = 2200;
    resize?.();
    expect(top).toBe(400);
    vi.useRealTimers();
  });

  it("arraste da barra que termina já no fim (distância 0) gruda", () => {
    const { result } = renderHook(() => useStickToBottom(el));
    result.current.unpin();
    programmaticScroll(400);
    el.dispatchEvent(new MouseEvent("pointerdown", { clientY: 480 }));
    programmaticScroll(max());
    window.dispatchEvent(new MouseEvent("pointerup", { clientY: 490 }));
    content = 2200;
    resize?.();
    expect(top).toBe(max());
  });
});
