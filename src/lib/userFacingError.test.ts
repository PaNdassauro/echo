import { describe, expect, it } from "vitest";
import { GENERIC_ERROR_FALLBACK, extractErrorMessage, isUserFacingMessage, toUserMessage } from "./userFacingError";

describe("extractErrorMessage", () => {
  it("lê Error, string e objeto estilo PostgrestError", () => {
    expect(extractErrorMessage(new Error("  boom "))).toBe("boom");
    expect(extractErrorMessage("texto")).toBe("texto");
    expect(extractErrorMessage({ message: "Número não conectado", code: "P0001" })).toBe("Número não conectado");
    expect(extractErrorMessage({ error: { message: "aninhado" } })).toBe("aninhado");
    expect(extractErrorMessage({ error_description: "OAuth ruim" })).toBe("OAuth ruim");
  });

  it("devolve null sem texto", () => {
    expect(extractErrorMessage(null)).toBeNull();
    expect(extractErrorMessage(undefined)).toBeNull();
    expect(extractErrorMessage("   ")).toBeNull();
    expect(extractErrorMessage({})).toBeNull();
    expect(extractErrorMessage(42)).toBeNull();
  });
});

describe("isUserFacingMessage", () => {
  it("aceita frases escritas para o usuário", () => {
    expect(isUserFacingMessage("Você não tem permissão para encerrar esta conversa.")).toBe(true);
    expect(isUserFacingMessage("Número não conectado. Reconecte pelo QR code.")).toBe(true);
    expect(isUserFacingMessage("Template ainda não aprovado pela Meta")).toBe(true);
  });

  it("rejeita o que é log: JSON, códigos, stack, rede, status", () => {
    expect(isUserFacingMessage('[{"code":"too_small","path":["name"]}]')).toBe(false);
    expect(isUserFacingMessage("duplicate key value violates unique constraint \"messages_wamid_key\"")).toBe(false);
    expect(isUserFacingMessage("PGRST116: The result contains 0 rows")).toBe(false);
    expect(isUserFacingMessage("new row violates row-level security policy for table \"tags\"")).toBe(false);
    expect(isUserFacingMessage("Failed to fetch")).toBe(false);
    expect(isUserFacingMessage("Edge Function returned a non-2xx status code")).toBe(false);
    expect(isUserFacingMessage("TypeError: Cannot read properties of undefined (reading 'id')")).toBe(false);
    expect(isUserFacingMessage("Error")).toBe(false);
    expect(isUserFacingMessage("Erro desconhecido")).toBe(false);
    expect(isUserFacingMessage("<!DOCTYPE html><html><body>502 Bad Gateway</body></html>")).toBe(false);
    expect(isUserFacingMessage("at handleSubmit (BroadcastBuilder.tsx:459:13)")).toBe(false);
    expect(isUserFacingMessage("JWT expired")).toBe(false);
    expect(isUserFacingMessage("x".repeat(161))).toBe(false);
  });
});

describe("toUserMessage", () => {
  it("repassa a mensagem do servidor quando ela é para o usuário", () => {
    expect(toUserMessage({ message: "Número não conectado." }, "Tente de novo.")).toBe("Número não conectado.");
  });

  it("troca mensagem técnica pelo próximo passo", () => {
    expect(toUserMessage(new Error("Failed to fetch"), "Verifique a conexão e tente novamente.")).toBe(
      "Verifique a conexão e tente novamente.",
    );
    expect(toUserMessage({ message: '{"error":"x"}' }, "Tente de novo.")).toBe("Tente de novo.");
  });

  it("usa o fallback genérico quando não há texto", () => {
    expect(toUserMessage(null)).toBe(GENERIC_ERROR_FALLBACK);
    expect(toUserMessage(undefined, "Próximo passo")).toBe("Próximo passo");
  });
});
