// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const LINE_GRUPO = "phone-vendas";
const LINE_FINANCEIRO = "phone-financeiro";
const LINE_COBRANCA = "phone-cobranca";
const LINE_API = "phone-cloud-api";

const { state } = vi.hoisted(() => ({
    state: {
        lines: [] as Array<{
            id: string;
            displayName: string;
            themeHue: number;
            phoneNumber: string;
            connectionType: string;
        }>,
        isLoading: false,
    },
}));

vi.mock("@/contexts/OrganizationContext", () => ({
    useOrganization: () => ({ currentOrganization: { id: "org-1" } }),
}));

// Em prod as linhas vêm da RLS; aqui são fixas para o teste ser determinístico.
vi.mock("@/hooks/useAccessiblePhoneNumbers", () => ({
    useAccessiblePhoneNumbers: () => ({
        phoneNumbers: state.lines,
        isLoading: state.isLoading,
    }),
}));

class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
        ResizeObserverStub as unknown as typeof ResizeObserver;
}

const OwnLinesSelectList = (await import("./OwnLinesSelectList")).default;

afterEach(cleanup);
beforeEach(() => {
    state.isLoading = false;
    state.lines = [
        {
            id: LINE_GRUPO,
            displayName: "Vendas Geral",
            themeHue: 176,
            phoneNumber: "5511999990001",
            connectionType: "qr",
        },
        {
            id: LINE_FINANCEIRO,
            displayName: "Financeiro",
            themeHue: 20,
            phoneNumber: "5521988887777",
            connectionType: "qr",
        },
        {
            id: LINE_COBRANCA,
            displayName: "Cobrança",
            themeHue: 300,
            phoneNumber: "5521977776666",
            connectionType: "qr",
        },
        // Cloud API da Meta: não tem grupo, não pode ser oferecida.
        {
            id: LINE_API,
            displayName: "Marketing API",
            themeHue: 90,
            phoneNumber: "5521966665555",
            connectionType: "business_api",
        },
    ];
});

const user = userEvent.setup({ pointerEventsCheck: 0 });

describe("OwnLinesSelectList", () => {
    it("esconde a linha dona do grupo — ela já está lá por definição", () => {
        render(
            <OwnLinesSelectList
                phoneNumberId={LINE_GRUPO}
                enabled
                onConfirm={vi.fn()}
            />
        );

        expect(screen.queryByText("Vendas Geral")).not.toBeInTheDocument();
        expect(screen.getByText("Financeiro")).toBeInTheDocument();
        expect(screen.getByText("Cobrança")).toBeInTheDocument();
    });

    it("marca como 'no grupo' e desabilita a linha que já é participante", () => {
        render(
            <OwnLinesSelectList
                phoneNumberId={LINE_GRUPO}
                enabled
                excludedPhones={["5521988887777"]}
                onConfirm={vi.fn()}
            />
        );

        expect(screen.getByText("no grupo")).toBeInTheDocument();
        expect(screen.getByText("Financeiro").closest("button")).toBeDisabled();
        expect(screen.getByText("Cobrança").closest("button")).not.toBeDisabled();
    });

    it("reconhece o participante mesmo sem o 9º dígito", () => {
        // O grupo devolve "552188887777"; a linha está salva com o 9.
        render(
            <OwnLinesSelectList
                phoneNumberId={LINE_GRUPO}
                enabled
                excludedPhones={["552188887777"]}
                onConfirm={vi.fn()}
            />
        );

        expect(screen.getByText("Financeiro").closest("button")).toBeDisabled();
    });

    it("entrega todas as linhas selecionadas de uma vez", async () => {
        const onConfirm = vi.fn();
        render(
            <OwnLinesSelectList
                phoneNumberId={LINE_GRUPO}
                enabled
                actionLabel="Adicionar ao grupo"
                onConfirm={onConfirm}
            />
        );

        await user.click(screen.getByText("Financeiro"));
        await user.click(screen.getByText("Cobrança"));
        await user.click(screen.getByRole("button", { name: /Adicionar ao grupo \(2\)/ }));

        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onConfirm.mock.calls[0][0].map((l: { id: string }) => l.id)).toEqual([
            LINE_FINANCEIRO,
            LINE_COBRANCA,
        ]);
    });

    it("alterna a seleção no segundo clique", async () => {
        const onConfirm = vi.fn();
        render(
            <OwnLinesSelectList phoneNumberId={LINE_GRUPO} enabled onConfirm={onConfirm} />
        );

        const row = screen.getByText("Financeiro").closest("button")!;
        await user.click(row);
        expect(row).toHaveAttribute("aria-pressed", "true");

        await user.click(row);
        expect(row).toHaveAttribute("aria-pressed", "false");
        expect(screen.getByRole("button", { name: /^Adicionar$/ })).toBeDisabled();
    });

    it("o botão fica travado enquanto nada está selecionado", () => {
        render(
            <OwnLinesSelectList phoneNumberId={LINE_GRUPO} enabled onConfirm={vi.fn()} />
        );

        expect(screen.getByRole("button", { name: /Adicionar/ })).toBeDisabled();
    });

    it("avisa quando todas as linhas já estão no grupo", () => {
        render(
            <OwnLinesSelectList
                phoneNumberId={LINE_GRUPO}
                enabled
                excludedPhones={["5521988887777", "5521977776666"]}
                onConfirm={vi.fn()}
            />
        );

        expect(screen.getByText(/já estão neste grupo/i)).toBeInTheDocument();
    });

    it("esconde número da Cloud API — Meta não tem grupos", () => {
        render(
            <OwnLinesSelectList phoneNumberId={LINE_GRUPO} enabled onConfirm={vi.fn()} />
        );

        expect(screen.queryByText("Marketing API")).not.toBeInTheDocument();
        expect(screen.getByText("Financeiro")).toBeInTheDocument();
    });

    it("avisa quando só sobra a Cloud API além da linha do grupo", () => {
        state.lines = state.lines.filter(
            (l) => l.id === LINE_GRUPO || l.id === LINE_API
        );

        render(
            <OwnLinesSelectList phoneNumberId={LINE_GRUPO} enabled onConfirm={vi.fn()} />
        );

        expect(screen.getByText(/Nenhum outro número conectado/i)).toBeInTheDocument();
    });

    it("avisa quando a organização só tem uma linha", () => {
        state.lines = state.lines.filter((l) => l.id === LINE_GRUPO);

        render(
            <OwnLinesSelectList phoneNumberId={LINE_GRUPO} enabled onConfirm={vi.fn()} />
        );

        expect(screen.getByText(/Nenhum outro número conectado/i)).toBeInTheDocument();
    });

    it("mostra o progresso e trava a lista enquanto a adição está em voo", () => {
        render(
            <OwnLinesSelectList
                phoneNumberId={LINE_GRUPO}
                enabled
                onConfirm={vi.fn()}
                busy
                busyLabel="Adicionando 2 de 3..."
            />
        );

        expect(screen.getByText("Adicionando 2 de 3...")).toBeInTheDocument();
        expect(screen.getByText("Financeiro").closest("button")).toBeDisabled();
    });
});
