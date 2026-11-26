import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { requireUser } from '../_shared/authz.ts';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { fetchExterno, UrlExternaBloqueadaError } from '../_shared/url-guard.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'note not found': 'Nota não encontrada.',
    'organization not found': 'Organização não encontrada.',
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

interface NoteWebhookPayload {
    note_id: string;
    conversation_id: string;
    content: string;
    // `user_id` saiu daqui: a identidade vem do JWT verificado (requireUser).
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
        // `user_id` vinha do CORPO, numa function pública: qualquer um na
        // internet forjava "nota criada por <fulano>" e disparava o webhook da
        // organização daquele conversation_id com o nome e o e-mail de um
        // terceiro. A identidade passa a sair do JWT verificado — os dois
        // chamadores (useNotes.ts:93 e NoteDialog.tsx:47) usam
        // supabase.functions.invoke, que já envia o token da sessão.
        const userId = await requireUser(supabase, req);

        const payload: NoteWebhookPayload = await req.json();
        const { note_id, conversation_id, content } = payload;

        if (!note_id || !conversation_id || !content) {
            return new Response(JSON.stringify({ error: 'Missing required fields' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Fetch complete context data
        const { data: noteData, error: noteError } = await supabase
            .from('conversation_notes')
            .select(`
        id,
        content,
        created_at,
        created_by,
        conversation:conversations(
          id,
          contact_name,
          contact_phone,
          channel,
          phone_number:phone_numbers(
            id,
            phone_number,
            display_name,
            organization:organizations(
              id,
              name
            )
          )
        )
      `)
            .eq('id', note_id)
            .single();

        if (noteError || !noteData) {
            console.error('Error fetching note data:', noteError);
            return new Response(JSON.stringify({ error: 'Note not found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // A nota tem de ser a que ESTE usuário criou, nesta conversa. Sem isto,
        // note_id e conversation_id eram independentes e um chamador cruzava a
        // nota de uma organização com a conversa de outra.
        if (noteData.created_by !== userId || (noteData.conversation as any)?.id !== conversation_id) {
            console.warn('[note-webhook] nota não pertence ao autor/conversa informados');
            return new Response(JSON.stringify({ error: 'Note not found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Direct do Instagram: a nota fica no Echo; 'ig:<id>' não vai ao webhook como telefone.
        if ((noteData.conversation as any)?.channel === 'instagram') {
            return new Response(JSON.stringify({ skipped: true, reason: 'instagram' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Fetch agent profile
        const { data: agentData } = await supabase
            .from('profiles')
            .select('id, first_name, last_name, email')
            .eq('id', userId)
            .single();

        const conversation = noteData.conversation as any;
        const phoneNumber = conversation?.phone_number as any;
        const organization = phoneNumber?.organization as any;

        if (!organization?.id) {
            console.error('Could not determine organization from note');
            return new Response(JSON.stringify({ error: 'Organization not found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Check for registered webhook
        const { data: webhookConfig } = await supabase
            .from('organization_webhooks')
            .select('url, is_active')
            .eq('organization_id', organization.id)
            .single();

        if (!webhookConfig || !webhookConfig.is_active || !webhookConfig.url) {
            console.log('No active webhook configured for organization:', organization.id);
            return new Response(JSON.stringify({
                success: true,
                message: 'No webhook configured',
                webhook_sent: false
            }), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Build webhook payload with complete metadata
        const webhookPayload = {
            event: 'note.created',
            timestamp: new Date().toISOString(),
            data: {
                note_id: noteData.id,
                content: noteData.content,
                created_at: noteData.created_at,
            },
            agent: {
                id: agentData?.id || userId,
                name: agentData ? `${agentData.first_name || ''} ${agentData.last_name || ''}`.trim() || 'Unknown' : 'Unknown',
                email: agentData?.email || null,
            },
            contact: {
                id: conversation?.id || conversation_id,
                name: conversation?.contact_name || 'Unknown',
                phone: conversation?.contact_phone || null,
            },
            organization: {
                id: organization.id,
                name: organization.name || 'Unknown',
            },
            phone_number: {
                id: phoneNumber?.id || null,
                display_name: phoneNumber?.display_name || null,
                number: phoneNumber?.phone_number || null,
            },
        };

        console.log('Sending webhook to:', webhookConfig.url);
        console.log('Payload:', JSON.stringify(webhookPayload, null, 2));

        // Send webhook
        try {
            // URL escolhida pela organização: passa pela guarda SSRF (fetchExterno) em cada salto.
            const webhookResponse = await fetchExterno(webhookConfig.url, {
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
            // Don't fail the request if webhook fails - note was still saved
            const bloqueada = webhookError instanceof UrlExternaBloqueadaError;
            if (bloqueada) {
                console.warn(`[note-webhook] URL do webhook bloqueada pela guarda (${webhookError.reason})`);
            } else {
                console.error('Webhook delivery failed:', webhookError.message);
            }
            return new Response(JSON.stringify({
                success: true,
                webhook_sent: false,
                // Recusa da guarda não detalha o motivo ao chamador (não vira sonda da rede interna).
                webhook_error: bloqueada ? 'URL do webhook não permitida' : webhookError.message,
            }), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

    } catch (error: any) {
        return createErrorResponse(error, corsHeaders, friendlyError);
    }
});
