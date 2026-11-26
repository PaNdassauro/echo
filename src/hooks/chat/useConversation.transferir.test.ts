import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

// Transferir com "só quem assumiu vê": depois da RPC, quem transferiu pode não
// enxergar mais a conversa, e a nota gravada depois cairia na RLS. A nota vai
// antes da RPC, e sai se a RPC falhar.

const ordem: string[] = [];
let rpcErro: unknown = null;
const deleteEq = vi.fn(async () => ({ error: null }));

vi.mock("@/integrations/supabase/client", () => ({
    supabase: {
        from: (tabela: string) => ({
            // fetch da conversa e leitura do nome
            select: () => ({
                eq: () => ({
                    maybeSingle: async () => ({ data: { id: "c1", contact_name: "Ana" }, error: null }),
                    single: async () => ({ data: { contact_name: "Ana" }, error: null }),
                }),
            }),
            insert: (linha: { content: string }) => {
                ordem.push(`insert:${tabela}:${linha.content}`);
                return { select: () => ({ maybeSingle: async () => ({ data: { id: "n1" }, error: null }) }) };
            },
            delete: () => {
                ordem.push(`delete:${tabela}`);
                return { eq: deleteEq };
            },
        }),
        rpc: async (nome: string) => {
            ordem.push(`rpc:${nome}`);
            return { error: rpcErro };
        },
        channel: () => ({ send: async () => "ok" }),
        removeChannel: () => {},
    },
}));

import { useConversation } from "./useConversation";

beforeEach(() => {
    ordem.length = 0;
    rpcErro = null;
    deleteEq.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

async function montar() {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const hook = renderHook(() => useConversation({ conversationId: "c1", userId: "u1", onSuccess, onError }));
    await waitFor(() => expect(hook.result.current.conversation?.id).toBe("c1"));
    return { ...hook, onSuccess, onError };
}

describe("useConversation — transferir", () => {
    it("grava a nota antes da transferência", async () => {
        const { result, onSuccess } = await montar();
        let ok = false;
        await act(async () => {
            ok = await result.current.transferConversation("u2", "Bia", false);
        });
        expect(ok).toBe(true);
        const nota = ordem.findIndex((o) => o === "insert:conversation_notes:Conversa transferida para Bia");
        const rpc = ordem.indexOf("rpc:promote_co_owner_to_primary");
        expect(nota).toBeGreaterThanOrEqual(0);
        expect(rpc).toBeGreaterThan(nota);
        expect(ordem).not.toContain("delete:conversation_notes");
        expect(onSuccess).toHaveBeenCalledWith("Conversa transferida", "O atendimento foi transferido para Bia");
    });

    it("transferência que falha apaga a nota e avisa o erro", async () => {
        rpcErro = { message: "Access denied to conversation", code: "42501" };
        const { result, onError } = await montar();
        let ok = true;
        await act(async () => {
            ok = await result.current.transferConversation("u2", "Bia", false);
        });
        expect(ok).toBe(false);
        expect(ordem.indexOf("delete:conversation_notes")).toBeGreaterThan(ordem.indexOf("rpc:promote_co_owner_to_primary"));
        expect(deleteEq).toHaveBeenCalledWith("id", "n1");
        expect(onError).toHaveBeenCalledTimes(1);
    });
});
