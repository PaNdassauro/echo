import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const saveTemplate = vi.fn();
const toast = vi.fn();

vi.mock("@/lib/templatesApi", () => ({
  saveTemplate: (opts: unknown) => saveTemplate(opts),
  templateErrorMessage: (_e: unknown, fallback: string) => fallback,
  CATEGORY_REJECTIONS: new Set<string>(),
}));
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ currentOrganization: { id: "org-1" } }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

import TemplateBuilderDialog from "./TemplateBuilderDialog";

afterEach(() => {
  cleanup();
  saveTemplate.mockReset();
  toast.mockReset();
});

describe("TemplateBuilderDialog", () => {
  it("mostra os erros no campo e não envia rascunho inválido", () => {
    render(<TemplateBuilderDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Enviar para aprovação/ }));
    expect(screen.getByText("Dê um nome ao template.")).toBeTruthy();
    expect(screen.getByText("Escreva a mensagem.")).toBeTruthy();
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it("gera o nome técnico, insere variável e envia com o exemplo", async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    saveTemplate.mockResolvedValue({ id: "1", name: "confirmacao_de_reserva", language: "pt_BR", status: "PENDING" });
    render(<TemplateBuilderDialog open onOpenChange={onOpenChange} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Confirmação de reserva" } });
    expect(screen.getByText("confirmacao_de_reserva")).toBeTruthy();

    const body = screen.getByLabelText("Texto") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "Olá , sua reserva está confirmada." } });
    body.setSelectionRange(4, 4);
    fireEvent.click(screen.getByRole("button", { name: /Variável/ }));
    expect(body.value).toBe("Olá {{1}}, sua reserva está confirmada.");

    fireEvent.change(screen.getByLabelText("Exemplo da variável 1"), { target: { value: "Maria" } });
    fireEvent.click(screen.getByRole("button", { name: /Enviar para aprovação/ }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const sent = saveTemplate.mock.calls[0][0] as { draft: { name: string; body: string; examples: Record<string, string> } };
    expect(sent.draft.name).toBe("confirmacao_de_reserva");
    expect(sent.draft.examples).toEqual({ "1": "Maria" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("template aprovado: mudar a quantidade de variáveis bloqueia o envio", () => {
    const editing = {
      id: "9",
      name: "aviso",
      language: "pt_BR",
      status: "APPROVED",
      category: "UTILITY",
      components: [{ type: "BODY", text: "Olá {{1}}, tudo certo com a reserva?", example: { body_text: [["Ana"]] } }],
    };
    render(<TemplateBuilderDialog open onOpenChange={vi.fn()} editing={editing} />);
    expect(screen.queryByText(/quebra envios/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Texto"), { target: { value: "Olá, tudo certo com a reserva?" } });
    expect(screen.getByText(/quebra envios/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Enviar para aprovação/ }));
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it("nova versão em outro idioma trava o nome e oferece só idioma livre", () => {
    const copyFrom = {
      id: "9",
      name: "aviso",
      language: "pt_BR",
      status: "APPROVED",
      category: "UTILITY",
      components: [{ type: "BODY", text: "Olá {{1}}, tudo certo?", example: { body_text: [["Ana"]] } }],
    };
    render(<TemplateBuilderDialog open onOpenChange={vi.fn()} copyFrom={copyFrom} usedLanguages={["pt_BR"]} />);
    const name = screen.getByLabelText("Nome") as HTMLInputElement;
    expect(name.readOnly).toBe(true);
    expect(name.value).toBe("aviso");
    expect(screen.getByText("Inglês (EUA)")).toBeTruthy();
  });

  it("cancelar a edição descarta o rascunho", () => {
    const editing = {
      id: "9",
      name: "aviso",
      language: "pt_BR",
      status: "REJECTED",
      category: "UTILITY",
      components: [{ type: "BODY", text: "Olá {{1}}, tudo certo com a reserva?", example: { body_text: [["Ana"]] } }],
    };
    const { rerender } = render(<TemplateBuilderDialog open onOpenChange={vi.fn()} editing={editing} />);
    fireEvent.change(screen.getByLabelText("Texto"), { target: { value: "Mudei {{1}} aqui e não salvei." } });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    rerender(<TemplateBuilderDialog open={false} onOpenChange={vi.fn()} editing={editing} />);
    rerender(<TemplateBuilderDialog open onOpenChange={vi.fn()} editing={editing} />);
    expect((screen.getByLabelText("Texto") as HTMLTextAreaElement).value).toBe("Olá {{1}}, tudo certo com a reserva?");
  });

  it("negrito numa palavra colada separa com espaço", () => {
    render(<TemplateBuilderDialog open onOpenChange={vi.fn()} />);
    const body = screen.getByLabelText("Texto") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "teste2000" } });
    body.setSelectionRange(9, 9);
    fireEvent.click(screen.getByRole("button", { name: "Negrito" }));
    expect(body.value).toBe("teste2000 **");
  });
});
