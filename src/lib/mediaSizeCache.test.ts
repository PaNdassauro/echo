import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMediaSizes,
  fitWithin,
  knownMediaSize,
  rememberMediaSize,
  seedMediaSize,
  wasMediaLoaded,
} from "./mediaSizeCache";

const KEY = "echo.mediaSize.v1";
const PUB = "https://p.supabase.co/storage/v1/object/public/attachments/";

beforeEach(() => clearMediaSizes());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearMediaSizes();
});

describe("mediaSizeCache", () => {
  it("guarda e devolve o tamanho por URL", () => {
    rememberMediaSize("https://x/a.png", 617, 880);
    expect(knownMediaSize("https://x/a.png")).toEqual({ width: 617, height: 880 });
    expect(knownMediaSize("https://x/b.png")).toBeUndefined();
    expect(knownMediaSize(null)).toBeUndefined();
  });

  it("ignora URL vazia e tamanho zerado (imagem quebrada)", () => {
    rememberMediaSize("", 10, 10);
    rememberMediaSize("https://x/zero.png", 0, 0);
    expect(knownMediaSize("https://x/zero.png")).toBeUndefined();
  });

  it("aceita 2000 entradas e descarta a mais antiga na 2001ª", () => {
    for (let i = 0; i < 2000; i++) rememberMediaSize(`https://x/${i}.png`, 10, 10);
    expect(knownMediaSize("https://x/0.png")).toEqual({ width: 10, height: 10 });
    rememberMediaSize("https://x/2000.png", 10, 10);
    expect(knownMediaSize("https://x/0.png")).toBeUndefined();
    expect(knownMediaSize("https://x/2000.png")).toEqual({ width: 10, height: 10 });
  });

  it("seed torna o tamanho conhecido sem marcar como carregada", () => {
    seedMediaSize("https://x/s.png", 100, 50);
    expect(knownMediaSize("https://x/s.png")).toEqual({ width: 100, height: 50 });
    expect(wasMediaLoaded("https://x/s.png")).toBe(false);
  });

  it("remember marca como carregada; clear zera os dois", () => {
    rememberMediaSize("https://x/r.png", 10, 20);
    expect(wasMediaLoaded("https://x/r.png")).toBe(true);
    expect(wasMediaLoaded(null)).toBe(false);
    clearMediaSizes();
    expect(wasMediaLoaded("https://x/r.png")).toBe(false);
    expect(knownMediaSize("https://x/r.png")).toBeUndefined();
  });

  it("encaixa no teto sem ampliar", () => {
    expect(fitWithin({ width: 617, height: 880 }, 300)).toEqual({ width: 210, height: 300 });
    expect(fitWithin({ width: 1200, height: 600 }, 300)).toEqual({ width: 300, height: 150 });
    expect(fitWithin({ width: 120, height: 80 }, 300)).toEqual({ width: 120, height: 80 });
  });
});

describe("mediaSizeCache persistido", () => {
  it("hidrata de um blob válido, como conhecido mas não carregado", () => {
    localStorage.setItem(KEY, JSON.stringify({ "a/b.jpg": [640, 480, 1000] }));
    expect(knownMediaSize(`${PUB}a/b.jpg`)).toEqual({ width: 640, height: 480 });
    expect(wasMediaLoaded(`${PUB}a/b.jpg`)).toBe(false);
  });

  it("ignora blob corrompido ou fora do esquema", () => {
    localStorage.setItem(KEY, "{nao-e-json");
    expect(knownMediaSize(`${PUB}a/b.jpg`)).toBeUndefined();
    clearMediaSizes();
    localStorage.setItem(KEY, JSON.stringify({ "a/b.jpg": [0, 480, 1] }));
    expect(knownMediaSize(`${PUB}a/b.jpg`)).toBeUndefined();
  });

  it("segue funcionando se getItem lançar", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    expect(knownMediaSize("https://x/q.png")).toBeUndefined();
    rememberMediaSize("https://x/q.png", 10, 10);
    expect(knownMediaSize("https://x/q.png")).toEqual({ width: 10, height: 10 });
  });

  it("segue funcionando se setItem lançar", () => {
    vi.useFakeTimers();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cota");
    });
    rememberMediaSize("https://x/q.png", 10, 10);
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(knownMediaSize("https://x/q.png")).toEqual({ width: 10, height: 10 });
  });

  it("persiste depois do debounce de 1 s, com chave curta do bucket", () => {
    vi.useFakeTimers();
    rememberMediaSize(`${PUB}c/d.png`, 30, 40);
    expect(localStorage.getItem(KEY)).toBeNull();
    vi.advanceTimersByTime(1000);
    const blob = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number[]>;
    expect(blob["c/d.png"]?.slice(0, 2)).toEqual([30, 40]);
  });

  it("mantém só as 2000 mais recentes", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 2005; i++) seedMediaSize(`https://x/${i}.png`, 10, 10);
    vi.advanceTimersByTime(1000);
    const blob = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number[]>;
    expect(Object.keys(blob)).toHaveLength(2000);
    expect(blob["https://x/0.png"]).toBeUndefined();
    expect(blob["https://x/2004.png"]).toBeDefined();
  });

  it("não persiste URL assinada", () => {
    vi.useFakeTimers();
    rememberMediaSize("https://x/s.png?token=abc", 10, 10);
    vi.advanceTimersByTime(1000);
    const blob = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number[]>;
    expect(Object.keys(blob)).toHaveLength(0);
    expect(knownMediaSize("https://x/s.png?token=abc")).toEqual({ width: 10, height: 10 });
  });

  it("clearMediaSizes limpa também o blob persistido", () => {
    vi.useFakeTimers();
    rememberMediaSize("https://x/z.png", 10, 10);
    vi.advanceTimersByTime(1000);
    expect(localStorage.getItem(KEY)).not.toBeNull();
    clearMediaSizes();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
