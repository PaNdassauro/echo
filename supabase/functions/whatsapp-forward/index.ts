import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { recusarSeDirect } from '../_shared/canal.ts';
import { z } from 'https://esm.sh/zod@3.23.8';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireUser, requirePhoneAccess } from '../_shared/authz.ts';
import { qrAuthHeaders } from '../_shared/qr.ts';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { MediaDimensionsSchema } from '../_shared/media-probe.ts';
import { paraUrlInterna } from '../_shared/url-publica.ts';
import { mesclarMetadata } from '../_shared/metadata-merge.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'session not connected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp nas configurações.',
    'session disconnected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp nas configurações.',
    'not connected': 'WhatsApp desconectado. Tente novamente ou reconecte nas configurações.',
    'qr service unreachable': 'Serviço temporariamente indisponível. Tente novamente.',
    'qr_service_url not configured': 'Serviço QR não configurado. Contate o suporte.',
    'unauthorized': 'Você não tem permissão para esta ação.',
    'not a member': 'Você não é membro desta organização.',
    'do not have access': 'Você não tem acesso a este número de WhatsApp.',
    'message not found': 'Mensagem não encontrada. Recarregue a página e tente novamente.',
    'message was deleted': 'Mensagem apagada não pode ser encaminhada.',
    'message type not forwardable': 'Este tipo de mensagem não pode ser encaminhado.',
    'same conversation': 'Só é possível encaminhar mensagens de uma mesma conversa.',
    'media unavailable': 'Mídia indisponível para encaminhamento.',
    'media expired': 'Mídia expirada ou inacessível — não é possível encaminhar.',
    'conversations not found': 'Alguma conversa de destino não foi encontrada. Recarregue e tente novamente.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

// Teto de mensagens por lote. Espelha MAX_SELECTED_MESSAGES no front: 10 × 5
// destinos = 50 envios sequenciais, que cabem com folga no wall-clock da função.
const MAX_MESSAGES = 10;

// Respiro entre mensagens do MESMO lote para o mesmo destino: disparar 10 envios
// back-to-back na mesma sessão é padrão de spam para o WhatsApp.
const SEND_INTERVAL_MS = 150;

const RequestSchema = z
  .object({
    // messageId (singular) é o contrato antigo — mantido para o front já publicado.
    messageId: z.string().uuid().optional(),
    messageIds: z.array(z.string().uuid()).min(1).max(MAX_MESSAGES).optional(),
    conversationIds: z.array(z.string().uuid()).min(1).max(5),
  })
  .refine((data) => Boolean(data.messageIds?.length || data.messageId), {
    message: 'messageId or messageIds is required',
  });

// Tipos encaminháveis. Fora daqui (contact, list, flow, template, group_action,
// deleted, notas) o conteúdo não é reproduzível verbatim em outro chat.
const FORWARDABLE_TYPES = ['text', 'image', 'video', 'audio', 'ptt', 'document', 'sticker'];
const MEDIA_TYPES = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'];

// Placeholders gravados no content quando a mídia não tem caption — não viram
// caption no encaminhamento.
const PLACEHOLDER_CONTENTS = ['[Imagem]', '[Vídeo]', '[Áudio]', '[Sticker]', '[Documento]'];

interface SourceMessage {
  id: string;
  content: string | null;
  message_type: string | null;
  media_url: string | null;
  media_mime_type: string | null;
  media_filename: string | null;
  media_size_bytes: number | null;
  is_deleted: boolean | null;
  conversation_id: string;
  metadata: Record<string, unknown> | null;
}

/** Origem + o que se deriva dela uma vez só (vale para todos os destinos). */
interface PreparedMessage {
  source: SourceMessage;
  type: string;
  isMedia: boolean;
  /** Caption real da origem — placeholder de mídia sem legenda não conta. */
  caption: string | null;
  isPtt: boolean;
  /** Meta não tem tipo "ptt" — voz vai como audio. */
  metaMediaType: string;
}

interface TargetConversation {
  id: string;
  contact_phone: string | null;
  contact_name: string | null;
  is_group: boolean | null;
  phone_number_id: string;
}

interface OrganizationCredentials {
  id: string;
  whatsapp_waba_id: string | null;
  whatsapp_access_token: string | null;
}

interface PhoneData {
  id: string;
  organization_id: string;
  connection_type: string | null;
  phone_number: string;
  /** ID do número na Cloud API (só business). */
  phone_number_id: string | null;
  /** O PostgREST devolve objeto ou array conforme a cardinalidade inferida. */
  organizations: OrganizationCredentials | OrganizationCredentials[] | null;
}

interface ForwardResult {
  conversationId: string;
  contactName: string | null;
  /** Só true quando TODAS as mensagens do lote chegaram neste destino. */
  success: boolean;
  sent: number;
  total: number;
  errors: string[];
  /** Primeira falha — campo lido pelo front do contrato antigo. */
  error?: string;
  /** wamid da primeira mensagem enviada (contrato antigo, lote de 1). */
  messageId?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Envia UMA mensagem para UM destino pelo canal do número dono da conversa. */
async function sendToTarget(
  prepared: PreparedMessage,
  target: TargetConversation,
  phoneData: PhoneData,
  supabaseUrl: string,
): Promise<string> {
  const { source, type, isMedia, caption, isPtt, metaMediaType } = prepared;
  const org = phoneData.organizations;
  const orgData = Array.isArray(org) ? org[0] : org;
  const to = target.contact_phone;

  if (!to) {
    throw new Error('Destination conversation has no contact phone');
  }
  if (target.is_group && phoneData.connection_type !== 'qr') {
    throw new Error('Groups are only supported on QR connections');
  }

  if (phoneData.connection_type === 'qr') {
    const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
    if (!qrServiceUrl) {
      throw new Error('QR_SERVICE_URL not configured');
    }

    const endpoint = isMedia
      ? `${qrServiceUrl}/message/send-media/${phoneData.id}`
      : `${qrServiceUrl}/message/send/${phoneData.id}`;

    // isForwarded liga a tag nativa "Encaminhada" no aparelho (Baileys
    // contextInfo). Mídia vai por URL: o qr-service baixa e reenvia.
    const body = isMedia
      ? {
          to,
          media_url: source.media_url,
          mime_type: source.media_mime_type || undefined,
          filename: source.media_filename || undefined,
          caption: type === 'sticker' ? undefined : caption || undefined,
          isPtt,
          isSticker: type === 'sticker',
          skipSave: true,
          isForwarded: true,
        }
      : {
          to,
          content: source.content,
          skipSave: true,
          isForwarded: true,
        };

    const qrResponse = await fetch(endpoint, {
      method: 'POST',
      headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });

    const contentType = qrResponse.headers.get('content-type') || '';
    const responseText = await qrResponse.text();
    if (!contentType.includes('application/json')) {
      console.error('[Forward][QR] Non-JSON response:', qrResponse.status, responseText.substring(0, 300));
      throw new Error(`QR service returned invalid response (${qrResponse.status})`);
    }
    const qrData = JSON.parse(responseText);
    if (!qrResponse.ok || !qrData.success) {
      throw new Error(qrData.error || 'Failed to send message via QR service');
    }
    return qrData.messageId || `qr_${Date.now()}`;
  }

  // Business API — sem tag nativa: a Cloud API não expõe "forwarded".
  const accessToken = orgData?.whatsapp_access_token;
  if (!accessToken) {
    throw new Error('WhatsApp credentials not configured for this organization');
  }

  const messageBody: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: isMedia ? metaMediaType : 'text',
  };
  if (isMedia) {
    const mediaPayload: Record<string, unknown> = { link: source.media_url };
    if (caption && ['image', 'video', 'document'].includes(metaMediaType)) {
      mediaPayload.caption = caption;
    }
    if (metaMediaType === 'document' && source.media_filename) {
      mediaPayload.filename = source.media_filename;
    }
    messageBody[metaMediaType] = mediaPayload;
  } else {
    messageBody.text = { body: source.content };
  }

  const whatsappResponse = await fetch(
    `https://graph.facebook.com/v18.0/${phoneData.phone_number_id}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messageBody),
    }
  );
  const whatsappData = await whatsappResponse.json();
  if (!whatsappResponse.ok) {
    console.error('[Forward][Meta] API error:', whatsappData);
    throw new Error(whatsappData.error?.message || 'Failed to send message');
  }
  return whatsappData.messages[0].id;
}

/**
 * Persistência: conteúdo/mídia copiados da origem; sender_* e quoted_*
 * deliberadamente NÃO copiados (encaminhamento não vaza autor nem quote).
 */
async function persistForwarded(
  supabase: SupabaseClient,
  prepared: PreparedMessage,
  target: TargetConversation,
  phoneData: PhoneData,
  userId: string,
  whatsappMessageId: string,
): Promise<void> {
  const { source, type, isMedia } = prepared;

  // Dimensões da mídia de origem: a cópia encaminhada reaproveita a caixa exata.
  // Só entra o que passa no schema (metadata é jsonb e não é confiável).
  const sourceMedia = isMedia
    ? MediaDimensionsSchema.safeParse((source.metadata as Record<string, unknown> | null)?.media)
    : null;

  // Upsert e não insert: o eco do Baileys pode gravar a mesma wamid antes.
  const { data: newMessage, error: msgError } = await supabase
    .from('messages')
    .upsert({
      conversation_id: target.id,
      content: source.content,
      direction: 'outbound',
      sent_by: userId,
      whatsapp_message_id: whatsappMessageId,
      message_type: type,
      media_url: isMedia ? source.media_url : null,
      media_mime_type: isMedia ? source.media_mime_type : null,
      media_filename: isMedia ? source.media_filename : null,
      media_size_bytes: isMedia ? source.media_size_bytes : null,
      metadata: { forwarded: true, ...(sourceMedia?.success ? { media: sourceMedia.data } : {}) },
    }, {
      onConflict: 'whatsapp_message_id,conversation_id',
      ignoreDuplicates: true,
    })
    .select('id')
    .maybeSingle();

  if (msgError) {
    console.error('[Forward] Error saving message to DB:', msgError);
  }

  // Corrida com o eco do Baileys: se ele gravou primeiro, a linha viva não
  // tem o flag — quem chega depois enriquece.
  if (!newMessage && !msgError) {
    const { data: existing } = await supabase
      .from('messages')
      .select('id, metadata')
      .eq('whatsapp_message_id', whatsappMessageId)
      .eq('conversation_id', target.id)
      .maybeSingle();
    const existingMeta = (existing?.metadata as Record<string, unknown> | null) ?? {};
    const needsForwarded = !existingMeta.forwarded;
    const needsMedia = !!sourceMedia?.success && !MediaDimensionsSchema.safeParse(existingMeta.media).success;
    if (existing && (needsForwarded || needsMedia)) {
      // A leitura acima só decide SE enriquece; a escrita é um patch atômico (sem regravar o
      // objeto inteiro, que apagaria leitura/poll gravados no meio do caminho).
      try {
        await mesclarMetadata(supabase, existing.id, {
          forwarded: true,
          ...(needsMedia && sourceMedia?.success ? { media: sourceMedia.data } : {}),
        });
      } catch (err) {
        console.error('[Forward] Error enriching echoed message metadata:', err);
      }
    }
  }

  await supabase
    .from('conversations')
    .update({
      last_message_at: new Date().toISOString(),
      status: 'active',
    })
    .eq('id', target.id);

  if (newMessage) {
    await emitMessageSent(supabase, {
      conversationId: target.id,
      messageId: newMessage.id,
      whatsappMessageId,
      content: source.content,
      messageType: type,
      sentBy: userId,
      origin: 'panel',
      phoneNumberDbId: phoneData.id,
      organizationId: phoneData.organization_id,
      metaPhoneNumberId: phoneData.phone_number_id,
      ...(isMedia && {
        media: {
          url: source.media_url,
          mime_type: source.media_mime_type,
          filename: source.media_filename,
          size_bytes: source.media_size_bytes,
        },
      }),
    });
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  try {
    const parsed = RequestSchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'Invalid request', details: parsed.error.flatten() }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { conversationIds } = parsed.data;
    const messageIds = [...new Set(parsed.data.messageIds ?? [parsed.data.messageId!])];

    const supabase = createClient(supabaseUrl, supabaseKey);
    await recusarSeDirect(supabase, conversationIds);

    // Identity comes from the verified JWT, never from the request body.
    const userId = await requireUser(supabase, req);

    // ── Mensagens de origem: as linhas do DB são a autoridade (conteúdo verbatim) ──
    // Ordem cronológica: o destino recebe o lote na mesma ordem de leitura.
    const { data: sources, error: sourceError } = await supabase
      .from('messages')
      .select('id, content, message_type, media_url, media_mime_type, media_filename, media_size_bytes, is_deleted, conversation_id, metadata')
      .in('id', messageIds)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });

    if (sourceError || !sources || sources.length !== messageIds.length) {
      throw new Error('Message not found');
    }

    for (const source of sources as SourceMessage[]) {
      if (source.is_deleted) {
        throw new Error('Message was deleted');
      }
      const type = source.message_type || 'text';
      if (!FORWARDABLE_TYPES.includes(type)) {
        throw new Error('Message type not forwardable');
      }
      if (MEDIA_TYPES.includes(type) && !source.media_url) {
        throw new Error('Media unavailable');
      }
    }

    // Lote sempre sai de uma conversa só — é o que a UI produz, e mantém a
    // checagem de acesso da origem num único ponto.
    const sourceConversationIds = new Set((sources as SourceMessage[]).map((s) => s.conversation_id));
    if (sourceConversationIds.size > 1) {
      throw new Error('Messages must come from the same conversation');
    }

    // Acesso à conversa de origem (o usuário precisa poder ver o que encaminha).
    const { data: sourceConv } = await supabase
      .from('conversations')
      .select('id, phone_number_id, phone_numbers ( organization_id )')
      .eq('id', [...sourceConversationIds][0])
      .maybeSingle();

    if (!sourceConv) {
      throw new Error('Message not found');
    }
    const sourceOrg = Array.isArray(sourceConv.phone_numbers) ? sourceConv.phone_numbers[0] : sourceConv.phone_numbers;
    await requirePhoneAccess(supabase, userId, sourceConv.phone_number_id, sourceOrg?.organization_id);

    const prepared: PreparedMessage[] = (sources as SourceMessage[]).map((source) => {
      const type = source.message_type || 'text';
      const isMedia = MEDIA_TYPES.includes(type);
      // Caption só quando a origem tinha caption de verdade (não os placeholders
      // de mídia sem legenda, nem o filename que o qr-service grava em documentos).
      const caption = isMedia &&
        source.content &&
        !PLACEHOLDER_CONTENTS.includes(source.content) &&
        source.content !== source.media_filename
        ? source.content
        : null;
      return {
        source,
        type,
        isMedia,
        caption,
        isPtt: type === 'ptt' || (type === 'audio' && (source.media_mime_type || '').includes('ogg')),
        metaMediaType: type === 'ptt' ? 'audio' : type,
      };
    });

    // Pré-check da mídia: URL do CDN da Meta expira. Uma checagem barata aqui
    // evita N falhas idênticas no fan-out. Por URL distinta, e a expirada
    // derruba só a própria mensagem — o resto do lote segue.
    const expiredUrls = new Set<string>();
    const mediaUrls = [...new Set(prepared.filter((p) => p.isMedia).map((p) => p.source.media_url!))];
    await Promise.all(mediaUrls.map(async (url) => {
      try {
        const head = await fetch(paraUrlInterna(url), { method: 'HEAD' });
        if (!head.ok) expiredUrls.add(url);
      } catch (_e) {
        expiredUrls.add(url);
      }
    }));

    // ── Destinos: conversas + números (cada destino roteia pelo próprio canal) ──
    const { data: targets, error: targetsError } = await supabase
      .from('conversations')
      .select('id, contact_phone, contact_name, is_group, phone_number_id')
      .in('id', conversationIds);

    if (targetsError || !targets || targets.length !== conversationIds.length) {
      throw new Error('Conversations not found');
    }

    const phoneIds = [...new Set(targets.map((t: { phone_number_id: string }) => t.phone_number_id))];
    const { data: phones, error: phonesError } = await supabase
      .from('phone_numbers')
      .select(`
        id,
        organization_id,
        connection_type,
        phone_number,
        phone_number_id,
        organizations (
          id,
          whatsapp_waba_id,
          whatsapp_access_token
        )
      `)
      .in('id', phoneIds);

    if (phonesError || !phones || phones.length !== phoneIds.length) {
      throw new Error('Phone number not found for destination conversation');
    }

    const phoneById = new Map<string, PhoneData>();
    for (const p of phones as PhoneData[]) {
      phoneById.set(p.id, p);
      await requirePhoneAccess(supabase, userId, p.id, p.organization_id);
    }

    // ── Fan-out: destinos em série, e dentro de cada destino o lote em ordem.
    // Erro numa mensagem não aborta as demais nem os outros destinos ──
    const results: ForwardResult[] = [];

    for (const target of targets as TargetConversation[]) {
      const phoneData = phoneById.get(target.phone_number_id)!;
      const result: ForwardResult = {
        conversationId: target.id,
        contactName: target.contact_name,
        success: false,
        sent: 0,
        total: prepared.length,
        errors: [],
      };

      for (let i = 0; i < prepared.length; i++) {
        const item = prepared[i];
        try {
          if (item.isMedia && expiredUrls.has(item.source.media_url!)) {
            throw new Error('Media expired');
          }

          const whatsappMessageId = await sendToTarget(item, target, phoneData, supabaseUrl);
          await persistForwarded(supabase, item, target, phoneData, userId, whatsappMessageId);

          result.sent++;
          if (!result.messageId) result.messageId = whatsappMessageId;
        } catch (msgError) {
          const errMsg = msgError instanceof Error ? msgError.message : String(msgError);
          console.error(`[Forward] Failed message ${item.source.id} -> conversation ${target.id}:`, errMsg);
          result.errors.push(friendlyError(errMsg));
        }

        if (i < prepared.length - 1) {
          await sleep(SEND_INTERVAL_MS);
        }
      }

      result.success = result.sent === result.total;
      result.error = result.errors[0];
      results.push(result);

      // automation-execute deliberadamente NÃO dispara: encaminhar para até 5
      // conversas rodando automações de outbound em cada uma seria surpresa.
    }

    const anySuccess = results.some((r) => r.sent > 0);
    // Com success:false o helper do front (checkEdgeFunctionResponseAsync) lança
    // usando o `error` do topo — sem ele, o motivo real ficava só dentro de
    // results[] e o usuário via "Erro desconhecido".
    const firstError = results.find((r) => r.error)?.error;
    return new Response(JSON.stringify({
      success: anySuccess,
      results,
      ...(anySuccess ? {} : { error: firstError || 'Não foi possível encaminhar.' }),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
