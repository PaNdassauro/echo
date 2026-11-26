import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const estado = vi.hoisted(() => ({
  toast: vi.fn(),
  invoke: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ currentOrganization: { id: ORG, name: "Acme" } }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: estado.toast }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: () => Promise.resolve({ data: { user: { email: "atendente@exemplo.com" } } }) },
    functions: { invoke: estado.invoke },
  },
}));

const ORG = "00000000-0000-4000-8000-000000000001";

import FeedbackForm from "./FeedbackForm";

async function preencherEEnviar() {
  fireEvent.click(screen.getByText("Relatar um problema"));
  fireEvent.change(await screen.findByPlaceholderText("Resumo do seu feedback…"), {
    target: { value: "Áudio não toca" },
  });
  fireEvent.change(screen.getByPlaceholderText("Descreva seu feedback em detalhes…"), {
    target: { value: "O áudio da conversa fica carregando para sempre." },
  });
  fireEvent.click(screen.getByRole("button", { name: /enviar feedback/i }));
}

describe("FeedbackForm", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_FEEDBACK_WEBHOOK_URL", "https://hooks.exemplo.com/feedback");
    vi.stubGlobal("fetch", estado.fetch);
    // O RadioGroup do Radix mede o item com ResizeObserver, que o jsdom não tem.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    estado.fetch.mockResolvedValue(new Response("{}"));
    estado.invoke.mockResolvedValue({ data: { success: true }, error: null });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("manda para o webhook e por e-mail", async () => {
    const onClose = vi.fn();
    render(<FeedbackForm onClose={onClose} />);
    await preencherEEnviar();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(estado.fetch).toHaveBeenCalledWith("https://hooks.exemplo.com/feedback", expect.objectContaining({ method: "POST" }));
    expect(estado.invoke).toHaveBeenCalledWith("send-feedback-email", {
      body: {
        type: "bug",
        title: "Áudio não toca",
        details: "O áudio da conversa fica carregando para sempre.",
        organization_id: ORG,
        url: window.location.href,
      },
    });
    expect(estado.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Feedback enviado" }));
  });

  it("conta como enviado se só o e-mail sair", async () => {
    estado.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const onClose = vi.fn();
    render(<FeedbackForm onClose={onClose} />);
    await preencherEEnviar();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(estado.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Feedback enviado" }));
  });

  it("avisa o erro e mantém o pop-up aberto se os dois falharem", async () => {
    estado.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    estado.invoke.mockResolvedValue({ data: null, error: new Error("boom") });
    const onClose = vi.fn();
    render(<FeedbackForm onClose={onClose} />);
    await preencherEEnviar();

    await waitFor(() =>
      expect(estado.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Não foi possível enviar o feedback", variant: "destructive" }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sem webhook configurado, o e-mail sozinho basta", async () => {
    vi.stubEnv("VITE_FEEDBACK_WEBHOOK_URL", "");
    const onClose = vi.fn();
    render(<FeedbackForm onClose={onClose} />);
    await preencherEEnviar();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(estado.fetch).not.toHaveBeenCalled();
    expect(estado.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Feedback enviado" }));
  });

  it("sem webhook e com o e-mail falhando, avisa o erro em vez de fingir que enviou", async () => {
    vi.stubEnv("VITE_FEEDBACK_WEBHOOK_URL", "");
    estado.invoke.mockResolvedValue({ data: null, error: new Error("Feedback recipients not configured") });
    const onClose = vi.fn();
    render(<FeedbackForm onClose={onClose} />);
    await preencherEEnviar();

    await waitFor(() =>
      expect(estado.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Não foi possível enviar o feedback", variant: "destructive" }),
      ),
    );
    expect(estado.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Feedback enviado" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
