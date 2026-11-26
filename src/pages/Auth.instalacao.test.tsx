import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
}));
const rpc = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
const consultarPrecisaSetup = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth, rpc } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/primeiroAcesso", () => ({ consultarPrecisaSetup }));
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

import Auth from "./Auth";

const abrir = (url = "/auth") => {
  window.history.replaceState(null, "", url);
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Auth />
    </MemoryRouter>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  auth.getUser.mockResolvedValue({ data: { user: null } });
  auth.getSession.mockResolvedValue({ data: { session: null } });
  auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  consultarPrecisaSetup.mockResolvedValue(false);
  window.__ECHO_CONFIG__ = undefined;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.__ECHO_CONFIG__ = undefined;
  window.history.replaceState(null, "", "/");
});

describe("Auth: esqueci a senha depende do e-mail da instalação", () => {
  it("com e-mail (padrão) mostra o botão", () => {
    abrir();
    expect(screen.getByRole("button", { name: "Esqueci minha senha" })).toBeTruthy();
  });

  it("com recuperacaoSenha=false não mostra o botão e manda pedir ao administrador", () => {
    window.__ECHO_CONFIG__ = { features: { recuperacaoSenha: false } };
    abrir();

    expect(screen.queryByRole("button", { name: "Esqueci minha senha" })).toBeNull();
    expect(
      screen.getByText("Esqueceu a senha? Peça ao administrador da instalação um link de nova senha."),
    ).toBeTruthy();
  });

  it("não tem o botão Voltar que levava à landing", () => {
    abrir();
    expect(screen.queryByRole("button", { name: /voltar/i })).toBeNull();
  });
});

describe("Auth: instalação nova", () => {
  it("quando precisa do primeiro acesso, vai para /setup", async () => {
    consultarPrecisaSetup.mockResolvedValue(true);
    abrir();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/setup", { replace: true }));
  });

  it("instalação configurada fica em /auth", async () => {
    abrir();
    await waitFor(() => expect(consultarPrecisaSetup).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalledWith("/setup", expect.anything());
  });
});

describe("Auth: cadastro por convite", () => {
  const convite = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "agente@example.com",
    phone_number_id: "00000000-0000-4000-8000-000000000002",
    organization_id: "00000000-0000-4000-8000-000000000003",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    phone_display_name: "Vendas",
  };

  const abrirConvite = async () => {
    rpc.mockReturnValue({ single: () => Promise.resolve({ data: convite, error: null }) });
    abrir("/auth?invite=token-do-convite");
    await screen.findByLabelText("Nome completo");
    fireEvent.change(screen.getByLabelText("Nome completo"), { target: { value: "Bruno Lima" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "SenhaForte123" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar conta" }));
  };

  it("sessão devolvida (sem confirmação de e-mail): 'Conta criada'", async () => {
    auth.signUp.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });
    await abrirConvite();

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Conta criada" })));
  });

  it("sem sessão (confirmação por e-mail): 'Confirme seu e-mail'", async () => {
    auth.signUp.mockResolvedValue({ data: { session: null }, error: null });
    await abrirConvite();

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Confirme seu e-mail" })));
  });

  it("senha com menos de 8 caracteres volta como aviso em português", async () => {
    auth.signUp.mockResolvedValue({
      data: { session: null },
      error: new Error("Password should be at least 8 characters."),
    });
    await abrirConvite();

    await screen.findByText("A senha precisa ter pelo menos 8 caracteres.");
  });
});
