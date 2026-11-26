import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SetupSchema,
  pontosDeCodigo,
  consultarPrecisaSetup,
  enviarSetup,
  mensagemDeErroSetup,
  type ErroSetup,
} from "./primeiroAcesso";

const fetchMock = vi.fn();

const ENTRADA = {
  codigo: "abc123",
  nome: "Ana Souza",
  email: "admin@example.com",
  senha: "SenhaForte123",
  organizacao: "Acme",
};

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  window.__ECHO_CONFIG__ = { supabaseUrl: "https://echo.exemplo.com", supabaseAnonKey: "anon" };
  sessionStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  window.__ECHO_CONFIG__ = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("consultarPrecisaSetup", () => {
  it("true quando a edge diz que precisa, e não guarda nada", async () => {
    fetchMock.mockResolvedValue(json({ precisa_setup: true }));

    await expect(consultarPrecisaSetup()).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://echo.exemplo.com/functions/v1/primeiro-acesso");
    expect(init.method).toBe("GET");
    expect(sessionStorage.getItem("echo:precisa_setup=0")).toBeNull();
  });

  it("false é guardado na sessão e poupa o próximo GET", async () => {
    fetchMock.mockResolvedValue(json({ precisa_setup: false }));

    await expect(consultarPrecisaSetup()).resolves.toBe(false);
    await expect(consultarPrecisaSetup()).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("echo:precisa_setup=0")).toBe("1");
  });

  it("404 (função ausente) conta como false e é lembrado na sessão: o GET não se repete", async () => {
    fetchMock.mockResolvedValue(new Response("nao existe", { status: 404 }));

    await expect(consultarPrecisaSetup()).resolves.toBe(false);
    await expect(consultarPrecisaSetup()).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("echo:precisa_setup=0")).toBe("1");
  });

  it("falha de rede, 5xx e corpo fora do contrato contam como false e NÃO são lembrados", async () => {
    fetchMock.mockResolvedValueOnce(new Response("falhou", { status: 502 }));
    await expect(consultarPrecisaSetup()).resolves.toBe(false);

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(consultarPrecisaSetup()).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce(json({ outra: "coisa" }));
    await expect(consultarPrecisaSetup()).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sessionStorage.getItem("echo:precisa_setup=0")).toBeNull();
  });
});

describe("enviarSetup", () => {
  it("201 devolve ok e manda o corpo em JSON com a chave anon", async () => {
    fetchMock.mockResolvedValue(json({ ok: true, organization_id: "00000000-0000-4000-8000-000000000001" }, 201));

    await expect(enviarSetup(SetupSchema.parse(ENTRADA))).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://echo.exemplo.com/functions/v1/primeiro-acesso");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", apikey: "anon" });
    expect(JSON.parse(String(init.body))).toEqual(ENTRADA);
  });

  it.each<[number, ErroSetup]>([
    [403, "codigo_invalido"],
    [403, "setup_desligado"],
    [409, "ja_configurado"],
    [422, "senha_fraca"],
    [422, "email_em_uso"],
    [500, "falha_interna"],
  ])("HTTP %i com erro %s vira o mesmo código", async (status, erro) => {
    fetchMock.mockResolvedValue(json({ ok: false, erro }, status));
    await expect(enviarSetup(SetupSchema.parse(ENTRADA))).resolves.toEqual({ ok: false, erro });
  });

  it("409 lembra, nesta aba, que a instalação já foi configurada", async () => {
    fetchMock.mockResolvedValue(json({ ok: false, erro: "ja_configurado" }, 409));
    await enviarSetup(SetupSchema.parse(ENTRADA));
    expect(sessionStorage.getItem("echo:precisa_setup=0")).toBe("1");
  });

  it("falha de rede e resposta ilegível dizem 'sem_resposta' (a criação pode ter ocorrido)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(enviarSetup(SetupSchema.parse(ENTRADA))).resolves.toEqual({ ok: false, erro: "sem_resposta" });

    fetchMock.mockResolvedValueOnce(new Response("<html>502</html>", { status: 502 }));
    await expect(enviarSetup(SetupSchema.parse(ENTRADA))).resolves.toEqual({ ok: false, erro: "sem_resposta" });

    fetchMock.mockResolvedValueOnce(json({ ok: false, erro: "inventado" }, 400));
    await expect(enviarSetup(SetupSchema.parse(ENTRADA))).resolves.toEqual({ ok: false, erro: "sem_resposta" });
  });

  it("a mensagem de 'sem_resposta' avisa que pode ter sido concluída", () => {
    expect(mensagemDeErroSetup("sem_resposta")).toContain("pode ter sido concluída");
  });
});

describe("SetupSchema (par do SetupSchema da edge)", () => {
  it("normaliza espaços e caixa do e-mail", () => {
    const lido = SetupSchema.parse({ ...ENTRADA, email: "  ADMIN@Example.COM ", nome: "  Ana  " });
    expect(lido.email).toBe("admin@example.com");
    expect(lido.nome).toBe("Ana");
  });

  it("recusa senha curta, organização curta, e-mail ruim e campo a mais", () => {
    expect(SetupSchema.safeParse({ ...ENTRADA, senha: "1234567" }).success).toBe(false);
    expect(SetupSchema.safeParse({ ...ENTRADA, organizacao: "A" }).success).toBe(false);
    expect(SetupSchema.safeParse({ ...ENTRADA, email: "sem-arroba" }).success).toBe(false);
    expect(SetupSchema.safeParse({ ...ENTRADA, extra: "x" }).success).toBe(false);
    expect(SetupSchema.safeParse({ ...ENTRADA, senha: "x".repeat(73) }).success).toBe(false);
  });

  it("conta o nome da organização em pontos de código, como o length() do Postgres (emoji = 1)", () => {
    expect(SetupSchema.safeParse({ ...ENTRADA, organizacao: "😀" }).success).toBe(false);
    expect(SetupSchema.safeParse({ ...ENTRADA, organizacao: "😀😀" }).success).toBe(true);
    expect(SetupSchema.safeParse({ ...ENTRADA, organizacao: "😀".repeat(100) }).success).toBe(true);
    expect(SetupSchema.safeParse({ ...ENTRADA, organizacao: "😀".repeat(101) }).success).toBe(false);
    expect(pontosDeCodigo("a😀b")).toBe(3);
  });
});
