import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { recusarSeDirect } from '../_shared/canal.ts';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireUser, requirePhoneAccess } from '../_shared/authz.ts';
import { qrAuthHeaders } from '../_shared/qr.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'session not connected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp.',
    'not connected': 'WhatsApp desconectado. Tente novamente.',
    'messageid and phonenumberid are required': 'Selecione uma mensagem para apagar.',
    'phone number not found': 'Número de WhatsApp não encontrado.',
    'message not found': 'Mensagem não encontrada.',
    'only supported for qr': 'Apagar mensagem só funciona com conexão QR.',
    'meta cloud api does not support': 'Apagar mensagens não é suportado pela API oficial.',
    'failed to delete': 'Falha ao apagar mensagem. Tente novamente.',
    'has no whatsapp id': 'Mensagem não pode ser apagada.',
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
        const { conversationId, messageId, phoneNumberId } = await req.json();

        if (!messageId || !phoneNumberId) {
            throw new Error('messageId and phoneNumberId are required');
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

        // Only QR connections support delete
        if (phoneData.connection_type !== 'qr') {
            throw new Error('Message deletion is only supported for QR connections. Meta Cloud API does not support this feature.');
        }

        // Get message details
        const { data: message, error: msgError } = await supabase
            .from('messages')
            .select('whatsapp_message_id, direction, conversations(contact_phone, is_group, group_jid)')
            .eq('id', messageId)
            .single();

        if (msgError || !message) {
            throw new Error('Message not found');
        }

        const conversation = Array.isArray(message.conversations)
            ? message.conversations[0]
            : message.conversations;

        if (!message.whatsapp_message_id) {
            throw new Error('Message has no WhatsApp ID - cannot delete');
        }

        // Determine recipient
        const to = conversation.is_group && conversation.group_jid
            ? conversation.group_jid
            : conversation.contact_phone;

        const fromMe = message.direction === 'outbound';

        // Call QR service to delete
        const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
        if (!qrServiceUrl) {
            throw new Error('QR_SERVICE_URL not configured');
        }

        console.log('[WhatsApp Delete] Calling QR service to delete message:', message.whatsapp_message_id);

        const qrResponse = await fetch(`${qrServiceUrl}/message/delete/${phoneData.id}`, {
            method: 'POST',
            headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                to,
                messageId: message.whatsapp_message_id,
                fromMe,
            }),
        });

        const qrData = await qrResponse.json();

        if (!qrResponse.ok || !qrData.success) {
            throw new Error(qrData.error || 'Failed to delete message via QR service');
        }

        // Soft delete: o conteúdo original é preservado, igual à rota /qr-message-deleted.
        const { error: updateError } = await supabase
            .from('messages')
            .update({
                is_deleted: true,
                deleted_at: new Date().toISOString()
            })
            .eq('id', messageId);

        if (updateError) {
            console.error('[WhatsApp Delete] Error updating message in database:', updateError);
            throw new Error(`Failed to update message in database: ${updateError.message}`);
        }

        console.log('[WhatsApp Delete] Message deleted successfully, messageId:', messageId);

        return new Response(JSON.stringify({ success: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    } catch (error: any) {
        console.error('Error deleting message:', error);
        return createErrorResponse(error, corsHeaders, friendlyError);
    }
});
