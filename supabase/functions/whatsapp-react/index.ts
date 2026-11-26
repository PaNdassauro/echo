import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { qrAuthHeaders } from '../_shared/qr.ts';
import { requireUser, requirePhoneAccess } from '../_shared/authz.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'session not connected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp.',
    'not connected': 'WhatsApp desconectado. Tente novamente.',
    'messageid and phonenumberid are required': 'Selecione uma mensagem para reagir.',
    'phone number not found': 'Número de WhatsApp não encontrado.',
    'message not found for this phone number': 'Mensagem não encontrada nesta linha.',
    'message not found': 'Mensagem não encontrada.',
    'not a member of this organization': 'Você não tem acesso a esta organização.',
    'do not have access to this phone number': 'Você não tem acesso a esta linha.',
    'not authenticated': 'Sessão expirada. Entre novamente.',
    'not supported on this channel': 'Este canal não suporta reações.',
    'whatsapp credentials not configured': 'WhatsApp não configurado.',
    'failed to send reaction': 'Falha ao enviar reação. Tente novamente.',
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
        const { messageId, phoneNumberId, emoji } = await req.json();

        if (!messageId || !phoneNumberId) {
            throw new Error('messageId and phoneNumberId are required');
        }

        const supabase = createClient(supabaseUrl, supabaseKey);

        // Resolve Phone Number ID
        const resolvedPhone = await resolvePhoneNumberId(supabase, phoneNumberId);
        if (!resolvedPhone) {
            throw new Error('Phone number not found (invalid ID or UUID)');
        }

        // Identidade vem do JWT verificado, nunca do corpo. Sem isto a function
        // só provava "tem uma conta", e qualquer usuário autenticado de qualquer
        // organização reagia usando o token de WhatsApp de outra.
        const userId = await requireUser(supabase, req);

        // Get phone number details (organization_id entra para o requirePhoneAccess)
        const { data: phoneData, error: phoneError } = await supabase
            .from('phone_numbers')
            .select('id, organization_id, connection_type, organizations(id, whatsapp_access_token)')
            .eq('id', resolvedPhone.dbId)
            .single();

        if (phoneError || !phoneData) {
            throw new Error('Phone number not found');
        }

        // Membro da organização da linha; agent precisa da linha atribuída.
        await requirePhoneAccess(supabase, userId, phoneData.id, phoneData.organization_id);

        // Get message details (include sender_jid for group messages).
        // O !inner + o filtro por conversations.phone_number_id são o que amarra
        // a mensagem À LINHA: antes o lookup era só por `id`, então um messageId
        // de qualquer organização era reagido com o token da org dona do
        // telefone. Mesmo escopo do handleReact do echo-api (index.ts:1687-1700).
        const { data: message, error: msgError } = await supabase
            .from('messages')
            .select('whatsapp_message_id, direction, sender_jid, conversations!inner(contact_phone, is_group, group_jid, phone_number_id, channel)')
            .eq('id', messageId)
            .eq('conversations.phone_number_id', phoneData.id)
            .maybeSingle();

        if (msgError || !message) {
            throw new Error('Message not found for this phone number');
        }

        const conversation = Array.isArray(message.conversations)
            ? message.conversations[0]
            : message.conversations;

        // Direct do Instagram: 'ig:<id>' não é telefone (ver _shared/canal.ts).
        if (conversation.channel === 'instagram') {
            throw new Error('Direct: esta ação só existe no WhatsApp.');
        }

        if (!message.whatsapp_message_id) {
            throw new Error('Message has no WhatsApp ID - cannot react');
        }

        // Determine recipient
        const to = conversation.is_group && conversation.group_jid
            ? conversation.group_jid
            : conversation.contact_phone;

        // fromMe = whether the message we're reacting to was sent by us
        const fromMe = message.direction === 'outbound';

        // For group messages, we need the participant JID of who sent the original message
        // For inbound: use sender_jid directly; for outbound: QR service will use own JID
        const participant = conversation.is_group && !fromMe ? message.sender_jid : undefined;

        const emojiValue = emoji || ''; // Empty string removes the reaction

        if (phoneData.connection_type === 'qr') {
            // Call QR service to send reaction
            const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
            if (!qrServiceUrl) {
                throw new Error('QR_SERVICE_URL not configured');
            }

            console.log('[WhatsApp React] Calling QR service to react to message:', message.whatsapp_message_id, 'with emoji:', emojiValue || '(remove)', 'participant:', participant);

            const qrResponse = await fetch(`${qrServiceUrl}/message/react/${phoneData.id}`, {
                method: 'POST',
                headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    to,
                    messageId: message.whatsapp_message_id,
                    emoji: emojiValue,
                    fromMe,
                    participant,
                }),
            });

            const qrData = await qrResponse.json();

            if (!qrResponse.ok || !qrData.success) {
                throw new Error(qrData.error || 'Failed to send reaction via QR service');
            }
        } else {
            // Business API: Cloud API tem mensagem `type: 'reaction'`; emoji
            // vazio remove a reação. Grupos não existem em business_api, então
            // `to` é sempre o contato.
            const org = Array.isArray(phoneData.organizations)
                ? phoneData.organizations[0]
                : phoneData.organizations;
            const accessToken = (org as { whatsapp_access_token?: string } | null)?.whatsapp_access_token;
            if (!accessToken) {
                throw new Error('WhatsApp credentials not configured for this organization');
            }

            console.log('[WhatsApp React] Sending reaction via Cloud API to message:', message.whatsapp_message_id, 'with emoji:', emojiValue || '(remove)');

            const metaResponse = await fetch(
                `https://graph.facebook.com/v18.0/${resolvedPhone.metaId}/messages`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        messaging_product: 'whatsapp',
                        recipient_type: 'individual',
                        to: conversation.contact_phone,
                        type: 'reaction',
                        reaction: {
                            message_id: message.whatsapp_message_id,
                            emoji: emojiValue,
                        },
                    }),
                },
            );

            const metaData = await metaResponse.json();
            if (!metaResponse.ok) {
                console.error('[WhatsApp React] Cloud API error:', metaData);
                throw new Error(metaData.error?.message || 'Failed to send reaction');
            }
        }

        // Update the message's our_reaction column in database
        // For inbound messages: we're reacting to contact's message
        // For outbound messages: we're reacting to our own message (less common but possible)
        const reactionValue = emojiValue || null;
        await supabase
            .from('messages')
            .update({ our_reaction: reactionValue })
            .eq('id', messageId);

        // Fan-out em message_reactions (is_from_me + reactor_jid NULL: a nossa
        // reação é uma só por mensagem — o eco do Baileys colide na mesma
        // linha em vez de duplicar). reactor_user_id vem do `userId` já
        // verificado no início: o segundo getUser que existia aqui era
        // best-effort e aceitava ausência de token, gravando NULL em vez de
        // recusar a chamada.
        try {
            await supabase
                .from('message_reactions')
                .delete()
                .eq('message_id', messageId)
                .eq('is_from_me', true)
                .is('reactor_jid', null);
            if (reactionValue) {
                await supabase.from('message_reactions').insert({
                    message_id: messageId,
                    reactor_jid: null,
                    reactor_user_id: userId,
                    is_from_me: true,
                    emoji: reactionValue,
                });
            }
        } catch (fanoutErr) {
            console.error('[WhatsApp React] Fan-out falhou (escalar segue válido):', fanoutErr);
        }

        console.log('[WhatsApp React] Reaction sent successfully');

        return new Response(JSON.stringify({ success: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    } catch (error: any) {
        console.error('Error sending reaction:', error);
        return createErrorResponse(error, corsHeaders, friendlyError);
    }
});
