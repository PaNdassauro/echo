import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message } from "@/hooks/chat/useMessages";

interface ConversationRow {
    id: string;
    contact_name: string | null;
    contact_phone: string | null;
    is_group: boolean | null;
}

interface ForwardResultRow {
    conversationId: string;
    contactName: string | null;
    success: boolean;
    sent: number;
    total: number;
    errors: string[];
    error?: string;
}

// Builder falso do PostgREST: o modal encadeia select/eq/order/limit e às vezes
// .or(), depois dá await no próprio builder.
interface FakeQuery extends PromiseLike<{ data: ConversationRow[]; error: null }> {
    select: () => FakeQuery;
    eq: () => FakeQuery;
    order: () => FakeQuery;
    limit: () => FakeQuery;
    or: () => FakeQuery;
}

const { conversations, invokeMock, toastMock } = vi.hoisted(() => ({
    conversations: [
        { id: "conv-1", contact_name: "Ana", contact_phone: "5511999990001", is_group: false },
        { id: "conv-2", contact_name: "Bruno", contact_phone: "5544988887777", is_group: false },
    ],
    invokeMock: vi.fn(),
    toastMock: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => {
    const makeQuery = (): FakeQuery => {
        const query = {
            select: () => query,
            eq: () => query,
            order: () => query,
            limit: () => query,
            or: () => query,
            then: (resolve: (value: { data: ConversationRow[]; error: null }) => unknown) =>
                Promise.resolve({ data: conversations, error: null }).then(resolve),
        } as FakeQuery;
        return query;
    };
    return {
        supabase: {
            from: () => makeQuery(),
            functions: { invoke: invokeMock },
        },
    };
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

// O ScrollArea do Radix observa o viewport; o jsdom não tem ResizeObserver e a
// lista de destinos derrubava o render no primeiro item.
class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
        ResizeObserverStub as unknown as typeof ResizeObserver;
}

const ForwardMessageModal = (await import("./ForwardMessageModal")).default;

afterEach(cleanup);
beforeEach(() => {
    invokeMock.mockReset();
    toastMock.mockReset();
});

const user = userEvent.setup({ pointerEventsCheck: 0 });

const msg = (id: string): Message => ({
    id,
    content: `msg ${id}`,
    direction: "inbound",
    created_at: "2026-08-17T12:00:00.000Z",
    sent_by: null,
});

// Espelha o corpo da whatsapp-forward: com nada enviado, `success:false` vem
// acompanhado do `error` do topo (é o que o helper do front lança).
const resposta = (results: ForwardResultRow[]) => {
    const anySuccess = results.some((r) => r.sent > 0);
    return {
        data: {
            success: anySuccess,
            results,
            ...(anySuccess ? {} : { error: results.find((r) => r.error)?.error }),
        },
        error: null,
    };
};

async function abrir(messages: Message[], onForwarded = vi.fn()) {
    const onOpenChange = vi.fn();
    render(
        <ForwardMessageModal
            open
            onOpenChange={onOpenChange}
            phoneNumberId="phone-1"
            messages={messages}
            onForwarded={onForwarded}
        />,
    );
    // Espera a lista de destinos chegar antes de qualquer clique.
    await screen.findByText("Ana");
    return { onOpenChange, onForwarded };
}

describe("ForwardMessageModal — lote de mensagens", () => {
    it("anuncia a quantidade no título", async () => {
        await abrir([msg("a"), msg("b"), msg("c")]);
        expect(screen.getByText("Encaminhar 3 mensagens")).toBeTruthy();
    });

    it("mantém o título singular para uma bolha só", async () => {
        await abrir([msg("a")]);
        expect(screen.getByText("Encaminhar mensagem")).toBeTruthy();
    });

    it("envia messageIds na ordem do lote e avisa o sucesso", async () => {
        invokeMock.mockResolvedValue(
            resposta([
                { conversationId: "conv-1", contactName: "Ana", success: true, sent: 2, total: 2, errors: [] },
            ]),
        );
        const { onOpenChange, onForwarded } = await abrir([msg("a"), msg("b")]);

        await user.click(screen.getByText("Ana"));
        await user.click(screen.getByRole("button", { name: /^encaminhar$/i }));

        await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
        expect(invokeMock.mock.calls[0][0]).toBe("whatsapp-forward");
        expect(invokeMock.mock.calls[0][1].body).toEqual({
            messageIds: ["a", "b"],
            conversationIds: ["conv-1"],
        });
        await waitFor(() => expect(onForwarded).toHaveBeenCalledTimes(1));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(toastMock.mock.calls[0][0]).toMatchObject({ title: "2 mensagens encaminhadas" });
    });

    it("no parcial detalha quantas faltaram por conversa e ainda encerra a seleção", async () => {
        invokeMock.mockResolvedValue(
            resposta([
                { conversationId: "conv-1", contactName: "Ana", success: true, sent: 3, total: 3, errors: [] },
                {
                    conversationId: "conv-2",
                    contactName: "Bruno",
                    success: false,
                    sent: 1,
                    total: 3,
                    errors: ["Mídia expirada"],
                    error: "Mídia expirada",
                },
            ]),
        );
        const { onForwarded } = await abrir([msg("a"), msg("b"), msg("c")]);

        await user.click(screen.getByText("Ana"));
        await user.click(screen.getByText("Bruno"));
        await user.click(screen.getByRole("button", { name: /^encaminhar$/i }));

        await waitFor(() => expect(toastMock).toHaveBeenCalled());
        const toastArg = toastMock.mock.calls[0][0];
        expect(toastArg.title).toBe("Encaminhada para 1 de 2 conversas");
        expect(toastArg.description).toContain("Bruno: 1 de 3 — Mídia expirada");
        expect(toastArg.variant).toBe("destructive");
        expect(onForwarded).toHaveBeenCalledTimes(1);
    });

    it("falha total não fecha o modal nem encerra a seleção", async () => {
        invokeMock.mockResolvedValue(
            resposta([
                {
                    conversationId: "conv-1",
                    contactName: "Ana",
                    success: false,
                    sent: 0,
                    total: 2,
                    errors: ["Sessão desconectada."],
                    error: "Sessão desconectada.",
                },
            ]),
        );
        const { onOpenChange, onForwarded } = await abrir([msg("a"), msg("b")]);

        await user.click(screen.getByText("Ana"));
        await user.click(screen.getByRole("button", { name: /^encaminhar$/i }));

        await waitFor(() => expect(toastMock).toHaveBeenCalled());
        expect(toastMock.mock.calls[0][0]).toMatchObject({
            title: "Não foi possível encaminhar",
            description: "Sessão desconectada.",
        });
        expect(onForwarded).not.toHaveBeenCalled();
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });
});
