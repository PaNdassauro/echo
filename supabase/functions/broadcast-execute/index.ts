import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { logWriteFailure } from '../_shared/failure-log.ts';
import { isInternalCaller, rampDeny, requirePhoneAccess, requireUser } from '../_shared/authz.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'broadcast not found': 'Disparo não encontrado.',
    'whatsapp credentials not configured': 'WhatsApp não configurado. Verifique as configurações.',
    'failed to fetch recipients': 'Erro ao carregar destinatários. Tente novamente.',
    'already completed': 'Este disparo já foi concluído.',
    'cancelled': 'Este disparo foi cancelado.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

// Build a WhatsApp template header component for media (image/video/document).
// See: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates#media-message-templates
function buildHeaderComponentFromMedia(media: { format?: string; link?: string; filename?: string } | null | undefined) {
    if (!media || !media.link || !media.format) return null;
    const fmt = String(media.format).toLowerCase();
    if (fmt !== 'image' && fmt !== 'video' && fmt !== 'document') return null;
    const parameter: any = { type: fmt };
    if (fmt === 'image') {
        parameter.image = { link: media.link };
    } else if (fmt === 'video') {
        parameter.video = { link: media.link };
    } else {
        parameter.document = { link: media.link };
        if (media.filename) parameter.document.filename = media.filename;
    }
    return { type: 'header', parameters: [parameter] };
}

// Delay between batches (1s)
const BATCH_DELAY_MS = 1000;

// How long this invocation will keep claiming work before returning. The run is
// NOT finished when the budget runs out -- the pg_cron driver
// (dispatch_broadcast_work) simply dispatches another worker on the next tick.
// Progress is durable in broadcast_recipients, so no invocation needs to survive
// the whole campaign. This replaced a 50s budget plus a self-invocation chain
// that was capped at 30 hops and, measured in production, gave up after ~782 of
// 1.756 recipients.
const WORKER_BUDGET_MS = 40000;

// Batch size
const BATCH_SIZE = 25;

// Parallel sends within a batch. Adapts at runtime between these bounds: it is
// raised while the provider stays healthy and dropped to the floor on the first
// rate-limit response. Meta's lowest paid tier allows 250 msg/sec, so the ceiling
// here is deliberately conservative.
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 15;
const CONCURRENCY_DEFAULT = 5;

// Per-message timeout. Without this, one hung provider response held a whole
// Promise.allSettled chunk open and dragged real throughput down to a single
// batch per invocation.
const SEND_TIMEOUT_MS = 15000;

// Recipients whose claim was lost this many times are failed rather than retried,
// so a message is never delivered (and charged) twice for an ambiguous outcome.
const MAX_ATTEMPTS = 2;

// Helper to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// fetch with a hard deadline. Deno's fetch has no default timeout, so without this
// a provider that never answers holds the whole chunk (and the worker budget) open.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = SEND_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Transient provider conditions must NOT burn a recipient. Previously any Meta error
// -- including a 429 or a 500 -- marked the person 'failed' permanently, with the raw
// error string as the only record, and nothing ever retried them.
function isTransientSendFailure(status: number, errorCode?: number): boolean {
    if (status === 429 || status >= 500) return true;
    // Meta throughput/limit codes: rate limit hit, too many API calls, temporarily blocked.
    return errorCode === 4 || errorCode === 80007 || errorCode === 130429 || errorCode === 131048;
}

function isRateLimited(status: number, errorCode?: number): boolean {
    return status === 429 || errorCode === 4 || errorCode === 130429 || errorCode === 80007;
}

// 'retry' and 'throttled' both mean the recipient went back to 'pending' and is NOT
// terminal; only 'throttled' additionally tells the worker to back off.
type SendOutcome = 'sent' | 'failed' | 'retry' | 'throttled';

// Phones imported via CSV may carry a leading "+" — that's the international
// flag, meaning the digits already include a country code and must NOT be
// reshaped into Brazilian format. Without "+", we still apply the BR
// "55+DDD+9+local" standardization for backwards compatibility with the
// existing import flow.
function normalizePhoneNumber(phone: string): string {
    const trimmed = String(phone ?? '').trim();
    const hasIntlPrefix = trimmed.startsWith('+');
    const digits = trimmed.replace(/\D/g, '');

    if (hasIntlPrefix) {
        return digits;
    }

    if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
        const countryCode = '55';
        const ddd = digits.substring(2, 4);
        const localNumber = digits.substring(4);

        if (localNumber.length === 8) {
            return countryCode + ddd + '9' + localNumber;
        } else if (localNumber.length === 9) {
            return digits;
        }
    } else if (digits.length >= 10 && digits.length <= 11) {
        const ddd = digits.substring(0, 2);
        const localNumber = digits.substring(2);

        if (localNumber.length === 8) {
            return '55' + ddd + '9' + localNumber;
        } else {
            return '55' + digits;
        }
    }

    return digits;
}

/**
 * Variações do mesmo telefone brasileiro (com e sem o 9, com e sem o 55).
 * Mesma forma de whatsapp-webhook/index.ts:139 e echo-api/index.ts:798.
 *
 * Sem isto, o find-or-create abaixo comparava `contact_phone` por igualdade
 * exata: um disparo para um número cuja conversa foi gravada no OUTRO formato
 * não encontrava nada e criava uma conversa DUPLICADA — o unique da tabela é
 * (phone_number_id, contact_phone, is_group) e formatos diferentes não colidem.
 * É a origem de parte do trabalho que o merge_duplicate_conversations faz todo
 * minuto.
 */
function phoneVariations(phone: string): string[] {
    const digits = String(phone ?? '').replace(/\D/g, '');
    if (!digits) return [];
    const variations: string[] = [digits];

    if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
        const ddd = digits.substring(2, 4);
        const localNumber = digits.substring(4);

        variations.push(ddd + localNumber);

        if (localNumber.length === 8) {
            variations.push('55' + ddd + '9' + localNumber);
            variations.push(ddd + '9' + localNumber);
        } else if (localNumber.length === 9) {
            variations.push('55' + ddd + localNumber.substring(1));
            variations.push(ddd + localNumber.substring(1));
        }
    }

    return [...new Set(variations)];
}

// Find or create conversation for a recipient
async function findOrCreateConversation(
    supabase: any,
    phoneNumberDbId: string,
    normalizedPhone: string,
    contactName: string
): Promise<{ id: string; status: string; source: string }> {
    const variations = phoneVariations(normalizedPhone);

    // .maybeSingle() e não .single(): com .single() o caso "0 linhas" virava
    // PGRST116 no `error`, que era descartado, e o fluxo seguia para o INSERT
    // como se fosse conversa nova mesmo quando a leitura havia falhado.
    // is_group: false porque grupo tem contact_phone = jid @g.us e entra no
    // mesmo unique. A ordem torna determinística a escolha quando o banco já
    // tem duplicatas herdadas: vence a conversa com atividade mais recente.
    const findExisting = async () => {
        const { data, error } = await supabase
            .from('conversations')
            .select('id, status, source')
            .eq('phone_number_id', phoneNumberDbId)
            .in('contact_phone', variations)
            .eq('is_group', false)
            .order('last_message_at', { ascending: false, nullsFirst: false })
            .limit(1)
            .maybeSingle();
        if (error) throw error;
        return data;
    };

    const existingConv = await findExisting();
    if (existingConv) {
        return existingConv;
    }

    // Create new conversation
    const { data: newConv, error } = await supabase
        .from('conversations')
        .insert({
            phone_number_id: phoneNumberDbId,
            contact_phone: normalizedPhone,
            contact_name: contactName || normalizedPhone,
            is_group: false,
            status: 'active',
            last_message_at: new Date().toISOString(),
            source: 'broadcast', // origem da conversa; não afeta o auto-close (regra única de 30 dias)
        })
        .select('id, status, source')
        .single();

    if (error) {
        // Corrida com uma inbound criando a MESMA conversa entre o SELECT e o
        // INSERT — mesmo tratamento de whatsapp-webhook:1484/2688. Sem o
        // reselect, o disparo enviava a mensagem e a bolha nunca aparecia.
        if (error.code === '23505') {
            const raced = await findExisting();
            if (raced) return raced;
        }
        console.error('[Broadcast] Failed to create conversation:', error);
        throw error;
    }

    return newConv;
}

// Save message to conversations
async function saveMessageToConversation(
    supabase: any,
    conversation: { id: string; status: string; source: string },
    phoneNumberDbId: string,
    organizationId: string,
    templateName: string,
    templateLanguage: string,
    templateBody: string,
    whatsappMessageId: string,
    components: any[] | null,
    broadcastName: string | null,
): Promise<void> {
    // Insert message with template metadata for fallback resends
    const { data: msgData, error: msgError } = await supabase
        .from('messages')
        .insert({
            conversation_id: conversation.id,
            direction: 'outbound',
            content: templateBody, // Use just the body content
            message_type: 'template',
            whatsapp_message_id: whatsappMessageId,
            status: 'sent',
            created_at: new Date().toISOString(),
            metadata: {
                template_name: templateName,
                language_code: templateLanguage,
                components: components && components.length > 0 ? components : null,
                // Aba Disparos (gatilho on_message_inserted): o gatilho decide se a conversa entra na aba.
                disparo: { rotulo: broadcastName?.trim().slice(0, 80) || 'Disparo', origem: 'echo' },
            },
        })
        .select('id')
        .single();

    if (msgError) {
        console.error('[Broadcast) Failed to insert message:', msgError);
        throw msgError;
    }

    // Posição e status ficam com o gatilho on_message_inserted (aba Disparos),
    // que já rodou no INSERT acima: conversa em atendimento não sobe nem muda; a
    // nova, a encerrada e a parada vão para Disparos. `source` continua sem mudar
    // (regra única de 30 dias). O webhook abaixo relê a conversa já atualizada.
    if (msgData) {
        await emitMessageSent(supabase, {
            conversationId: conversation.id,
            messageId: msgData.id,
            whatsappMessageId,
            content: templateBody,
            messageType: 'template',
            sentBy: null,
            origin: 'broadcast',
            phoneNumberDbId,
            organizationId,
            templateName,
        });
    }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // S5: chamadores de serviço (cron dispatch-broadcast-work e
    // process_scheduled_broadcasts com o service_role_key do Vault; echo-api com
    // SUPABASE_SERVICE_ROLE_KEY) passam direto. O front (Broadcasts.tsx e
    // BroadcastBuilder.tsx) chama com o JWT da sessão só como "nudge" de
    // latência: aí a identidade sai do JWT e o usuário precisa ter acesso à
    // linha do disparo (conferido depois de ler o disparo). Sem nenhuma das duas
    // credenciais, rampa (EDGE_INTERNAL_AUTH_ENFORCE).
    let callerUserId: string | null = null;
    const internal = isInternalCaller(req, { jwtVerifiedByGateway: true });
    if (!internal.ok) {
        try {
            callerUserId = await requireUser(supabase, req);
        } catch {
            const denied = rampDeny('broadcast-execute', internal.reason, corsHeaders);
            if (denied) return denied;
        }
    }

    try {
        // chainDepth is accepted and ignored: the self-invocation chain is gone, replaced
        // by the pg_cron driver. Kept in the signature so an in-flight call from the old
        // deployment (or a queued pg_net request) still works during rollout.
        const { broadcastId } = await req.json();

        if (!broadcastId) {
            return new Response(
                JSON.stringify({ error: 'broadcastId is required' }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        console.log(`[Broadcast] Processing broadcast: ${broadcastId}`);

        // 1. Fetch broadcast details
        const { data: broadcast, error: broadcastError } = await supabase
            .from('broadcasts')
            .select(`
                *,
                phone_numbers (
                    id,
                    phone_number_id,
                    phone_number,
                    connection_type,
                    organization_id,
                    organizations (
                        whatsapp_access_token,
                        whatsapp_waba_id
                    )
                )
            `)
            .eq('id', broadcastId)
            .single();

        if (broadcastError || !broadcast) {
            console.error('[Broadcast] Failed to fetch broadcast:', broadcastError);
            return new Response(
                JSON.stringify({ error: 'Broadcast not found' }),
                { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // Usuário logado: só dispara o que é da linha dele. O nudge do front é
        // latência pura (o cron entrega de qualquer forma), então recusar aqui
        // nunca perde um disparo legítimo.
        if (callerUserId) {
            await requirePhoneAccess(supabase, callerUserId, broadcast.phone_number_id, broadcast.organization_id);
        }

        // Check if already completed or cancelled
        if (broadcast.status === 'completed' || broadcast.status === 'cancelled') {
            return new Response(
                JSON.stringify({ error: 'Broadcast already completed or cancelled', status: broadcast.status }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        const phoneNumber = broadcast.phone_numbers;
        const org = phoneNumber?.organizations;

        const credentialsMissing = !phoneNumber || !org?.whatsapp_access_token;

        if (credentialsMissing) {
            await supabase
                .from('broadcasts')
                .update({ status: 'failed', updated_at: new Date().toISOString() })
                .eq('id', broadcastId);

            return new Response(
                JSON.stringify({ error: 'WhatsApp credentials not configured' }),
                { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // 2. Mark as processing
        //
        // O .neq('status','cancelled') fecha a janela entre a leitura acima e
        // esta escrita: sem ele, um cancelamento que chega no meio é RESSUSCITADO
        // aqui, o driver continua alimentando workers e a campanha termina
        // inteira depois de alguém ter recebido "cancelado" com sucesso.
        await supabase
            .from('broadcasts')
            .update({ status: 'processing', started_at: broadcast.started_at || new Date().toISOString() })
            .eq('id', broadcastId)
            .neq('status', 'cancelled');

        // Get template body text from stored components
        let baseTemplateBody = '';
        if (broadcast.template_components && Array.isArray(broadcast.template_components)) {
            const bodyComponent = broadcast.template_components.find((c: any) => c.type === 'BODY');
            if (bodyComponent?.text) {
                baseTemplateBody = bodyComponent.text;
            }
        }

        let sentCount = broadcast.sent_count || 0;
        let failedCount = broadcast.failed_count || 0;
        const startTime = Date.now();
        let batchNumber = 0;

        // Adaptive send concurrency, carried across workers on the broadcasts row.
        // Raised while the provider stays healthy, slammed to the floor on the first
        // rate-limit response so we back off instead of burning recipients on 429s.
        let concurrency = Math.min(
            CONCURRENCY_MAX,
            Math.max(CONCURRENCY_MIN, broadcast.concurrency || CONCURRENCY_DEFAULT),
        );
        let throttledAt: string | null = broadcast.throttled_at || null;

        // Persisting a recipient's terminal state is the one write that must not be lost:
        // a recipient that was really sent but stays 'pending' gets picked up by the next
        // batch and messaged again (the infinite-fallback bug, caused by a
        // trigger error on an unchecked update). Retry, then say so loudly.
        const markRecipient = async (recipientId: string, patch: Record<string, unknown>) => {
            for (let attempt = 1; attempt <= 3; attempt++) {
                const { error } = await supabase.from('broadcast_recipients').update(patch).eq('id', recipientId);
                if (!error) return;
                console.error(`[Broadcast] Failed to mark recipient ${recipientId} (attempt ${attempt}/3): ${error.message}`);
                if (attempt < 3) await delay(250 * attempt);
            }
            console.error(`[Broadcast] CRITICAL: recipient ${recipientId} could not be marked ${JSON.stringify(patch)} — it may be sent again.`);
        };

        // Hand a claimed row back to the queue. Refunds the attempt so a pure rate-limit
        // (nothing was tried) does not eat the recipient's retry budget.
        const releaseClaim = async (recipientId: string) => {
            const { error } = await supabase.rpc('release_broadcast_claims', {
                p_recipient_ids: [recipientId],
                p_refund_attempt: true,
            });
            if (error) {
                // Left 'sending'; the watchdog in dispatch_broadcast_work reclaims it.
                console.error(`[Broadcast] Failed to release claim on ${recipientId}: ${error.message}`);
            }
        };

        // Recount from broadcast_recipients (the source of truth), write the terminal
        // status and build the response. Shared by both ways a run can end: the queue
        // draining, and the execution guard tripping with nothing left pending.
        const finalizeBroadcast = async () => {
            const { count: dbSent } = await supabase.from('broadcast_recipients').select('*', { count: 'exact', head: true }).eq('broadcast_id', broadcastId).eq('status', 'sent');
            const { count: dbFailed } = await supabase.from('broadcast_recipients').select('*', { count: 'exact', head: true }).eq('broadcast_id', broadcastId).eq('status', 'failed');

            const finalStatus = (dbSent === 0 && (dbFailed || 0) > 0) ? 'failed' : 'completed';
            // sent_count/failed_count are deliberately NOT written here. They are owned
            // solely by the tr_broadcast_counts_* triggers. Writing an absolute snapshot
            // from here raced those deltas and could LOWER the counter, which is how
            // production ended up reporting 718 sent against 782 real.
            //
            // .neq('status','cancelled'): 'cancelled' é um fim legítimo e não pode
            // ser sobrescrito por 'completed'. O cancelamento (RPC cancel_broadcast)
            // drena a fila, então este worker chega aqui logo depois -- e sem a
            // guarda ele reescreveria o disparo como concluído.
            const { error: finalizeError } = await supabase.from('broadcasts').update({
                status: finalStatus,
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            }).eq('id', broadcastId).neq('status', 'cancelled');

            // Never report success on a write that did not land: that is how a row ends up
            // stuck at 'processing' while the UI celebrates "Disparo concluído".
            if (finalizeError) {
                console.error('[Broadcast] Failed to write final status:', finalizeError);
                throw new Error(`Failed to finalize broadcast: ${finalizeError.message}`);
            }

            console.log(`[Broadcast] Completed! Sent: ${dbSent}, Failed: ${dbFailed}, Status: ${finalStatus}`);
            return new Response(JSON.stringify({
                success: true,
                status: finalStatus,
                sent: dbSent,
                failed: dbFailed,
                hasMore: false
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        };

        // This worker is out of time but the broadcast is not finished. Persist the
        // adapted concurrency so the next worker starts where this one left off, and
        // report what remains. The broadcast stays 'processing' on purpose: that is the
        // signal dispatch_broadcast_work() looks for.
        const respondStillWorking = async () => {
            const { count: pendingCount } = await supabase.from('broadcast_recipients')
                .select('*', { count: 'exact', head: true })
                .eq('broadcast_id', broadcastId).eq('status', 'pending');

            await supabase.from('broadcasts').update({
                concurrency: concurrency,
                throttled_at: throttledAt,
                updated_at: new Date().toISOString(),
            }).eq('id', broadcastId);

            return new Response(JSON.stringify({
                success: true,
                status: 'processing',
                hasMore: true,
                pendingRemaining: pendingCount || 0,
                concurrency,
                throttled: throttledAt !== null,
                message: 'Continuing on the next scheduler tick'
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        };

        // 3. Process ALL batches in a loop (25 recipients per batch)
        while (true) {
            batchNumber++;

            // Out of budget: hand the rest back to the cron driver. Nothing is lost --
            // every recipient is either terminal or still 'pending', and
            // dispatch_broadcast_work() picks the broadcast up on the next tick.
            const elapsedMs = Date.now() - startTime;
            if (elapsedMs > WORKER_BUDGET_MS) {
                console.log(`[Broadcast] Budget spent after ${batchNumber - 1} batches (${elapsedMs}ms). Returning; the driver will continue.`);
                return await respondStillWorking();
            }

            // Claim the next batch atomically. This is the difference between a queue and
            // a race: two workers running against the same broadcast can never take the
            // same row, so the same person can no longer be messaged twice.
            const { data: recipients, error: recipientsError } = await supabase
                .rpc('claim_broadcast_batch', { p_broadcast_id: broadcastId, p_limit: BATCH_SIZE });

            if (recipientsError) {
                console.error('[Broadcast] Failed to claim recipients:', recipientsError);
                throw new Error(`Failed to claim recipients: ${recipientsError.message}`);
            }

            // Nothing left to claim - this broadcast is done
            if (!recipients || recipients.length === 0) {
                console.log(`[Broadcast] All recipients processed after ${batchNumber - 1} batches`);
                break;
            }

            console.log(`[Broadcast] Batch ${batchNumber}: Processing ${recipients.length} recipients (concurrency=${concurrency})`);

            const sendOne = async (recipient: any): Promise<SendOutcome> => {
                try {
                    const normalizedPhone = normalizePhoneNumber(recipient.phone_number);

                    const components: any[] = [];
                    const variables = recipient.variables || [];
                    const bodyVarCount = broadcast.body_variable_count || 0;
                    const buttonVarCount = broadcast.button_variable_count || 0;

                    // Add header media component first (if template has media header)
                    const headerComponent = buildHeaderComponentFromMedia(broadcast.header_media);
                    if (headerComponent) {
                        components.push(headerComponent);
                    }

                    const bodyVariables = variables.slice(0, bodyVarCount);
                    const buttonVariables = variables.slice(bodyVarCount, bodyVarCount + buttonVarCount);

                    let personalizedBody = baseTemplateBody || broadcast.template_name;
                    bodyVariables.forEach((value: string, index: number) => {
                        // Todas as ocorrências: {{1}} repetido ficava cru no histórico.
                        personalizedBody = personalizedBody.split(`{{${index + 1}}}`).join(value || '');
                    });

                    if (broadcast.template_components) {
                        const buttonsComponent = broadcast.template_components.find((c: any) => c.type === 'BUTTONS');
                        if (buttonsComponent?.buttons && Array.isArray(buttonsComponent.buttons)) {
                            const buttonTexts: string[] = [];
                            let buttonParamIdx = 0;

                            buttonsComponent.buttons.forEach((btn: any) => {
                                if (btn.type === 'URL' && btn.url) {
                                    let url = btn.url;
                                    if (url.includes('{{') && buttonVariables[buttonParamIdx]) {
                                        url = url.replace(/\{\{\d+\}\}/g, buttonVariables[buttonParamIdx]);
                                        buttonParamIdx++;
                                    }
                                    buttonTexts.push(`[URL:${url}]${btn.text || 'Link'}`);
                                } else if (btn.type === 'PHONE_NUMBER' && btn.phone_number) {
                                    buttonTexts.push(`[PHONE:${btn.phone_number}]${btn.text || 'Call'}`);
                                } else if (btn.type === 'QUICK_REPLY') {
                                    buttonTexts.push(`[QUICK]${btn.text || 'Reply'}`);
                                }
                            });

                            if (buttonTexts.length > 0) {
                                personalizedBody += '\n\n---BUTTONS---\n' + buttonTexts.join('\n');
                            }
                        }
                    }

                    if (bodyVariables.length > 0) {
                        components.push({
                            type: 'body',
                            parameters: bodyVariables.map((value: string) => ({ type: 'text', text: value || '' }))
                        });
                    }

                    if (buttonVarCount > 0 && broadcast.template_components) {
                        const buttonsComponent = broadcast.template_components.find((c: any) => c.type === 'BUTTONS');
                        if (buttonsComponent?.buttons && Array.isArray(buttonsComponent.buttons)) {
                            let buttonParamIdx = 0;
                            buttonsComponent.buttons.forEach((btn: any, index: number) => {
                                if (btn.type === 'URL' && btn.url?.includes('{{')) {
                                    components.push({
                                        type: 'button',
                                        sub_type: 'url',
                                        index: String(index),
                                        parameters: [{ type: 'text', text: buttonVariables[buttonParamIdx] || '' }]
                                    });
                                    buttonParamIdx++;
                                }
                            });
                        }
                    }

                    const requestPayload = {
                        messaging_product: 'whatsapp',
                        to: normalizedPhone,
                        type: 'template',
                        template: {
                            name: broadcast.template_name,
                            language: { code: broadcast.template_language },
                            ...(components.length > 0 ? { components } : {}),
                        },
                    };

                    console.log(`[Broadcast] Payload for ${normalizedPhone}:`, JSON.stringify(requestPayload));

                    // Bound the provider call. Promise.allSettled waits for the slowest
                    // member of the chunk, so one hung request used to set the pace for
                    // everything behind it.
                    const response = await fetchWithTimeout(
                        `https://graph.facebook.com/v18.0/${phoneNumber.phone_number_id}/messages`,
                        {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${org.whatsapp_access_token}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify(requestPayload),
                        }
                    );

                    const result = await response.json();

                    if (response.ok && result.messages?.[0]?.id) {
                        const whatsappMessageId = result.messages[0].id;
                        await markRecipient(recipient.id, { status: 'sent', whatsapp_message_id: whatsappMessageId, sent_at: new Date().toISOString() });

                        try {
                            const conversation = await findOrCreateConversation(supabase, phoneNumber.id, normalizedPhone, recipient.contact_name || '');
                            await saveMessageToConversation(supabase, conversation, phoneNumber.id, phoneNumber.organization_id, broadcast.template_name, broadcast.template_language, personalizedBody, whatsappMessageId, components, broadcast.name ?? null);
                        } catch (convError) {
                            // Neste ponto a mensagem JÁ saiu para o contato e o
                            // destinatário JÁ está marcado 'sent' (linha acima).
                            // Falhar aqui significa: entregue no WhatsApp, ausente
                            // do CRM, e — até agora — sem nenhuma evidência além
                            // deste console.error, que ninguém lê.
                            //
                            // Não dá para reverter o envio, então o certo é deixar
                            // rastro: o check-message-failure-alerts acende o banner
                            // em ≤60s e scripts/replay-write-failures.mjs re-executa
                            // a escrita a partir deste payload.
                            console.error('[Broadcast] Conv Error:', convError);
                            await logWriteFailure(supabase, {
                                phoneNumberDbId: phoneNumber.id,
                                toJid: normalizedPhone,
                                wamid: whatsappMessageId,
                                action: 'msg_write_failed',
                                error: `${(convError as any)?.code ?? 'unknown'}: ${(convError as any)?.message ?? String(convError)}`,
                                route: 'broadcast-execute',
                                payload: {
                                    broadcast_id: broadcastId,
                                    recipient_id: recipient.id,
                                    phone_number_id: phoneNumber.id,
                                    organization_id: phoneNumber.organization_id,
                                    contact_phone: normalizedPhone,
                                    contact_name: recipient.contact_name || '',
                                    content: personalizedBody,
                                    whatsapp_message_id: whatsappMessageId,
                                    message_type: 'template',
                                    template_name: broadcast.template_name,
                                    template_language: broadcast.template_language,
                                },
                            });
                        }
                        return 'sent';
                    }

                    const errorMsg = result.error?.message || 'Unknown error';
                    const errorCode = result.error?.code;
                    console.error(`[Broadcast] Meta API Error for ${normalizedPhone} (status=${response.status}, code=${errorCode}): ${errorMsg}`);

                    // Rate limits and provider outages are not this recipient's fault.
                    // Return the claim so a later worker retries, instead of burning them.
                    if (isTransientSendFailure(response.status, errorCode) && recipient.attempts < MAX_ATTEMPTS) {
                        await releaseClaim(recipient.id);
                        return isRateLimited(response.status, errorCode) ? 'throttled' : 'retry';
                    }

                    await markRecipient(recipient.id, { status: 'failed', error_message: errorMsg });
                    return 'failed';
                } catch (err: any) {
                    const aborted = err?.name === 'AbortError';
                    console.error(`[Broadcast] Processing Error for recipient ${recipient.id}${aborted ? ' (timeout)' : ''}:`, err);

                    // A timeout is ambiguous: the message may already be on its way. Retry
                    // only while the attempt budget allows, then fail it explicitly rather
                    // than risk delivering (and charging for) the same message repeatedly.
                    if (recipient.attempts < MAX_ATTEMPTS) {
                        await releaseClaim(recipient.id);
                        return 'retry';
                    }

                    await markRecipient(recipient.id, {
                        status: 'failed',
                        error_message: aborted ? `Timeout após ${SEND_TIMEOUT_MS}ms (status de entrega desconhecido)` : (err.message || 'Unknown error'),
                    });
                    return 'failed';
                }
            };

            for (let i = 0; i < recipients.length; i += concurrency) {
                const chunk = recipients.slice(i, i + concurrency);
                const results = await Promise.allSettled(chunk.map(sendOne));

                let chunkThrottled = false;
                for (const r of results) {
                    if (r.status !== 'fulfilled') { failedCount++; continue; }
                    if (r.value === 'sent') sentCount++;
                    else if (r.value === 'failed') failedCount++;
                    else if (r.value === 'throttled') chunkThrottled = true;
                    // 'retry' and 'throttled' are back in the queue: not counted either way.
                }

                // Adaptive throughput, capped in both directions. Back off hard and
                // immediately on the first rate limit; creep back up only after the
                // provider has been quiet for a while.
                if (chunkThrottled) {
                    concurrency = CONCURRENCY_MIN;
                    throttledAt = new Date().toISOString();
                    console.warn(`[Broadcast] Rate limited. Concurrency dropped to ${concurrency}.`);
                    await delay(BATCH_DELAY_MS);
                } else if (concurrency < CONCURRENCY_MAX) {
                    const quietFor = throttledAt ? Date.now() - new Date(throttledAt).getTime() : Infinity;
                    if (quietFor > 120000) {
                        concurrency++;
                        console.log(`[Broadcast] Provider healthy. Concurrency raised to ${concurrency}.`);
                    }
                }
            }

            // A short batch means the queue is drained, so there is no next batch to pace
            // against. Sleeping here was pure dead time that pushed `elapsed` past the
            // guard on the very iteration where the work was already finished.
            if (recipients.length < BATCH_SIZE) {
                console.log(`[Broadcast] Batch ${batchNumber} complete (sent=${sentCount}, failed=${failedCount}). Queue drained.`);
                continue;
            }

            console.log(`[Broadcast] Batch ${batchNumber} complete (sent=${sentCount}, failed=${failedCount}). Waiting ${BATCH_DELAY_MS}ms...`);
            await delay(BATCH_DELAY_MS);

        } // End of while loop

        // All batches complete - recount, write the terminal status and respond
        return await finalizeBroadcast();

    } catch (error: any) {
        console.error('[Broadcast] Global Error:', error);
        return createErrorResponse(error, corsHeaders, friendlyError);
    }
});
