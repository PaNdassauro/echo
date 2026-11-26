import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatHeader from "./ChatHeader";

afterEach(cleanup);

const user = userEvent.setup({ pointerEventsCheck: 0 });

const contato = {
    id: "conv-1",
    contact_name: "Ana Souza",
    contact_phone: "+55 11 99999-0000",
    is_group: false,
};

/** Props obrigatórias que não têm nada a ver com o avatar. */
const base = {
    isMobile: false,
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

describe("ChatHeader — foto de perfil abre o painel", () => {
    it("desktop 1:1: clicar na foto chama onOpenProfile", async () => {
        const onOpenProfile = vi.fn();
        render(
            <ChatHeader
                {...base}
                conversation={contato}
                onOpenProfile={onOpenProfile}
                onRefetchHistory={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("button", { name: /Ver perfil de Ana Souza/ }));
        expect(onOpenProfile).toHaveBeenCalledTimes(1);
    });

    it('desktop 1:1: a foto não abre mais o menu de "Recuperar mensagens"', async () => {
        // A ação migrou para dentro do painel. Se o dropdown voltar, este teste
        // pega — era um menu de um item só ocupando o gatilho do perfil.
        render(
            <ChatHeader
                {...base}
                conversation={contato}
                onOpenProfile={vi.fn()}
                onRefetchHistory={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("button", { name: /Ver perfil de Ana Souza/ }));
        expect(screen.queryByText("Recuperar mensagens")).toBeNull();
    });

    it("mobile 1:1: a foto (que era inerte) passa a abrir o perfil", async () => {
        const onOpenProfile = vi.fn();
        render(
            <ChatHeader
                {...base}
                isMobile
                conversation={contato}
                onOpenProfile={onOpenProfile}
            />,
        );

        await user.click(screen.getByRole("button", { name: /Ver perfil de Ana Souza/ }));
        expect(onOpenProfile).toHaveBeenCalledTimes(1);
    });

    it("grupo: a foto continua abrindo os membros, não o perfil", async () => {
        const onGroupInfo = vi.fn();
        const onOpenProfile = vi.fn();
        render(
            <ChatHeader
                {...base}
                conversation={{ ...contato, contact_name: "Evento 2026", is_group: true }}
                onGroupInfo={onGroupInfo}
                onOpenProfile={onOpenProfile}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Ver membros do grupo" }));
        expect(onGroupInfo).toHaveBeenCalledTimes(1);
        expect(onOpenProfile).not.toHaveBeenCalled();
    });

    it("aria-expanded reflete o painel aberto", () => {
        const { rerender } = render(
            <ChatHeader {...base} conversation={contato} onOpenProfile={vi.fn()} />,
        );
        expect(
            screen
                .getByRole("button", { name: /Ver perfil de Ana Souza/ })
                .getAttribute("aria-expanded"),
        ).toBe("false");

        rerender(
            <ChatHeader {...base} conversation={contato} onOpenProfile={vi.fn()} profileOpen />,
        );
        expect(
            screen
                .getByRole("button", { name: /Ver perfil de Ana Souza/ })
                .getAttribute("aria-expanded"),
        ).toBe("true");
    });

    it("sem onOpenProfile a foto não vira botão (nada quebra em quem não passa a prop)", () => {
        render(<ChatHeader {...base} conversation={contato} />);
        expect(screen.queryByRole("button", { name: /Ver perfil de Ana Souza/ })).toBeNull();
    });
});
