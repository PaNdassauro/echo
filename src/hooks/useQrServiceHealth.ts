import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

const cappingSchema = z.object({
    /** NONE | FIRST_WARNING | SECOND_WARNING | CAPPED */
    status: z.string(),
    used_quota: z.number().nullable(),
    total_quota: z.number().nullable(),
    cycle_end: z.string().nullable(),
    at: z.string(),
    source: z.string(),
});

const providerSchema = z.object({
    /** Nome registrado no serviço ('baileys' | 'zapo' | ...). */
    provider: z.string(),
    /** Lib e versão em uso de fato (ex.: 'zapo-js@1.8'). */
    libraryId: z.string(),
});
export type LiveProvider = z.infer<typeof providerSchema>;

const avatarQueueSchema = z.object({
    queued: z.number(),
    inFlight: z.number(),
    dropped: z.number(),
    pausedUntil: z.string().nullable(),
    consecutive429: z.number(),
});

const reachoutLockSchema = z.object({
    hits: z.number(),
    locked_until: z.string(),
    source: z.string(),
    enforcement_type: z.string().nullable(),
});
export type LineReachoutLock = z.infer<typeof reachoutLockSchema>;

const failuresSchema = z.object({
    window_minutes: z.number(),
    spilled: z.number(),
    by_action: z.record(z.string(), z.number()),
    truncated: z.boolean(),
});
export type FailureSummary = z.infer<typeof failuresSchema>;

const schema = z.object({
    success: z.literal(true),
    checked_at: z.string(),
    service: z.object({
        version: z.string().nullable(),
        commit: z.string().nullable(),
        uptime_s: z.number().nullable(),
        rss_mb: z.number().nullable(),
        total_sessions: z.number(),
        pending_webhooks: z.number().nullable(),
        outbox_stalled: z.boolean().nullable(),
        // Campos abaixo: edge anterior a esta versão não manda. `.nullish()` tolera ausência.
        heap_used_mb: z.number().nullish(),
        outbox_mem: z.number().nullish(),
        /** Arquivos de webhook spillados em disco. Normal é 0; sobe depois de restart. */
        outbox_disk: z.number().nullish(),
        outbox_oldest_disk_age_s: z.number().nullish(),
        outbox_skipped: z.number().nullish(),
        avatars: avatarQueueSchema.nullish(),
    }),
    /** phone_number_id → status do SessionManager ('connected', 'qr_ready', 'connecting'…). Ausente = sem sessão viva. */
    sessions: z.record(z.string(), z.string()),
    /** phone_number_id → cota de conversas novas (message capping). Ausente = a sessão nunca informou. */
    capping: z.record(z.string(), cappingSchema).default({}),
    /** phone_number_id → provider AO VIVO da sessão. Ausente = sem sessão viva (ou edge antiga). */
    providers: z.record(z.string(), providerSchema).default({}),
    /** Providers aceitos pelo serviço. Vazio = edge antiga; a UI cai na lista fixa. */
    registered_providers: z.array(z.string()).default([]),
    /** phone_number_id → bloqueio local de contato frio ativo (ack 463). Ausente = sem bloqueio. */
    reachout_locks: z.record(z.string(), reachoutLockSchema).default({}),
    /** Limites de proteção em vigor (chave → valor). Vazio = edge ou serviço antigos. */
    protection_limits: z.record(z.string(), z.number()).default({}),
    /** Falhas da última hora no qr_message_log. null = edge antiga ou consulta falhou. */
    failures: failuresSchema.nullish(),
});
export type LineCapping = z.infer<typeof cappingSchema>;

export type QrServiceHealth = z.infer<typeof schema>;

const errorSchema = z.object({ error: z.string() });

async function fetchQrServiceHealth(organizationId: string): Promise<QrServiceHealth> {
    const { data, error } = await supabase.functions.invoke("qr-service-health", { body: { organizationId } });
    if (error) {
        // invoke() não devolve o corpo do erro; ele vem em error.context (Response).
        const ctx: unknown = (error as { context?: unknown }).context;
        if (ctx instanceof Response) {
            const parsed = errorSchema.safeParse(await ctx.json().catch(() => null));
            if (parsed.success) throw new Error(parsed.data.error);
        }
        console.error("[useQrServiceHealth] invoke falhou", error);
        throw new Error(error.message);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
        console.error("[useQrServiceHealth] resposta fora do contrato", parsed.error.flatten());
        throw new Error("Resposta do serviço fora do formato esperado");
    }
    return parsed.data;
}

export function useQrServiceHealth(organizationId: string | undefined, enabled = true) {
    return useQuery({
        queryKey: ["qr-service-health", organizationId],
        queryFn: () => fetchQrServiceHealth(organizationId as string),
        enabled: enabled && Boolean(organizationId),
        refetchInterval: 30_000,
        refetchOnWindowFocus: true,
        staleTime: 15_000,
        retry: 1,
    });
}
