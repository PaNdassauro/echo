import { describe, expect, it } from "vitest";
import { parseArgs, validarAmbiente, validarArgumentos } from "./bootstrap-admin.mjs";

const SENHA_VALIDA = "forte-1-teste";
const SENHA_ALTERNATIVA = "alt-12345";
const OK = ["--email", "admin@example.com", "--password", SENHA_VALIDA, "--org", "Acme"];

describe("parseArgs", () => {
  it("lê `--chave valor` e `--chave=valor`", () => {
    const { valores, erros } = parseArgs(["--email=admin@example.com", "--org", "Acme Ltda", "--password", SENHA_ALTERNATIVA]);
    expect(erros).toEqual([]);
    expect(valores).toEqual({ email: "admin@example.com", org: "Acme Ltda", password: SENHA_ALTERNATIVA });
  });

  it("aceita valor com `=` dentro quando vem na forma `--chave=valor`", () => {
    const { valores } = parseArgs(["--password=a=b=c12345"]);
    expect(valores.password).toBe("a=b=c12345");
  });

  it("recusa opção desconhecida, argumento solto, valor ausente e flag repetida", () => {
    expect(parseArgs(["--nome", "x"]).erros).toEqual(["opção desconhecida: --nome"]);
    expect(parseArgs(["solto"]).erros).toEqual(["argumento inesperado: solto"]);
    expect(parseArgs(["--email"]).erros).toEqual(["--email precisa de um valor"]);
    expect(parseArgs(["--email", "--org", "Acme"]).erros).toContain("--email precisa de um valor");
    expect(parseArgs(["--org", "A1", "--org", "B2"]).erros).toEqual(["--org foi passada mais de uma vez"]);
  });
});

describe("validarArgumentos", () => {
  it("aceita o conjunto completo e normaliza e-mail e nome", () => {
    const r = validarArgumentos(["--email", "  Admin@Example.COM ", "--password", SENHA_VALIDA, "--org", "  Acme  "]);
    expect(r.ok).toBe(true);
    expect(r.dados).toEqual({ email: "admin@example.com", password: SENHA_VALIDA, org: "Acme" });
  });

  it("lista o que falta", () => {
    const r = validarArgumentos([]);
    expect(r.ok).toBe(false);
    expect(r.erros).toEqual(["--email é obrigatório", "--password é obrigatório", "--org é obrigatório"]);
  });

  it("recusa e-mail inválido, senha curta e organização curta ou longa", () => {
    expect(validarArgumentos(["--email", "nao-e-email", "--password", SENHA_VALIDA, "--org", "Acme"]).erros).toEqual([
      "--email não é um e-mail válido",
    ]);
    expect(validarArgumentos(["--email", "admin@example.com", "--password", "curta", "--org", "Acme"]).erros).toEqual([
      "--password precisa de pelo menos 8 caracteres",
    ]);
    expect(validarArgumentos(["--email", "admin@example.com", "--password", SENHA_VALIDA, "--org", " A "]).erros).toEqual([
      "--org precisa de pelo menos 2 caracteres",
    ]);
    expect(
      validarArgumentos(["--email", "admin@example.com", "--password", SENHA_VALIDA, "--org", "x".repeat(101)]).erros,
    ).toEqual(["--org aceita no máximo 100 caracteres"]);
  });

  it("usa BOOTSTRAP_ADMIN_PASSWORD só quando --password falta", () => {
    const semSenha = ["--email", "admin@example.com", "--org", "Acme"];
    expect(validarArgumentos(semSenha, { BOOTSTRAP_ADMIN_PASSWORD: "senha-do-ambiente" }).dados.password).toBe(
      "senha-do-ambiente",
    );
    expect(validarArgumentos(OK, { BOOTSTRAP_ADMIN_PASSWORD: "outra-senha-aqui" }).dados.password).toBe(SENHA_VALIDA);
    expect(validarArgumentos(semSenha, {}).ok).toBe(false);
  });

  it("não repete a senha nas mensagens de erro", () => {
    const r = validarArgumentos(["--email", "ruim", "--password", "curta", "--org", "Acme"]);
    expect(JSON.stringify(r.erros)).not.toContain("curta");
  });
});

describe("validarAmbiente", () => {
  it("aceita URL http(s) e chave", () => {
    const r = validarAmbiente({ SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste" });
    expect(r.ok).toBe(true);
  });

  it("não tem valor padrão: ausência é erro claro", () => {
    const r = validarAmbiente({});
    expect(r.ok).toBe(false);
    expect(r.erros).toEqual(["SUPABASE_URL não definida", "SUPABASE_SERVICE_ROLE_KEY não definida"]);
  });

  it("recusa URL inválida, esquema estranho e chave vazia", () => {
    expect(validarAmbiente({ SUPABASE_URL: "abc", SUPABASE_SERVICE_ROLE_KEY: "k" }).ok).toBe(false);
    expect(validarAmbiente({ SUPABASE_URL: "ftp://exemplo.test", SUPABASE_SERVICE_ROLE_KEY: "k" }).ok).toBe(false);
    expect(validarAmbiente({ SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "  " }).erros).toEqual([
      "SUPABASE_SERVICE_ROLE_KEY está vazia",
    ]);
  });
});
