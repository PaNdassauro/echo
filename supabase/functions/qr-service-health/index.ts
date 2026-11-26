import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { qrAuthHeaders } from '../_shared/qr.ts';
import { requireUser } from '../_shared/authz.ts';

/**
 * qr-service-health — estado AO VIVO das sessões Baileys para o painel /ops.
 *
 * O `/session/health` do qr-service exige a service key, então o navegador não
 * pode chamá-lo. Esta function faz a ponte: valida o JWT do usuário, exige
 * admin da org (ou super admin) e devolve só as sessões dos números daquela
 * org — o serviço é multi-tenant e o mapa completo vazaria ids de outras orgs.
 *
 * Não gera tráfego na sessão do WhatsApp: é leitura de memória do serviço.
 */

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function friendlyError(error: string): string {
    const lower = error.toLowerCase();
    if (lower.includes('not authenticated')) return 'Sessão expirada. Entre novamente.';
    if (lower.includes('forbidden')) return 'Só administradores da organização podem ver o estado do serviço.';
    if (lower.includes('organizationid')) return 'Organização não informada.';
    if (lower.includes('qr_service_url')) return 'Serviço QR não configurado.';
    if (lower.includes('qr service')) return 'Serviço QR não respondeu.';
    return `Erro: ${error}`;
}

interface ServiceHealth {
    version?: string;
    commit?: string;
    uptime_s?: number;
    rss_mb?: number;
    sessions?: number;
    pending_webhooks?: number;
    outbox_stalled?: boolean;
    heap_used_mb?: number;
    outbox_mem?: number;
    outbox_disk?: number;
    outbox_oldest_disk_age_s?: number | null;
    outbox_skipped?: number;
    avatars?: AvatarQueueInfo;
}

interface AvatarQueueInfo {
    queued: number;
    inFlight: number;
    dropped: number;
    pausedUntil: string | null;
    consecutive429: number;
}

interface ReachoutLock {
    hits: number;
    locked_until: string;
    last_jid?: string;
    source: string;
    enforcement_type: string | null;
}

/** Janela do resumo de falhas do qr_message_log. */
const FAILURE_WINDOW_MS = 60 * 60 * 1000;
const FAILURE_ROW_CAP = 1000;

interface FailureSummary {
    window_minutes: number;
    /** webhook_spilled sai em rajada (milhares): contado à parte, sem baixar as linhas. */
    spilled: number;
    by_action: Record<string, number>;
    /** true quando as falhas passaram do teto de linhas lidas: by_action é piso, não total. */
    truncated: boolean;
}

interface CappingInfo {
    status: string;
    used_quota: number | null;
    total_quota: number | null;
    cycle_end: string | null;
    at: string;
    source: string;
}
interface ProviderInfo {
    /** Nome registrado no serviço ('baileys' | 'zapo' | ...). */
    provider: string;
    /** Lib e versão que a sessão está usando de fato (ex.: 'zapo-js@1.8'). */
    libraryId: string;
}
interface SessionHealth {
    sessions?: Record<string, string>;
    total_sessions?: number;
    timestamp?: string;
    /** Cota de conversas novas por sessão (qr-service >= 2.5.0). Ausente = sem informação. */
    message_capping?: Record<string, CappingInfo>;
    /** Provider AO VIVO por sessão (qr-service >= 2.4). Só sessões com client criado. */
    providers?: Record<string, ProviderInfo>;
    /** Providers que o serviço aceita em migrate-provider / qr_provider. */
    registered_providers?: string[];
    /** Bloqueio local de contato frio (ack 463) por sessão. Só sessões com bloqueio ativo. */
    reachout_locks?: Record<string, ReachoutLock>;
    /** Limites de proteção ativos (valores numéricos; ms ou contagem pelo nome da chave). */
    protection_limits?: Record<string, number>;
}

async function loadFailureSummary(
    supabase: SupabaseClient,
    phoneIds: string[],
): Promise<FailureSummary | null> {
    if (phoneIds.length === 0) return null;
    const since = new Date(Date.now() - FAILURE_WINDOW_MS).toISOString();
    const [spilled, others] = await Promise.all([
        supabase
            .from('qr_message_log')
            .select('id', { count: 'exact', head: true })
            .in('phone_number_id', phoneIds)
            .eq('success', false)
            .eq('action', 'webhook_spilled')
            .gte('created_at', since),
        supabase
            .from('qr_message_log')
            .select('action')
            .in('phone_number_id', phoneIds)
            .eq('success', false)
            .neq('action', 'webhook_spilled')
            .gte('created_at', since)
            .limit(FAILURE_ROW_CAP),
    ]);
    if (spilled.error || others.error) {
        // Resumo é diagnóstico acessório: falhar aqui não pode derrubar o painel.
        console.error('[qr-service-health] resumo de falhas falhou', spilled.error ?? others.error);
        return null;
    }
    const byAction: Record<string, number> = {};
    for (const row of others.data ?? []) {
        const action = (row as { action: string }).action;
        byAction[action] = (byAction[action] ?? 0) + 1;
    }
    return {
        window_minutes: FAILURE_WINDOW_MS / 60_000,
        spilled: spilled.count ?? 0,
        by_action: byAction,
        truncated: (others.data?.length ?? 0) >= FAILURE_ROW_CAP,
    };
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!res.ok) {
            throw new Error(`QR service returned ${res.status} for ${new URL(url).pathname}`);
        }
        return (await res.json()) as T;
    } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
            throw new Error('QR service timed out');
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    try {
        const userId = await requireUser(supabase, req);

        const body = (await req.json().catch(() => ({}))) as { organizationId?: unknown };
        const organizationId = typeof body.organizationId === 'string' ? body.organizationId : '';
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
            throw new Error('organizationId is required');
        }

        // Admin da org ou super admin — o mesmo gate da RPC get_connection_health.
        const { data: profile } = await supabase
            .from('profiles')
            .select('is_super_admin')
            .eq('id', userId)
            .maybeSingle();
        if (!profile?.is_super_admin) {
            const { data: member } = await supabase
                .from('organization_members')
                .select('role')
                .eq('organization_id', organizationId)
                .eq('user_id', userId)
                .maybeSingle();
            if (member?.role !== 'admin') {
                throw new Error('Forbidden: organization admin required');
            }
        }

        const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
        if (!qrServiceUrl) {
            throw new Error('QR_SERVICE_URL not configured');
        }

        const { data: phones, error: phonesError } = await supabase
            .from('phone_numbers')
            .select('id')
            .eq('organization_id', organizationId)
            .eq('connection_type', 'qr');
        if (phonesError) {
            throw new Error(`Failed to load phone numbers: ${phonesError.message}`);
        }
        const orgPhoneIds = new Set((phones ?? []).map((p: { id: string }) => p.id));

        const [service, sessionHealth, failures] = await Promise.all([
            fetchJson<ServiceHealth>(`${qrServiceUrl}/health`, {}, 8000),
            fetchJson<SessionHealth>(`${qrServiceUrl}/session/health`, { headers: qrAuthHeaders() }, 8000),
            loadFailureSummary(supabase, [...orgPhoneIds]),
        ]);

        const sessions: Record<string, string> = {};
        for (const [id, status] of Object.entries(sessionHealth.sessions ?? {})) {
            if (orgPhoneIds.has(id)) sessions[id] = status;
        }
        const capping: Record<string, CappingInfo> = {};
        for (const [id, info] of Object.entries(sessionHealth.message_capping ?? {})) {
            if (orgPhoneIds.has(id)) capping[id] = info;
        }
        const providers: Record<string, ProviderInfo> = {};
        for (const [id, info] of Object.entries(sessionHealth.providers ?? {})) {
            if (orgPhoneIds.has(id)) providers[id] = info;
        }

        // last_jid é o telefone do contato frio: fica no serviço, o painel não precisa dele.
        const reachoutLocks: Record<string, Omit<ReachoutLock, 'last_jid'>> = {};
        for (const [id, lock] of Object.entries(sessionHealth.reachout_locks ?? {})) {
            if (!orgPhoneIds.has(id)) continue;
            reachoutLocks[id] = {
                hits: lock.hits,
                locked_until: lock.locked_until,
                source: lock.source,
                enforcement_type: lock.enforcement_type ?? null,
            };
        }

        return new Response(
            JSON.stringify({
                success: true,
                checked_at: new Date().toISOString(),
                service: {
                    version: service.version ?? null,
                    commit: service.commit ?? null,
                    uptime_s: service.uptime_s ?? null,
                    rss_mb: service.rss_mb ?? null,
                    total_sessions: sessionHealth.total_sessions ?? Object.keys(sessionHealth.sessions ?? {}).length,
                    pending_webhooks: service.pending_webhooks ?? null,
                    outbox_stalled: service.outbox_stalled ?? null,
                    heap_used_mb: service.heap_used_mb ?? null,
                    outbox_mem: service.outbox_mem ?? null,
                    outbox_disk: service.outbox_disk ?? null,
                    outbox_oldest_disk_age_s: service.outbox_oldest_disk_age_s ?? null,
                    outbox_skipped: service.outbox_skipped ?? null,
                    avatars: service.avatars ?? null,
                },
                reachout_locks: reachoutLocks,
                // Limites globais do serviço, sem id de linha: não vazam nada de outra org.
                protection_limits: sessionHealth.protection_limits ?? {},
                failures,
                sessions,
                capping,
                providers,
                // Lista global do serviço, não tem id de linha: não vaza nada de outra org.
                registered_providers: sessionHealth.registered_providers ?? [],
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
    } catch (error) {
        return createErrorResponse(error, corsHeaders, friendlyError);
    }
});
