import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatHeader from "./ChatHeader";

afterEach(cleanup);

const user = userEvent.setup({ pointerEventsCheck: 0 });

// Em grupo o contact_phone é o JID, que é o destino do envio. Trocá-lo pelo
// "Editar número" mandou as mensagens de um grupo para o privado de um
// fornecedor. O cabeçalho não oferece mais a edição em grupo.

const grupo = {
    id: "conv-g",
    contact_name: "Grupo Acme",
    contact_phone: "120363000000000004@g.us",
    is_group: true,
    group_jid: "120363000000000004@g.us",
};

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

describe("ChatHeader — editar número em grupo", () => {
    it("desktop, grupo: mostra o JID sem o lápis de editar número", () => {
        render(<ChatHeader {...base} isMobile={false} conversation={grupo} />);

        expect(screen.getByText("120363000000000004@g.us")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Editar número" })).toBeNull();
    });

    it("desktop, 1:1: o lápis de editar número continua", () => {
        render(<ChatHeader {...base} isMobile={false} conversation={contato} />);

        expect(screen.getByRole("button", { name: "Editar número" })).toBeTruthy();
    });

    it('mobile, grupo: o menu não tem "Editar número"', async () => {
        render(<ChatHeader {...base} isMobile conversation={grupo} />);

        await user.click(screen.getByRole("button", { name: "Mais opções" }));
        expect(await screen.findByRole("menuitem", { name: /Editar apelido/ })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: /Editar número/ })).toBeNull();
    });

    it('mobile, 1:1: o menu mantém "Editar número"', async () => {
        render(<ChatHeader {...base} isMobile conversation={contato} />);

        await user.click(screen.getByRole("button", { name: "Mais opções" }));
        expect(await screen.findByRole("menuitem", { name: /Editar número/ })).toBeTruthy();
    });
});
