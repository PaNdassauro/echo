import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } },
}));

vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ currentOrganization: { id: "org1" } }),
}));

import { FunctionsHttpError } from "@supabase/supabase-js";
import { AudioTranscricao } from "./AudioTranscricao";
import { limparMemoriaTranscricao } from "@/lib/transcricaoAudio";

const ID = "3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b";

afterEach(cleanup);
beforeEach(() => {
  invoke.mockReset();
  limparMemoriaTranscricao();
});

describe("AudioTranscricao", () => {
  it("mostra a transcrição gravada sem botão", () => {
    render(<AudioTranscricao messageId={ID} metadata={{ leitura: { tipo: "audio", texto: "Chego às 10h" } }} isOutbound={false} />);
    expect(screen.getByText("Chego às 10h")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Transcrever/ })).toBeNull();
  });

  it("transcreve no clique e mostra o texto devolvido", async () => {
    invoke.mockResolvedValue({ data: { status: "ok", texto: "Pode reservar a sala" }, error: null });
    render(<AudioTranscricao messageId={ID} metadata={null} isOutbound={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Transcrever/ }));
    expect(screen.getByRole("button", { name: /Transcrevendo/ })).toBeTruthy();
    expect(await screen.findByText("Pode reservar a sala")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("transcrever-audio", { body: { messageId: ID } });
  });

  it("clique duplo chama a edge uma vez só", async () => {
    let resolver: (v: unknown) => void = () => {};
    invoke.mockReturnValue(new Promise((r) => (resolver = r)));
    render(<AudioTranscricao messageId={ID} metadata={null} isOutbound />);
    const botao = screen.getByRole("button", { name: /Transcrever/ });
    fireEvent.click(botao);
    fireEvent.click(botao);
    expect(invoke).toHaveBeenCalledTimes(1);
    resolver({ data: { status: "ok", texto: "ok" }, error: null });
    expect(await screen.findByText("ok")).toBeTruthy();
  });

  it("falha passageira oferece tentar de novo", async () => {
    invoke.mockResolvedValue({ data: { status: "falhou", erro: "timeout", definitivo: false }, error: null });
    render(<AudioTranscricao messageId={ID} metadata={null} isOutbound={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Transcrever/ }));
    expect(await screen.findByText(/Tente de novo em alguns minutos/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Tentar de novo/ })).toBeTruthy();
  });

  it("falha definitiva só explica, sem botão", async () => {
    invoke.mockResolvedValue({ data: { status: "falhou", erro: "grande_demais", definitivo: true }, error: null });
    render(<AudioTranscricao messageId={ID} metadata={null} isOutbound={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Transcrever/ }));
    expect(await screen.findByText(/longo demais/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("org sem chave OpenAI: avisa e esconde o botão das outras bolhas", async () => {
    invoke.mockResolvedValue({ data: { status: "indisponivel", motivo: "chave_anthropic" }, error: null });
    render(<AudioTranscricao messageId={ID} metadata={null} isOutbound={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Transcrever/ }));
    expect(await screen.findByText(/chave OpenAI/)).toBeTruthy();
    cleanup();
    render(<AudioTranscricao messageId={ID} metadata={null} isOutbound={false} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("erro HTTP da edge não mostra o código cru", async () => {
    const resposta = new Response(JSON.stringify({ error: "erro_interno" }), { status: 500 });
    invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(resposta) });
    render(<AudioTranscricao messageId={ID} metadata={null} isOutbound={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Transcrever/ }));
    expect(await screen.findByText(/Verifique a conexão/)).toBeTruthy();
    expect(screen.queryByText("erro_interno")).toBeNull();
  });

  it("texto no teto avisa que foi cortado", () => {
    render(<AudioTranscricao messageId={ID} metadata={{ leitura: { tipo: "audio", texto: "a".repeat(6000) } }} isOutbound={false} />);
    expect(screen.getByText(/Transcrição cortada/)).toBeTruthy();
  });

  it("áudio que o leitor desistiu não mostra botão", () => {
    render(<AudioTranscricao messageId={ID} metadata={{ leitura: { tipo: "audio", texto: null, lacuna: true } }} isOutbound={false} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("bolha otimista (id temporário) não mostra nada", () => {
    const { container } = render(<AudioTranscricao messageId="temp-1" metadata={null} isOutbound />);
    expect(container.firstChild).toBeNull();
  });

  function simularAltura(scroll: number, client: number) {
    const sh = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(scroll);
    const ch = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(client);
    return () => {
      sh.mockRestore();
      ch.mockRestore();
    };
  }

  it("texto que passa das 4 linhas abre recolhido com Ver mais, e Ver menos volta", () => {
    const restaurar = simularAltura(200, 96);
    try {
      render(<AudioTranscricao messageId={ID} metadata={{ leitura: { tipo: "audio", texto: "a".repeat(300) } }} isOutbound={false} />);
      const paragrafo = screen.getByText("a".repeat(300));
      expect(paragrafo.className).toContain("line-clamp-4");
      fireEvent.click(screen.getByRole("button", { name: "Ver mais" }));
      expect(paragrafo.className).not.toContain("line-clamp-4");
      fireEvent.click(screen.getByRole("button", { name: "Ver menos" }));
      expect(paragrafo.className).toContain("line-clamp-4");
      expect(screen.getByRole("button", { name: "Ver mais" })).toBeTruthy();
    } finally {
      restaurar();
    }
  });

  it("texto longo que cabe nas 4 linhas (bolha larga) não mostra Ver mais", () => {
    const restaurar = simularAltura(72, 72);
    try {
      render(<AudioTranscricao messageId={ID} metadata={{ leitura: { tipo: "audio", texto: "a".repeat(240) } }} isOutbound={false} />);
      expect(screen.queryByRole("button", { name: "Ver mais" })).toBeNull();
    } finally {
      restaurar();
    }
  });
});
