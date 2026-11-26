import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { recusarSeDirect } from '../_shared/canal.ts';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requirePhoneAccess, requireUser } from '../_shared/authz.ts';
import { fetchExterno, UrlExternaBloqueadaError } from '../_shared/url-guard.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'action button not found': 'Botão de ação não encontrado.',
    'conversation not found': 'Conversa não encontrada.',
    'missing required fields': 'Campos obrigatórios não preenchidos.',
    'webhook delivery failed': 'Falha ao enviar webhook. Tente novamente.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

interface ActionButtonWebhookPayload {
    conversation_id: string;
    /** Legado: o front ainda manda, mas a identidade sai do JWT (S6). */
    user_id?: string;
    button_id: string;
    button_label?: string;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        // S6: verify_jwt = false no gateway, então a identidade é conferida
        // aqui. O único chamador (useActionButton) usa functions.invoke com a
        // sessão do atendente. O `user_id` do corpo é ignorado.
        const user_id = await requireUser(supabase, req);

        const payload: ActionButtonWebhookPayload = await req.json();
        const { conversation_id, button_id } = payload;

        if (!conversation_id || !button_id) {
            return new Response(JSON.stringify({ error: 'Missing required fields: conversation_id, button_id' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
        if (payload.user_id && payload.user_id !== user_id) {
            console.warn('[action-button-webhook] user_id do corpo difere do JWT; usando o JWT');
        }
        await recusarSeDirect(supabase, [conversation_id]);

        // Fetch the specific action button by ID
        const { data: actionButtonConfig, error: btnError } = await supabase
            .from('organization_action_buttons')
            .select('id, label, url, is_active, button_type, organization_id')
            .eq('id', button_id)
            .single();

        if (btnError || !actionButtonConfig) {
            console.error('Action button not found:', btnError);
            return new Response(JSON.stringify({ error: 'Action button not found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        if (!actionButtonConfig.is_active || !actionButtonConfig.url) {
            console.log('Action button not active or missing URL:', button_id);
            return new Response(JSON.stringify({
                success: true,
                message: 'Action button not active',
                webhook_sent: false,
            }), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Fetch conversation with full context
        const { data: conversationData, error: convError } = await supabase
            .from('conversations')
            .select(`
                id,
                contact_name,
                contact_phone,
                phone_number:phone_numbers(
                    id,
                    phone_number,
                    display_name,
                    organization_id,
                    organization:organizations(
                        id,
                        name
                    )
                )
            `)
            .eq('id', conversation_id)
            .single();

        if (convError || !conversationData) {
            console.error('Error fetching conversation:', convError);
            return new Response(JSON.stringify({ error: 'Conversation not found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const phoneNumber = conversationData.phone_number as any;
        const organization = phoneNumber?.organization as any;

        // O botão tem que ser da mesma organização da conversa, e o atendente
        // precisa enxergar a linha da conversa (visibilidade é por linha).
        // Sem isso, qualquer conta lia nome e telefone de qualquer conversa
        // pelo corpo do webhook. Mesma resposta 404 para não confirmar ids.
        if (!phoneNumber?.id || !phoneNumber.organization_id
            || actionButtonConfig.organization_id !== phoneNumber.organization_id) {
            return new Response(JSON.stringify({ error: 'Conversation not found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
        await requirePhoneAccess(supabase, user_id, phoneNumber.id, phoneNumber.organization_id);

        // Fetch agent profile
        const { data: agentData } = await supabase
            .from('profiles')
            .select('id, first_name, last_name, email')
            .eq('id', user_id)
            .single();

        // Build webhook payload
        const webhookPayload = {
            event: 'action_button.clicked',
            timestamp: new Date().toISOString(),
            button_label: actionButtonConfig.label,
            contact: {
                id: conversationData.id,
                name: conversationData.contact_name || 'Unknown',
                phone: conversationData.contact_phone || null,
            },
            agent: {
                id: agentData?.id || user_id,
                name: agentData
                    ? `${agentData.first_name || ''} ${agentData.last_name || ''}`.trim() || 'Unknown'
                    : 'Unknown',
                email: agentData?.email || null,
            },
            organization: {
                id: organization?.id || null,
                name: organization?.name || 'Unknown',
            },
            phone_number: {
                id: phoneNumber?.id || null,
                display_name: phoneNumber?.display_name || null,
                number: phoneNumber?.phone_number || null,
            },
        };

        // SSRF: a URL é do tenant e a function roda dentro da rede do compose/Supabase. fetchExterno confere cada salto
        // (http/https, host público ou listado em ECHO_OUTBOUND_ALLOW_HOSTS) e segue até 3 redirecionamentos.
        try {
            const webhookResponse = await fetchExterno(actionButtonConfig.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(webhookPayload),
            });

            const responseStatus = webhookResponse.status;
            console.log('Webhook response status:', responseStatus);

            return new Response(JSON.stringify({
                success: true,
                webhook_sent: true,
                webhook_status: responseStatus,
            }), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        } catch (webhookError: any) {
            if (webhookError instanceof UrlExternaBloqueadaError) {
                console.warn(`[action-button-webhook] URL recusada pela guarda (${webhookError.reason}) no botão ${actionButtonConfig.id}`);
                return new Response(JSON.stringify({
                    success: true,
                    webhook_sent: false,
                    webhook_error: 'URL do webhook não permitida. Use um endereço público http(s).',
                }), {
                    status: 200,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }
            console.error('Webhook delivery failed:', webhookError.message);
            return new Response(JSON.stringify({
                success: true,
                webhook_sent: false,
                webhook_error: webhookError.message,
            }), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

    } catch (error: any) {
        return createErrorResponse(error, corsHeaders, friendlyError);
    }
});
