// Envio de localização (pino fixo) — ambos os canais.
// QR: rota /message/send-location do qr-service (Baileys locationMessage).
// Cloud API: type:location. Linha gravada com metadata.location estruturado
// (a LocationBubble renderiza dele; a string em content é o fallback legado).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { recusarSeDirect } from '../_shared/canal.ts';
import { z } from 'https://esm.sh/zod@3.23.8';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireUser, requirePhoneAccess } from '../_shared/authz.ts';
import { qrAuthHeaders } from '../_shared/qr.ts';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { reativarConversa } from '../_shared/conversation-touch.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'session not connected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp.',
    'not connected': 'WhatsApp desconectado. Tente novamente.',
    'phone number not found': 'Número de WhatsApp não encontrado.',
    'qr service unreachable': 'Serviço temporariamente indisponível. Tente novamente.',
    'whatsapp credentials not configured': 'WhatsApp não configurado.',
    'failed to send location': 'Falha ao enviar localização. Tente novamente.',
  };
  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) return value;
  }
  return `Erro: ${error}`;
}

const isUUID = (str: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

const InputSchema = z.object({
  to: z.string().min(5).max(64),
  conversationId: z.string().uuid(),
  phoneNumberId: z.string().min(1).max(64),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: z.string().trim().max(512).nullish(),
  address: z.string().trim().max(512).nullish(),
  quotedMessageId: z.string().uuid().nullish(),
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  try {
    const parsed = InputSchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: `Entrada inválida: ${parsed.error.issues.map((i) => i.message).join('; ')}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    const { to, conversationId, phoneNumberId, latitude, longitude, name, address, quotedMessageId } = parsed.data;

    const supabase = createClient(supabaseUrl, supabaseKey);
    await recusarSeDirect(supabase, [conversationId]);
    const userId = await requireUser(supabase, req);

    let phoneData: {
      id: string;
      phone_number_id: string | null;
      organization_id: string;
      connection_type: string | null;
      organizations: { whatsapp_access_token: string | null } | { whatsapp_access_token: string | null }[] | null;
    } | null = null;

    if (isUUID(phoneNumberId)) {
      const { data } = await supabase
        .from('phone_numbers')
        .select('id, phone_number_id, organization_id, connection_type, organizations (whatsapp_access_token)')
        .eq('id', phoneNumberId)
        .maybeSingle();
      phoneData = data;
    }
    if (!phoneData) {
      const { data } = await supabase
        .from('phone_numbers')
        .select('id, phone_number_id, organization_id, connection_type, organizations (whatsapp_access_token)')
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle();
      phoneData = data;
    }
    if (!phoneData) {
      throw new Error('Phone number not found');
    }

    await requirePhoneAccess(supabase, userId, phoneData.id, phoneData.organization_id);

    const { data: conversation } = await supabase
      .from('conversations')
      .select('id, phone_number_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conversation || conversation.phone_number_id !== phoneData.id) {
      throw new Error('Conversa não pertence a este número');
    }

    // Quote (opcional)
    let quotedWhatsappId: string | null = null;
    let quotedContent: string | null = null;
    let quotedFromMe = false;
    let quotedParticipant: string | null = null;
    if (quotedMessageId) {
      const { data: quotedMsg } = await supabase
        .from('messages')
        .select('whatsapp_message_id, content, direction, sender_phone, conversation_id')
        .eq('id', quotedMessageId)
        .maybeSingle();
      if (quotedMsg && quotedMsg.conversation_id === conversationId) {
        quotedWhatsappId = quotedMsg.whatsapp_message_id;
        quotedContent = quotedMsg.content;
        quotedFromMe = quotedMsg.direction === 'outbound';
        quotedParticipant = quotedMsg.sender_phone ? `${quotedMsg.sender_phone.replace(/\D/g, '')}@s.whatsapp.net` : null;
      }
    }

    let whatsappMessageId: string;

    if (phoneData.connection_type === 'qr') {
      const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
      if (!qrServiceUrl) {
        throw new Error('QR_SERVICE_URL not configured');
      }

      let qrResponse: Response;
      try {
        qrResponse = await fetch(`${qrServiceUrl}/message/send-location/${phoneData.id}`, {
          method: 'POST',
          headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            to,
            latitude,
            longitude,
            name: name ?? undefined,
            address: address ?? undefined,
            quotedMessageId: quotedWhatsappId,
            quotedContent,
            quotedFromMe,
            quotedParticipant,
            skipSave: true,
          }),
        });
      } catch (fetchErr: unknown) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        throw new Error(`QR service unreachable: ${msg}`);
      }

      const qrData = await qrResponse.json();
      if (!qrResponse.ok || !qrData.success) {
        throw new Error(qrData.error || 'Failed to send location');
      }
      whatsappMessageId = qrData.messageId || `qr_${Date.now()}`;
    } else {
      const org = phoneData.organizations;
      const orgData = Array.isArray(org) ? org[0] : org;
      const accessToken = orgData?.whatsapp_access_token;
      if (!accessToken) {
        throw new Error('WhatsApp credentials not configured for this organization');
      }

      const messageBody = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'location',
        ...(quotedWhatsappId ? { context: { message_id: quotedWhatsappId } } : {}),
        location: {
          latitude,
          longitude,
          ...(name ? { name } : {}),
          ...(address ? { address } : {}),
        },
      };

      const whatsappResponse = await fetch(
        `https://graph.facebook.com/v18.0/${phoneData.phone_number_id}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(messageBody),
        },
      );

      const whatsappData = await whatsappResponse.json();
      if (!whatsappResponse.ok) {
        console.error('[SendLocation] WhatsApp API error:', whatsappData);
        throw new Error(whatsappData.error?.message || 'Failed to send location');
      }
      whatsappMessageId = whatsappData.messages[0].id;
    }

    const messageContent = name ? `[Localização: ${name}]` : `[Localização: ${latitude}, ${longitude}]`;

    const { data: newMessage, error: msgError } = await supabase
      .from('messages')
      .upsert({
        conversation_id: conversationId,
        content: messageContent,
        direction: 'outbound',
        sent_by: userId,
        whatsapp_message_id: whatsappMessageId,
        message_type: 'location',
        metadata: {
          location: { lat: latitude, lng: longitude, name: name ?? null, address: address ?? null },
        },
        quoted_message_id: quotedWhatsappId ? quotedMessageId : null,
      }, {
        onConflict: 'whatsapp_message_id,conversation_id',
        ignoreDuplicates: true,
      })
      .select()
      .maybeSingle();

    if (msgError) {
      console.error('[SendLocation] Error saving message to DB:', msgError);
    }

    // Update conversation. O trigger on_message_inserted já avançou
    // last_message_at no insert; aqui só reabre, e só se não estiver 'active' (D1).
    await reativarConversa(supabase, conversationId);

    if (newMessage) {
      await emitMessageSent(supabase, {
        conversationId,
        messageId: newMessage.id,
        whatsappMessageId,
        content: messageContent,
        messageType: 'location',
        sentBy: userId,
        origin: 'panel',
        phoneNumberDbId: phoneData.id,
        organizationId: phoneData.organization_id,
        metaPhoneNumberId: phoneData.phone_number_id,
        quotedMessageId: quotedWhatsappId ? quotedMessageId : null,
        quotedWhatsappId,
        quotedContent,
      });
    }

    return new Response(
      JSON.stringify({ success: true, messageId: whatsappMessageId, message: newMessage }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: unknown) {
    console.error('[SendLocation] Error:', error);
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
