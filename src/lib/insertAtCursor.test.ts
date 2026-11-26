import { describe, expect, it } from "vitest";
import { insertAtSelection } from "./insertAtCursor";

describe("insertAtSelection", () => {
  it("insere no cursor", () => {
    expect(insertAtSelection("oi tudo", "😀", 2, 2)).toEqual({ value: "oi😀 tudo", caret: 4 });
  });

  it("substitui o trecho selecionado", () => {
    expect(insertAtSelection("oi tudo bem", "🎉", 3, 7)).toEqual({ value: "oi 🎉 bem", caret: 5 });
  });

  it("sem seleção conhecida acrescenta no fim", () => {
    expect(insertAtSelection("oi", "👍", null, null)).toEqual({ value: "oi👍", caret: 4 });
  });

  it("seleção fora do valor (campo encolheu) cai no fim", () => {
    expect(insertAtSelection("oi", "👍", 10, 12)).toEqual({ value: "oi👍", caret: 4 });
  });
});
