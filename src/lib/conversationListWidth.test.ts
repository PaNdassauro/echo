import { afterEach, describe, expect, it } from "vitest";
import {
  LIST_WIDTH_DEFAULT,
  LIST_WIDTH_MAX,
  LIST_WIDTH_MIN,
  clampListWidth,
  minListWidthFor,
  parseListWidth,
  persistListWidth,
  readStoredListWidth,
  widthForKey,
} from "./conversationListWidth";

afterEach(() => {
  localStorage.clear();
});

describe("parseListWidth", () => {
  it("aceita número dentro da faixa e arredonda", () => {
    expect(parseListWidth("420")).toBe(420);
    expect(parseListWidth("420.6")).toBe(421);
  });

  it("prende fora da faixa", () => {
    expect(parseListWidth("10")).toBe(LIST_WIDTH_MIN);
    expect(parseListWidth("9999")).toBe(LIST_WIDTH_MAX);
  });

  it("cai no padrão para lixo, vazio e null", () => {
    expect(parseListWidth(null)).toBe(LIST_WIDTH_DEFAULT);
    expect(parseListWidth("")).toBe(LIST_WIDTH_DEFAULT);
    expect(parseListWidth("abc")).toBe(LIST_WIDTH_DEFAULT);
    expect(parseListWidth("Infinity")).toBe(LIST_WIDTH_DEFAULT);
  });
});

describe("persist/read", () => {
  it("ida e volta pelo localStorage, já presa na faixa", () => {
    expect(readStoredListWidth()).toBe(LIST_WIDTH_DEFAULT);
    persistListWidth(500);
    expect(readStoredListWidth()).toBe(500);
    persistListWidth(5000);
    expect(readStoredListWidth()).toBe(LIST_WIDTH_MAX);
  });
});

describe("widthForKey", () => {
  it("setas andam 16px (64 com Shift) e respeitam os limites", () => {
    expect(widthForKey(400, "ArrowRight", false)).toBe(416);
    expect(widthForKey(400, "ArrowLeft", true)).toBe(336);
    expect(widthForKey(LIST_WIDTH_MIN, "ArrowLeft", false)).toBe(LIST_WIDTH_MIN);
    expect(widthForKey(LIST_WIDTH_MAX, "ArrowRight", true)).toBe(LIST_WIDTH_MAX);
  });

  it("Home/End vão aos extremos e Enter volta ao padrão", () => {
    expect(widthForKey(400, "Home", false)).toBe(LIST_WIDTH_MIN);
    expect(widthForKey(400, "End", false)).toBe(LIST_WIDTH_MAX);
    expect(widthForKey(400, "Enter", false)).toBe(LIST_WIDTH_DEFAULT);
  });

  it("ignora as outras teclas", () => {
    expect(widthForKey(400, "a", false)).toBeNull();
    expect(widthForKey(400, "ArrowUp", false)).toBeNull();
  });

  it("clamp arredonda", () => {
    expect(clampListWidth(350.4)).toBe(350);
  });
});

describe("mínimo que acompanha o texto do app", () => {
  it("escala com o font-size do <html> e não desce dos 240px", () => {
    expect(minListWidthFor("16px")).toBe(LIST_WIDTH_MIN);
    expect(minListWidthFor("18px")).toBe(270);
    expect(minListWidthFor("20px")).toBe(300);
    expect(minListWidthFor("14.4px")).toBe(LIST_WIDTH_MIN);
  });

  it("sem valor em px (jsdom, vazio) fica no mínimo base", () => {
    expect(minListWidthFor("")).toBe(LIST_WIDTH_MIN);
    expect(minListWidthFor("125%")).toBe(LIST_WIDTH_MIN);
  });

  it("clamp e teclado respeitam o mínimo efetivo", () => {
    expect(clampListWidth(250, 300)).toBe(300);
    expect(widthForKey(310, "ArrowLeft", false, 300)).toBe(300);
    expect(widthForKey(500, "Home", false, 300)).toBe(300);
  });
});
