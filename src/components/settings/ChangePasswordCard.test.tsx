import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const updateUser = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { updateUser } } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { ChangePasswordCard } from "./ChangePasswordCard";

const SENHA_NOVA = "Nova-Teste-123";
const SENHA_DIVERGENTE = "Nova-Teste-124";

const preencher = (senha: string, confirmacao: string) => {
  fireEvent.change(screen.getByLabelText("Nova senha"), { target: { value: senha } });
  fireEvent.change(screen.getByLabelText("Confirmar nova senha"), { target: { value: confirmacao } });
  fireEvent.click(screen.getByRole("button", { name: "Alterar senha" }));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  updateUser.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChangePasswordCard", () => {
  it("troca a senha pelo Auth, limpa os campos e avisa", async () => {
    render(<ChangePasswordCard />);
    preencher(SENHA_NOVA, SENHA_NOVA);

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: SENHA_NOVA }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Senha alterada" })));
    expect((screen.getByLabelText("Nova senha") as HTMLInputElement).value).toBe("");
  });

  it("menos de 8 caracteres não chega ao Auth", async () => {
    render(<ChangePasswordCard />);
    preencher("curta12", "curta12");

    await screen.findByText("A senha precisa ter pelo menos 8 caracteres.");
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("confirmação diferente não chega ao Auth", async () => {
    render(<ChangePasswordCard />);
    preencher(SENHA_NOVA, SENHA_DIVERGENTE);

    expect((await screen.findAllByText(/As senhas não coincidem/)).length).toBeGreaterThan(0);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("mesma senha da atual volta em português", async () => {
    updateUser.mockResolvedValue({ data: null, error: Object.assign(new Error("same"), { code: "same_password" }) });
    render(<ChangePasswordCard />);
    preencher(SENHA_NOVA, SENHA_NOVA);

    await screen.findByText("A nova senha precisa ser diferente da atual.");
    expect(toast).not.toHaveBeenCalled();
  });
});
