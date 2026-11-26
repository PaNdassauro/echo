import { describe, expect, it } from "vitest";
import {
  sanitizeParticipantInput,
  validateParticipantPhone,
  isDuplicateParticipant,
} from "@/lib/groupParticipantPhone";

describe("sanitizeParticipantInput", () => {
  it("remove espaços, parênteses, hífen e o '+'", () => {
    expect(sanitizeParticipantInput("+55 (11) 99999-9999")).toBe("5511999999999");
  });

  it("descarta letras coladas por engano", () => {
    expect(sanitizeParticipantInput("55abc11def999999999")).toBe("5511999999999");
  });

  it("corta no teto do E.164 para um texto colado não virar telefone", () => {
    expect(sanitizeParticipantInput("1".repeat(40))).toHaveLength(15);
  });

  it("devolve vazio quando não há dígito nenhum", () => {
    expect(sanitizeParticipantInput("  contato do cliente ")).toBe("");
  });
});

describe("validateParticipantPhone", () => {
  it("aceita e normaliza um número brasileiro formatado", () => {
    const result = validateParticipantPhone("+55 (11) 99999-0001");
    expect(result.ok).toBe(true);
    expect(result.phone).toBe("5511999990001");
    expect(result.error).toBeNull();
  });

  it("recusa número curto demais com mensagem exibível", () => {
    const result = validateParticipantPhone("119");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/incompleto/i);
  });

  it("recusa entrada vazia", () => {
    expect(validateParticipantPhone("").ok).toBe(false);
  });

  it("recusa número longo demais", () => {
    const result = validateParticipantPhone("1".repeat(16));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/longo/i);
  });

  it("aceita número internacional sem prefixo 55", () => {
    const result = validateParticipantPhone("351912345678");
    expect(result.ok).toBe(true);
    expect(result.phone).toBe("351912345678");
  });
});

describe("isDuplicateParticipant", () => {
  it("casa a mesma pessoa com e sem o 9º dígito", () => {
    expect(isDuplicateParticipant("5511999990001", ["551199990001"])).toBe(true);
    expect(isDuplicateParticipant("551199990001", ["5511999990001"])).toBe(true);
  });

  it("casa com e sem o código do país", () => {
    expect(isDuplicateParticipant("5511999990001", ["11999990001"])).toBe(true);
  });

  it("não confunde pessoas diferentes", () => {
    expect(isDuplicateParticipant("5511999990001", ["5544988887777"])).toBe(false);
  });

  it("lista vazia nunca é duplicata", () => {
    expect(isDuplicateParticipant("5511999990001", [])).toBe(false);
  });

  it("telefone vazio não casa com nada", () => {
    expect(isDuplicateParticipant("", ["5511999990001"])).toBe(false);
  });
});
