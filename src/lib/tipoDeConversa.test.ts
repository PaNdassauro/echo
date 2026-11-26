import { describe, expect, it } from "vitest";
import { casaFiltroDeTipo, ehTipoDaConversa } from "./tipoDeConversa";

const grupo = { is_group: true };
const individual = { is_group: false };
const semFlag = { is_group: null };

describe("filtro de tipo da lista", () => {
  it("nada marcado mostra tudo", () => {
    expect([grupo, individual, semFlag].every((c) => casaFiltroDeTipo(c, []))).toBe(true);
  });

  it("separa grupo de conversa 1:1 (is_group nulo conta como 1:1)", () => {
    expect([grupo, individual, semFlag].map((c) => casaFiltroDeTipo(c, ["grupo"]))).toEqual([true, false, false]);
    expect([grupo, individual, semFlag].map((c) => casaFiltroDeTipo(c, ["individual"]))).toEqual([false, true, true]);
    expect([grupo, individual, semFlag].every((c) => casaFiltroDeTipo(c, ["individual", "grupo"]))).toBe(true);
  });

  it("só aceita os ids conhecidos", () => {
    expect(["individual", "grupo", "whatsapp", ""].map(ehTipoDaConversa)).toEqual([true, true, false, false]);
  });
});
