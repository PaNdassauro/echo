import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { qrFetch } from "@/lib/qrService";
import { migrateProviderErrorSchema, migrateProviderResponseSchema, type MigrateProviderResponse } from "@/types/lineProvider";

/**
 * Troca a lib (provider) que atende uma linha QR. Dois caminhos:
 *
 * - `save`: grava phone_numbers.qr_provider. Vale na PRÓXIMA conexão — o
 *   serviço lê a coluna ao conectar (cache de 300s). Sem tráfego na sessão.
 * - `migrate`: POST /session/migrate-provider no serviço. Fecha a sessão sem
 *   logout, exporta as credenciais, importa na lib nova, grava a coluna e
 *   reconecta. Não re-pareia; guarda backup para rollback. Reconecta a linha.
 *
 * Ambos invalidam as queries do /ops para o chip refletir o novo estado.
 */

async function saveProvider(phoneNumberId: string, to: string): Promise<void> {
    const { data, error } = await supabase
        .from("phone_numbers")
        .update({ qr_provider: to })
        .eq("id", phoneNumberId)
        .select("id");
    if (error) throw error;
    // RLS (phone_numbers_manage) barra não-admin devolvendo ZERO linhas, sem erro.
    // Sem esta checagem o toast diria "salvo" com nada persistido.
    if (!data || data.length === 0) {
        throw new Error("Nenhuma linha atualizada: só administradores da organização podem trocar a lib.");
    }
}

async function migrateProvider(phoneNumberId: string, to: string): Promise<MigrateProviderResponse> {
    const res = await qrFetch(`/session/migrate-provider/${phoneNumberId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
        const parsed = migrateProviderErrorSchema.safeParse(body);
        throw new Error(parsed.success ? parsed.data.error : `Serviço respondeu ${res.status}`);
    }
    const parsed = migrateProviderResponseSchema.safeParse(body);
    if (!parsed.success) {
        console.error("[useSetLineProvider] resposta do migrate-provider fora do contrato", parsed.error.flatten());
        throw new Error("Resposta do serviço fora do formato esperado");
    }
    return parsed.data;
}

export function useSetLineProvider(organizationId: string | undefined) {
    const queryClient = useQueryClient();
    const invalidate = () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: ["connection-health", organizationId] }),
            queryClient.invalidateQueries({ queryKey: ["qr-service-health", organizationId] }),
        ]);

    const save = useMutation({
        mutationFn: ({ phoneNumberId, to }: { phoneNumberId: string; to: string }) => saveProvider(phoneNumberId, to),
        onSettled: () => void invalidate(),
    });

    const migrate = useMutation({
        mutationFn: ({ phoneNumberId, to }: { phoneNumberId: string; to: string }) => migrateProvider(phoneNumberId, to),
        onSettled: () => void invalidate(),
    });

    return { save, migrate };
}
