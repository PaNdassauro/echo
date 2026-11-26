import { describe, expect, it } from "vitest";
import { isRecoveryLinkRejected, readRecoveryLink } from "./passwordRecovery";

const TOKEN = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";

describe("readRecoveryLink", () => {
  it("sem nada na URL não é link de recuperação", () => {
    expect(readRecoveryLink("", "")).toBeNull();
    expect(readRecoveryLink("?invite=abc", "")).toBeNull();
  });

  it("lê o link novo, com token_hash na query", () => {
    expect(readRecoveryLink(`?token_hash=${TOKEN}&type=recovery`, "")).toEqual({
      kind: "token",
      tokenHash: TOKEN,
    });
  });

  it("aceita o token com prefixo pkce_", () => {
    expect(readRecoveryLink(`?token_hash=pkce_${TOKEN}&type=recovery`, "")).toEqual({
      kind: "token",
      tokenHash: `pkce_${TOKEN}`,
    });
  });

  it("token malformado é link inválido, não tela de login", () => {
    expect(readRecoveryLink("?token_hash=<script>&type=recovery", "")).toEqual({ kind: "invalid" });
    expect(readRecoveryLink("?token_hash=&type=recovery", "")).toEqual({ kind: "invalid" });
  });

  it("token_hash de outro tipo (confirmação de cadastro) não é recuperação", () => {
    expect(readRecoveryLink(`?token_hash=${TOKEN}&type=signup`, "")).toBeNull();
  });

  it("lê o link antigo, com a sessão no hash", () => {
    expect(readRecoveryLink("", "#access_token=x&refresh_token=y&type=recovery")).toEqual({
      kind: "session",
    });
  });

  it("erro devolvido pelo Supabase vira link inválido", () => {
    expect(
      readRecoveryLink(
        "",
        "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      ),
    ).toEqual({ kind: "invalid" });
    expect(readRecoveryLink("?error=access_denied&error_code=otp_expired", "")).toEqual({ kind: "invalid" });
  });
});

describe("readRecoveryLink com convite", () => {
  it("erro na confirmação de cadastro do convite não vira aviso de link de senha", () => {
    expect(readRecoveryLink("?invite=abc", "#error=access_denied&error_code=otp_expired")).toBeNull();
  });
});

describe("isRecoveryLinkRejected", () => {
  it("token vencido ou já usado", () => {
    expect(isRecoveryLinkRejected({ code: "otp_expired", status: 403 })).toBe(true);
    expect(isRecoveryLinkRejected({ status: 403 })).toBe(true);
    expect(isRecoveryLinkRejected({ status: 401 })).toBe(true);
  });

  it("falha de rede ou do servidor não condena o link", () => {
    expect(isRecoveryLinkRejected(new Error("Failed to fetch"))).toBe(false);
    expect(isRecoveryLinkRejected({ status: 500 })).toBe(false);
    expect(isRecoveryLinkRejected({ status: 429, code: "over_request_rate_limit" })).toBe(false);
    expect(isRecoveryLinkRejected(null)).toBe(false);
  });
});
