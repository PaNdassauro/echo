import { beforeEach, describe, expect, it } from "vitest";
import type { CachedLine } from "./conversationListCache";
import { conversationListCache, MAX_LINES } from "./conversationListCache";

const entry = (fetchedAt: number): CachedLine => ({ rows: [], fetchedAt, complete: true });

describe("conversationListCache", () => {
  beforeEach(() => {
    conversationListCache.clear();
    conversationListCache.setCapacity(MAX_LINES);
  });

  it("guarda e devolve por linha", () => {
    const e = entry(1);
    conversationListCache.set("a", e);
    expect(conversationListCache.get("a")).toBe(e);
    expect(conversationListCache.get("b")).toBeUndefined();
  });

  it("evicta a linha menos recente acima de MAX_LINES", () => {
    for (let i = 0; i <= MAX_LINES; i++) conversationListCache.set(`l${i}`, entry(i));
    expect(conversationListCache.get("l0")).toBeUndefined();
    expect(conversationListCache.get(`l${MAX_LINES}`)).toBeDefined();
  });

  it("set em linha existente a torna a mais recente (LRU)", () => {
    for (let i = 0; i < MAX_LINES; i++) conversationListCache.set(`l${i}`, entry(i));
    conversationListCache.set("l0", entry(99));
    conversationListCache.set("novo", entry(100));
    expect(conversationListCache.get("l0")?.fetchedAt).toBe(99);
    expect(conversationListCache.get("l1")).toBeUndefined();
  });

  it("a capacidade começa em MAX_LINES e não desce dele", () => {
    expect(conversationListCache.capacity()).toBe(MAX_LINES);
    conversationListCache.setCapacity(1);
    expect(conversationListCache.capacity()).toBe(MAX_LINES);
    // Valor que não é número não pode desligar a evicção.
    conversationListCache.setCapacity(8);
    conversationListCache.setCapacity(Number.NaN);
    expect(conversationListCache.capacity()).toBe(MAX_LINES);
  });

  it("com a capacidade maior (escopo conjunto) guarda todos os números", () => {
    conversationListCache.setCapacity(8);
    for (let i = 0; i < 8; i++) conversationListCache.set(`l${i}`, entry(i));
    for (let i = 0; i < 8; i++) expect(conversationListCache.get(`l${i}`)).toBeDefined();

    conversationListCache.set("l8", entry(8));
    expect(conversationListCache.get("l0")).toBeUndefined();
    expect(conversationListCache.get("l8")).toBeDefined();
  });

  it("ao voltar a um escopo pequeno, a capacidade desce e saem as menos recentes", () => {
    conversationListCache.setCapacity(8);
    for (let i = 0; i < 8; i++) conversationListCache.set(`l${i}`, entry(i));

    conversationListCache.setCapacity(MAX_LINES);

    expect(conversationListCache.capacity()).toBe(MAX_LINES);
    for (let i = 0; i < 8 - MAX_LINES; i++) expect(conversationListCache.get(`l${i}`)).toBeUndefined();
    for (let i = 8 - MAX_LINES; i < 8; i++) expect(conversationListCache.get(`l${i}`)).toBeDefined();
  });

  it("tocar uma linha antes de encolher a poupa da evicção", () => {
    conversationListCache.setCapacity(6);
    for (let i = 0; i < 6; i++) conversationListCache.set(`l${i}`, entry(i));

    const dela = conversationListCache.get("l0");
    if (dela) conversationListCache.set("l0", dela);
    conversationListCache.setCapacity(MAX_LINES);

    expect(conversationListCache.get("l0")).toBe(dela);
    expect(conversationListCache.get("l1")).toBeUndefined();
  });

  it("capacidade fracionária é arredondada para baixo", () => {
    conversationListCache.setCapacity(5.9);
    expect(conversationListCache.capacity()).toBe(5);
  });
});
