import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaixaConjuntaDialog } from "./CaixaConjuntaDialog";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const h = vi.hoisted(() => ({
  instagram: [] as Array<{ linha_id: string; ligada: boolean; display_name: string }>,
}));
vi.mock("@/hooks/useInstagramConexoes", () => ({
  useInstagramConexoes: () => ({ data: h.instagram }),
}));

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OLD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const numeros = [
  { id: A, displayName: "Vendas API", themeHue: 200, connectionType: "business_api" },
  { id: B, displayName: "Suporte", themeHue: 176, connectionType: "qr" },
  { id: C, displayName: "Comercial", themeHue: null, connectionType: "qr" },
];

const montar = (fora: string[] = []) => {
  const onSalvar = vi.fn();
  const onOpenChange = vi.fn();
  render(<CaixaConjuntaDialog open onOpenChange={onOpenChange} numeros={numeros} fora={fora} onSalvar={onSalvar} />);
  return { onSalvar, onOpenChange };
};

const linha = (nome: string) => screen.getByRole("checkbox", { name: new RegExp(nome) });

beforeEach(() => {
  h.instagram = [];
});
afterEach(cleanup);

describe("CaixaConjuntaDialog", () => {
  it("lista os números com o tipo de canal; por padrão entram todos", () => {
    montar();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(linha("Vendas API").getAttribute("aria-checked")).toBe("true");
    expect(linha("Vendas API").textContent).toContain("Business API");
    expect(linha("Suporte").textContent).toContain("QR Code");
  });

  it("começa desmarcando o que já estava fora", () => {
    montar([B]);
    expect(linha("Suporte").getAttribute("aria-checked")).toBe("false");
    expect(linha("Comercial").getAttribute("aria-checked")).toBe("true");
  });

  it("marca o número que divide a caixa com o Instagram", () => {
    h.instagram = [{ linha_id: B, ligada: true, display_name: "@acme" }];
    montar();
    expect(linha("Suporte").textContent).toContain("+");
    expect(linha("Suporte").querySelector('[aria-label="Instagram"]')).toBeTruthy();
    expect(linha("Vendas API").querySelector('[aria-label="Instagram"]')).toBeNull();
  });

  it("a linha inteira alterna ao clicar", () => {
    montar();
    fireEvent.click(linha("Suporte"));
    expect(linha("Suporte").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(linha("Suporte"));
    expect(linha("Suporte").getAttribute("aria-checked")).toBe("true");
  });

  it("Espaço e Enter alternam pelo teclado", () => {
    montar();
    fireEvent.keyDown(linha("Comercial"), { key: " " });
    expect(linha("Comercial").getAttribute("aria-checked")).toBe("false");
    fireEvent.keyDown(linha("Comercial"), { key: "Enter" });
    expect(linha("Comercial").getAttribute("aria-checked")).toBe("true");
  });

  it("pede pelo menos 2 números e desliga o Salvar", () => {
    montar();
    fireEvent.click(linha("Suporte"));
    expect(screen.queryByText("Escolha pelo menos 2 números")).toBeNull();
    fireEvent.click(linha("Comercial"));
    expect(screen.getByText("Escolha pelo menos 2 números")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("salva as exclusões (os desmarcados) e fecha", () => {
    const { onSalvar, onOpenChange } = montar();
    fireEvent.click(linha("Suporte"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(onSalvar).toHaveBeenCalledWith([B]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("guarda a exclusão antiga de um número que o usuário já não acessa", () => {
    const { onSalvar } = montar([OLD, B]);
    fireEvent.click(linha("Suporte")); // volta a entrar
    fireEvent.click(linha("Comercial")); // sai
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(onSalvar).toHaveBeenCalledWith([OLD, C]);
  });

  it("com o mapa vazio mostra 'Carregando números…' sem o alerta de mínimo", () => {
    render(<CaixaConjuntaDialog open onOpenChange={vi.fn()} numeros={[]} fora={[]} onSalvar={vi.fn()} />);
    expect(screen.getByText("Carregando números…")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("abre antes de o mapa de números chegar e marca tudo quando ele chega", () => {
    const onSalvar = vi.fn();
    const props = { open: true, onOpenChange: vi.fn(), fora: [] as string[], onSalvar };
    const { rerender } = render(<CaixaConjuntaDialog {...props} numeros={[]} />);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    rerender(<CaixaConjuntaDialog {...props} numeros={numeros} />);
    expect(linha("Vendas API").getAttribute("aria-checked")).toBe("true");
    expect(linha("Suporte").getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("mudar a lista no meio da edição não apaga o rascunho", () => {
    const props = { open: true, onOpenChange: vi.fn(), fora: [] as string[], onSalvar: vi.fn() };
    const { rerender } = render(<CaixaConjuntaDialog {...props} numeros={numeros} />);
    fireEvent.click(linha("Suporte"));
    rerender(<CaixaConjuntaDialog {...props} numeros={numeros.slice(0, 2)} />);
    expect(linha("Suporte").getAttribute("aria-checked")).toBe("false");
  });

  it("número que some no meio da edição não conta no mínimo de 2", () => {
    const props = { open: true, onOpenChange: vi.fn(), fora: [] as string[], onSalvar: vi.fn() };
    const { rerender } = render(<CaixaConjuntaDialog {...props} numeros={numeros} />);
    fireEvent.click(linha("Suporte")); // sai; sobram A e C marcados
    rerender(<CaixaConjuntaDialog {...props} numeros={numeros.slice(0, 2)} />); // C deixa de ser acessível
    expect(screen.getByText("Escolha pelo menos 2 números")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("número liberado no meio da edição entra marcado e não é gravado como exclusão", () => {
    const onSalvar = vi.fn();
    const props = { open: true, onOpenChange: vi.fn(), fora: [] as string[], onSalvar };
    const { rerender } = render(<CaixaConjuntaDialog {...props} numeros={numeros.slice(0, 2)} />);
    fireEvent.click(linha("Suporte")); // sai
    rerender(<CaixaConjuntaDialog {...props} numeros={numeros} />); // Comercial é liberada agora
    expect(linha("Comercial").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(onSalvar).toHaveBeenCalledWith([B]);
  });

  it("Cancelar não salva", () => {
    const { onSalvar, onOpenChange } = montar();
    fireEvent.click(linha("Suporte"));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onSalvar).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
