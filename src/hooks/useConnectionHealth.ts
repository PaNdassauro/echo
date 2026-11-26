import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

// Validação primeiro: a RPC devolve jsonb, então o contrato é checado aqui e
// não confiado cegamente no tipo Json do Supabase.
const timestamp = z.string().nullable();

const lineSchema = z.object({
    id: z.string().uuid(),
    display_name: z.string().nullable(),
    phone_number: z.string().nullable(),
    is_active: z.boolean().nullable(),
    qr_session_status: z.string().nullable(),
    /** Lib que atende a linha no qr-service (phone_numbers.qr_provider). `.default`: RPC anterior à 20260922 não devolve a chave. */
    qr_provider: z.string().default("baileys"),
    last_event: z.enum(["open", "close"]).nullable(),
    last_status_code: z.number().nullable(),
    last_reason: z.string().nullable(),
    last_event_at: timestamp,
    last_open_at: timestamp,
    last_inbound_at: timestamp,
    closes: z.number(),
    closes_24h: z.number(),
    conflicts: z.number(),
    conflicts_7d: z.number(),
    last_conflict_at: timestamp,
    forbidden: z.number(),
    last_forbidden_at: timestamp,
    group_adds: z.number(),
    group_adds_7d: z.number(),
});

const dailySchema = z.object({
    phone_number_id: z.string().uuid(),
    day: z.string(),
    closes: z.number(),
    conflicts: z.number(),
    forbidden: z.number(),
    flaps: z.number(),
});

const eventSchema = z.object({
    id: z.string().uuid(),
    phone_number_id: z.string().uuid(),
    event: z.string(),
    status_code: z.number().nullable(),
    reason: z.string().nullable(),
    error_message: z.string().nullable(),
    reconnect_attempts: z.number().nullable(),
    created_at: z.string(),
    group_name: z.string().nullable(),
    group_action: z.string().nullable(),
    group_action_at: timestamp,
});

const prospectingSchema = z.object({
    phone_number_id: z.string().uuid(),
    new_conversations_7d: z.number(),
    started_by_us_7d: z.number(),
    unanswered_7d: z.number(),
});

// Grupos que o WhatsApp restringiu (suspensão / trava de crescimento), vistos pelo
// qr-service ao carregar os metadados (qr_message_log.action = 'group_restricted').
// `.default([])`: uma RPC de versão anterior pode não devolver a chave.
const restrictedGroupSchema = z.object({
    phone_number_id: z.string().uuid(),
    group_jid: z.string(),
    subject: z.string().nullable(),
    suspended: z.boolean().nullable(),
    appeal_status: z.string().nullable(),
    growth_locked_until: timestamp,
    seen_at: z.string(),
});

const healthSchema = z.object({
    generated_at: z.string(),
    since: z.string(),
    lines: z.array(lineSchema),
    daily: z.array(dailySchema),
    events: z.array(eventSchema),
    prospecting: z.array(prospectingSchema),
    restricted_groups: z.array(restrictedGroupSchema).default([]),
});

export type ConnectionLine = z.infer<typeof lineSchema>;
export type DailyRow = z.infer<typeof dailySchema>;
export type ConnectionEvent = z.infer<typeof eventSchema>;
export type ProspectingRow = z.infer<typeof prospectingSchema>;
export type RestrictedGroup = z.infer<typeof restrictedGroupSchema>;
export type ConnectionHealth = z.infer<typeof healthSchema>;

export type HealthWindowDays = 7 | 30 | 90;

async function fetchConnectionHealth(orgId: string, days: HealthWindowDays): Promise<ConnectionHealth> {
    const { data, error } = await supabase.rpc("get_connection_health", { p_org_id: orgId, p_days: days });
    if (error) {
        console.error("[useConnectionHealth] rpc falhou", error);
        throw new Error(error.message);
    }
    const parsed = healthSchema.safeParse(data);
    if (!parsed.success) {
        console.error("[useConnectionHealth] resposta fora do contrato", parsed.error.flatten());
        throw new Error("Resposta da RPC fora do formato esperado");
    }
    return parsed.data;
}

export function useConnectionHealth(orgId: string | undefined, days: HealthWindowDays, enabled = true) {
    return useQuery({
        queryKey: ["connection-health", orgId, days],
        queryFn: () => fetchConnectionHealth(orgId as string, days),
        enabled: enabled && Boolean(orgId),
        // Painel de operação: quem deixa aberto quer ver a queda acontecer.
        refetchInterval: 60_000,
        refetchOnWindowFocus: true,
        staleTime: 30_000,
    });
}
