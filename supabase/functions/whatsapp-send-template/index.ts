import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { recusarSeDirect } from '../_shared/canal.ts';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { reativarConversa } from '../_shared/conversation-touch.ts';
import { sendMetaTypingIndicator, getLatestInboundWamid } from '../_shared/meta-typing-indicator.ts';
import { requireUser, requirePhoneAccess } from '../_shared/authz.ts';
import { logWriteFailure } from '../_shared/failure-log.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'phonenumberid is required': 'Selecione um número de WhatsApp para enviar.',
    'phone number not found': 'Número de WhatsApp não encontrado.',
    'no whatsapp access token': 'WhatsApp não configurado. Verifique as configurações.',
    'failed to send template': 'Falha ao enviar template. Verifique se está aprovado.',
    'template not found': 'Template não encontrado ou não aprovado.',
    'parameter': 'Erro nos parâmetros do template. Verifique os valores.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

// Helper to check if string is valid UUID
const isUUID = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

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

// Helper to resolve phone_number_id (accepts either database UUID or Meta's phone_number_id)
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

  // Try to find by Meta's phone_number_id
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // `userId` NÃO sai mais do corpo: ele era gravado direto em messages.sent_by
    // sem nenhuma checagem, então qualquer JWT válido enviava template pela linha
    // de outra organização assinando com o nome de um terceiro.
    const { to, templateName, languageCode, conversationId, components, messageContent, phoneNumberId, headerMedia } = await req.json();
    await recusarSeDirect(supabase, [conversationId]);

    if (!phoneNumberId) {
      throw new Error('phoneNumberId is required');
    }

    // Identidade do JWT verificado. verify_jwt (default true, sem entrada no
    // config.toml) só provava "tem uma conta"; não provava acesso a ESTA linha.
    const userId = await requireUser(supabase, req);

    // Find phone number and associated organization credentials
    // const supabase = createClient(supabaseUrl, supabaseKey); // Removed duplicate declaration

    const resolvedPhone = await resolvePhoneNumberId(supabase, phoneNumberId);
    if (!resolvedPhone) {
      throw new Error(`Phone number not found (invalid ID or UUID): ${phoneNumberId}`);
    }

    const { data: phoneNumberData, error: phoneError } = await supabase
      .from('phone_numbers')
      .select(`
        id,
        organization_id,
        typing_indicator_enabled,
        organization:organizations (
          id,
          whatsapp_access_token,
          whatsapp_waba_id
        )
      `)
      .eq('id', resolvedPhone.dbId)
      .single();

    if (phoneError || !phoneNumberData || !phoneNumberData.organization) {
      console.error('Phone number not found or not linked to org:', phoneError);
      throw new Error(`Phone number ${phoneNumberId} not registered or missing organization link.`);
    }

    // Membro da organização da linha; agent precisa da linha atribuída.
    await requirePhoneAccess(supabase, userId, phoneNumberData.id, phoneNumberData.organization_id);

    // conversationId também vem do corpo: sem esta amarração a bolha outbound
    // era gravada dentro da conversa de outra organização (e o webhook
    // message.sent daquela org disparava com os dados do contato dela).
    // Mesma checagem de whatsapp-send-poll/index.ts:94-100.
    if (conversationId) {
      const { data: convScope, error: convScopeError } = await supabase
        .from('conversations')
        .select('id, phone_number_id')
        .eq('id', conversationId)
        .maybeSingle();

      if (convScopeError) {
        console.error('Erro ao validar conversa:', convScopeError);
        throw new Error('Failed to validate conversation');
      }
      if (!convScope || convScope.phone_number_id !== phoneNumberData.id) {
        throw new Error('Unauthorized: conversa não pertence a este número');
      }
    }

    const org = phoneNumberData.organization as any;
    const accessToken = org.whatsapp_access_token;

    // We also need metaPhoneNumberId for the API call later
    const metaPhoneNumberId = resolvedPhone.metaId;

    if (!accessToken) {
      throw new Error(`Organization ${org.id} has no WhatsApp Access Token configured.`);
    }

    console.log('Sending template to:', to, 'Template:', templateName, 'from phone:', phoneNumberId);

    // Build template object
    const templateObj: any = {
      name: templateName,
      language: {
        code: languageCode || 'pt_BR',
      },
    };

    // Build the final components array. If `headerMedia` is provided, the server
    // builds the header component authoritatively (replacing any header from the
    // client). This guards against stale/buggy clients that send a malformed
    // header — Meta returns "received UNKNOWN" in that case.
    const baseComponents: any[] = Array.isArray(components) ? [...components] : [];
    const headerComp = buildHeaderComponentFromMedia(headerMedia);
    let finalComponents: any[];
    if (headerComp) {
      finalComponents = baseComponents.filter((c: any) => c?.type !== 'header');
      finalComponents.unshift(headerComp);
    } else {
      finalComponents = baseComponents;
    }

    if (finalComponents.length > 0) {
      templateObj.components = finalComponents;
    }

    console.log('[send-template] Final payload:', JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: templateObj,
    }, null, 2));

    // Disparo condicional do typing indicator (apenas se habilitado no número e houver inbound recente em 24h)
    if (conversationId && (phoneNumberData as any).typing_indicator_enabled) {
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      void (async () => {
        try {
          const inboundWamid = await getLatestInboundWamid(supabase, conversationId, {
            maxAgeMs: TWENTY_FOUR_HOURS_MS,
          });
          if (inboundWamid) {
            await sendMetaTypingIndicator({
              accessToken,
              metaPhoneNumberId,
              inboundMessageId: inboundWamid,
            });
          }
        } catch (typingErr) {
          console.warn('[whatsapp-send-template] Error sending typing indicator:', typingErr);
        }
      })();
    }


    // Send template via WhatsApp API
    const whatsappResponse = await fetch(
      `https://graph.facebook.com/v18.0/${metaPhoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to,
          type: 'template',
          template: templateObj,
        }),
      }
    );

    const whatsappData = await whatsappResponse.json();

    if (!whatsappResponse.ok) {
      console.error('WhatsApp API error:', whatsappData);
      throw new Error(whatsappData.error?.message || 'Failed to send template');
    }

    console.log('Template sent successfully:', whatsappData);

    // Save to database with the actual message content and template metadata for fallback resends
    // const supabase = createClient(supabaseUrl, supabaseKey); // Removed duplicate declaration

    const { data: msgData, error: msgError } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      content: messageContent || templateName,
      direction: 'outbound',
      sent_by: userId,
      message_type: 'template',
      whatsapp_message_id: whatsappData.messages[0].id,
      metadata: {
        template_name: templateName,
        language_code: languageCode || 'pt_BR',
        components: finalComponents.length > 0 ? finalComponents : null,
        header_media: headerMedia || null,
      },
    }).select().single();

    if (msgError) {
      // A mensagem JÁ saiu para o contato: um insert falho aqui é a bolha
      // sumindo do CRM sem deixar rastro — a mesma classe de perda silenciosa
      // que o whatsapp-send já cobre (index.ts:485). A evidência acende o
      // banner do check-message-failure-alerts em ≤60s e o payload é
      // replayável por scripts/replay-write-failures.mjs.
      //
      // A resposta continua 200 de propósito: um 5xx faria o agente reenviar e
      // duplicar a mensagem no contato, que é pior que a bolha faltando.
      console.error('Error saving message to DB:', msgError);
      await logWriteFailure(supabase, {
        phoneNumberDbId: resolvedPhone.dbId,
        toJid: String(to ?? 'unknown'),
        wamid: whatsappData.messages?.[0]?.id ?? null,
        action: 'msg_write_failed',
        error: `${msgError.code ?? 'unknown'}: ${msgError.message}`,
        route: 'whatsapp-send-template',
        payload: {
          conversation_id: conversationId,
          content: messageContent || templateName,
          direction: 'outbound',
          sent_by: userId,
          message_type: 'template',
          whatsapp_message_id: whatsappData.messages?.[0]?.id ?? null,
          metadata: {
            template_name: templateName,
            language_code: languageCode || 'pt_BR',
            components: finalComponents.length > 0 ? finalComponents : null,
            header_media: headerMedia || null,
          },
        },
      });
    } else {
      console.log('Message saved to DB:', msgData);
    }

    // Update conversation. O trigger on_message_inserted já avançou
    // last_message_at no insert; aqui só reabre, e só se não estiver 'active' (D1).
    await reativarConversa(supabase, conversationId);

    if (msgData) {
      await emitMessageSent(supabase, {
        conversationId,
        messageId: msgData.id,
        whatsappMessageId: whatsappData.messages[0].id,
        content: messageContent || templateName,
        messageType: 'template',
        sentBy: userId,
        origin: 'panel',
        phoneNumberDbId: resolvedPhone.dbId,
        organizationId: org?.id,
        metaPhoneNumberId,
        templateName,
      });
    }

    return new Response(JSON.stringify({ ...whatsappData, savedMessage: msgData }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
