import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no seguinte.
afterEach(cleanup);

const user = userEvent.setup({ pointerEventsCheck: 0 });

const ORG_ID = "00000000-0000-4000-8000-000000000001";

const rpc = vi.fn();
const select = vi.fn();
const eq = vi.fn(() => ({ select }));
const update = vi.fn((_patch: Record<string, unknown>) => ({ eq }));
const from = vi.fn((_tabela: string) => ({ update }));
vi.mock("@/integrations/supabase/client", () => ({
    supabase: { rpc: (...args: unknown[]) => rpc(...args), from: (t: string) => from(t) },
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ toast: (...args: unknown[]) => toast(...args) }));

const { AIConfigurationModal } = await import("./AIConfigurationModal");

function chamadas(nome: string) {
    return rpc.mock.calls.filter((c) => c[0] === nome);
}

function mockRpc(temChave: boolean) {
    rpc.mockImplementation((nome: string) =>
        Promise.resolve(
            nome === "get_org_ai_config"
                ? { data: [{ tem_chave: temChave, ai_insights_prompt: "Prompt da org" }], error: null }
                : { data: null, error: null },
        ),
    );
}

beforeEach(() => {
    rpc.mockReset();
    select.mockReset().mockResolvedValue({ data: [{ id: ORG_ID }], error: null });
    eq.mockClear();
    update.mockClear();
    from.mockClear();
    toast.mockReset();
});

async function abrir() {
    render(<AIConfigurationModal orgId={ORG_ID} />);
    await user.click(screen.getByRole("button", { name: /configurar ia/i }));
    return screen.findByLabelText("Chave de IA (OpenAI ou Anthropic)");
}

describe("AIConfigurationModal", () => {
    it("já configurada: lê pela RPC, deixa o campo vazio e não chama set_ai_api_key sem chave nova", async () => {
        mockRpc(true);
        const campo = await abrir();

        await waitFor(() => expect(campo).toHaveAttribute("placeholder", expect.stringContaining("já configurada")));
        expect(chamadas("get_org_ai_config")[0][1]).toEqual({ p_org_id: ORG_ID });
        expect(campo).toHaveValue("");
        expect(await screen.findByDisplayValue("Prompt da org")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /salvar configurações/i }));
        await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Configurações salvas" }));
        expect(update).toHaveBeenCalledWith({ ai_insights_prompt: "Prompt da org" });
        expect(chamadas("set_ai_api_key")).toHaveLength(0);
    });

    it("gravar novo valor: a chave digitada vai pela RPC set_ai_api_key", async () => {
        mockRpc(false);
        const campo = await abrir();
        await screen.findByDisplayValue("Prompt da org");

        await user.type(campo, "sk-nova-chave");
        await user.click(screen.getByRole("button", { name: /salvar configurações/i }));

        await waitFor(() => expect(chamadas("set_ai_api_key")).toHaveLength(1));
        expect(chamadas("set_ai_api_key")[0][1]).toEqual({ p_org_id: ORG_ID, p_raw_key: "sk-nova-chave" });
        await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Configurações salvas" }));
    });

    it("UPDATE do prompt que não casa nenhuma linha vira erro e a chave não é gravada", async () => {
        mockRpc(false);
        select.mockResolvedValue({ data: [], error: null });
        const campo = await abrir();
        await screen.findByDisplayValue("Prompt da org");

        await user.type(campo, "sk-nova-chave");
        await user.click(screen.getByRole("button", { name: /salvar configurações/i }));

        await waitFor(() =>
            expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })),
        );
        expect(chamadas("set_ai_api_key")).toHaveLength(0);
    });
});
