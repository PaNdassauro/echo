import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no seguinte.
afterEach(cleanup);

const user = userEvent.setup({ pointerEventsCheck: 0 });

const ORG_ID = "00000000-0000-4000-8000-000000000001";

vi.mock("@/contexts/OrganizationContext", () => ({
    useOrganization: () => ({ currentOrganization: { id: ORG_ID, name: "Acme" }, isLoading: false }),
}));

const rpc = vi.fn();
const select = vi.fn();
const eq = vi.fn(() => ({ select }));
const update = vi.fn((_patch: Record<string, unknown>) => ({ eq }));
const from = vi.fn((_tabela: string) => ({ update }));
vi.mock("@/integrations/supabase/client", () => ({
    supabase: { rpc: (...args: unknown[]) => rpc(...args), from: (t: string) => from(t) },
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const { IntegrationSettings } = await import("./IntegrationSettings");

beforeEach(() => {
    rpc.mockReset();
    select.mockReset().mockResolvedValue({ data: [{ id: ORG_ID }], error: null });
    eq.mockClear();
    update.mockClear();
    from.mockClear();
    toast.mockReset();
});

const config = (temToken: boolean) => ({
    data: [{ whatsapp_waba_id: "100500", whatsapp_app_id: null, tem_token: temToken }],
    error: null,
});

describe("IntegrationSettings", () => {
    it("já configurado: lê pela RPC, nunca mostra o token e não o envia sem digitar um novo", async () => {
        rpc.mockResolvedValue(config(true));
        render(<IntegrationSettings />);

        const campo = await screen.findByLabelText("Token de acesso (sistema)");
        await waitFor(() => expect(campo).toHaveAttribute("placeholder", expect.stringContaining("Já configurado")));
        expect(rpc).toHaveBeenCalledWith("get_org_whatsapp_config", { p_org_id: ORG_ID });
        expect(from).not.toHaveBeenCalledWith("organizations");
        expect(campo).toHaveValue("");
        expect(screen.getByDisplayValue("100500")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /salvar/i }));
        await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
        const patch = update.mock.calls[0][0];
        expect(patch).not.toHaveProperty("whatsapp_access_token");
        expect(patch).toMatchObject({ whatsapp_waba_id: "100500" });
    });

    it("sem token: aviso de configuração pendente", async () => {
        rpc.mockResolvedValue(config(false));
        render(<IntegrationSettings />);
        expect(await screen.findByText("Configuração pendente")).toBeInTheDocument();
    });

    it("gravar novo valor: o token digitado vai no UPDATE e o campo esvazia", async () => {
        rpc.mockResolvedValue(config(false));
        render(<IntegrationSettings />);

        const campo = await screen.findByLabelText("Token de acesso (sistema)");
        await screen.findByDisplayValue("100500");
        await user.type(campo, "EAAGnovo");
        await user.click(screen.getByRole("button", { name: /salvar/i }));

        await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
        expect(update.mock.calls[0][0]).toMatchObject({ whatsapp_waba_id: "100500", whatsapp_access_token: "EAAGnovo" });
        await waitFor(() => expect(campo).toHaveValue(""));
        expect(await screen.findByText("Configurado")).toBeInTheDocument();
    });

    it("UPDATE que não casa nenhuma linha vira erro, não sucesso", async () => {
        rpc.mockResolvedValue(config(true));
        select.mockResolvedValue({ data: [], error: null });
        render(<IntegrationSettings />);
        await screen.findByDisplayValue("100500");

        await user.click(screen.getByRole("button", { name: /salvar/i }));
        await waitFor(() =>
            expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })),
        );
    });
});
