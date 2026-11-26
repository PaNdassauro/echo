import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ChatHeader from "./ChatHeader";

afterEach(cleanup);

// Caixa conjunta: o cabeçalho mostra de qual número a conversa é.

const contato = {
    id: "conv-1",
    contact_name: "Ana Souza",
    contact_phone: "5511999990000",
    is_group: false,
};

const base = {
    isQrConnection: true,
    isUpdating: false,
    isEditingName: false,
    editNameValue: "",
    setEditNameValue: vi.fn(),
    editNameInputRef: createRef<HTMLInputElement>(),
    isSavingName: false,
    startEditName: vi.fn(),
    saveContactName: vi.fn(),
    cancelEditName: vi.fn(),
    isEditingPhone: false,
    editPhoneValue: "",
    setEditPhoneValue: vi.fn(),
    editPhoneInputRef: createRef<HTMLInputElement>(),
    isSavingPhone: false,
    startEditPhone: vi.fn(),
    saveContactPhone: vi.fn(),
    cancelEditPhone: vi.fn(),
    searchOpen: false,
    onOpenSearch: vi.fn(),
    onCloseSearch: vi.fn(),
    onTransfer: vi.fn(),
    onClose: vi.fn(),
    onGroupInfo: vi.fn(),
    userIsPrimary: true,
    userIsCoOwner: false,
    coOwners: [],
    onShare: vi.fn(),
    onLeaveShared: vi.fn(),
    windowExpiration: null,
    formatExpirationTime: () => "",
};

describe("ChatHeader: selo do número", () => {
    it.each([false, true])("mostra o selo do número, tanto na caixa conjunta quanto no modo número (mobile=%s)", (isMobile) => {
        render(<ChatHeader {...base} isMobile={isMobile} conversation={contato} numeroNome="Vendas API" numeroHue={200} />);
        expect(screen.getByRole("img", { name: "Número: Vendas API" })).toBeTruthy();
    });

    it.each([false, true])("sem o nome do número (ainda não resolveu) não mostra selo (mobile=%s)", (isMobile) => {
        render(<ChatHeader {...base} isMobile={isMobile} conversation={contato} />);
        expect(screen.queryByRole("img", { name: /^Número:/ })).toBeNull();
    });

    it("no desktop o selo tem teto de largura e os pais podem encolher (o nome do número trunca, não passa por baixo dos botões)", () => {
        render(<ChatHeader {...base} isMobile={false} conversation={contato} numeroNome="Vendas API com nome bem longo" numeroHue={200} />);
        const selo = screen.getByRole("img", { name: /^Número:/ });
        const teto = selo.parentElement as HTMLElement;
        expect(teto.className).toContain("max-w-[200px]");
        expect(teto.className).toContain("min-w-0");
        // Linha do nome e o bloco que a envolve: sem min-w-0 o conteúdo mínimo vira o nome inteiro.
        const linha = teto.parentElement as HTMLElement;
        expect(linha.className).toContain("min-w-0");
        expect((linha.parentElement as HTMLElement).className).toContain("min-w-0");
    });
});
