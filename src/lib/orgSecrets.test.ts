import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
    supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

const { buscarConfigWhatsapp, buscarConfigIa } = await import("./orgSecrets");

const ORG = "00000000-0000-4000-8000-000000000001";

beforeEach(() => rpc.mockReset());

describe("orgSecrets", () => {
    it("devolve a primeira linha validada", async () => {
        rpc.mockResolvedValue({
            data: [{ whatsapp_waba_id: "1", whatsapp_app_id: null, tem_token: true }],
            error: null,
        });
        await expect(buscarConfigWhatsapp(ORG)).resolves.toEqual({
            whatsapp_waba_id: "1",
            whatsapp_app_id: null,
            tem_token: true,
        });
    });

    it("organização sem linha vira null", async () => {
        rpc.mockResolvedValue({ data: [], error: null });
        await expect(buscarConfigIa(ORG)).resolves.toBeNull();
    });

    it("erro da RPC (42501 para quem não é admin) sobe", async () => {
        const erro = { code: "42501", message: "Unauthorized" };
        rpc.mockResolvedValue({ data: null, error: erro });
        await expect(buscarConfigIa(ORG)).rejects.toBe(erro);
    });

    it("resposta fora do contrato é recusada", async () => {
        rpc.mockResolvedValue({ data: [{ tem_chave: "sim", ai_insights_prompt: null }], error: null });
        await expect(buscarConfigIa(ORG)).rejects.toThrow(/inesperada/);
    });
});
