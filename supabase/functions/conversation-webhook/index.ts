// Avisa o webhook da organização quando alguém do time LÊ uma conversa ou a MARCA
// COMO NÃO LIDA no painel. A leitura do Echo é por pessoa (conversation_reads): o
// aviso leva o e-mail de quem leu, para o receptor aplicar só para essa pessoa.
//
// Chamada pelo NotificationContext DEPOIS que a RPC gravou, sem segurar a tela.
// Não usa sendOrganizationWebhook: aquele monta o payload de MENSAGEM e rotularia
// o evento como message.status. Aqui o corpo é pequeno e próprio (event,
// conversation_id, contact_phone, phone_number_id, read_at).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { requireUser } from '../_shared/authz.ts';
import { fetchExterno, UrlExternaBloqueadaError } from '../_shared/url-guard.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const EVENTOS = new Set(['conversation.read', 'conversation.unread']);
// O front manda o que a pessoa abriu ou marcou; lote grande não é leitura.
const MAX_CONVERSAS = 50;
// Um CRM lento não pode prender a function: passado o limite, desiste.
const TIMEOUT_MS = 8_000;

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }
    if (req.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }

    const url = Deno.env.get('SUPABASE_URL')!;
    const supabase = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    let userId: string;
    try {
        // A identidade vem do JWT verificado, nunca do corpo.
        userId = await requireUser(supabase, req);
    } catch {
        return json({ error: 'Unauthorized' }, 401);
    }
    // Quem leu vai junto com o e-mail: o receptor acha a pessoa por ele e apaga a não lida
    // só para ela, não para todos.
    const { data: quem } = await supabase.auth.admin.getUserById(userId);
    const email = quem?.user?.email ?? null;

    let body: { event?: unknown; conversationIds?: unknown };
    try {
        body = await req.json();
    } catch {
        return json({ error: 'Invalid JSON' }, 400);
    }
    const event = String(body?.event ?? '');
    const ids = Array.isArray(body?.conversationIds)
        ? (body.conversationIds as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, MAX_CONVERSAS)
        : [];
    if (!EVENTOS.has(event) || ids.length === 0) {
        return json({ error: 'Missing required fields' }, 400);
    }

    // Só as conversas que a PRÓPRIA pessoa enxerga: a consulta vai com o token
    // dela, então as regras de acesso do Echo (setor, linha) valem aqui também.
    // Com a chave de serviço, um atendente da linha A marcava conversa da linha B.
    const doUsuario = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: conversas, error: convErr } = await doUsuario
        .from('conversations')
        .select('id, contact_phone, group_jid, is_group, phone_number_id, channel')
        .in('id', ids);
    if (convErr) return json({ error: 'Could not load conversations' }, 500);
    if (!conversas || conversas.length === 0) return json({ ok: true, enviados: 0 });

    // A organização vem da linha da conversa, e a pessoa tem de ser dela.
    const { data: membros, error: membrosErr } = await supabase
        .from('organization_members')
        .select('organization_id')
        .eq('user_id', userId);
    if (membrosErr) return json({ error: 'Could not load memberships' }, 500);
    const minhasOrgs = new Set((membros ?? []).map((m: { organization_id: string }) => m.organization_id));

    const linhasIds = [...new Set(conversas.map((c) => c.phone_number_id).filter((x): x is string => !!x))];
    const { data: linhas, error: linhasErr } = await supabase
        .from('phone_numbers')
        .select('id, organization_id, phone_number_id')
        .in('id', linhasIds);
    if (linhasErr) return json({ error: 'Could not load phone numbers' }, 500);
    const linhaPorId = new Map((linhas ?? []).map((l: { id: string; organization_id: string | null; phone_number_id: string | null }) => [l.id, l]));

    const agora = new Date().toISOString();
    const porOrg = new Map<string, Record<string, unknown>[]>();
    for (const c of conversas) {
        // Direct do Instagram: 'ig:<id>' não é telefone e não vai ao webhook.
        if (c.channel === 'instagram') continue;
        const linha = c.phone_number_id ? linhaPorId.get(c.phone_number_id) : undefined;
        const orgId = linha?.organization_id;
        if (!orgId || !minhasOrgs.has(orgId)) continue;
        const lista = porOrg.get(orgId) ?? [];
        lista.push({
            event,
            ts: Date.now(),
            ts_iso: agora,
            read_at: agora,
            organization_id: orgId,
            conversation_id: c.id,
            // Grupo vai pelo JID: é por ele que o receptor acha o grupo.
            contact_phone: c.is_group && c.group_jid ? c.group_jid : c.contact_phone,
            phone_number_id: linha?.phone_number_id ?? null,
            is_group: !!c.is_group,
            by: { id: userId, email },
        });
        porOrg.set(orgId, lista);
    }

    let enviados = 0;
    for (const [orgId, eventos] of porOrg) {
        const { data: hook } = await supabase
            .from('organization_webhooks')
            .select('url, is_active')
            .eq('organization_id', orgId)
            .maybeSingle();
        if (!hook?.is_active || !hook?.url) continue;
        try {
            // Um POST por organização com a lista: o receptor recebe a lista de eventos de uma vez.
            // URL escolhida pela organização: passa pela guarda SSRF (fetchExterno) em cada salto.
            const resp = await fetchExterno(hook.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(eventos),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            console.log(`[conversation-webhook] ${event} x${eventos.length} → ${resp.status}`);
            if (resp.ok) enviados += eventos.length;
        } catch (err) {
            if (err instanceof UrlExternaBloqueadaError) {
                console.warn(`[conversation-webhook] ${event}: URL do webhook bloqueada pela guarda (org ${orgId}, ${err.reason})`);
            } else {
                console.warn(`[conversation-webhook] ${event} falhou (org ${orgId}):`, err);
            }
        }
    }

    return json({ ok: true, enviados });
});
