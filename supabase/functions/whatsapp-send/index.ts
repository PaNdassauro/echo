import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireUser } from '../_shared/authz.ts';
import { qrAuthHeaders } from '../_shared/qr.ts';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { reativarConversa } from '../_shared/conversation-touch.ts';
import { logWriteFailure } from '../_shared/failure-log.ts';
import { sendMetaTypingIndicator, getLatestInboundWamid } from '../_shared/meta-typing-indicator.ts';
import { extractFirstUrl, fetchLinkPreview } from '../_shared/og.ts';
import { enviarPeloDirect, respostaVaiPeloDirect } from '../_shared/instagram-envio.ts';
import { mesclarMetadata } from '../_shared/metadata-merge.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  // Direct do Instagram: a mensagem já sai pronta para o painel.
  if (error.startsWith('Direct')) return error;
  const errorMap: Record<string, string> = {
    // Erros de sessão QR
    'session not connected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp nas configurações.',
    'session disconnected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp nas configurações.',
    'not connected': 'WhatsApp desconectado. Tente novamente ou reconecte nas configurações.',
    'qr service unreachable': 'Serviço temporariamente indisponível. Tente novamente.',
    'qr service returned invalid': 'Erro no serviço. Tente novamente em alguns instantes.',

    // Erros de configuração
    'phonenumberid is required': 'Selecione um número de WhatsApp para enviar.',
    'phone number not found': 'Número de WhatsApp não encontrado. Verifique sua configuração.',
    'organization not found': 'Organização não encontrada. Contate o suporte.',
    'whatsapp credentials not configured': 'WhatsApp não configurado. Verifique as configurações da organização.',
    'qr_service_url not configured': 'Serviço QR não configurado. Contate o suporte.',

    // Erros de permissão
    'unauthorized': 'Você não tem permissão para esta ação.',
    'not a member': 'Você não é membro desta organização.',
    'do not have access': 'Você não tem acesso a este número de WhatsApp.',

    // Erros de reenvio (botão "Reenviar")
    'retry not allowed': 'Não foi possível reenviar esta mensagem. Recarregue a página e tente novamente.',

    // Erros de envio
    'failed to send message': 'Falha ao enviar. Tente novamente ou verifique o número.',
    'message undeliverable': 'Mensagem não entregue. Verifique se o número tem WhatsApp.',
    'invalid phone number': 'Número de telefone inválido.',
    'rate limit': 'Muitas mensagens enviadas. Aguarde alguns minutos.',
    'media too large': 'Arquivo muito grande. Reduza o tamanho e tente novamente.',
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
    const { to: toParam, message, conversationId, phoneNumberId, quotedMessageId: quotedMessageIdParam, triggeredByAutomation, mentions, retryMessageId } = await req.json();

    // Mutáveis: o branch de retry resolve destino e citação a partir do DB.
    let to = toParam;
    let quotedMessageId = quotedMessageIdParam;

    if (!phoneNumberId) {
      throw new Error('phoneNumberId is required');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Identity comes from the verified JWT, never from the request body.
    const userId = await requireUser(supabase, req);

    // Resolve Phone Number ID
    const resolvedPhone = await resolvePhoneNumberId(supabase, phoneNumberId);
    if (!resolvedPhone) {
      throw new Error('Phone number not found (invalid ID or UUID)');
    }

    // Get Phone Number & Organization & Credentials
    const { data: phoneData, error: phoneError } = await supabase
      .from('phone_numbers')
      .select(`
        id,
        organization_id,
        connection_type,
        append_agent_name,
        phone_number,
        typing_indicator_enabled,
        organizations (
          id,
          whatsapp_waba_id,
          whatsapp_access_token
        )
      `)
      .eq('id', resolvedPhone.dbId)
      .single();

    if (phoneError || !phoneData) {
      console.error('Phone fetch error:', phoneError);
      throw new Error("Phone number found but failed to fetch details.");
    }

    const org = phoneData.organizations;
    const orgData = Array.isArray(org) ? org[0] : org;

    if (!orgData) {
      throw new Error("Organization not found for this phone number.");
    }

    // @ts-ignore
    const { whatsapp_waba_id, whatsapp_access_token } = orgData;
    const append_agent_name = (phoneData as any).append_agent_name;
    const accessToken = whatsapp_access_token;
    const metaPhoneNumberId = resolvedPhone.metaId;

    // Permission Check
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_super_admin, first_name, last_name, email')
      .eq('id', userId)
      .single();

    if (!profile?.is_super_admin) {
      const { data: member } = await supabase
        .from('organization_members')
        .select('role')
        .eq('organization_id', phoneData.organization_id)
        .eq('user_id', userId)
        .maybeSingle();

      if (!member) {
        throw new Error("Unauthorized: You are not a member of this organization.");
      }

      if (member.role === 'agent') {
        const { data: assignment } = await supabase
          .from('user_phone_numbers')
          .select('id')
          .eq('user_id', userId)
          .eq('phone_number_id', phoneData.id)
          .maybeSingle();

        if (!assignment) {
          throw new Error("Unauthorized: You do not have access to this phone number.");
        }
      }
    }

    // A checagem acima prova acesso à LINHA. Falta provar que a CONVERSA é
    // desta linha — `conversationId` vem do corpo e, até aqui, só o ramo de
    // retry abaixo o amarrava. Sem isto, um membro de qualquer organização com
    // acesso a qualquer linha grava uma bolha outbound dentro da conversa de
    // OUTRA organização e, de quebra, dispara o webhook `message.sent` dela:
    // emitMessageSent relê a conversa da vítima (_shared/webhooks.ts:394) e
    // publica contact.phone/contact.name no endpoint do atacante. As functions
    // irmãs já fazem esta checagem (whatsapp-send-poll/index.ts:94-100).
    let convScope: {
      id: string;
      phone_number_id: string;
      contact_phone: string | null;
      channel: string | null;
      instagram_account_id: string | null;
      instagram_user_id: string | null;
    } | null = null;
    if (conversationId) {
      const { data: conv, error: convError } = await supabase
        .from('conversations')
        .select('id, phone_number_id, contact_phone, channel, instagram_account_id, instagram_user_id')
        .eq('id', conversationId)
        .maybeSingle();

      // Erro de consulta não é "conversa de outra org": distinguir evita
      // transformar um soluço de banco em "Unauthorized" para o usuário certo.
      if (convError) {
        console.error('[whatsapp-send] erro ao validar conversa:', convError);
        throw new Error('Failed to validate conversation');
      }
      if (!conv || conv.phone_number_id !== phoneData.id) {
        throw new Error('Unauthorized: conversa não pertence a este número');
      }
      convScope = conv;
    }

    // Reenviar uma linha persistida que falhou (botão "Reenviar"): a linha do
    // DB é a autoridade — conteúdo verbatim e destino resolvido de
    // conversations.contact_phone, porque o front pode segurar um telefone
    // velho (closure memoizada da bolha / reescrita do fallback do 9º dígito).
    let retryRow: {
      content: string;
      quoted_message_id: string | null;
      sent_by: string | null;
      metadata: Record<string, unknown> | null;
    } | null = null;
    if (retryMessageId) {
      const { data: row } = await supabase
        .from('messages')
        .select('content, quoted_message_id, message_type, direction, status, conversation_id, sent_by, is_deleted, metadata')
        .eq('id', retryMessageId)
        .maybeSingle();

      if (!row) throw new Error('Retry not allowed: message not found');
      if (row.conversation_id !== conversationId) throw new Error('Retry not allowed: message belongs to another conversation');
      if (row.direction !== 'outbound') throw new Error('Retry not allowed: not an outbound message');
      if (row.status !== 'failed') throw new Error('Retry not allowed: message did not fail');
      if (row.is_deleted) throw new Error('Retry not allowed: message was discarded');
      if (row.message_type && row.message_type !== 'text') throw new Error('Retry not allowed: only text messages can be resent');

      // A conversa já foi validada contra a linha logo acima; aqui só falta o
      // destino verbatim do DB (antes esta era uma segunda query idêntica).
      if (!convScope) {
        throw new Error('Retry not allowed: conversation does not match this phone number');
      }

      to = convScope.contact_phone || to;
      quotedMessageId = row.quoted_message_id;
      retryRow = row;
    }

    // Conversa do Direct do Instagram: mesmo composer, outra saída. Nada de
    // WhatsApp, webhook da organização ou automação (o Direct não é telefone).
    // Card juntado (WhatsApp + Direct do mesmo contato): sai pelo Direct quando o
    // contato escreveu por último lá e ainda está nas 24h.
    // Reenvio segue o canal da PRÓPRIA mensagem que falhou.
    const peloDirect = convScope?.channel === 'instagram'
      || (retryRow
        ? retryRow.metadata?.canal === 'instagram'
        : Boolean(convScope?.instagram_user_id) && await respostaVaiPeloDirect(supabase, convScope!.id));
    if (convScope && peloDirect) {
      let textoDoDirect = retryRow ? retryRow.content : message;
      if (!retryRow && append_agent_name) {
        const nomeDoAgente = profile?.first_name
          ? `${profile.first_name} ${profile.last_name || ''}`.trim()
          : (profile?.email?.split('@')[0] || 'Agente');
        // O Direct não formata *negrito*: o nome vai como linha simples.
        textoDoDirect = `${nomeDoAgente}:\n${message}`;
      }
      const { mid } = await enviarPeloDirect(supabase, {
        organizationId: phoneData.organization_id,
        conversa: convScope,
        texto: textoDoDirect,
        userId,
        quotedMessageId: quotedMessageId || null,
        retryMessageId: retryMessageId || null,
      });
      return new Response(JSON.stringify({ success: true, messageId: mid }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Modify message with Agent Name if enabled
    let finalMessage = message;
    if (retryRow) {
      // O conteúdo persistido é o corpo final já enviado (inclui o header
      // `*Agente*`, se houver); reaplicar o append duplicaria o nome.
      finalMessage = retryRow.content;
    } else if (append_agent_name) {
      const agentName = profile?.first_name
        ? `${profile.first_name} ${profile.last_name || ''}`.trim()
        : (profile?.email?.split('@')[0] || 'Agente');

      finalMessage = `*${agentName}*\n\n${message}`;
    }

    console.log('Sending message to:', to, 'from phone:', phoneData.id, 'connection_type:', phoneData.connection_type, 'agent:', profile?.email);

    // Fetch quoted message details if replying to a message
    let quotedWhatsappId: string | null = null;
    let quotedContent: string | null = null;
    let quotedFromMe = false;
    let quotedParticipant: string | null = null;
    if (quotedMessageId) {
      const { data: quotedMsg } = await supabase
        .from('messages')
        .select('whatsapp_message_id, content, direction, sender_phone, metadata')
        .eq('id', quotedMessageId)
        .single();
      // Card juntado: mensagem do Direct não se cita pelo WhatsApp (o id é do Instagram).
      if (quotedMsg && (quotedMsg.metadata as Record<string, unknown> | null)?.canal !== 'instagram') {
        quotedWhatsappId = quotedMsg.whatsapp_message_id;
        quotedContent = quotedMsg.content;
        quotedFromMe = quotedMsg.direction === 'outbound';
        quotedParticipant = quotedMsg.sender_phone ? `${quotedMsg.sender_phone.replace(/\D/g, '')}@s.whatsapp.net` : null;
        console.log('[QuotedMessage] Found quoted message:', quotedWhatsappId, 'fromMe:', quotedFromMe, 'participant:', quotedParticipant);
      }
    }

    let whatsappMessageId: string;

    // Route based on connection_type
    if (phoneData.connection_type === 'qr') {
      // QR Connection - send via Baileys service
      const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
      if (!qrServiceUrl) {
        throw new Error('QR_SERVICE_URL not configured. Please add it to Edge Function secrets.');
      }

      console.log('[QR Send] Routing to Baileys service:', qrServiceUrl);
      if (mentions && mentions.length > 0) {
        console.log('[QR Send] Including mentions:', mentions);
      }

      const sendStartTime = Date.now();
      let qrResponse: Response;
      try {
        qrResponse = await fetch(`${qrServiceUrl}/message/send/${phoneData.id}`, {
          method: 'POST',
          headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            to,
            content: finalMessage,
            quotedMessageId: quotedWhatsappId,
            quotedContent,
            quotedFromMe,
            quotedParticipant,
            mentions, // Array of JIDs for group mentions
            skipSave: true // Edge Function will save to DB
          }),
        });
      } catch (fetchErr: any) {
        const duration = Date.now() - sendStartTime;
        console.error('[QR Send] FETCH FAILED (network error):', {
          error: fetchErr?.message || String(fetchErr),
          phoneNumberId: phoneData.id,
          to,
          durationMs: duration,
        });
        throw new Error(`QR service unreachable: ${fetchErr?.message || 'Network error'}`);
      }

      const duration = Date.now() - sendStartTime;

      // Check content-type before parsing - service may return HTML error pages
      const contentType = qrResponse.headers.get('content-type') || '';
      const responseText = await qrResponse.text();

      if (!contentType.includes('application/json')) {
        console.error('[QR Send] Non-JSON response from QR service:', {
          httpStatus: qrResponse.status,
          contentType,
          responsePreview: responseText.substring(0, 500),
          url: `${qrServiceUrl}/message/send/${phoneData.id}`,
          durationMs: duration,
        });
        throw new Error(`QR service returned invalid response (${qrResponse.status}). Check if service is running.`);
      }

      let qrData: any;
      try {
        qrData = JSON.parse(responseText);
      } catch (parseErr) {
        console.error('[QR Send] JSON parse failed:', {
          httpStatus: qrResponse.status,
          responsePreview: responseText.substring(0, 500),
        });
        throw new Error('QR service returned invalid JSON');
      }

      if (!qrResponse.ok || !qrData.success) {
        console.error('[QR Send] Baileys service error:', {
          httpStatus: qrResponse.status,
          response: qrData,
          phoneNumberId: phoneData.id,
          to,
          durationMs: duration,
        });
        throw new Error(qrData.error || 'Failed to send message via QR service');
      }

      console.log('[QR Send] Message sent successfully:', { messageId: qrData.messageId, durationMs: duration });
      whatsappMessageId = qrData.messageId || `qr_${Date.now()}`;
    } else {
      // Business API - send via Meta
      if (!whatsapp_waba_id || !accessToken) {
        throw new Error("WhatsApp credentials not configured for this organization.");
      }

      // Disparo do typing indicator (fire-and-forget) antes do envio (se habilitado nas configs do número)
      if (conversationId && phoneData.typing_indicator_enabled) {
        void (async () => {
          try {
            const inboundWamid = await getLatestInboundWamid(supabase, conversationId);
            if (inboundWamid) {
              await sendMetaTypingIndicator({
                accessToken,
                metaPhoneNumberId,
                inboundMessageId: inboundWamid,
              });
            }
          } catch (typingErr) {
            console.warn('[whatsapp-send] Error sending typing indicator fallback:', typingErr);
          }
        })();
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
            to: to,
            ...(quotedWhatsappId && { context: { message_id: quotedWhatsappId } }),
            type: 'text',
            text: {
              body: finalMessage,
              // Link preview no aparelho do contato (paridade WhatsApp);
              // inofensivo quando não há URL no texto.
              preview_url: true,
            },
          }),
        }
      );

      const whatsappData = await whatsappResponse.json();

      if (!whatsappResponse.ok) {
        console.error('WhatsApp API error:', whatsappData);
        throw new Error(whatsappData.error?.message || 'Failed to send message');
      }

      console.log('Message sent successfully:', whatsappData);
      whatsappMessageId = whatsappData.messages[0].id;
    }

    // Save to database.
    let newMessage: { id: string } | null = null;
    if (retryMessageId) {
      // Retry: update-in-place na MESMA linha (wamid novo, erro limpo);
      // created_at e sent_by preservados — a bolha progride error→sent no
      // lugar, sem duplicar nem ressuscitar no refetch.
      const { data: updated, error: updError } = await supabase
        .from('messages')
        .update({
          whatsapp_message_id: whatsappMessageId,
          status: 'sent',
          error_message: null,
        })
        .eq('id', retryMessageId)
        .select('id')
        .maybeSingle();

      if (updError?.code === '23505') {
        // 23505 sugere que o eco do Baileys gravou a linha com o wamid novo —
        // mas o unique é COMPOSTO (wamid, conversation_id), então PROVAR antes
        // de deletar: um 23505 vindo de outra causa apagava a mensagem sem
        // substituta. Só descarta a antiga com o eco comprovado NA MESMA conversa.
        const { data: echoRow } = await supabase
          .from('messages')
          .select('id')
          .eq('whatsapp_message_id', whatsappMessageId)
          .eq('conversation_id', conversationId)
          .neq('id', retryMessageId)
          .maybeSingle();
        if (echoRow) {
          await supabase.from('messages').delete().eq('id', retryMessageId);
          newMessage = echoRow;
        } else {
          console.error(`[Retry] 23505 sem eco comprovado para ${whatsappMessageId} — mantendo a linha original`);
          await logWriteFailure(supabase, {
            toJid: String(to ?? 'unknown'),
            wamid: whatsappMessageId,
            action: 'msg_write_failed',
            error: `23505 no retry sem eco na conversa ${conversationId}`,
            route: 'whatsapp-send-retry',
            payload: { retryMessageId, conversationId, whatsappMessageId },
          });
        }
      } else if (updError) {
        // Mensagem JÁ saiu para o contato; update falho = bolha presa em erro.
        console.error('Error updating retried message in DB:', updError);
        await logWriteFailure(supabase, {
          toJid: String(to ?? 'unknown'),
          wamid: whatsappMessageId,
          action: 'msg_write_failed',
          error: `${updError.code ?? 'unknown'}: ${updError.message}`,
          route: 'whatsapp-send-retry',
          payload: { retryMessageId, conversationId, whatsappMessageId },
        });
      } else {
        newMessage = updated;
      }
    } else {
      // Upsert e não insert: o eco do Baileys (`messages.upsert` com fromMe) pode
      // chegar em /qr-message antes desta linha e gravar a mesma wamid. Com
      // ignoreDuplicates, a corrida vira no-op silencioso em vez de 23505 — e o
      // `newMessage` nulo é o que impede o `message.sent` de sair duas vezes.
      const { data: inserted, error: msgError } = await supabase
        .from('messages')
        .upsert({
          conversation_id: conversationId,
          content: finalMessage,
          direction: 'outbound',
          sent_by: userId,
          whatsapp_message_id: whatsappMessageId,
          quoted_message_id: quotedMessageId || null,
          message_type: 'text',
        }, {
          onConflict: 'whatsapp_message_id,conversation_id',
          ignoreDuplicates: true,
        })
        .select('id')
        .maybeSingle();

      if (msgError) {
        // A mensagem JÁ saiu para o contato — insert falho aqui é a bolha do
        // agente sumindo do CRM. Evidência → alerta em ≤60s + replay manual.
        console.error('Error saving message to DB:', msgError);
        await logWriteFailure(supabase, {
          toJid: String(to ?? 'unknown'),
          wamid: whatsappMessageId,
          action: 'msg_write_failed',
          error: `${msgError.code ?? 'unknown'}: ${msgError.message}`,
          route: 'whatsapp-send',
          payload: {
            conversation_id: conversationId,
            content: finalMessage,
            direction: 'outbound',
            sent_by: userId,
            whatsapp_message_id: whatsappMessageId,
            message_type: 'text',
          },
        });
      }
      newMessage = inserted;
    }

    // Preview de link da NOSSA bolha (o eco do Baileys é dedupado e a Cloud API
    // não ecoa — sem isto só o inbound teria card). Roda DEPOIS da resposta
    // (waitUntil): preview é acessório, nunca atrasa o envio.
    if (newMessage) {
      const previewUrl = extractFirstUrl(finalMessage);
      if (previewUrl) {
        const messageRowId = newMessage.id;
        const enrich = (async () => {
          const preview = await fetchLinkPreview(previewUrl);
          if (!preview) return;
          // Mescla atômica: não lê metadata antes (a transcrição escreve leitura na linha).
          await mesclarMetadata(supabase, messageRowId, { link_preview: preview });
        })().catch((err: unknown) => console.warn('[LinkPreview] enrichment falhou:', err));
        // EdgeRuntime.waitUntil segura o isolate até o enrich terminar
        (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
          .EdgeRuntime?.waitUntil?.(enrich);
      }
    }

    // Update conversation. Envio novo: o trigger on_message_inserted já avançou
    // last_message_at no insert; aqui só reabre, e só se não estiver 'active' (D1).
    // O reenvio atualiza a linha no lugar (sem trigger de INSERT) e segue
    // avançando last_message_at como antes.
    if (retryMessageId) {
      await supabase
        .from('conversations')
        .update({
          last_message_at: new Date().toISOString(),
          status: 'active'
        })
        .eq('id', conversationId);
    } else {
      await reativarConversa(supabase, conversationId);
    }

    // `message.sent` nasce aqui porque é aqui que a mensagem nasce. O eco do
    // aparelho não serve de gatilho: em grupo ele cai no ignoreDuplicates acima
    // e nenhum evento chegava ao CRM. Sai depois do update da conversa para o
    // webhook enriquecer com o status já reaberto.
    if (newMessage) {
      await emitMessageSent(supabase, {
        conversationId,
        messageId: newMessage.id,
        whatsappMessageId,
        content: finalMessage,
        messageType: 'text',
        // No retry, o autor original da mensagem é preservado.
        sentBy: retryRow?.sent_by || userId,
        origin: 'panel',
        phoneNumberDbId: phoneData.id,
        organizationId: phoneData.organization_id,
        metaPhoneNumberId,
        quotedMessageId: quotedMessageId || null,
        quotedWhatsappId: quotedWhatsappId,
        quotedContent: quotedContent,
      });
    }

    // Trigger automation flows for message_sent (fire-and-forget)
    // Only if NOT triggered by automation (prevents infinite loops).
    // Retry também não dispara: o envio original já rodou as automações.
    if (phoneData.organization_id && !triggeredByAutomation && !retryMessageId) {
      fetch(`${supabaseUrl}/functions/v1/automation-execute`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          organizationId: phoneData.organization_id,
          conversationId,
          phoneNumberDbId: phoneData.id,
          metaPhoneNumberId,
          contactPhone: to,
          accessToken: accessToken || '',
          connectionType: phoneData.connection_type,
          triggerContext: 'outbound',
          message: {
            content: finalMessage,
            type: 'text',
            selectionId: null
          }
        })
      }).catch(err => console.error('[Automation-Send] Trigger error:', err));
    }

    return new Response(JSON.stringify({ success: true, messageId: whatsappMessageId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
