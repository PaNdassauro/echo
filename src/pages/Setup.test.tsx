import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const signInWithPassword = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signInWithPassword } },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import Setup from "./Setup";

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

const Local = ({ nome }: { nome: string }) => {
  const { pathname } = useLocation();
  return <span data-testid="local">{`${nome}:${pathname}`}</span>;
};

const abrir = (url = "/setup?codigo=codigo-do-terminal") =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="/auth" element={<Local nome="auth" />} />
        <Route path="/dashboard" element={<Local nome="dashboard" />} />
      </Routes>
    </MemoryRouter>,
  );

const SENHA_VALIDA = "Forte-Teste-123";

const preencher = (senha = SENHA_VALIDA, confirmacao = senha) => {
  fireEvent.change(screen.getByLabelText("Seu nome"), { target: { value: "Ana Souza" } });
  fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "Admin@Example.com" } });
  fireEvent.change(screen.getByLabelText("Senha"), { target: { value: senha } });
  fireEvent.change(screen.getByLabelText("Confirmar senha"), { target: { value: confirmacao } });
  fireEvent.change(screen.getByLabelText("Nome da organização"), { target: { value: "Acme" } });
};

const enviar = () => fireEvent.click(screen.getByRole("button", { name: "Criar administrador" }));

/** Chamadas POST da edge (o GET de consulta não conta). */
const postsFeitos = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");

beforeEach(() => {
  window.__ECHO_CONFIG__ = { supabaseUrl: "https://echo.exemplo.com", supabaseAnonKey: "anon" };
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve(
      init?.method === "POST"
        ? json({ ok: true, organization_id: "00000000-0000-4000-8000-000000000001" }, 201)
        : json({ precisa_setup: true }),
    ),
  );
  signInWithPassword.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  cleanup();
  window.__ECHO_CONFIG__ = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("Setup", () => {
  it("instalação já configurada (precisa_setup=false) vai para /auth", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ precisa_setup: false })));
    abrir();

    await waitFor(() => expect(screen.getByTestId("local").textContent).toBe("auth:/auth"));
  });

  it("envia o formulário, entra com a senha e vai para /dashboard", async () => {
    abrir();
    await screen.findByRole("button", { name: "Criar administrador" });
    preencher();
    enviar();

    await waitFor(() => expect(screen.getByTestId("local").textContent).toBe("dashboard:/dashboard"));
    const posts = postsFeitos();
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({
      codigo: "codigo-do-terminal",
      nome: "Ana Souza",
      email: "admin@example.com",
      senha: SENHA_VALIDA,
      organizacao: "Acme",
    });
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "admin@example.com", password: SENHA_VALIDA });
  });

  it("com o código na URL não mostra o campo de código; sem ele, mostra com a instrução", async () => {
    abrir("/setup?codigo=abc");
    await screen.findByRole("button", { name: "Criar administrador" });
    expect(screen.queryByLabelText("Código de instalação")).toBeNull();
    cleanup();

    abrir("/setup");
    await screen.findByLabelText("Código de instalação");
    expect(screen.getByText(/rodou \.\/install\.sh, ou rode \.\/echo setup-link/)).toBeTruthy();
  });

  it("409 mostra que já foi configurada, com o caminho para entrar", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "POST" ? json({ ok: false, erro: "ja_configurado" }, 409) : json({ precisa_setup: true })),
    );
    abrir();
    await screen.findByRole("button", { name: "Criar administrador" });
    preencher();
    enviar();

    await screen.findByText("Esta instalação já foi configurada. Entre com sua conta.");
    expect(screen.getByRole("link", { name: "Entrar" }).getAttribute("href")).toBe("/auth");
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("código recusado reabre o campo de código com a mensagem", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "POST" ? json({ ok: false, erro: "codigo_invalido" }, 403) : json({ precisa_setup: true })),
    );
    abrir();
    await screen.findByRole("button", { name: "Criar administrador" });
    preencher();
    enviar();

    await screen.findByText(/Código de instalação inválido/);
    expect(screen.getByLabelText("Código de instalação")).toBeTruthy();
  });

  it("senhas diferentes e senha curta não chegam à edge", async () => {
    abrir();
    await screen.findByRole("button", { name: "Criar administrador" });

    preencher(SENHA_VALIDA, "Forte-Teste-124");
    enviar();
    expect((await screen.findAllByText("As senhas não coincidem")).length).toBeGreaterThan(0);

    preencher("curta12", "curta12");
    enviar();
    await screen.findByText("A senha precisa ter pelo menos 8 caracteres.");

    expect(postsFeitos()).toHaveLength(0);
  });

  it("conexão que cai no POST avisa que a criação pode ter sido concluída", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST" ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(json({ precisa_setup: true })),
    );
    abrir();
    await screen.findByRole("button", { name: "Criar administrador" });
    preencher();
    enviar();

    await screen.findByText(/pode ter sido concluída/);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("criado, mas o login falha: avisa e manda para /auth", async () => {
    signInWithPassword.mockResolvedValue({ data: {}, error: new Error("Invalid login credentials") });
    abrir();
    await screen.findByRole("button", { name: "Criar administrador" });
    preencher();
    enviar();

    await waitFor(() => expect(screen.getByTestId("local").textContent).toBe("auth:/auth"));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Administrador criado" }));
  });

  it("clique duplo não dispara dois POST", async () => {
    abrir();
    await screen.findByRole("button", { name: "Criar administrador" });
    preencher();
    // Enter repetido dispara o submit do formulário direto, sem passar pelo botão (que fica desabilitado).
    const formulario = screen.getByRole("button", { name: "Criar administrador" }).closest("form");
    if (!formulario) throw new Error("formulário não encontrado");
    fireEvent.submit(formulario);
    fireEvent.submit(formulario);

    await waitFor(() => expect(screen.getByTestId("local").textContent).toBe("dashboard:/dashboard"));
    expect(postsFeitos()).toHaveLength(1);
  });
});
