import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

// O telefone do card de um fornecedor já foi gravado no card de um
// grupo: a edição aberta no primeiro card seguia aberta depois da troca, porque
// o header não desmonta. Estes testes travam o reset na troca de conversa.

const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));

const conversas: Record<string, { id: string; contact_name: string; contact_phone: string; is_group: boolean; group_jid?: string }> = {
    fornecedor: { id: "fornecedor", contact_name: "Fornecedor Acme", contact_phone: "5531999990002", is_group: false },
    grupo: {
        id: "grupo",
        contact_name: "Grupo Acme",
        contact_phone: "120363000000000004@g.us",
        is_group: true,
        group_jid: "120363000000000004@g.us",
    },
};

vi.mock("@/integrations/supabase/client", () => ({
    supabase: {
        from: () => ({
            select: () => ({
                eq: (_col: string, id: string) => ({
                    maybeSingle: async () => ({ data: conversas[id], error: null }),
                }),
            }),
            update,
        }),
    },
}));

import { useConversation } from "./useConversation";

afterEach(() => {
    cleanup();
    update.mockClear();
});

function montar(inicial: string) {
    return renderHook(
        ({ id }: { id: string }) =>
            useConversation({ conversationId: id, userId: "u1", seedConversation: conversas[id] }),
        { initialProps: { id: inicial } },
    );
}

describe("useConversation — troca de card com edição aberta", () => {
    it("fecha a edição de número e esvazia o valor ao trocar de conversa", async () => {
        const { result, rerender } = montar("fornecedor");
        await waitFor(() => expect(result.current.conversation?.id).toBe("fornecedor"));

        act(() => result.current.startEditPhone());
        expect(result.current.isEditingPhone).toBe(true);
        expect(result.current.editPhoneValue).toBe("5531999990002");

        rerender({ id: "grupo" });
        await waitFor(() => expect(result.current.conversation?.id).toBe("grupo"));

        expect(result.current.isEditingPhone).toBe(false);
        expect(result.current.editPhoneValue).toBe("");
    });

    it("salvar depois da troca não grava o telefone do card anterior no grupo", async () => {
        const { result, rerender } = montar("fornecedor");
        await waitFor(() => expect(result.current.conversation?.id).toBe("fornecedor"));

        act(() => result.current.startEditPhone());
        rerender({ id: "grupo" });
        await waitFor(() => expect(result.current.conversation?.id).toBe("grupo"));

        await act(async () => {
            await result.current.saveContactPhone();
        });
        expect(update).not.toHaveBeenCalled();
    });

    it("fecha também a edição de nome", async () => {
        const { result, rerender } = montar("fornecedor");
        await waitFor(() => expect(result.current.conversation?.id).toBe("fornecedor"));

        act(() => result.current.startEditName());
        expect(result.current.isEditingName).toBe(true);

        rerender({ id: "grupo" });
        await waitFor(() => expect(result.current.conversation?.id).toBe("grupo"));

        expect(result.current.isEditingName).toBe(false);
        expect(result.current.editNameValue).toBe("");
    });
});

// Card aberto: a correção do grupo no banco só chegava à aba da
// atendente depois de um F5. A lista recebe o UPDATE por realtime e a semente
// muda; o hook tem de acompanhar, porque o telefone é o destino do envio.
describe("useConversation — card aberto acompanha a semente da lista", () => {
    type Semente = (typeof conversas)[string];

    function montarComSemente(semente: Semente) {
        return renderHook(
            ({ seed }: { seed: Semente }) =>
                useConversation({ conversationId: seed.id, userId: "u1", seedConversation: seed }),
            { initialProps: { seed: semente } },
        );
    }

    it("telefone corrigido no banco chega ao card aberto sem recarregar", async () => {
        const certo = { ...conversas.grupo };
        // O banco ainda tem o valor errado quando o card abre (o fetch lê daqui).
        conversas.grupo = { ...certo, contact_phone: "5531999990002" };
        try {
            const { result, rerender } = montarComSemente(conversas.grupo);
            await waitFor(() => expect(result.current.conversation?.group_jid).toBe("120363000000000004@g.us"));
            expect(result.current.conversation?.contact_phone).toBe("5531999990002");

            // Correção no banco → realtime atualiza a lista → semente nova.
            conversas.grupo = certo;
            rerender({ seed: { ...certo } });

            await waitFor(() => expect(result.current.conversation?.contact_phone).toBe("120363000000000004@g.us"));
            // Campo que só o fetch traz continua lá.
            expect(result.current.conversation?.group_jid).toBe("120363000000000004@g.us");
        } finally {
            conversas.grupo = certo;
        }
    });

    it("nome novo também chega ao card aberto", async () => {
        const { result, rerender } = montarComSemente({ ...conversas.fornecedor });
        await waitFor(() => expect(result.current.conversation?.id).toBe("fornecedor"));

        rerender({ seed: { ...conversas.fornecedor, contact_name: "Fornecedor Acme (Beta)" } });

        await waitFor(() => expect(result.current.conversation?.contact_name).toBe("Fornecedor Acme (Beta)"));
    });
});
