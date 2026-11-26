import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { qrAuthHeaders } from '../_shared/qr.ts';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { logWriteFailure } from '../_shared/failure-log.ts';
import { checkInternalCaller } from '../_shared/authz.ts';
import { AgendamentoPerdido, FalhaNoArquivo, LotePausado, enviarArquivosAgendados } from './arquivos.ts';
import { MAX_ATTEMPTS, isRetryableError } from './retry.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Maps technical errors to friendly Portuguese messages (used by createErrorResponse).
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'whatsapp credentials not configured': 'WhatsApp não configurado. Verifique as configurações.',
    'templates are not supported': 'Templates não são suportados neste canal.',
    'qr_service_url not configured': 'Serviço QR não configurado. Contate o suporte.',
    'scheduled message not found': 'Mensagem agendada não encontrada.',
  };
  const lowerError = (error || '').toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) return value;
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // S5: só serviço. O destino e o texto saem do banco, mas a chamada dispara
  // envio pelo WhatsApp. process_scheduled_messages() (cron 7 e o "enviar agora" do painel, via RPC)
  // chama com o service_role_key do Vault.
  // verify_jwt = true (padrão; ver config.toml).
  const denied = checkInternalCaller(req, 'scheduled-message-execute', {
    jwtVerifiedByGateway: true,
    headers: corsHeaders,
  });
  if (denied) return denied;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { scheduledMessageId } = await req.json();

    if (!scheduledMessageId || !isUUID(scheduledMessageId)) {
      throw new Error('Valid scheduledMessageId is required');
    }

    console.log('[ScheduledMessage] Processing:', scheduledMessageId);

    // Fetch the scheduled message with all related data
    const { data: scheduled, error: fetchError } = await supabase
      .from('scheduled_messages')
      .select(`
        *,
        phone_numbers!inner (
          id,
          phone_number_id,
          phone_number,
          connection_type,
          organization_id,
          append_agent_name,
          organizations (
            id,
            whatsapp_waba_id,
            whatsapp_access_token
          )
        ),
        conversations!inner (
          id,
          contact_phone,
          channel
        )
      `)
      .eq('id', scheduledMessageId)
      .single();

    if (fetchError || !scheduled) {
      console.error('[ScheduledMessage] Fetch error:', fetchError);
      throw new Error('Scheduled message not found');
    }

    // Skip if not in processing status (already handled or cancelled)
    if (scheduled.status !== 'processing') {
      console.log('[ScheduledMessage] Skipping - status is:', scheduled.status);
      return new Response(JSON.stringify({ success: true, skipped: true, reason: `Status is ${scheduled.status}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const phoneData = scheduled.phone_numbers;
    const org = phoneData.organizations;
    const orgData = Array.isArray(org) ? org[0] : org;
    const to = scheduled.contact_phone;
    const metaPhoneNumberId = phoneData.phone_number_id;
    const accessToken = orgData?.whatsapp_access_token;
    const appendAgentName = phoneData?.append_agent_name;

    let whatsappMessageId: string;
    let messageContent: string;
    let messageType = 'text';
    // Declarados aqui, e não dentro do ramo de texto, para o emitMessageSent
    // lá embaixo conseguir preencher a citação no webhook.
    let quotedWhatsappId: string | null = null;
    let quotedContent: string | null = null;

    try {
      // Direct do Instagram: 'ig:<id>' não é telefone (ver _shared/canal.ts).
      // Cai direto em 'failed' — a mensagem não casa nenhum padrão de retry.
      const conv = Array.isArray(scheduled.conversations) ? scheduled.conversations[0] : scheduled.conversations;
      if (conv?.channel === 'instagram') {
        console.warn('[ScheduledMessage] Refusing Instagram Direct conversation:', scheduled.conversation_id);
        throw new Error('Direct: agendamento só existe no WhatsApp.');
      }

      if (scheduled.message_type === 'media') {
        // Arquivos: cada um grava a própria mensagem e o próprio wamid em media[i]
        // (ver arquivos.ts). A coluna whatsapp_message_id só entra aqui, depois do
        // último: preenchida antes, o reaper daria por enviado o que ainda falta.
        const attempts = scheduled.attempts ?? MAX_ATTEMPTS;
        let ultimoWamid: string;
        try {
          ultimoWamid = await enviarArquivosAgendados(supabase, { ...scheduled, attempts }, {
            id: phoneData.id,
            phone_number_id: metaPhoneNumberId,
            connection_type: phoneData.connection_type,
            organization_id: phoneData.organization_id,
            accessToken,
          });
        } catch (loteError) {
          if (loteError instanceof AgendamentoPerdido) {
            // Outra execução (ou outra mudança de status) é dona da linha agora: nenhuma escrita.
            console.warn('[ScheduledMessage] Lost ownership mid-batch, stopping:', scheduledMessageId);
            return new Response(JSON.stringify({ success: true, skipped: true, reason: 'ownership lost' }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          if (loteError instanceof LotePausado) {
            // Volta à fila já elegível e devolve a tentativa que o claim gastou:
            // pausar pelo tempo não é falha. O próximo tick continua do próximo arquivo.
            await supabase
              .from('scheduled_messages')
              .update({
                status: 'scheduled',
                next_attempt_at: new Date().toISOString(),
                attempts: Math.max(attempts - 1, 0),
              })
              .eq('id', scheduledMessageId)
              .eq('status', 'processing')
              .eq('attempts', attempts);
            console.log(`[ScheduledMessage] Batch paused after ${loteError.enviadosNestaExecucao} file(s); requeued`);
            return new Response(JSON.stringify({ success: true, paused: true, sent: loteError.enviadosNestaExecucao }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          throw loteError;
        }

        await supabase
          .from('scheduled_messages')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            whatsapp_message_id: ultimoWamid,
            error_message: null,
          })
          .eq('id', scheduledMessageId)
          .eq('status', 'processing')
          .eq('attempts', attempts);

        console.log('[ScheduledMessage] Files sent successfully:', ultimoWamid);
        return new Response(JSON.stringify({ success: true, messageId: ultimoWamid }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (scheduled.message_type === 'text') {
        // Send text message
        messageContent = scheduled.content || '';

        // Append agent name if enabled
        if (appendAgentName && scheduled.created_by) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('first_name, last_name, email')
            .eq('id', scheduled.created_by)
            .single();

          if (profile) {
            const agentName = profile.first_name
              ? `${profile.first_name} ${profile.last_name || ''}`.trim()
              : (profile.email?.split('@')[0] || 'Agente');
            messageContent = `*${agentName}*\n\n${messageContent}`;
          }
        }

        // Fetch quoted message details if replying
        let quotedFromMe = false;
        let quotedParticipant: string | null = null;

        if (scheduled.quoted_message_id) {
          const { data: quotedMsg } = await supabase
            .from('messages')
            .select('whatsapp_message_id, content, direction, sender_phone')
            .eq('id', scheduled.quoted_message_id)
            .single();

          if (quotedMsg) {
            quotedWhatsappId = quotedMsg.whatsapp_message_id;
            quotedContent = quotedMsg.content;
            quotedFromMe = quotedMsg.direction === 'outbound';
            quotedParticipant = quotedMsg.sender_phone
              ? `${quotedMsg.sender_phone.replace(/\D/g, '')}@s.whatsapp.net`
              : null;
          }
        }

        if (phoneData.connection_type === 'qr') {
          // QR Connection - send via Baileys service
          const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
          if (!qrServiceUrl) {
            throw new Error('QR_SERVICE_URL not configured');
          }

          console.log('[ScheduledMessage] Sending via QR service');

          const qrResponse = await fetch(`${qrServiceUrl}/message/send/${phoneData.id}`, {
            method: 'POST',
            headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              to,
              content: messageContent,
              quotedMessageId: quotedWhatsappId,
              quotedContent,
              quotedFromMe,
              quotedParticipant,
              mentions: scheduled.mentions || [],
              skipSave: true,
            }),
          });

          const contentType = qrResponse.headers.get('content-type') || '';
          const responseText = await qrResponse.text();

          if (!contentType.includes('application/json')) {
            throw new Error(`QR service returned invalid response (${qrResponse.status})`);
          }

          const qrData = JSON.parse(responseText);
          if (!qrResponse.ok || !qrData.success) {
            throw new Error(qrData.error || 'Failed to send via QR service');
          }

          whatsappMessageId = qrData.messageId || `qr_${Date.now()}`;
        } else {
          // Business API - send via Meta
          if (!accessToken) {
            throw new Error('WhatsApp credentials not configured');
          }

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
                to,
                ...(quotedWhatsappId && { context: { message_id: quotedWhatsappId } }),
                type: 'text',
                text: { body: messageContent },
              }),
            }
          );

          const whatsappData = await whatsappResponse.json();
          if (!whatsappResponse.ok) {
            throw new Error(whatsappData.error?.message || 'Failed to send message');
          }

          whatsappMessageId = whatsappData.messages[0].id;
        }
      } else if (scheduled.message_type === 'template') {
        // Send template message (API only - QR doesn't support templates)
        if (phoneData.connection_type === 'qr') {
          throw new Error('Templates are not supported on this connection');
        }

        if (!accessToken) {
          throw new Error('WhatsApp credentials not configured');
        }

        messageType = 'template';

        // Build template components from variables
        const components: any[] = [];
        const bodyVariables = scheduled.body_variables || [];
        const buttonVariables = scheduled.button_variables || [];

        // Header media (image/video/document) goes first if present
        const headerComponent = buildHeaderComponentFromMedia(scheduled.header_media);
        if (headerComponent) {
          components.push(headerComponent);
        }

        if (bodyVariables.length > 0) {
          components.push({
            type: 'body',
            parameters: bodyVariables.map((v: string) => ({ type: 'text', text: v })),
          });
        }

        if (buttonVariables.length > 0) {
          // index é a posição do botão no template, não na lista de variáveis: com
          // resposta rápida ou "ligar" antes do link, index 0 apontava para o botão errado.
          const templateButtons: Array<{ type?: string; url?: string }> =
            scheduled.template_components?.find((c: any) => c.type === 'BUTTONS')?.buttons ?? [];
          const dynamicPositions = templateButtons
            .map((btn, position) => (btn.type === 'URL' && btn.url?.includes('{{') ? position : -1))
            .filter((position) => position >= 0);
          buttonVariables.forEach((v: string, idx: number) => {
            components.push({
              type: 'button',
              sub_type: 'url',
              index: String(dynamicPositions[idx] ?? idx),
              parameters: [{ type: 'text', text: v }],
            });
          });
        }

        const templateObj: any = {
          name: scheduled.template_name,
          language: { code: scheduled.template_language || 'pt_BR' },
        };

        if (components.length > 0) {
          templateObj.components = components;
        }

        console.log('[ScheduledMessage] Sending template:', scheduled.template_name);

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
              to,
              type: 'template',
              template: templateObj,
            }),
          }
        );

        const whatsappData = await whatsappResponse.json();
        if (!whatsappResponse.ok) {
          throw new Error(whatsappData.error?.message || 'Failed to send template');
        }

        whatsappMessageId = whatsappData.messages[0].id;

        // Build message content for display (template body with variables filled)
        messageContent = scheduled.template_name || '';
        if (scheduled.template_components) {
          const bodyComponent = scheduled.template_components.find(
            (c: any) => c.type === 'BODY'
          );
          if (bodyComponent?.text) {
            messageContent = bodyComponent.text;
            bodyVariables.forEach((v: string, idx: number) => {
              // Todas as ocorrências: {{1}} repetido ficava cru no histórico.
              messageContent = messageContent.split(`{{${idx + 1}}}`).join(v);
            });
          }
        }
      } else {
        throw new Error(`Unknown message_type: ${scheduled.message_type}`);
      }

      // Marca o id do WhatsApp ANTES de qualquer outra escrita.
      //
      // A partir daqui a mensagem já saiu — o contato vai receber, aconteça o
      // que acontecer no resto deste bloco. Se o processo morrer entre este
      // ponto e o update final de status, a linha fica em 'processing' e o
      // reaper (reap_stuck_scheduled_messages) precisa distinguir "enviou e não
      // fechou" de "nunca enviou". Esta coluna preenchida é a única evidência
      // dessa diferença; sem ela o reaper reenviaria e o contato receberia a
      // mesma mensagem duas vezes.
      await supabase
        .from('scheduled_messages')
        .update({ whatsapp_message_id: whatsappMessageId })
        .eq('id', scheduledMessageId);

      // Save message to database
      const { data: savedMessage, error: msgError } = await supabase
        .from('messages')
        .upsert({
          conversation_id: scheduled.conversation_id,
          content: messageContent,
          direction: 'outbound',
          sent_by: scheduled.created_by,
          message_type: messageType,
          whatsapp_message_id: whatsappMessageId,
          quoted_message_id: scheduled.quoted_message_id || null,
          ...(messageType === 'template' && {
            metadata: {
              template_name: scheduled.template_name,
              language_code: scheduled.template_language,
              components: scheduled.template_components,
              scheduled_message_id: scheduled.id,
            },
          }),
        }, {
          onConflict: 'whatsapp_message_id,conversation_id',
          ignoreDuplicates: true,
        })
        .select('id')
        .maybeSingle();

      if (msgError) {
        // O agendamento já foi marcado como enviado (wamid gravado acima, de
        // propósito — o reaper NÃO pode reenviar) e o contato recebeu. Insert
        // falho aqui era perda garantida por design anti-duplicação: nenhuma
        // linha em messages e nenhum reprocessamento. Evidência → alerta + replay.
        console.error('[ScheduledMessage] Error saving message:', msgError);
        await logWriteFailure(supabase, {
          toJid: String(scheduled.conversation_id),
          wamid: whatsappMessageId,
          action: 'msg_write_failed',
          error: `${msgError.code ?? 'unknown'}: ${msgError.message}`,
          route: 'scheduled-message-execute',
          payload: {
            conversation_id: scheduled.conversation_id,
            content: messageContent,
            direction: 'outbound',
            sent_by: scheduled.created_by,
            message_type: messageType,
            whatsapp_message_id: whatsappMessageId,
          },
        });
      }

      // Update conversation
      await supabase
        .from('conversations')
        .update({
          last_message_at: new Date().toISOString(),
          status: 'active',
        })
        .eq('id', scheduled.conversation_id);

      if (savedMessage) {
        await emitMessageSent(supabase, {
          conversationId: scheduled.conversation_id,
          messageId: savedMessage.id,
          whatsappMessageId,
          content: messageContent,
          messageType,
          sentBy: scheduled.created_by,
          origin: 'scheduled',
          phoneNumberDbId: phoneData.id,
          organizationId: phoneData.organization_id,
          metaPhoneNumberId: phoneData.phone_number_id,
          quotedMessageId: scheduled.quoted_message_id || null,
          quotedWhatsappId,
          quotedContent,
          templateName: messageType === 'template' ? scheduled.template_name : null,
        });
      }

      // Mark scheduled message as sent
      await supabase
        .from('scheduled_messages')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: whatsappMessageId,
        })
        .eq('id', scheduledMessageId);

      console.log('[ScheduledMessage] Sent successfully:', whatsappMessageId);

      return new Response(JSON.stringify({ success: true, messageId: whatsappMessageId }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (sendError: any) {
      console.error('[ScheduledMessage] Send error:', sendError.message);

      // `attempts` já foi incrementado pelo cron ao reivindicar a linha, então
      // aqui ele conta esta tentativa inclusive.
      const attempts = scheduled.attempts ?? MAX_ATTEMPTS;
      // Arquivo: a decisão já veio pronta da frase original (FalhaNoArquivo).
      const retryable = sendError instanceof FalhaNoArquivo
        ? sendError.retentavel
        : isRetryableError(sendError.message);
      const willRetry = retryable && attempts < MAX_ATTEMPTS;

      if (willRetry) {
        // Backoff linear a partir da tentativa atual: 2min, depois 4min. Curto
        // de propósito — quem agendou espera a mensagem perto do horário pedido,
        // não meia hora depois.
        const backoffMs = attempts * 2 * 60 * 1000;
        const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();

        // scheduled_at NÃO é reescrito: é o horário que o usuário pediu e o que
        // o dashboard exibe. A elegibilidade do retry mora em next_attempt_at.
        await supabase
          .from('scheduled_messages')
          .update({
            status: 'scheduled',
            next_attempt_at: nextAttemptAt,
            error_message: sendError.message,
          })
          .eq('id', scheduledMessageId)
          .eq('status', 'processing')
          .eq('attempts', attempts);

        console.log(`[ScheduledMessage] Retry ${attempts}/${MAX_ATTEMPTS} scheduled for ${nextAttemptAt}`);

        // 200: a falha foi absorvida pelo retry, não é erro do invocador (o cron).
        return new Response(JSON.stringify({
          success: false,
          retrying: true,
          attempts,
          next_attempt_at: nextAttemptAt,
          error: sendError.message,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Mark as failed
      await supabase
        .from('scheduled_messages')
        .update({
          status: 'failed',
          error_message: sendError.message,
        })
        .eq('id', scheduledMessageId)
        .eq('status', 'processing')
        .eq('attempts', attempts);

      return createErrorResponse(sendError, corsHeaders, friendlyError);
    }
  } catch (error: any) {
    console.error('[ScheduledMessage] Error:', error.message);
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
