import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

// "Só quem assumiu vê": quando outra atendente assume a conversa, a RLS passa a
// devolver 0 linhas para quem a tinha aberta. Isso (e só isso) avisa o chamador.
// Erro de rede/servidor não pode tirar a conversa da tela.

type Resposta = { data: unknown; error: unknown };
let resposta: Resposta | (() => Promise<Resposta>);

vi.mock("@/integrations/supabase/client", () => ({
    supabase: {
        from: () => ({
            select: () => ({
                eq: () => ({
                    maybeSingle: async () => (typeof resposta === "function" ? resposta() : resposta),
                }),
            }),
        }),
    },
}));

import { useConversation } from "./useConversation";

const LINHA = { id: "c1", contact_name: "Ana", contact_phone: "5511999998888", is_group: false };

beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("useConversation — conversa que a RLS esconde", () => {
    it("0 linhas sem erro: chama onInaccessible com o id", async () => {
        resposta = { data: null, error: null };
        const onInaccessible = vi.fn();
        renderHook(() => useConversation({ conversationId: "c1", userId: "u1", onInaccessible }));
        await waitFor(() => expect(onInaccessible).toHaveBeenCalledWith("c1"));
        expect(onInaccessible).toHaveBeenCalledTimes(1);
    });

    it("erro de rede: não chama onInaccessible", async () => {
        resposta = { data: null, error: { message: "Failed to fetch" } };
        const onInaccessible = vi.fn();
        const { result } = renderHook(() => useConversation({ conversationId: "c1", userId: "u1", onInaccessible }));
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(onInaccessible).not.toHaveBeenCalled();
    });

    it("linha visível: carrega a conversa e não chama onInaccessible", async () => {
        resposta = { data: LINHA, error: null };
        const onInaccessible = vi.fn();
        const { result } = renderHook(() => useConversation({ conversationId: "c1", userId: "u1", onInaccessible }));
        await waitFor(() => expect(result.current.conversation?.id).toBe("c1"));
        expect(onInaccessible).not.toHaveBeenCalled();
    });

    it("resposta tardia de outra conversa: não chama onInaccessible", async () => {
        let soltar: (r: Resposta) => void = () => {};
        resposta = () => new Promise<Resposta>((res) => { soltar = res; });
        const onInaccessible = vi.fn();
        const { rerender, result } = renderHook(
            ({ id }: { id: string }) => useConversation({ conversationId: id, userId: "u1", onInaccessible }),
            { initialProps: { id: "c1" } },
        );
        // Troca de conversa antes de a primeira resposta chegar.
        resposta = { data: { ...LINHA, id: "c2" }, error: null };
        rerender({ id: "c2" });
        await waitFor(() => expect(result.current.conversation?.id).toBe("c2"));
        soltar({ data: null, error: null });
        await Promise.resolve();
        expect(onInaccessible).not.toHaveBeenCalled();
    });
});
