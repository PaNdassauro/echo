import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { InviteMemberDialog } from "./InviteMemberDialog";
import type { ResultadoConvites } from "./inviteResult";
import type { TeamPhoneNumber } from "./types";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const LINHA = "00000000-0000-4000-8000-000000000001";
const URL_CONVITE = "https://echo.exemplo.com/auth?invite=token-1";

const linhas: TeamPhoneNumber[] = [
  {
    id: LINHA,
    display_name: "Vendas",
    phone_number: "5511999990001",
    theme_hue: 200,
    connection_type: "qr",
    is_active: true,
    sector_isolation_enabled: false,
    sector_follows_owner: false,
  },
];

const writeText = vi.fn();
const onSendInvitations = vi.fn<(...args: unknown[]) => Promise<ResultadoConvites | null>>();
const onOpenChange = vi.fn();

const criado = (email: "enviado" | "nao_configurado" | "falhou"): ResultadoConvites => ({
  vinculados: 0,
  criados: [{ phoneNumberId: LINHA, phoneNumberName: "Vendas", url: URL_CONVITE, email }],
});

const abrir = (phoneNumbers: TeamPhoneNumber[] = linhas) =>
  render(
    <MemoryRouter>
      <InviteMemberDialog
        open
        onOpenChange={onOpenChange}
        phoneNumbers={phoneNumbers}
        onSendInvitations={onSendInvitations}
      />
    </MemoryRouter>,
  );

const convidar = async () => {
  fireEvent.change(screen.getByLabelText("E-mail do membro"), { target: { value: "agente@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: /Enviar convite/ }));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InviteMemberDialog: link do convite", () => {
  it("sem e-mail na instalação mostra o link por número, só leitura, e explica", async () => {
    onSendInvitations.mockResolvedValue(criado("nao_configurado"));
    abrir();
    await convidar();

    expect(await screen.findByText(/Esta instalação não envia e-mail/)).toBeTruthy();
    const campo = screen.getByLabelText("Vendas") as HTMLInputElement;
    expect(campo.value).toBe(URL_CONVITE);
    expect(campo.readOnly).toBe(true);
    expect(onSendInvitations).toHaveBeenCalledWith({ email: "agente@example.com", phoneNumberIds: [LINHA] });
    expect(screen.queryByLabelText("E-mail do membro")).toBeNull();
  });

  it("'Copiar' grava o link na área de transferência no clique e confirma", async () => {
    onSendInvitations.mockResolvedValue(criado("nao_configurado"));
    abrir();
    await convidar();

    fireEvent.click(await screen.findByRole("button", { name: "Copiar link de Vendas" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_CONVITE));
    expect(await screen.findByText("Copiado")).toBeTruthy();
  });

  it("navegador que recusa a cópia deixa o link selecionado e avisa", async () => {
    writeText.mockRejectedValue(new DOMException("sem permissão", "NotAllowedError"));
    onSendInvitations.mockResolvedValue(criado("nao_configurado"));
    abrir();
    await convidar();

    fireEvent.click(await screen.findByRole("button", { name: "Copiar link de Vendas" }));

    expect(await screen.findByText(/use Ctrl\+C/)).toBeTruthy();
  });

  it("e-mail enviado diz para quem foi", async () => {
    onSendInvitations.mockResolvedValue(criado("enviado"));
    abrir();
    await convidar();

    expect(await screen.findByText(/Enviamos o convite para agente@example.com/)).toBeTruthy();
  });

  it("falha no envio do e-mail manda copiar o link", async () => {
    onSendInvitations.mockResolvedValue(criado("falhou"));
    abrir();
    await convidar();

    expect(await screen.findByText(/Não foi possível enviar o e-mail\. Copie o link/)).toBeTruthy();
  });

  it("'Concluir' fecha o diálogo", async () => {
    onSendInvitations.mockResolvedValue(criado("nao_configurado"));
    abrir();
    await convidar();

    fireEvent.click(await screen.findByRole("button", { name: "Concluir" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("pessoa que já tinha conta é vinculada na hora: fecha sem mostrar link", async () => {
    onSendInvitations.mockResolvedValue({ vinculados: 1, criados: [] });
    abrir();
    await convidar();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("button", { name: "Concluir" })).toBeNull();
  });

  it("falha na criação mantém o formulário (o toast de erro é de quem chamou)", async () => {
    onSendInvitations.mockResolvedValue(null);
    abrir();
    await convidar();

    await waitFor(() => expect(onSendInvitations).toHaveBeenCalled());
    expect(screen.getByLabelText("E-mail do membro")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("InviteMemberDialog: instalação sem número", () => {
  it("explica que falta conectar um número, leva a Configurações > Números e não oferece o envio", () => {
    abrir([]);

    const aviso = screen.getByText(/Conecte o primeiro número em Configurações > Números/).textContent ?? "";
    expect(aviso).toContain("na aba QR Code (botão Gerar QR)");
    expect(aviso).not.toContain("Adicionar número");
    const link = screen.getByRole("link", { name: "Ir para Números" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/settings?tab=appearance");
    expect(screen.queryByRole("button", { name: /Enviar convite/ })).toBeNull();
    expect(screen.queryByLabelText("E-mail do membro")).toBeNull();
  });

  it("clicar no link fecha o diálogo", () => {
    abrir([]);
    fireEvent.click(screen.getByRole("link", { name: "Ir para Números" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
