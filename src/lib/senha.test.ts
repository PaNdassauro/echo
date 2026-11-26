import { describe, expect, it, vi } from "vitest";
import { NovaSenhaSchema, SENHA_MINIMA, mensagemDeErroDeSenha } from "./senha";

describe("NovaSenhaSchema", () => {
  it("aceita senha com o mínimo e confirmação igual", () => {
    expect(NovaSenhaSchema.safeParse({ senha: "12345678", confirmacao: "12345678" }).success).toBe(true);
  });

  it("recusa abaixo do mínimo, acima de 72 e confirmação diferente", () => {
    expect(SENHA_MINIMA).toBe(8);
    expect(NovaSenhaSchema.safeParse({ senha: "1234567", confirmacao: "1234567" }).success).toBe(false);
    expect(NovaSenhaSchema.safeParse({ senha: "x".repeat(73), confirmacao: "x".repeat(73) }).success).toBe(false);
    const divergente = NovaSenhaSchema.safeParse({ senha: "12345678", confirmacao: "12345679" });
    expect(divergente.success).toBe(false);
    if (!divergente.success) expect(divergente.error.issues[0]?.message).toBe("As senhas não coincidem.");
  });
});

describe("mensagemDeErroDeSenha", () => {
  it("traduz os códigos conhecidos do Auth", () => {
    expect(mensagemDeErroDeSenha({ code: "same_password", message: "x" })).toBe(
      "A nova senha precisa ser diferente da atual.",
    );
    expect(mensagemDeErroDeSenha({ code: "weak_password" })).toContain("Senha fraca demais");
    expect(mensagemDeErroDeSenha(new Error("For security purposes, you can only request this after 5 seconds."))).toBe(
      "Muitas tentativas. Aguarde um instante e tente novamente.",
    );
  });

  it("erro técnico não vaza para a tela", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(mensagemDeErroDeSenha(new TypeError("Failed to fetch"))).toBe("Verifique a conexão e tente novamente.");
  });
});
