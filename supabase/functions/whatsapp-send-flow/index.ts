import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { recusarSeDirect } from '../_shared/canal.ts';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { reativarConversa } from '../_shared/conversation-touch.ts';
import { requireUser, requirePhoneAccess } from '../_shared/authz.ts';
import { logWriteFailure } from '../_shared/failure-log.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'phonenumberid is required': 'Selecione um número de WhatsApp.',
    'templatename is required': 'Selecione um template.',
    'phone number not found': 'Número de WhatsApp não encontrado.',
    'no whatsapp access token': 'WhatsApp não configurado.',
    'failed to send flow': 'Falha ao enviar formulário. Tente novamente.',
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

interface FlowPayload {
  to: string;
  phoneNumberId: string;
  conversationId: string;
  // `userId` saiu daqui de propósito: a identidade vem do JWT verificado
  // (requireUser), nunca do corpo. Antes ela ia direto para messages.sent_by.
  // Template-based flow sending
  templateName: string;
  languageCode: string;
  flowButtonIndex?: number;
  flowToken?: string;
  flowActionData?: Record<string, any>;
  // Body parameters for template variables like {{1}}, {{2}}, etc.
  bodyParameters?: string[];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const payload: FlowPayload = await req.json();
    await recusarSeDirect(supabase, [payload.conversationId]);

    // Validation
    if (!payload.phoneNumberId) {
      throw new Error('phoneNumberId is required');
    }
    if (!payload.templateName) {
      throw new Error('templateName is required');
    }
    if (!payload.to) {
      throw new Error('to (phone number) is required');
    }

    // Generate flow_token if not provided (for tracking responses)
    const flowToken = payload.flowToken || crypto.randomUUID();

    // Resolve phone number
    const resolvedPhone = await resolvePhoneNumberId(supabase, payload.phoneNumberId);
    if (!resolvedPhone) {
      throw new Error(`Phone number not found (invalid ID or UUID): ${payload.phoneNumberId}`);
    }

    // Identidade do JWT verificado. verify_jwt (default true, sem entrada no
    // config.toml) só provava "tem uma conta"; não provava acesso a ESTA linha.
    const userId = await requireUser(supabase, req);

    // Get credentials
    const { data: phoneNumberData, error: phoneError } = await supabase
      .from('phone_numbers')
      .select(`
        id,
        organization_id,
        organization:organizations (
          id,
          whatsapp_access_token
        )
      `)
      .eq('id', resolvedPhone.dbId)
      .single();

    if (phoneError || !phoneNumberData || !phoneNumberData.organization) {
      console.error('Phone number not found or not linked to org:', phoneError);
      throw new Error(`Phone number ${payload.phoneNumberId} not registered or missing organization link.`);
    }

    // Membro da organização da linha; agent precisa da linha atribuída.
    await requirePhoneAccess(supabase, userId, phoneNumberData.id, phoneNumberData.organization_id);

    // conversationId vem do corpo: amarra à linha, senão a bolha outbound cai
    // na conversa de outra organização (whatsapp-send-poll/index.ts:94-100).
    if (payload.conversationId) {
      const { data: convScope, error: convScopeError } = await supabase
        .from('conversations')
        .select('id, phone_number_id')
        .eq('id', payload.conversationId)
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

    if (!accessToken) {
      throw new Error(`Organization ${org.id} has no WhatsApp Access Token configured.`);
    }

    console.log('Sending flow template to:', payload.to, 'Template:', payload.templateName, 'from phone:', payload.phoneNumberId);

    // Build template components array
    const components: any[] = [];

    // Add BODY component with parameters if provided
    if (payload.bodyParameters && payload.bodyParameters.length > 0) {
      components.push({
        type: 'body',
        parameters: payload.bodyParameters.map(value => ({
          type: 'text',
          text: value
        }))
      });
    }

    // Add flow button component
    components.push({
      type: 'button',
      sub_type: 'flow',
      index: payload.flowButtonIndex ?? 0,
      parameters: [
        {
          type: 'action',
          action: {
            flow_token: flowToken,
            flow_action_data: payload.flowActionData || {}
          }
        }
      ]
    });

    // Build template object
    const templateObj: any = {
      name: payload.templateName,
      language: {
        code: payload.languageCode || 'pt_BR',
      },
      components
    };

    // Build WhatsApp API payload
    const whatsappPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: payload.to,
      type: 'template',
      template: templateObj,
    };

    console.log('WhatsApp payload:', JSON.stringify(whatsappPayload, null, 2));

    // Send to WhatsApp
    const whatsappResponse = await fetch(
      `https://graph.facebook.com/v18.0/${resolvedPhone.metaId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(whatsappPayload),
      }
    );

    const whatsappData = await whatsappResponse.json();

    if (!whatsappResponse.ok) {
      console.error('WhatsApp API error:', whatsappData);
      throw new Error(whatsappData.error?.message || 'Failed to send flow template');
    }

    console.log('Flow template sent successfully:', whatsappData);

    const whatsappMessageId = whatsappData.messages[0].id;

    // Save to database
    const { data: msgData, error: msgError } = await supabase.from('messages').insert({
      conversation_id: payload.conversationId,
      content: `[Flow Template: ${payload.templateName}]`,
      direction: 'outbound',
      sent_by: userId,
      message_type: 'flow',
      whatsapp_message_id: whatsappMessageId,
      flow_token: flowToken,
    }).select().single();

    if (msgError) {
      // A mensagem JÁ saiu para o contato: insert falho aqui é a bolha sumindo
      // do CRM sem rastro. Evidência no padrão do whatsapp-send (index.ts:485):
      // acende o banner do check-message-failure-alerts em ≤60s e o payload é
      // replayável por scripts/replay-write-failures.mjs.
      //
      // Resposta continua 200: um 5xx faria o agente reenviar e duplicar no
      // contato, que é pior que a bolha faltando.
      console.error('Error saving message to DB:', msgError);
      await logWriteFailure(supabase, {
        phoneNumberDbId: resolvedPhone.dbId,
        toJid: String(payload.to ?? 'unknown'),
        wamid: whatsappMessageId ?? null,
        action: 'msg_write_failed',
        error: `${msgError.code ?? 'unknown'}: ${msgError.message}`,
        route: 'whatsapp-send-flow',
        payload: {
          conversation_id: payload.conversationId,
          content: `[Flow Template: ${payload.templateName}]`,
          direction: 'outbound',
          sent_by: userId,
          message_type: 'flow',
          whatsapp_message_id: whatsappMessageId,
          flow_token: flowToken,
        },
      });
    } else {
      console.log('Message saved to DB:', msgData);
    }

    // Update conversation. O trigger on_message_inserted já avançou
    // last_message_at no insert; aqui só reabre, e só se não estiver 'active' (D1).
    await reativarConversa(supabase, payload.conversationId);

    if (msgData) {
      await emitMessageSent(supabase, {
        conversationId: payload.conversationId,
        messageId: msgData.id,
        whatsappMessageId,
        content: `[Flow Template: ${payload.templateName}]`,
        messageType: 'flow',
        sentBy: userId,
        origin: 'panel',
        phoneNumberDbId: resolvedPhone.dbId,
        organizationId: org?.id,
        metaPhoneNumberId: resolvedPhone.metaId,
        templateName: payload.templateName,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        messageId: whatsappMessageId,
        flowToken,
        savedMessage: msgData,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Error sending flow template:', error);
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
