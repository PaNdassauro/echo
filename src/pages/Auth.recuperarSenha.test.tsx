import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  verifyOtp: vi.fn(),
  updateUser: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
}));
const invoke = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth, functions: { invoke }, rpc: vi.fn() },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
// Sem rede nos testes: a consulta do primeiro acesso responde "já configurada".
vi.mock("@/lib/primeiroAcesso", () => ({ consultarPrecisaSetup: () => Promise.resolve(false) }));
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

import Auth from "./Auth";
import Index from "./Index";
import { readRecoveryLink } from "@/lib/passwordRecovery";

const SENHA_NOVA = "nova-teste-9";

const LocalAtual = () => {
  const { pathname, search } = useLocation();
  return <span data-testid="local">{pathname + search}</span>;
};

const TOKEN = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";

const abrir = (url: string) => {
  window.history.replaceState(null, "", url);
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Auth />
    </MemoryRouter>,
  );
};

const preencherSenha = (senha: string, confirmacao = senha) => {
  fireEvent.change(screen.getByLabelText("Nova senha"), { target: { value: senha } });
  fireEvent.change(screen.getByLabelText("Confirmar nova senha"), { target: { value: confirmacao } });
  fireEvent.click(screen.getByRole("button", { name: "Atualizar senha" }));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  auth.getUser.mockResolvedValue({ data: { user: null } });
  auth.getSession.mockResolvedValue({ data: { session: null } });
  auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  auth.verifyOtp.mockResolvedValue({ data: {}, error: null });
  auth.updateUser.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("Auth: pedir o link de nova senha", () => {
  it("pede pelo Auth, com volta para o domínio atual, e mostra a mesma tela exista a conta ou não", async () => {
    abrir("/auth");
    fireEvent.click(screen.getByRole("button", { name: "Esqueci minha senha" }));
    fireEvent.change(screen.getByLabelText("E-mail da sua conta"), { target: { value: " ana@exemplo.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar link de nova senha" }));

    await screen.findByText("Confira seu e-mail");
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("ana@exemplo.com", {
      redirectTo: `${window.location.origin}/auth`,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByText("ana@exemplo.com")).toBeTruthy();
  });

  it("limite de frequência vira aviso em português, sem texto cru", async () => {
    auth.resetPasswordForEmail.mockResolvedValue({
      data: null,
      error: new Error("For security purposes, you can only request this after 42 seconds."),
    });
    abrir("/auth");
    fireEvent.click(screen.getByRole("button", { name: "Esqueci minha senha" }));
    fireEvent.change(screen.getByLabelText("E-mail da sua conta"), { target: { value: "ana@exemplo.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar link de nova senha" }));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: "Não foi possível enviar o e-mail",
      description: "Muitas tentativas. Aguarde um instante e tente novamente.",
    });
    expect(screen.queryByText("Confira seu e-mail")).toBeNull();
  });
});

describe("Index: link que caiu no endereço raiz", () => {
  it("manda para /auth mantendo o token", () => {
    const url = `/?token_hash=${TOKEN}&type=recovery`;
    window.history.replaceState(null, "", url);
    render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/auth" element={<LocalAtual />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("local").textContent).toBe(`/auth?token_hash=${TOKEN}&type=recovery`);
  });
});

describe("Auth: abrir o link de nova senha", () => {
  it("abrir o link não consome o token; ele só é trocado ao gravar a senha", async () => {
    abrir(`/auth?token_hash=${TOKEN}&type=recovery`);

    expect(screen.getByLabelText("Nova senha")).toBeTruthy();
    await waitFor(() => expect(auth.getUser).toHaveBeenCalled());
    expect(auth.verifyOtp).not.toHaveBeenCalled();

    preencherSenha(SENHA_NOVA);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/dashboard"));
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN, type: "recovery" });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: SENHA_NOVA });
  });

  it("sessão já aberta no navegador não pula a troca de senha", async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    abrir(`/auth?token_hash=${TOKEN}&type=recovery`);

    await waitFor(() => expect(auth.getUser).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Nova senha")).toBeTruthy();
  });

  it("eventos de sessão durante a recuperação não levam ao dashboard", async () => {
    abrir(`/auth?token_hash=${TOKEN}&type=recovery`);
    await waitFor(() => expect(auth.onAuthStateChange).toHaveBeenCalled());
    const aoMudar = auth.onAuthStateChange.mock.calls[0][0] as (evento: string, sessao: unknown) => Promise<void>;
    const sessao = { user: { id: "u1" } };

    await act(async () => {
      await aoMudar("SIGNED_IN", sessao);
      await aoMudar("PASSWORD_RECOVERY", sessao);
      await aoMudar("USER_UPDATED", sessao);
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Nova senha")).toBeTruthy();
  });

  it("depois de trocado, o token sai da URL e a página recarregada volta para a nova senha", async () => {
    auth.updateUser.mockResolvedValueOnce({ data: null, error: new Error("Failed to fetch") });
    abrir(`/auth?token_hash=${TOKEN}&type=recovery`);
    preencherSenha(SENHA_NOVA);

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(window.location.search).toBe("");
    expect(readRecoveryLink(window.location.search, window.location.hash)).toEqual({ kind: "session" });
  });

  it("link vencido com sessão aberta: 'Voltar para entrar' leva ao dashboard", async () => {
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
    auth.getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    abrir("/auth#error=access_denied&error_code=otp_expired");

    await waitFor(() => expect(auth.getUser).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Voltar para entrar" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/dashboard"));
  });

  it("link vencido ou já usado mostra o aviso e deixa pedir outro", async () => {
    auth.verifyOtp.mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Email link is invalid or has expired"), { code: "otp_expired", status: 403 }),
    });
    abrir(`/auth?token_hash=${TOKEN}&type=recovery`);
    preencherSenha(SENHA_NOVA);

    await screen.findByText("Este link venceu ou já foi usado");
    expect(auth.updateUser).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Pedir novo link" }));
    expect(screen.getByLabelText("E-mail da sua conta")).toBeTruthy();
    expect(navigate).toHaveBeenCalledWith("/auth", { replace: true });
  });

  it("senha recusada depois do token trocado: a nova tentativa não gasta o token de novo", async () => {
    auth.updateUser.mockResolvedValueOnce({
      data: null,
      error: new Error("New password should be different from the old password."),
    });
    abrir(`/auth?token_hash=${TOKEN}&type=recovery`);
    preencherSenha("senha-antiga");

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: "Não foi possível atualizar a senha",
      description: "A nova senha precisa ser diferente da atual.",
    });

    preencherSenha("senha-nova-de-verdade");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/dashboard"));
    expect(auth.verifyOtp).toHaveBeenCalledTimes(1);
    expect(auth.updateUser).toHaveBeenCalledTimes(2);
  });

  it("falha de rede ao trocar o token não condena o link", async () => {
    auth.verifyOtp.mockResolvedValueOnce({ data: null, error: new Error("Failed to fetch") });
    abrir(`/auth?token_hash=${TOKEN}&type=recovery`);
    preencherSenha(SENHA_NOVA);

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(screen.queryByText("Este link venceu ou já foi usado")).toBeNull();
    expect(screen.getByLabelText("Nova senha")).toBeTruthy();
  });

  it("erro devolvido pelo Supabase no hash (link antigo vencido) mostra o aviso, não o login mudo", () => {
    abrir("/auth#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");

    expect(screen.getByText("Este link venceu ou já foi usado")).toBeTruthy();
    expect(screen.queryByLabelText("Senha")).toBeNull();
  });

  it("link antigo, com a sessão no hash, segue funcionando sem verifyOtp", async () => {
    abrir("/auth#access_token=x&refresh_token=y&type=recovery");
    preencherSenha(SENHA_NOVA);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/dashboard"));
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(auth.updateUser).toHaveBeenCalledWith({ password: SENHA_NOVA });
  });
});
