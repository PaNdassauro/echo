import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachWheelLimiter } from "@/lib/wheelScroll";

const reduced = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/accessibilityPrefs", () => ({ prefersReducedMotion: () => reduced.value }));

const FRAME_MS = 16;

let now = 0;
let callbacks = new Map<number, FrameRequestCallback>();
let nextId = 1;

/** Roda um frame (16 ms) e devolve quantos px o scroller andou. */
function step(el: HTMLElement): number {
  const before = el.scrollTop;
  now += FRAME_MS;
  const pending = [...callbacks.entries()];
  callbacks = new Map();
  for (const [, cb] of pending) cb(now);
  return el.scrollTop - before;
}

function makeScroller(scrollHeight = 10000, clientHeight = 500, scrollTop = 1000): HTMLElement {
  const el = document.createElement("div");
  let top = scrollTop;
  Object.defineProperty(el, "scrollTop", { get: () => top, set: (v: number) => { top = v; }, configurable: true });
  Object.defineProperty(el, "scrollHeight", { get: () => scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { get: () => clientHeight, configurable: true });
  return el;
}

function wheel(el: HTMLElement, init: WheelEventInit): WheelEvent {
  const e = new WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });
  el.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  now = 1000;
  callbacks = new Map();
  nextId = 1;
  reduced.value = false;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("attachWheelLimiter", () => {
  it("um clique de 100 px anima até +100 em vários frames, sem passar do teto por frame", () => {
    const el = makeScroller();
    attachWheelLimiter(el, { maxPxPerSecond: 1800 });
    const e = wheel(el, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(true);
    expect(el.scrollTop).toBe(1000);
    let frames = 0;
    while (callbacks.size > 0 && frames < 200) {
      const moved = step(el);
      expect(moved).toBeLessThanOrEqual((1800 * FRAME_MS) / 1000 + 1e-6);
      frames++;
    }
    expect(frames).toBeGreaterThan(3);
    expect(Math.abs(el.scrollTop - 1100)).toBeLessThanOrEqual(0.5);
  });

  it("cinco cliques rápidos chegam a +500 na velocidade limitada, não de uma vez", () => {
    const el = makeScroller();
    attachWheelLimiter(el, { maxPxPerSecond: 1800 });
    for (let i = 0; i < 5; i++) wheel(el, { deltaY: 100 });
    const firstFrame = step(el);
    expect(firstFrame).toBeLessThanOrEqual(1800 * 0.016 + 1e-6);
    expect(el.scrollTop).toBeLessThan(1500);
    let frames = 1;
    while (callbacks.size > 0 && frames < 500) {
      step(el);
      frames++;
    }
    expect(frames).toBeGreaterThan(15);
    expect(Math.abs(el.scrollTop - 1500)).toBeLessThanOrEqual(0.5);
  });

  it("delta pequeno (8 px) passa direto: sem preventDefault e sem mexer no scrollTop", () => {
    const el = makeScroller();
    attachWheelLimiter(el);
    const e = wheel(el, { deltaY: 8, deltaMode: 0 });
    expect(e.defaultPrevented).toBe(false);
    expect(callbacks.size).toBe(0);
    expect(el.scrollTop).toBe(1000);
  });

  it("wheel com ctrlKey (pinch zoom) é ignorado", () => {
    const el = makeScroller();
    attachWheelLimiter(el);
    const e = wheel(el, { deltaY: 120, ctrlKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(callbacks.size).toBe(0);
  });

  it("wheel horizontal passa direto", () => {
    const el = makeScroller();
    attachWheelLimiter(el);
    const e = wheel(el, { deltaX: 200, deltaY: 10 });
    expect(e.defaultPrevented).toBe(false);
  });

  it("deltaMode 1 (linhas) conta como clique, mesmo com delta pequeno", () => {
    const el = makeScroller();
    attachWheelLimiter(el);
    const e = wheel(el, { deltaY: 3, deltaMode: 1 });
    expect(e.defaultPrevented).toBe(true);
    let frames = 0;
    while (callbacks.size > 0 && frames < 200) {
      step(el);
      frames++;
    }
    expect(Math.abs(el.scrollTop - 1100)).toBeLessThanOrEqual(0.5);
  });

  it("o destino é limitado ao máximo rolável", () => {
    const el = makeScroller(1000, 500, 450);
    attachWheelLimiter(el);
    wheel(el, { deltaY: 100 });
    let frames = 0;
    while (callbacks.size > 0 && frames < 200) {
      step(el);
      frames++;
    }
    expect(el.scrollTop).toBeLessThanOrEqual(500);
    expect(el.scrollTop).toBeGreaterThan(499);
  });

  it("detach para a animação e remove o listener", () => {
    const el = makeScroller();
    const detach = attachWheelLimiter(el);
    wheel(el, { deltaY: 100 });
    step(el);
    const stopped = el.scrollTop;
    detach();
    expect(callbacks.size).toBe(0);
    const e = wheel(el, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(false);
    step(el);
    expect(el.scrollTop).toBe(stopped);
  });

  it("movimento reduzido aplica o clique na hora, sem animar", () => {
    reduced.value = true;
    const el = makeScroller();
    attachWheelLimiter(el);
    const e = wheel(el, { deltaY: 400 });
    expect(e.defaultPrevented).toBe(true);
    expect(el.scrollTop).toBe(1100);
    expect(callbacks.size).toBe(0);
  });

  it("reancora o alvo quando outra coisa move o scroller (compensação da paginação)", () => {
    const el = makeScroller();
    attachWheelLimiter(el);
    wheel(el, { deltaY: -100 });
    step(el);
    step(el);
    const before = el.scrollTop;
    expect(before).toBeLessThan(1000);
    el.scrollTop = before + 3000; // Virtuoso: scrollBy ao inserir 3000 px acima
    while (callbacks.size > 0) step(el);
    // O que faltava do clique continua valendo a partir do novo lugar.
    expect(Math.abs(el.scrollTop - 3900)).toBeLessThanOrEqual(0.5);
  });

  it("não briga com o hook: puxado ao fim, o alvo vai junto e o loop para no fim", () => {
    const el = makeScroller(10000, 500, 9470);
    attachWheelLimiter(el);
    wheel(el, { deltaY: 100 }); // alvo 9500 (máximo)
    step(el);
    el.scrollTop = 9500; // useStickToBottom: toEnd()
    step(el);
    expect(el.scrollTop).toBe(9500);
    expect(callbacks.size).toBe(0);
    wheel(el, { deltaY: -100 });
    while (callbacks.size > 0) step(el);
    expect(Math.abs(el.scrollTop - 9400)).toBeLessThanOrEqual(0.5);
  });

  it("para quando o scroll não avança (limite do navegador)", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollTop", { get: () => 1000, set: () => {}, configurable: true });
    Object.defineProperty(el, "scrollHeight", { get: () => 10000, configurable: true });
    Object.defineProperty(el, "clientHeight", { get: () => 500, configurable: true });
    attachWheelLimiter(el);
    wheel(el, { deltaY: 100 });
    let frames = 0;
    while (callbacks.size > 0 && frames < 20) {
      step(el);
      frames++;
    }
    expect(callbacks.size).toBe(0);
    expect(frames).toBeLessThanOrEqual(2);
  });

  it("a cauda termina rápido: um clique acaba em menos de 30 frames", () => {
    const el = makeScroller();
    attachWheelLimiter(el);
    wheel(el, { deltaY: 100 });
    let frames = 0;
    while (callbacks.size > 0 && frames < 200) {
      step(el);
      frames++;
    }
    expect(frames).toBeLessThanOrEqual(30);
    expect(Math.abs(el.scrollTop - 1100)).toBeLessThanOrEqual(0.5);
  });

  it("anda já no primeiro frame mesmo com o relógio quase parado desde o evento", () => {
    const el = makeScroller();
    attachWheelLimiter(el);
    wheel(el, { deltaY: -100 });
    // O primeiro frame chega 0,2 ms depois do evento (o carimbo do rAF pode até
    // vir antes dele): ainda assim o scroller tem de se mexer.
    now += 0.2;
    const pending = [...callbacks.values()];
    callbacks = new Map();
    for (const cb of pending) cb(now - 5);
    expect(el.scrollTop).toBeLessThan(1000);
    expect(callbacks.size).toBe(1);
    while (callbacks.size > 0) step(el);
    expect(Math.abs(el.scrollTop - 900)).toBeLessThanOrEqual(0.5);
  });

  it("scroller que arredonda para pixel inteiro (Chrome) chega ao destino", () => {
    const el = document.createElement("div");
    let top = 1000;
    Object.defineProperty(el, "scrollTop", { get: () => top, set: (v: number) => { top = Math.round(v); }, configurable: true });
    Object.defineProperty(el, "scrollHeight", { get: () => 10000, configurable: true });
    Object.defineProperty(el, "clientHeight", { get: () => 500, configurable: true });
    attachWheelLimiter(el);
    wheel(el, { deltaY: -100 });
    // Frames curtíssimos (1 ms): o passo proporcional seria fracionário.
    let frames = 0;
    while (callbacks.size > 0 && frames < 400) {
      now += 1;
      const pending = [...callbacks.values()];
      callbacks = new Map();
      for (const cb of pending) cb(now);
      frames++;
    }
    expect(el.scrollTop).toBe(900);
  });
});
