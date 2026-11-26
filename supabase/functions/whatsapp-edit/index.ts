import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { recusarSeDirect } from '../_shared/canal.ts';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireUser, requirePhoneAccess } from '../_shared/authz.ts';
import { qrAuthHeaders } from '../_shared/qr.ts';
import { registrarEdicao } from '../_shared/metadata-merge.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'session not connected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp.',
    'not connected': 'WhatsApp desconectado. Tente novamente.',
    'newcontent are required': 'Digite o novo conteúdo da mensagem.',
    'phone number not found': 'Número de WhatsApp não encontrado.',
    'message not found': 'Mensagem não encontrada.',
    'only supported for qr': 'Editar mensagem só funciona com conexão QR.',
    'meta cloud api does not support': 'Editar mensagens não é suportado pela API oficial.',
    'only edit your own': 'Você só pode editar suas próprias mensagens.',
    'failed to edit': 'Falha ao editar mensagem. Tente novamente.',
    'has no whatsapp id': 'Mensagem não pode ser editada.',
    'edit window expired': 'Mensagens só podem ser editadas até 15 minutos após o envio.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Helper to resolve phone_number_id (accepts either database UUID or Meta's phone_number_id)
    const isUUID = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

    async function resolvePhoneNumberId(supabase: any, phoneNumberIdOrUuid: string): Promise<{ metaId: string; dbId: string } | null> {
        // Only query by 'id' if it's a valid UUID to avoid Postgres syntax errors
        if (isUUID(phoneNumberIdOrUuid)) {
            const { data } = await supabase
                .from('phone_numbers')
                .select('id, phone_number_id')
                .eq('id', phoneNumberIdOrUuid)
                .maybeSingle();

            if (data) {
                return { metaId: data.phone_number_id, dbId: data.id };
            }
        }

        // Try by Meta's phone_number_id
        const { data: dataByMeta } = await supabase
            .from('phone_numbers')
            .select('id, phone_number_id')
            .eq('phone_number_id', phoneNumberIdOrUuid)
            .maybeSingle();

        if (dataByMeta) {
            return { metaId: dataByMeta.phone_number_id, dbId: dataByMeta.id };
        }

        return null;
    }

    try {
        const { conversationId, messageId, phoneNumberId, newContent } = await req.json();

        if (!messageId || !phoneNumberId || !newContent) {
            throw new Error('messageId, phoneNumberId and newContent are required');
        }

        const supabase = createClient(supabaseUrl, supabaseKey);
        await recusarSeDirect(supabase, [conversationId]);

        // Identity comes from the verified JWT, never from the request body.
        const userId = await requireUser(supabase, req);

        // Resolve Phone Number ID
        const resolvedPhone = await resolvePhoneNumberId(supabase, phoneNumberId);
        if (!resolvedPhone) {
            throw new Error('Phone number not found (invalid ID or UUID)');
        }

        // Get phone number details
        const { data: phoneData, error: phoneError } = await supabase
            .from('phone_numbers')
            .select('id, connection_type, organization_id')
            .eq('id', resolvedPhone.dbId)
            .single();

        if (phoneError || !phoneData) {
            throw new Error('Phone number not found');
        }

        // The caller must belong to the org that owns this number.
        await requirePhoneAccess(supabase, userId, phoneData.id, phoneData.organization_id);

        // Only QR connections support edit
        if (phoneData.connection_type !== 'qr') {
            throw new Error('Message editing is only supported for QR connections. Meta Cloud API does not support this feature.');
        }

        // Get message details
        const { data: message, error: msgError } = await supabase
            .from('messages')
            .select('whatsapp_message_id, direction, message_type, created_at, content, conversations(contact_phone, is_group, group_jid)')
            .eq('id', messageId)
            .single();

        if (msgError || !message) {
            throw new Error('Message not found');
        }

        // Can only edit your own messages
        if (message.direction !== 'outbound') {
            throw new Error('You can only edit your own messages');
        }

        // WhatsApp only allows editing within 15 minutes of sending.
        // Reject early to surface a friendly error instead of relying on WhatsApp's generic failure.
        const WHATSAPP_EDIT_WINDOW_MS = 15 * 60 * 1000;
        const sentAtMs = new Date(message.created_at).getTime();
        if (!Number.isFinite(sentAtMs) || Date.now() - sentAtMs > WHATSAPP_EDIT_WINDOW_MS) {
            throw new Error('Edit window expired: messages can only be edited within 15 minutes of sending');
        }

        const conversation = Array.isArray(message.conversations)
            ? message.conversations[0]
            : message.conversations;

        if (!message.whatsapp_message_id) {
            throw new Error('Message has no WhatsApp ID - cannot edit');
        }

        // Determine recipient
        const to = conversation.is_group && conversation.group_jid
            ? conversation.group_jid
            : conversation.contact_phone;

        // Call QR service to edit
        const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
        if (!qrServiceUrl) {
            throw new Error('QR_SERVICE_URL not configured');
        }

        console.log('[WhatsApp Edit] Calling QR service to edit message:', message.whatsapp_message_id);

        // Determine if it's a media message (caption edit) or text message
        const isMediaMessage = message.message_type && ['image', 'video', 'document', 'audio', 'sticker'].includes(message.message_type);

        const qrResponse = await fetch(`${qrServiceUrl}/message/edit/${phoneData.id}`, {
            method: 'POST',
            headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                to,
                messageId: message.whatsapp_message_id,
                newContent,
                isMediaMessage,
            }),
        });

        const qrData = await qrResponse.json();

        if (!qrResponse.ok || !qrData.success) {
            throw new Error(qrData.error || 'Failed to edit message via QR service');
        }

        // Update message in database. Marca is_edited/edited_at e guarda a versão anterior igual
        // à rota /qr-message-edited — antes só o content mudava, então a mensagem editada pelo
        // painel era a única que não ganhava o selo de "editado".
        const editedAt = new Date().toISOString();
        // Numa UPDATE só (RPC), sem ler metadata antes: a transcrição escreve leitura na
        // mesma linha. A edição já saiu pelo WhatsApp, então falha aqui só é logada (como antes).
        try {
            await registrarEdicao(supabase, messageId, newContent, editedAt, false);
        } catch (updateError) {
            console.error('[WhatsApp Edit] Failed to record edit in database:', updateError);
        }

        console.log('[WhatsApp Edit] Message edited successfully');

        return new Response(JSON.stringify({ success: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    } catch (error: any) {
        console.error('Error editing message:', error);
        return createErrorResponse(error, corsHeaders, friendlyError);
    }
});
