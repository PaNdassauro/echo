import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CopilotoFaixa, type CopilotoEstadoVisivel } from "./CopilotoFaixa";

afterEach(cleanup);

const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

const pronto: CopilotoEstadoVisivel = {
  fase: "pronto",
  momento: "Cliente quer o orçamento em maio",
  sugestoes: [
    { texto: "Maio funciona bem para nós!", intencao: "responder", porque: "valida o desejo" },
    { texto: "Quantas pessoas vão?", intencao: "avancar", porque: "falta o número de participantes" },
  ],
};

const props = (estado: CopilotoEstadoVisivel, extra: Partial<Parameters<typeof CopilotoFaixa>[0]> = {}) => ({
  estado,
  recolhida: false,
  onAlternarRecolhida: vi.fn(),
  onAtualizar: vi.fn(),
  onInserir: vi.fn(() => true),
  ...extra,
});

describe("CopilotoFaixa", () => {
  it("lendo: mostra o shimmer e trava o atualizar", () => {
    render(<CopilotoFaixa {...props({ fase: "lendo" })} />);
    expect(screen.getByText("Lendo a conversa…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sugerir agora" })).toHaveProperty("disabled", true);
  });

  it("pronto: o momento e um botão por sugestão, com o porquê na descrição", () => {
    render(<CopilotoFaixa {...props(pronto)} />);
    expect(screen.getByText("Cliente quer o orçamento em maio")).toBeTruthy();
    const chip = screen.getByRole("button", { name: "Maio funciona bem para nós!" });
    expect(chip.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Responder. valida o desejo")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("clicar insere o texto (não envia)", () => {
    const p = props(pronto);
    render(<CopilotoFaixa {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Quantas pessoas vão?" }));
    expect(p.onInserir).toHaveBeenCalledWith("Quantas pessoas vão?");
  });

  it("recolhida: esconde as sugestões e conta quantas há", () => {
    render(<CopilotoFaixa {...props(pronto, { recolhida: true })} />);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText("Cliente quer o orçamento em maio · 2 sugestões")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mostrar sugestões" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("erro: mensagem e 'tentar de novo'", () => {
    const p = props({ fase: "erro", mensagem: "Sem conexão." });
    render(<CopilotoFaixa {...p} />);
    expect(screen.getByText("Sem conexão.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(p.onAtualizar).toHaveBeenCalledTimes(1);
  });

  it("ocioso: aguardando o cliente, com 'sugerir agora'", () => {
    render(<CopilotoFaixa {...props({ fase: "ocioso" })} />);
    expect(screen.getByText("Aguardando o cliente")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sugerir agora" })).toHaveProperty("disabled", false);
  });
});
