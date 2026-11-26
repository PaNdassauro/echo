import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { qrAuthHeaders } from '../_shared/qr.ts';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { checkInternalCaller } from '../_shared/authz.ts';
import { fetchExterno, UrlExternaBloqueadaError } from '../_shared/url-guard.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SURVEY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface SurveyAnswer {
    questionId: string;
    question: string;
    answer: string;
    selectionId: string | null;
    answeredAt: string;
}

interface SurveyState {
    questionIndex: number;
    answers: SurveyAnswer[];
    startedAt: string;
    lastQuestionSentAt?: string;
    reminderSentAt?: string | null;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    // S5: só serviço. O destino e o texto saem do banco, mas a chamada dispara
    // envio pelo WhatsApp. process_survey_timeouts() (cron 8) chama com um JWT
    // literal no corpo da função (não lê o Vault). O papel desse JWT não foi
    // conferido: o log da rampa mostra (jwt_anon = trocar para o Vault antes do
    // enforce).
    // verify_jwt = true (padrão; ver config.toml).
    const denied = checkInternalCaller(req, 'survey-timeout-execute', {
        jwtVerifiedByGateway: true,
        headers: corsHeaders,
    });
    if (denied) return denied;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        // Fetch all active sessions that haven't expired
        // We filter for survey context in JS because JSONB path filters
        // (context->survey) are unreliable in PostgREST
        const { data: sessions, error } = await supabase
            .from('automation_sessions')
            .select(`
                id,
                flow_id,
                conversation_id,
                current_node_id,
                context,
                automation_flows!inner (
                    id,
                    flow_data
                )
            `)
            .eq('status', 'active')
            .gt('expires_at', new Date().toISOString());

        if (error) {
            throw new Error(`Failed to fetch sessions: ${error.message}`);
        }

        if (!sessions || sessions.length === 0) {
            return jsonResponse({ success: true, processed: 0 });
        }

        const now = Date.now();
        let processed = 0;
        const errors: string[] = [];

        for (const session of sessions) {
            try {
                const surveyState = session.context?.survey as SurveyState | undefined;
                if (!surveyState?.startedAt) continue;

                const elapsed = now - new Date(surveyState.startedAt).getTime();
                if (elapsed > SURVEY_TIMEOUT_MS) {
                    // This session has timed out — process it
                    await processTimedOutSurvey(supabase, session, surveyState);
                    processed++;
                    continue;
                }

                // Not timed out yet — check if a reminder is due
                const reminderFired = await maybeSendReminder(supabase, session, surveyState, now);
                if (reminderFired) processed++;
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[SurveyTimeout] Error processing session ${session.id}:`, message);
                errors.push(`${session.id}: ${message}`);
            }
        }

        console.log(`[SurveyTimeout] Done. Processed: ${processed}, Errors: ${errors.length}`);
        return jsonResponse({ success: true, processed, errors: errors.length > 0 ? errors : undefined });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[SurveyTimeout] Fatal error:', message);
        return new Response(
            JSON.stringify({ success: false, error: message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});

async function processTimedOutSurvey(
    supabase: SupabaseClient,
    session: Record<string, unknown>,
    surveyState: SurveyState
): Promise<void> {
    console.log(`[SurveyTimeout] Processing timed-out session: ${session.id}`);

    // Resolve the survey node from flow_data
    const flow = session.automation_flows as Record<string, unknown>;
    const flowData = typeof flow.flow_data === 'string'
        ? JSON.parse(flow.flow_data)
        : flow.flow_data;

    const nodes = (flowData?.nodes || []) as Array<{ id: string; type: string; data: Record<string, unknown> }>;
    const surveyNode = nodes.find(
        (n) => n.id === session.current_node_id && n.type === 'surveyNode'
    );

    if (!surveyNode) {
        console.warn(`[SurveyTimeout] Session ${session.id}: current node is not a surveyNode, ending session`);
        await endSession(supabase, session.id as string);
        return;
    }

    // Send webhook if configured
    if (surveyNode.data.webhookUrl) {
        await sendSurveyWebhook(supabase, session, surveyNode, surveyState);
    }

    // End the session
    await endSession(supabase, session.id as string);
}

async function sendSurveyWebhook(
    supabase: SupabaseClient,
    session: Record<string, unknown>,
    node: { id: string; type: string; data: Record<string, unknown> },
    surveyState: SurveyState
): Promise<void> {
    const url = node.data.webhookUrl as string;
    if (!url) return;

    try {
        // Get conversation + phone_number data for contact info and org_id
        const { data: conversation } = await supabase
            .from('conversations')
            .select('contact_name, contact_phone, phone_number_id')
            .eq('id', session.conversation_id)
            .single();

        let organizationId: string | null = null;
        if (conversation?.phone_number_id) {
            const { data: phoneNumber } = await supabase
                .from('phone_numbers')
                .select('organization_id')
                .eq('id', conversation.phone_number_id)
                .single();
            organizationId = phoneNumber?.organization_id || null;
        }

        // Same payload format as sendSurveyWebhook() in automation-execute
        const payload = {
            event: 'automation.survey_completed',
            timed_out: true,
            timestamp: new Date().toISOString(),
            organization_id: organizationId,
            conversation_id: session.conversation_id,
            flow_id: session.flow_id,
            session_id: session.id,
            node_id: node.id,
            contact: {
                name: conversation?.contact_name,
                phone: conversation?.contact_phone,
            },
            survey: {
                questions: node.data.questions,
                answers: surveyState.answers || [],
            },
        };

        // URL escolhida por quem monta o fluxo: passa pela guarda SSRF (fetchExterno) em cada salto.
        const response = await fetchExterno(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Echo-Automation-Survey/1.0',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            // Só o status vai para o log: o corpo é de um servidor que o tenant escolheu.
            console.error(`[SurveyTimeout] Webhook failed: ${response.status}`);
        } else {
            console.log(`[SurveyTimeout] Webhook sent to ${url} for session ${session.id}`);
        }
    } catch (error) {
        // Don't rethrow — we still want to end the session even if webhook fails
        if (error instanceof UrlExternaBloqueadaError) {
            console.warn(`[SurveyTimeout] URL do webhook bloqueada pela guarda (${error.reason})`);
        } else {
            console.error('[SurveyTimeout] Error sending webhook:', error);
        }
    }
}

async function endSession(supabase: SupabaseClient, sessionId: string): Promise<void> {
    await supabase
        .from('automation_sessions')
        .update({
            status: 'completed',
            context: {},
            updated_at: new Date().toISOString(),
        })
        .eq('id', sessionId);

    console.log(`[SurveyTimeout] Session ${sessionId} ended as completed`);
}

function jsonResponse(data: Record<string, unknown>): Response {
    return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

async function maybeSendReminder(
    supabase: SupabaseClient,
    session: Record<string, unknown>,
    surveyState: SurveyState,
    now: number
): Promise<boolean> {
    if (surveyState.reminderSentAt) return false;

    // Resolve the survey node from flow_data to read reminder config
    const flow = session.automation_flows as Record<string, unknown>;
    const flowData = typeof flow.flow_data === 'string'
        ? JSON.parse(flow.flow_data)
        : flow.flow_data;

    const nodes = (flowData?.nodes || []) as Array<{ id: string; type: string; data: Record<string, unknown> }>;
    const surveyNode = nodes.find(
        (n) => n.id === session.current_node_id && n.type === 'surveyNode'
    );
    if (!surveyNode) return false;

    const reminderMessage = (surveyNode.data.reminderMessage as string | undefined)?.trim();
    const reminderDelayMinutes = Number(surveyNode.data.reminderDelayMinutes ?? 0);
    if (!reminderMessage || !reminderDelayMinutes || reminderDelayMinutes <= 0) return false;

    const referenceTs = surveyState.lastQuestionSentAt || surveyState.startedAt;
    const elapsedSinceQuestion = now - new Date(referenceTs).getTime();
    if (elapsedSinceQuestion < reminderDelayMinutes * 60 * 1000) return false;

    console.log(`[SurveyReminder] Sending reminder for session ${session.id}`);
    const sentAt = new Date(now).toISOString();
    await sendReminderMessage(supabase, session, reminderMessage);

    // Persist reminderSentAt regardless of send success — avoid re-firing every minute on failures
    const newContext = {
        ...(session.context as Record<string, unknown> || {}),
        survey: { ...surveyState, reminderSentAt: sentAt },
    };
    await supabase
        .from('automation_sessions')
        .update({ context: newContext, updated_at: sentAt })
        .eq('id', session.id);

    return true;
}

async function sendReminderMessage(
    supabase: SupabaseClient,
    session: Record<string, unknown>,
    text: string
): Promise<void> {
    try {
        const { data: conversation } = await supabase
            .from('conversations')
            .select('contact_phone, phone_number_id, channel')
            .eq('id', session.conversation_id)
            .single();

        if (!conversation?.contact_phone || !conversation.phone_number_id) {
            console.error(`[SurveyReminder] Missing contact/phone for session ${session.id}`);
            return;
        }

        // Direct do Instagram: 'ig:<id>' não é telefone (ver _shared/canal.ts).
        if (conversation.channel === 'instagram') {
            console.warn(`[SurveyReminder] Skipping Instagram Direct conversation for session ${session.id}`);
            return;
        }

        const { data: phoneData } = await supabase
            .from('phone_numbers')
            .select(`
                id,
                phone_number_id,
                connection_type,
                organization_id,
                organizations ( whatsapp_access_token )
            `)
            .eq('id', conversation.phone_number_id)
            .single();

        if (!phoneData) {
            console.error(`[SurveyReminder] Phone number row not found for session ${session.id}`);
            return;
        }

        const org = (phoneData as Record<string, unknown>).organizations as
            | { whatsapp_access_token?: string }
            | { whatsapp_access_token?: string }[]
            | undefined;
        const orgRow = Array.isArray(org) ? org[0] : org;
        const accessToken = orgRow?.whatsapp_access_token;

        let whatsappMessageId: string | null = null;

        if (phoneData.connection_type === 'qr') {
            const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
            if (!qrServiceUrl) {
                console.error('[SurveyReminder] QR_SERVICE_URL not configured');
                return;
            }
            const response = await fetch(`${qrServiceUrl}/message/send/${phoneData.id}`, {
                method: 'POST',
                headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ to: conversation.contact_phone, content: text }),
            });
            const data = await response.json();
            whatsappMessageId = data.messageId || (data.success ? `qr_${Date.now()}` : null);
        } else {
            if (!accessToken) {
                console.error(`[SurveyReminder] Missing access token for session ${session.id}`);
                return;
            }
            const response = await fetch(
                `https://graph.facebook.com/v18.0/${phoneData.phone_number_id}/messages`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        messaging_product: 'whatsapp',
                        to: conversation.contact_phone,
                        type: 'text',
                        text: { body: text },
                    }),
                }
            );
            const data = await response.json();
            whatsappMessageId = data.messages?.[0]?.id || null;
            if (!response.ok) {
                console.error(`[SurveyReminder] Meta API error ${response.status}:`, data);
            }
        }

        if (whatsappMessageId) {
            const { data: savedMessage, error: saveError } = await supabase
                .from('messages')
                .insert({
                    conversation_id: session.conversation_id,
                    content: text,
                    direction: 'outbound',
                    whatsapp_message_id: whatsappMessageId,
                    message_type: 'text',
                    // Lembrete automático da pesquisa não é gente agindo (aba Disparos).
                    metadata: { automacao: true },
                })
                .select('id')
                .maybeSingle();
            if (saveError) console.error('[SurveyReminder] Failed to save message row:', saveError);

            if (savedMessage) {
                await emitMessageSent(supabase, {
                    conversationId: session.conversation_id as string,
                    messageId: savedMessage.id,
                    whatsappMessageId,
                    content: text,
                    messageType: 'text',
                    sentBy: null,
                    origin: 'automation',
                    phoneNumberDbId: phoneData.id,
                    organizationId: phoneData.organization_id,
                    metaPhoneNumberId: phoneData.phone_number_id,
                });
            }
        }
    } catch (error) {
        console.error('[SurveyReminder] Error sending reminder:', error);
    }
}
