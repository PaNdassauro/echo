import { metaAppSecrets, OFFICIAL_CONNECTION_TYPES, signatureEnforced, webhookValue } from '../_shared/meta-webhook.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { z } from 'https://esm.sh/zod@3.23.8';
import { qrAuthHeaders } from '../_shared/qr.ts';
import { segredoConfere } from '../_shared/segredo.ts';
import { reativarConversa } from '../_shared/conversation-touch.ts';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { logWriteFailure } from '../_shared/failure-log.ts';
import { registrarEdicao } from '../_shared/metadata-merge.ts';
import { emitMessageSent, sendOrganizationWebhook } from '../_shared/webhooks.ts';
import { chaveDoAviso } from '../_shared/aviso-unico.ts';
import { atualizacaoDoNomeDoGrupo } from '../_shared/nome-do-grupo.ts';
import {
  bufferReader,
  blobReader,
  MediaDimensionsSchema,
  probeMediaDimensions,
  probeUrlDimensions,
  thumbHashFromUrl,
  withMediaDims,
  withThumbHash,
  type MediaDims,
} from '../_shared/media-probe.ts';
import { ehAnexoNosso, urlPublicaDoAnexo } from '../_shared/url-publica.ts';
// Automation logic now handled by separate edge function: automation-execute

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'session not connected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp nas configurações.',
    'not connected': 'WhatsApp desconectado. Tente novamente ou reconecte nas configurações.',
    'phone number not found': 'Número de WhatsApp não encontrado.',
    'failed to create conversation': 'Erro ao criar conversa. Tente novamente.',
    'failed to update': 'Erro ao atualizar. Tente novamente.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

// Atribuição de anúncio Click-to-WhatsApp (botão "Enviar mensagem" no Instagram/Facebook).
// O WhatsApp só entrega esse bloco na PRIMEIRA mensagem de um lead vindo de anúncio, e não
// existe API para buscá-lo depois — o que não for gravado aqui está perdido. Por isso ele é
// persistido cru, sem reinterpretação.
//
// Os dois transportes entregam o mesmo conceito em formatos diferentes: a Cloud API manda
// `referral` em snake_case, o Baileys manda `externalAdReply` em camelCase. O `ctwa_clid` é
// promovido ao topo para dar uma chave de consulta estável independente da origem, e
// `referral_transport` registra de qual formato o bloco veio.
function ctwaMetadata(
  referral: unknown,
  transport: 'baileys' | 'cloud_api',
  hoistedClid?: unknown,
): Record<string, unknown> | null {
  if (!referral || typeof referral !== 'object' || Array.isArray(referral)) return null;
  const block = referral as Record<string, unknown>;
  if (Object.keys(block).length === 0) return null;

  // Baileys: o serviço QR já promove o clid. Cloud API: ele vem dentro do próprio bloco.
  const clid = typeof hoistedClid === 'string' && hoistedClid
    ? hoistedClid
    : typeof block.ctwa_clid === 'string' ? block.ctwa_clid : null;

  return { ctwa_clid: clid, referral: block, referral_transport: transport };
}

/**
 * Classifica erro do PostgREST/Postgres para o contrato de erro do webhook.
 *
 * Permanente = reenviar o MESMO payload falha para sempre (dados/integridade/schema:
 * SQLSTATE classes 22, 23 e 42) — devolver 5xx aqui criaria loop de reentrega. A
 * exceção é 23505 (unique): é duplicata/corrida, o retry ou o reselect resolvem.
 * Todo o resto (timeout, pool, PGRST*, rede) é transiente: 5xx para o transporte
 * reentregar. Default = transiente — a whitelist de tipo e o content ?? '' já barram
 * os permanentes conhecidos, então o desconhecido merece retry.
 */
function isPermanentDbError(err: { code?: string } | null | undefined): boolean {
  const c = err?.code ?? '';
  if (c === '23505') return false;
  return c.startsWith('22') || c.startsWith('23') || c.startsWith('42');
}

/**
 * Espelho exato do CHECK messages_message_type_check (21 tipos). Tipo fora da lista NUNCA pode chegar ao insert — vira 'unsupported'
 * com o original preservado em metadata. Sem isto, um tipo novo da Meta (order,
 * system, evento de boas-vindas, subtipo novo de interactive) ou do qr-service era 23514
 * e a mensagem morria em silêncio.
 */
const VALID_MESSAGE_TYPES = new Set([
  'text', 'image', 'audio', 'video', 'document', 'location', 'sticker', 'template',
  'button_reply', 'list_reply', 'flow', 'nfm_reply', 'contact', 'deleted',
  'unsupported', 'reaction', 'group_action', 'ptt', 'list', 'poll',
  // 'call': registro de ligação de voz gravado pelo qr-service quando a ligação
  // termina. Depende do CHECK de messages.message_type aceitar 'call' (baseline) — sem ele o insert
  // volta 23514 e a mensagem morre em silêncio.
  'call',
]);

function validateMessageType(raw: unknown): { type: string; originalType: string | null } {
  const t = typeof raw === 'string' && raw.trim() ? raw.trim() : 'text';
  return VALID_MESSAGE_TYPES.has(t)
    ? { type: t, originalType: null }
    : { type: 'unsupported', originalType: t };
}

// logWriteFailure agora vive em _shared/failure-log.ts — mesma evidência
// estruturada para todos os writers de mensagem (send/scheduled/automation).

/**
 * Payload do qr-service. Frouxo de propósito (.passthrough(), 1 refine): a missão é
 * rejeitar só o irrecuperável — payload sem identidade de origem/destino — nunca
 * tráfego legítimo de uma versão antiga do serviço.
 */
const QrMessageSchema = z.object({
  phone_number_id: z.string().min(1),
  from: z.string().optional(),
  message_id: z.string().nullish(),
  content: z.string().nullish(),
  message_type: z.string().optional(),
  is_group: z.boolean().optional(),
  group_jid: z.string().nullish(),
}).passthrough()
  .refine((b) => (b.is_group === true ? !!b.group_jid : !!b.from), {
    message: 'from (1:1) ou group_jid (grupo) é obrigatório',
  });

// Fire-and-forget OS push for a saved inbound message. Delegates to the
// send-web-push edge function, which resolves the conversation's recipients
// (assignee + co-owners) and delivers to their subscribed devices — reaching
// them even with the tab fully closed. Never blocks or fails the webhook.
function triggerWebPush(
  supabaseUrl: string,
  serviceKey: string,
  args: { conversationId: string; title: string; body: string },
): void {
  fetch(`${supabaseUrl}/functions/v1/send-web-push`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  }).catch((err) => console.error('[WebPush] trigger error:', err));
}

// Meta's webhook always delivers wa_id as full E.164 digits (no leading "+").
// A Brazilian wa_id is "55" + DDD(2) + 8 or 9 digits. International numbers
// arrive with their own country code (e.g., 34 for Spain). We only generate
// BR variations when the value clearly is Brazilian — otherwise we trust the
// number and never prepend "55", since that's what was corrupting Spanish
// numbers in the first place.
function normalizePhoneNumber(phone: string | number): { normalized: string; variations: string[] } {
  if (!phone) return { normalized: '', variations: [] };

  const phoneStr = String(phone);
  const digits = phoneStr.replace(/\D/g, '');
  const variations: string[] = [digits];

  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.substring(2, 4);
    const localNumber = digits.substring(4);

    variations.push(ddd + localNumber);

    if (localNumber.length === 8) {
      variations.push('55' + ddd + '9' + localNumber);
      variations.push(ddd + '9' + localNumber);
    } else if (localNumber.length === 9) {
      variations.push('55' + ddd + localNumber.substring(1));
      variations.push(ddd + localNumber.substring(1));
    }
  }

  return { normalized: digits, variations: [...new Set(variations)] };
}

/**
 * Converte o `timestamp` do payload do qr-service (epoch em SEGUNDOS) no
 * created_at da mensagem.
 *
 * Sem isso a linha nasce com o default do banco (now()), o que é invisível numa
 * mensagem ao vivo mas mente numa recuperada: o histórico de uma queda de dias
 * entrava inteiro datado da hora do refetch, no fim da conversa em vez da posição
 * cronológica real.
 *
 * Fora da faixa plausível devolve null e o caller deixa o default agir — um
 * timestamp corrompido não pode jogar a mensagem para 1970 nem para o futuro.
 */
function messageTimestampToIso(timestamp: unknown): string | null {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const ms = seconds * 1000;
  // WhatsApp não existia antes de 2009; o teto tolera relógio adiantado do aparelho.
  const MIN_MS = Date.UTC(2009, 0, 1);
  const MAX_MS = Date.now() + 24 * 60 * 60 * 1000;
  if (ms < MIN_MS || ms > MAX_MS) return null;

  return new Date(ms).toISOString();
}

/** Atraso a partir do qual a chegada é marcada como reentrega tardia. */
const LATE_DELIVERY_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * sent_at (hora do cliente) e delivered_late para uma mensagem da Cloud API.
 * lagMinutes só vem preenchido quando a entrega é tardia, para o log.
 */
function cloudDeliveryTiming(timestamp: unknown, nowMs = Date.now()): {
  metadata: { sent_at: string; delivered_late?: true } | null;
  lagMinutes: number | null;
} {
  const sentAt = messageTimestampToIso(timestamp);
  if (!sentAt) return { metadata: null, lagMinutes: null };
  const lagMs = nowMs - Date.parse(sentAt);
  if (lagMs <= LATE_DELIVERY_THRESHOLD_MS) return { metadata: { sent_at: sentAt }, lagMinutes: null };
  return { metadata: { sent_at: sentAt, delivered_late: true }, lagMinutes: Math.round(lagMs / 60000) };
}

/**
 * Localiza as mensagens de um wamid, restritas ao número que originou o evento.
 *
 * O unique de messages é composto (whatsapp_message_id, conversation_id), então o mesmo wamid
 * pode existir em conversas de números diferentes. Filtrar só por wamid — como era feito antes —
 * podia editar/apagar a mensagem de outro número, e o .maybeSingle() estourava com
 * "multiple rows returned", devolvendo 500 mesmo depois de ter escrito.
 *
 * phoneNumberId ausente (imagem antiga do qr-service) cai no comportamento largo, sem escopo.
 */
async function findMessagesByWamid(
  supabase: any,
  wamid: string,
  phoneNumberId: string | undefined,
  columns: string,
): Promise<{ rows: any[] } | { error: unknown }> {
  let query = supabase
    .from('messages')
    .select(`id, ${columns}, conversations!inner(phone_number_id)`)
    .eq('whatsapp_message_id', wamid);

  if (phoneNumberId) {
    query = query.eq('conversations.phone_number_id', phoneNumberId);
  } else {
    console.warn(`[findMessagesByWamid] No phone_number_id for ${wamid} — matching across all numbers`);
  }

  const { data, error } = await query;
  if (error) return { error };
  return { rows: data ?? [] };
}

/**
 * Fan-out da reação em message_reactions (agregação multi-usuário em grupo).
 *
 * As colunas escalares (reaction/our_reaction) continuam sendo o fallback e
 * são escritas pelos chamadores; aqui só o fan-out. Regras:
 * - from_me → reactor_jid NULL sempre (eco do aparelho e reação do painel
 *   precisam colidir na mesma linha única por mensagem).
 * - contato/participante sem reactor_jid (qr-service antigo) → degrada para o
 *   escalar: NÃO escreve aqui (um NULL colidiria entre participantes).
 * - emoji vazio = remoção → DELETE da linha.
 * Falha aqui não derruba o caminho principal — melhor escalar certo do que 500.
 */
async function writeReactionRows(
  supabase: any,
  messageIds: string[],
  opts: {
    emoji: string | null;
    isFromMe: boolean;
    reactorJid?: string | null;
    reactorName?: string | null;
    reactorUserId?: string | null;
  },
): Promise<void> {
  const reactorJid = opts.isFromMe ? null : (opts.reactorJid ?? null);
  if (!opts.isFromMe && !reactorJid) {
    console.log('[Reactions] Sem reactor_jid (payload antigo) — mantendo só o escalar');
    return;
  }
  try {
    for (const messageId of messageIds) {
      let del = supabase
        .from('message_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('is_from_me', opts.isFromMe);
      del = reactorJid ? del.eq('reactor_jid', reactorJid) : del.is('reactor_jid', null);
      const { error: delError } = await del;
      if (delError) {
        console.error('[Reactions] Falha ao remover linha anterior:', delError);
        continue;
      }
      if (opts.emoji) {
        const { error: insError } = await supabase.from('message_reactions').insert({
          message_id: messageId,
          reactor_jid: reactorJid,
          reactor_name: opts.reactorName ?? null,
          reactor_user_id: opts.reactorUserId ?? null,
          is_from_me: opts.isFromMe,
          emoji: opts.emoji,
        });
        if (insError) {
          console.error('[Reactions] Falha ao inserir reação:', insError);
        }
      }
    }
  } catch (err) {
    console.error('[Reactions] Erro no fan-out (escalar segue válido):', err);
  }
}

// Download media from WhatsApp and store in Supabase Storage
async function downloadAndStoreMedia(
  supabase: any,
  mediaId: string,
  accessToken: string,
  mediaType: string,
  mimeType: string,
  filename?: string
): Promise<{ url: string; mime_type: string; filename: string; size_bytes: number; dims?: MediaDims | null } | null> {
  try {
    console.log(`[Media] Downloading media ${mediaId}, type: ${mediaType}`);

    // Step 1: Get media URL from WhatsApp
    const mediaInfoResponse = await fetch(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      }
    );

    if (!mediaInfoResponse.ok) {
      console.error('[Media] Failed to get media info:', await mediaInfoResponse.text());
      return null;
    }

    const mediaInfo = await mediaInfoResponse.json();
    const mediaUrl = mediaInfo.url;

    if (!mediaUrl) {
      console.error('[Media] No URL in media info response');
      return null;
    }

    // Step 2: Download the actual file
    const fileResponse = await fetch(mediaUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!fileResponse.ok) {
      console.error('[Media] Failed to download file:', await fileResponse.text());
      return null;
    }

    const fileBlob = await fileResponse.blob();
    const fileSize = fileBlob.size;

    // Dimensões de exibição para o chat reservar a caixa exata. Só CPU sobre o blob
    // que já está em memória (sem rede); nunca lança. Figurinha tem caixa fixa.
    let dims: MediaDims | null = null;
    if (mediaType === 'image' || mediaType === 'video') {
      dims = await probeMediaDimensions(blobReader(fileBlob), { timeoutMs: 500 });
    }

    // Generate filename if not provided
    const extension = mimeType.split('/')[1]?.split(';')[0] || 'bin';
    const rawFilename = filename || `${mediaType}_${mediaId}.${extension}`;

    // Sanitize filename: remove accents, replace spaces with underscores, remove special chars
    const sanitizedFilename = rawFilename
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
      .replace(/\s+/g, '_') // Replace spaces with underscores
      .replace(/[^a-zA-Z0-9_.\-]/g, ''); // Remove any remaining special chars

    const storagePath = `media/${Date.now()}_${sanitizedFilename}`;

    // Sanitize content type - strip codec specification (e.g., "audio/ogg; codecs=opus" -> "audio/ogg")
    const sanitizedMimeType = mimeType.split(';')[0].trim();

    console.log(`[Media] Uploading to storage: ${storagePath}, size: ${fileSize} bytes, contentType: ${sanitizedMimeType}`);

    // Step 3: Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('attachments')
      .upload(storagePath, fileBlob, {
        contentType: sanitizedMimeType,
        upsert: false
      });

    if (uploadError) {
      console.error('[Media] Storage upload error:', uploadError);
      return null;
    }

    // Step 4: Get public URL (a base pública, não a interna: a URL é gravada e vai ao navegador)
    const publicUrl = urlPublicaDoAnexo(storagePath);

    console.log(`[Media] Upload successful: ${publicUrl}`);

    return {
      url: publicUrl,
      mime_type: mimeType,
      filename: sanitizedFilename,
      size_bytes: fileSize,
      dims,
    };
  } catch (error) {
    console.error('[Media] Error processing media:', error);
    return null;
  }
}

/**
 * Verifies Meta's X-Hub-Signature-256 header against the raw request body.
 * Meta sends `sha256=<hex>` where <hex> = HMAC-SHA256(appSecret, rawBody).
 * Uses a constant-time comparison to avoid leaking the digest via timing.
 */
async function verifyMetaSignature(
  appSecret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const prefix = 'sha256=';
  if (!signatureHeader || !signatureHeader.startsWith(prefix)) return false;
  const providedHex = signatureHeader.slice(prefix.length);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computedHex = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (computedHex.length !== providedHex.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computedHex.length; i++) {
    mismatch |= computedHex.charCodeAt(i) ^ providedHex.charCodeAt(i);
  }
  return mismatch === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  // Vazio ou ausente = verificação desligada: um token vazio no .env não pode casar com `hub.verify_token=` vazio.
  const verifyToken = Deno.env.get('WHATSAPP_VERIFY_TOKEN') ?? '';

  try {
    // Webhook verification
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');

      if (mode === 'subscribe' && verifyToken !== '' && token === verifyToken) {
        console.log('Webhook verified successfully');
        return new Response(challenge, { status: 200 });
      } else {
        return new Response('Forbidden', { status: 403 });
      }
    }

    // Handle incoming messages
    if (req.method === 'POST') {
      const supabase = createClient(supabaseUrl, supabaseKey);

      // Check if this is a QR reaction from Baileys service
      const url = new URL(req.url);

      // Internal /qr-* routes come from the QR service, not Meta, so they carry no Meta
      // signature. A shared secret (QR_WEBHOOK_SECRET, same value here and in the QR
      // service) is required: without it anyone could post messages, reactions and
      // delivery status into any QR line. No secret configured = 503, never open.
      if (url.pathname.includes('/qr-')) {
        const qrSecret = Deno.env.get('QR_WEBHOOK_SECRET');
        if (!qrSecret) {
          console.error('[whatsapp-webhook] QR_WEBHOOK_SECRET not configured: refusing QR route (set the same value here and in the QR service)');
          return new Response(JSON.stringify({ error: 'QR_WEBHOOK_SECRET not configured' }), {
            status: 503,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        // Tempo constante: `!==` sai no primeiro caractere diferente e deixa
        // adivinhar o segredo pela latência.
        if (!(await segredoConfere(req.headers.get('x-qr-secret'), qrSecret))) {
          console.warn('[whatsapp-webhook] Rejected QR route: bad/missing x-qr-secret');
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (url.pathname.endsWith('/qr-reaction')) {
        const reactionBody = await req.json();
        console.log('[QR-Reaction] Received reaction:', JSON.stringify(reactionBody, null, 2));

        const { reaction_emoji, target_message_id, from_me, phone_number_id, reactor_jid, reactor_name } = reactionBody;

        if (!target_message_id) {
          return new Response(JSON.stringify({ error: 'Missing target_message_id' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Update the target message with the reaction (empty string = remove reaction)
        const reactionValue = reaction_emoji && reaction_emoji.trim() !== '' ? reaction_emoji : null;

        // Eco da NOSSA reação (enviada pelo painel ou pelo celular pareado) vai
        // para our_reaction; gravá-lo em `reaction` duplicava o badge na bolha
        // (o painel já grava our_reaction ao reagir). qr-service antigo não
        // manda from_me → segue no comportamento atual (reação do contato).
        const reactionColumn = from_me === true ? 'our_reaction' : 'reaction';

        // Sessões espelhadas: o mesmo wamid existe em conversas de números
        // diferentes — escopar pelo número que originou o evento.
        const targets = await findMessagesByWamid(supabase, target_message_id, phone_number_id, 'conversation_id');
        if ('error' in targets) {
          console.error('[QR-Reaction] Error loading message:', targets.error);
          return new Response(JSON.stringify({ error: 'Failed to update reaction' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (targets.rows.length === 0) {
          console.warn(`[QR-Reaction] Message not found for whatsapp_message_id: ${target_message_id}`);
          return new Response(JSON.stringify({ status: 'not_found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error: updateError } = await supabase
          .from('messages')
          .update({ [reactionColumn]: reactionValue })
          .in('id', targets.rows.map((row) => row.id));

        if (updateError) {
          console.error('[QR-Reaction] Error updating message:', updateError);
          return new Response(JSON.stringify({ error: 'Failed to update reaction' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Fan-out por reator (agregação em grupo); o escalar acima é o fallback
        await writeReactionRows(supabase, targets.rows.map((row) => row.id), {
          emoji: reactionValue,
          isFromMe: from_me === true,
          reactorJid: reactor_jid ?? null,
          reactorName: reactor_name ?? null,
        });

        // Update conversation last_message_at to reorder in sidebar
        const conversationIds = [...new Set(targets.rows.map((row) => row.conversation_id))];
        await supabase
          .from('conversations')
          .update({ last_message_at: new Date().toISOString() })
          .in('id', conversationIds);

        console.log(`[QR-Reaction] Updated message(s) ${targets.rows.map((r) => r.id).join(', ')} with reaction: ${reactionValue}`);
        return new Response(JSON.stringify({ status: 'ok', message_id: targets.rows[0].id }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Voto em enquete (decriptado pelo qr-service). Escrita atômica via RPC
      // record_poll_vote; escopo por número (sessões espelhadas atualizam as
      // duas cópias da enquete).
      if (url.pathname.endsWith('/qr-poll-vote')) {
        const voteBody = await req.json();
        const { poll_message_id, voter_jid, voter_name, selected_options, phone_number_id } = voteBody;

        if (!poll_message_id || !voter_jid || !Array.isArray(selected_options)) {
          return new Response(JSON.stringify({ error: 'poll_message_id, voter_jid and selected_options[] are required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const targets = await findMessagesByWamid(supabase, poll_message_id, phone_number_id, 'conversation_id');
        if ('error' in targets) {
          console.error('[Poll-Vote] Error loading poll message:', targets.error);
          return new Response(JSON.stringify({ error: 'Failed to load poll' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        if (targets.rows.length === 0) {
          console.warn(`[Poll-Vote] Poll not found for wamid: ${poll_message_id}`);
          return new Response(JSON.stringify({ status: 'not_found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        for (const row of targets.rows) {
          const { error: rpcError } = await supabase.rpc('record_poll_vote', {
            p_message_id: row.id,
            p_voter: voter_jid,
            p_voter_name: voter_name ?? null,
            p_options: selected_options,
          });
          if (rpcError) {
            console.error('[Poll-Vote] RPC error:', rpcError);
          }
        }

        console.log(`[Poll-Vote] ${voter_jid} → ${poll_message_id}: [${selected_options.join(', ')}]`);
        return new Response(JSON.stringify({ status: 'ok' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Handle delivery status updates from QR service (sent -> delivered -> read)
      if (url.pathname.endsWith('/qr-delivery-update')) {
        const { message_id, status, status_label, phone_number_id: deliveryPhoneId } = await req.json();
        console.log(`[QR-DeliveryUpdate] Received: msgId=${message_id}, status=${status} (${status_label})`);

        if (!message_id) {
          return new Response(JSON.stringify({ error: 'Missing message_id' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Map Baileys status codes to our status strings
        // 1=pending, 2=sent, 3=delivered, 4=read, 5=played (treat as read)
        const statusMap: Record<number, string> = {
          0: 'failed', // ack com erro (ex.: 463 restrição de abordagem) — ver status_label ERROR_<code>
          1: 'pending',
          2: 'sent',
          3: 'delivered',
          4: 'read',
          5: 'read',
        };

        // O qr-service só encaminha status >= 3, então um código fora do mapa é
        // algo novo do Baileys — cai em 'delivered'. Antes caía em 'sent', o que
        // hoje emitiria um `message.sent` duplicado do emitido na gravação.
        const newStatus = statusMap[status] || 'delivered';

        // Escopo por número: sessões espelhadas gravam o mesmo wamid em conversas
        // de números diferentes — o .maybeSingle() sem filtro estourava com
        // "multiple rows returned" (PGRST116) e o status de LEITURA se perdia
        // permanentemente (o Baileys não reenvia recibos).
        let deliveryPhoneRowId: string | undefined;
        if (deliveryPhoneId) {
          const isDeliveryUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryPhoneId);
          const { data: deliveryPhone, error: deliveryPhoneError } = await supabase
            .from('phone_numbers')
            .select('id')
            .eq(isDeliveryUUID ? 'id' : 'phone_number_id', deliveryPhoneId)
            .maybeSingle();

          // Descartar este erro degradava em silêncio para o "match largo"
          // abaixo — exatamente o cenário que o escopo por número existe para
          // impedir: com sessões espelhadas, o status aterrissa na cópia de
          // OUTRO número. O payload trazia o telefone; falhar a leitura dele
          // não é o mesmo que não recebê-lo, e o warn de :654 não distinguia
          // os dois casos. 503 → o qr-service reentrega.
          if (deliveryPhoneError) {
            console.error('[QR-DeliveryUpdate] Erro ao resolver phone_number:', deliveryPhoneError);
            return new Response(JSON.stringify({ error: 'Failed to resolve phone number' }), {
              status: 503,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          deliveryPhoneRowId = deliveryPhone?.id;
        }

        let deliveryQuery = supabase
          .from('messages')
          .select(`
            id,
            content,
            message_type,
            sent_by,
            created_at,
            whatsapp_message_id,
            media_url,
            media_mime_type,
            media_filename,
            media_size_bytes,
            conversation:conversations!inner(
              id,
              contact_phone,
              contact_name,
              phone_number:phone_numbers!inner(
                id,
                organization_id,
                phone_number_id
              )
            )
          `)
          .eq('whatsapp_message_id', message_id);
        if (deliveryPhoneRowId) {
          deliveryQuery = deliveryQuery.eq('conversation.phone_number_id', deliveryPhoneRowId);
        } else {
          console.warn(`[QR-DeliveryUpdate] Sem phone_number_id no payload — match largo para ${message_id}`);
        }
        const { data: messageRows, error: msgFetchError } = await deliveryQuery;

        if (msgFetchError) {
          console.error('[QR-DeliveryUpdate] Error fetching message:', msgFetchError);
          return new Response(JSON.stringify({ error: 'Failed to fetch message' }), {
            status: 503,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (!messageRows || messageRows.length === 0) {
          console.warn(`[QR-DeliveryUpdate] Message not found for whatsapp_message_id: ${message_id}`);
          return new Response(JSON.stringify({ status: 'not_found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const messageData = messageRows[0];

        // Update message status — todas as cópias escopadas de uma vez
        const { error: updateError } = await supabase
          .from('messages')
          .update({ status: newStatus })
          .in('id', messageRows.map((row: { id: string }) => row.id));

        if (updateError) {
          console.error('[QR-DeliveryUpdate] Error updating message:', updateError);
          return new Response(JSON.stringify({ error: 'Failed to update status' }), {
            status: 503,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Send webhook for status update
        const conversation = messageData.conversation as any;
        const phoneNumber = conversation?.phone_number as any;
        const organizationId = phoneNumber?.organization_id;

        if (organizationId) {
          // Map status to code
          let statusCode = 0;
          switch (newStatus) {
            case 'sent': statusCode = 2; break;
            case 'delivered': statusCode = 3; break;
            case 'read': statusCode = 4; break;
            case 'failed': statusCode = -1; break;
            default: statusCode = 0;
          }

          // Build media object if message has media
          const mediaObject = messageData.media_url ? {
            url: messageData.media_url,
            mime_type: messageData.media_mime_type,
            filename: messageData.media_filename,
            size_bytes: messageData.media_size_bytes,
          } : null;

          const webhookPayload = {
            phone_number_id: phoneNumber?.phone_number_id,
            phone_number_internal_id: phoneNumber?.id,
            message: {
              id: messageData.id,
              whatsapp_id: message_id,
              content: messageData.content,
              type: messageData.message_type,
              status: newStatus,
              status_code: statusCode,
              sent_by: messageData.sent_by,
              // Hora da mensagem: o CRM cria a linha pelo aviso de status quando não a tem, e sem ela a
              // fala de dias atrás aparecia como "agora". Vira message_created_at.
              created_at: messageData.created_at,
              updated_at: new Date().toISOString(),
              media: mediaObject,
            },
            contact: {
              id: conversation.id,
              name: conversation.contact_name || 'Unknown',
              phone: conversation.contact_phone,
            },
            conversation: {
              id: conversation.id
            }
          };

          await sendOrganizationWebhook(supabase, organizationId, `message.${newStatus}`, webhookPayload);
          console.log(`[QR-DeliveryUpdate] Webhook sent for message.${newStatus}`);
        }

        console.log(`[QR-DeliveryUpdate] Updated message ${messageData.id} to status: ${newStatus}`);
        return new Response(JSON.stringify({ status: 'ok', message_id: messageData.id, new_status: newStatus }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Recibos por participante em GRUPO (message-receipt.update do Baileys).
      // Em @g.us o WhatsApp não manda status por messages.update — o recibo vem
      // um por participante. O fan-out persiste em message_receipts (RPC) e o
      // status escalar é agregado aqui: delivered no primeiro recibo, read
      // quando todos leram (group_size = snapshot do qr-service, participantes
      // menos o próprio número).
      if (url.pathname.endsWith('/qr-message-receipt')) {
        const receiptBody = await req.json();
        const {
          message_id: receiptWamid,
          phone_number_id: receiptPhoneId,
          group_size: receiptGroupSize,
          receipts,
        } = receiptBody;

        if (!receiptWamid || !Array.isArray(receipts) || receipts.length === 0) {
          return new Response(JSON.stringify({ error: 'message_id and receipts[] are required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Escopo por número: sessões espelhadas gravam o mesmo wamid em
        // conversas de números diferentes (mesma mecânica do qr-delivery-update).
        let receiptPhoneRowId: string | undefined;
        if (receiptPhoneId) {
          const isReceiptUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receiptPhoneId);
          const { data: receiptPhone, error: receiptPhoneError } = await supabase
            .from('phone_numbers')
            .select('id')
            .eq(isReceiptUUID ? 'id' : 'phone_number_id', receiptPhoneId)
            .maybeSingle();

          // Mesmo raciocínio do /qr-delivery-update: erro de leitura aqui
          // degradava para o match largo e o recibo podia cair na cópia
          // espelhada de outro número. 503 → o qr-service reentrega.
          if (receiptPhoneError) {
            console.error('[QR-MessageReceipt] Erro ao resolver phone_number:', receiptPhoneError);
            return new Response(JSON.stringify({ error: 'Failed to resolve phone number' }), {
              status: 503,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          receiptPhoneRowId = receiptPhone?.id;
        }

        let receiptQuery = supabase
          .from('messages')
          .select(`
            id,
            content,
            message_type,
            sent_by,
            whatsapp_message_id,
            media_url,
            media_mime_type,
            media_filename,
            media_size_bytes,
            conversation:conversations!inner(
              id,
              contact_phone,
              contact_name,
              phone_number:phone_numbers!inner(
                id,
                organization_id,
                phone_number_id
              )
            )
          `)
          .eq('whatsapp_message_id', receiptWamid);
        if (receiptPhoneRowId) {
          receiptQuery = receiptQuery.eq('conversation.phone_number_id', receiptPhoneRowId);
        } else {
          console.warn(`[QR-MessageReceipt] Sem phone_number_id no payload — match largo para ${receiptWamid}`);
        }
        const { data: receiptMsgRows, error: receiptFetchError } = await receiptQuery;

        if (receiptFetchError) {
          console.error('[QR-MessageReceipt] Error fetching message:', receiptFetchError);
          return new Response(JSON.stringify({ error: 'Failed to fetch message' }), {
            status: 503,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        if (!receiptMsgRows || receiptMsgRows.length === 0) {
          // 404 = discard silencioso no outbox: mensagem que o CRM não conhece.
          console.warn(`[QR-MessageReceipt] Message not found for whatsapp_message_id: ${receiptWamid}`);
          return new Response(JSON.stringify({ status: 'not_found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const receiptMessageIds = receiptMsgRows.map((row: { id: string }) => row.id);
        const { data: receiptCounts, error: receiptRpcError } = await supabase.rpc('record_message_receipts', {
          p_message_ids: receiptMessageIds,
          p_receipts: receipts,
        });
        if (receiptRpcError) {
          console.error('[QR-MessageReceipt] RPC error:', receiptRpcError);
          return new Response(JSON.stringify({ error: 'Failed to record receipts' }), {
            status: 503,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Todas as cópias escopadas partilham wamid e recibos — as contagens
        // são iguais entre elas; o max é só defesa.
        const receiptReadCount = Math.max(
          0,
          ...((receiptCounts ?? []) as Array<{ read_count: number | null }>).map((c) => c.read_count ?? 0),
        );
        const groupSize = typeof receiptGroupSize === 'number' && receiptGroupSize > 0 ? receiptGroupSize : null;
        const receiptStatus = groupSize !== null && receiptReadCount >= groupSize ? 'read' : 'delivered';

        // Update MONOTÔNICO — recibo atrasado nunca rebaixa read; delivered não
        // repinta delivered (evita webhook message.delivered duplicado).
        let receiptUpdate = supabase
          .from('messages')
          .update({ status: receiptStatus })
          .in('id', receiptMessageIds);
        receiptUpdate = receiptStatus === 'read'
          ? receiptUpdate.neq('status', 'read')
          : receiptUpdate.in('status', ['pending', 'sending', 'sent']);
        const { data: receiptUpdatedRows, error: receiptUpdateError } = await receiptUpdate.select('id');

        if (receiptUpdateError) {
          // Recibos já persistidos — não falhar o job por causa do escalar.
          console.error('[QR-MessageReceipt] Error updating status:', receiptUpdateError);
        } else if (receiptUpdatedRows && receiptUpdatedRows.length > 0) {
          const receiptMsg = receiptMsgRows[0];
          const receiptConversation = receiptMsg.conversation as any;
          const receiptPhoneNumber = receiptConversation?.phone_number as any;
          if (receiptPhoneNumber?.organization_id) {
            const receiptMedia = receiptMsg.media_url ? {
              url: receiptMsg.media_url,
              mime_type: receiptMsg.media_mime_type,
              filename: receiptMsg.media_filename,
              size_bytes: receiptMsg.media_size_bytes,
            } : null;
            await sendOrganizationWebhook(supabase, receiptPhoneNumber.organization_id, `message.${receiptStatus}`, {
              phone_number_id: receiptPhoneNumber.phone_number_id,
              phone_number_internal_id: receiptPhoneNumber.id,
              message: {
                id: receiptMsg.id,
                whatsapp_id: receiptWamid,
                content: receiptMsg.content,
                type: receiptMsg.message_type,
                status: receiptStatus,
                status_code: receiptStatus === 'read' ? 4 : 3,
                sent_by: receiptMsg.sent_by,
                updated_at: new Date().toISOString(),
                media: receiptMedia,
              },
              contact: {
                id: receiptConversation.id,
                name: receiptConversation.contact_name || 'Unknown',
                phone: receiptConversation.contact_phone,
              },
              conversation: {
                id: receiptConversation.id,
              },
            });
          }
          console.log(`[QR-MessageReceipt] ${receiptWamid}: ${receipts.length} recibo(s), read ${receiptReadCount}/${groupSize ?? '?'} → status ${receiptStatus}`);
        }

        return new Response(JSON.stringify({ status: 'ok', read_count: receiptReadCount, group_size: groupSize }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Handle message deleted for everyone (received via Baileys)
      // Soft delete: content, message_type e media_url ficam intactos — a UI apenas sinaliza.
      if (url.pathname.endsWith('/qr-message-deleted')) {
        const { message_id, phone_number_id } = await req.json();
        if (!message_id) {
          return new Response(JSON.stringify({ error: 'Missing message_id' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const targets = await findMessagesByWamid(supabase, message_id, phone_number_id, 'is_deleted');
        if ('error' in targets) {
          console.error('[QR-MessageDeleted] Error loading message:', targets.error);
          return new Response(JSON.stringify({ error: 'Failed to load message' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (targets.rows.length === 0) {
          console.warn(`[QR-MessageDeleted] Message not found for whatsapp_message_id: ${message_id}`);
          return new Response(JSON.stringify({ status: 'not_found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Idempotente: reentrega do webhook não reescreve deleted_at.
        const pending = targets.rows.filter((row) => !row.is_deleted);
        if (pending.length === 0) {
          console.log(`[QR-MessageDeleted] Message ${message_id} already marked as deleted`);
          return new Response(JSON.stringify({ status: 'ok', already_deleted: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error: updateError } = await supabase
          .from('messages')
          .update({ is_deleted: true, deleted_at: new Date().toISOString() })
          .in('id', pending.map((row) => row.id));

        if (updateError) {
          console.error('[QR-MessageDeleted] Error updating message:', updateError);
          return new Response(JSON.stringify({ error: 'Failed to update message' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`[QR-MessageDeleted] Marked message(s) ${pending.map((r) => r.id).join(', ')} as deleted`);
        return new Response(JSON.stringify({ status: 'ok', message_id: pending[0].id }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Handle message edited by sender (received via Baileys)
      // Guarda a versão anterior em metadata.edit_history antes de sobrescrever o content.
      if (url.pathname.endsWith('/qr-message-edited')) {
        const { message_id, new_content, phone_number_id, flag_only } = await req.json();
        // flag_only: em 1:1 o WhatsApp entrega a edição cifrada com o segredo da mensagem alvo. Se
        // o serviço não conseguiu decifrar (segredo fora do cache), ele avisa que houve edição sem
        // o texto novo — melhor marcar do que deixar o operador lendo texto velho sem aviso.
        if (!message_id || (!new_content && !flag_only)) {
          return new Response(JSON.stringify({ error: 'Missing message_id or new_content' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const targets = await findMessagesByWamid(
          supabase, message_id, phone_number_id, 'content, is_deleted'
        );
        if ('error' in targets) {
          console.error('[QR-MessageEdited] Error loading message:', targets.error);
          return new Response(JSON.stringify({ error: 'Failed to load message' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (targets.rows.length === 0) {
          console.warn(`[QR-MessageEdited] Message not found for whatsapp_message_id: ${message_id}`);
          return new Response(JSON.stringify({ status: 'not_found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // A edição chega por dois caminhos do Baileys (messages.upsert e messages.update), então
        // o disparo duplicado é esperado: sem esta guarda o histórico ganharia entradas repetidas.
        // Também ignora edição que chegue depois da exclusão — antes ela ressuscitava o texto.
        const pending = targets.rows.filter(
          (row) => (flag_only || row.content !== new_content) && !row.is_deleted
        );
        if (pending.length === 0) {
          console.log(`[QR-MessageEdited] No-op for ${message_id} (unchanged or already deleted)`);
          return new Response(JSON.stringify({ status: 'ok', skipped: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const editedAt = new Date().toISOString();
        for (const row of pending) {
          // Numa UPDATE só, sem ler metadata antes (a transcrição escreve leitura na mesma
          // linha e um read-modify-write apagaria). flag_only: sem o texto novo, marca a edição e
          // registra que o conteúdo exibido está defasado (não mexe em content nem em edit_history).
          try {
            await registrarEdicao(supabase, row.id, flag_only ? null : new_content, editedAt, !!flag_only);
          } catch (updateError) {
            console.error('[QR-MessageEdited] Error updating message:', updateError);
            return new Response(JSON.stringify({ error: 'Failed to update message' }), {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
        }

        console.log(`[QR-MessageEdited] Updated content for message(s) ${pending.map((r) => r.id).join(', ')}`);
        return new Response(JSON.stringify({ status: 'ok', message_id: pending[0].id }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Check if this is a QR message from Baileys service
      // Group participant events (added/removed/joined/left/promoted/demoted) → system message
      if (url.pathname.endsWith('/qr-group-event')) {
        const evtBody = await req.json();
        console.log('[QR-GroupEvent] Received:', JSON.stringify(evtBody));

        const { phone_number_id, group_jid, group_subject, action, actor, targets, content, event_id, timestamp } = evtBody;

        if (!phone_number_id || !group_jid || !event_id) {
          return new Response(JSON.stringify({ error: 'Missing phone_number_id, group_jid or event_id' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Resolve phone number (UUID or legacy qr_* id)
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(phone_number_id);
        const { data: phoneNumber } = await supabase
          .from('phone_numbers')
          .select('id')
          .eq(isUUID ? 'id' : 'phone_number_id', phone_number_id)
          .single();

        if (!phoneNumber) {
          console.error('[QR-GroupEvent] Phone number not found:', phone_number_id);
          return new Response(JSON.stringify({ error: 'Phone number not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Find or create the group conversation (same pattern as /qr-message)
        let conversationId: string | null = null;
        const { data: existingConv } = await supabase
          .from('conversations')
          .select('id, contact_name, group_subject')
          .eq('group_jid', group_jid)
          .eq('phone_number_id', phoneNumber.id)
          .limit(1)
          .maybeSingle();

        if (existingConv) {
          conversationId = existingConv.id;
          // Nome do grupo no WhatsApp; o apelido do lápis (contact_name) não é tocado.
          const nomes = atualizacaoDoNomeDoGrupo(existingConv, group_subject);
          if (nomes) {
            await supabase.from('conversations').update(nomes).eq('id', existingConv.id);
          }
        } else {
          const { data: newConv, error: createError } = await supabase
            .from('conversations')
            .insert({
              contact_phone: group_jid,
              contact_name: group_subject || group_jid.replace('@g.us', ''),
              group_subject: group_subject || null,
              whatsapp_id: `qr_group_${phone_number_id}_${group_jid}`,
              status: 'active',
              phone_number_id: phoneNumber.id,
              is_group: true,
              group_jid: group_jid,
            })
            .select('id')
            .single();

          if (createError?.code === '23505') {
            // Corrida com o /qr-message do mesmo grupo novo — reselect em vez de perder o evento.
            const { data: racedConv } = await supabase
              .from('conversations')
              .select('id')
              .eq('group_jid', group_jid)
              .eq('phone_number_id', phoneNumber.id)
              .limit(1)
              .maybeSingle();
            conversationId = racedConv?.id ?? null;
          } else if (!createError && newConv) {
            conversationId = newConv.id;
          }
          if (!conversationId) {
            console.error('[QR-GroupEvent] Error creating group conversation:', createError);
            return new Response(JSON.stringify({ error: 'Failed to create group conversation' }), {
              status: 503,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
        }

        // Insert the system message. read_at is set so it never counts as unread, and we
        // intentionally do NOT bump conversations.last_message_at (events don't reorder the
        // list) — except for 'group_joined' (this number entered the group), handled below.
        // Group events can be redelivered with the same event_id; upsert on the
        // composite unique key makes a duplicate a silent no-op (0 rows) instead
        // of a 23505 error being logged by Postgres.
        const eventCreatedAt = messageTimestampToIso(timestamp);
        const { data: newMsg, error: msgError } = await supabase
          .from('messages')
          .upsert({
            conversation_id: conversationId,
            content: content || '',
            direction: 'inbound',
            whatsapp_message_id: event_id,
            message_type: 'group_action',
            read_at: new Date().toISOString(),
            sender_phone: actor?.phone || null,
            sender_name: actor?.name || null,
            sender_jid: actor?.jid || null,
            metadata: { groupAction: { action, actor, targets } },
            // Mesmo motivo do /qr-message: um evento recuperado é de dias atrás.
            ...(eventCreatedAt ? { created_at: eventCreatedAt } : {}),
          }, {
            onConflict: 'whatsapp_message_id,conversation_id',
            ignoreDuplicates: true,
          })
          .select('id')
          .maybeSingle();

        if (msgError) {
          console.error('[QR-GroupEvent] Error inserting message:', msgError);
          const logged = await logWriteFailure(supabase, {
            phoneNumberDbId: phoneNumber.id,
            toJid: String(group_jid),
            wamid: event_id ?? null,
            action: 'msg_write_failed',
            error: `${msgError.code ?? 'unknown'}: ${msgError.message ?? String(msgError)}`,
            route: '/qr-group-event',
            payload: evtBody,
          });
          // Permanente evidenciado → 422 (retry não resolve); resto → 503 (retry resolve).
          return new Response(JSON.stringify({ error: 'Failed to insert group event', logged }), {
            status: logged && isPermanentDbError(msgError) ? 422 : 503,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (!newMsg) {
          console.log(`[QR-GroupEvent] Duplicate event skipped: ${event_id}`);
          return new Response(JSON.stringify({ status: 'ok', duplicate: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // group_joined is the one group event that SHOULD surface/reorder the conversation:
        // it means this number just entered the group. Gated on the message insert (newMsg),
        // so redelivered events return above as duplicates and never reorder the list.
        // status back to 'active' covers re-adds to a previously closed group conversation.
        if (action === 'group_joined') {
          const ts = eventCreatedAt ?? new Date().toISOString();
          await supabase
            .from('conversations')
            .update({ status: 'active' })
            .eq('id', conversationId);
          // Só avança, pelo mesmo motivo do /qr-message.
          await supabase
            .from('conversations')
            .update({ last_message_at: ts })
            .eq('id', conversationId)
            .lt('last_message_at', ts);
        }

        console.log(`[QR-GroupEvent] Stored ${action} event ${newMsg?.id} for group ${group_jid}`);
        return new Response(JSON.stringify({ status: 'ok', message_id: newMsg?.id }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname.endsWith('/qr-message')) {
        const qrBodyRaw = await req.json();
        console.log('[QR-Webhook] Received QR message:', JSON.stringify(qrBodyRaw, null, 2));

        // 400 só para o irrecuperável (sem origem/destino) — e mesmo esse deixa
        // evidência: o qr-service não vai retentar um 400, então a linha na
        // qr_message_log é o único rastro que sobra.
        const qrParse = QrMessageSchema.safeParse(qrBodyRaw);
        if (!qrParse.success) {
          const issues = qrParse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          console.error('[QR-Webhook] Payload inválido:', issues);
          await logWriteFailure(supabase, {
            toJid: String(qrBodyRaw?.group_jid ?? qrBodyRaw?.from ?? 'unknown'),
            wamid: typeof qrBodyRaw?.message_id === 'string' ? qrBodyRaw.message_id : null,
            action: 'msg_payload_invalid',
            error: issues,
            route: '/qr-message',
            payload: qrBodyRaw,
          });
          return new Response(JSON.stringify({ error: 'Invalid payload', issues }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const qrBody = qrBodyRaw;

        let {
          phone_number_id,
          from,
          content,
          contact_name,
          message_id,
          timestamp,
          message_type,
          media_url, // NEW: Direct URL from QR service (bypassing base64 limits)
          media_base64,
          media_mime_type,
          media_filename,
          media_size_bytes: media_size_declared, // fileLength do stanza: existe mesmo sem download
          media_download_failed, // qr-service esgotou retries + fallback
          selection_id, // Added selection_id for interactive responses
          // Group-specific fields from QR service
          is_group,
          group_jid,
          group_subject,
          sender_phone,
          sender_name,
          sender_jid, // Original participant JID for reactions
          // Quoted message fields
          quoted_stanza_id,
          quoted_content,
          // Contact message fields
          contact_metadata,
          // Metadata genérico do qr-service (view_once, ptt, location…)
          metadata: qr_metadata,
          // Click-to-WhatsApp ad attribution (só na primeira mensagem de um lead de anúncio)
          ctwa_clid,
          referral,
          // Direction indicator (from_me = sent from Business app)
          from_me,
        } = qrBody;

        const isGroupMessage = is_group === true;

        // Em mensagem nossa (from_me), o pushName que o WhatsApp manda é o nome do
        // DONO da sessão, não o do contato — o serviço já não envia esse nome, e aqui
        // ele é descartado como segunda linha de defesa. A conversa nasce com o
        // telefone, que o looksLikePhone abaixo sabe corrigir quando a primeira inbound
        // chegar; o nosso nome não é corrigível e ficaria grudado para sempre.
        const incomingContactName = from_me === true ? undefined : contact_name;
        // Use contact_name (pushName from WhatsApp) or fallback to from
        const displayName = incomingContactName || from;

        // Get phone number details
        // Support both UUID (new format) and qr_* string (legacy sessions)
        // Resolvido ANTES do branch de reação: o update de reação precisa ser
        // escopado ao número (sessões espelhadas duplicam o wamid).
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(phone_number_id);
        const { data: phoneNumber, error: phoneLookupError } = await supabase
          .from('phone_numbers')
          .select('id, organization_id, auto_reply_message, connection_type')
          .eq(isUUID ? 'id' : 'phone_number_id', phone_number_id)
          .maybeSingle();

        // A rota do QR nunca atende linha oficial (Baileys não fala Cloud API), e a
        // autenticação dela não é a da Meta. Sem esta recusa, qualquer POST aqui injetaria
        // mensagem numa linha Cloud API sem passar pela assinatura da Meta, que vale só no
        // ramo Cloud.
        if (!phoneLookupError && phoneNumber && OFFICIAL_CONNECTION_TYPES.includes(String(phoneNumber.connection_type))) {
          console.warn('[QR-Webhook] Recusado: linha oficial não recebe evento pela rota QR');
          return new Response(JSON.stringify({ error: 'Official line does not accept QR events' }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Erro de consulta (timeout, pool) NÃO é "não encontrado": o 404 aqui fazia o
        // diagnóstico errado e transformava um soluço de banco em perda permanente.
        // 503 → o retry do serviço reentrega quando o banco voltar.
        if (phoneLookupError) {
          console.error('[QR-Webhook] Erro ao resolver phone number:', phoneLookupError);
          return new Response(JSON.stringify({ error: 'Failed to resolve phone number' }), {
            status: 503,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        if (!phoneNumber) {
          console.error('[QR-Webhook] Phone number not found:', phone_number_id, '(searched by', isUUID ? 'id' : 'phone_number_id', ')');
          return new Response(JSON.stringify({ error: 'Phone number not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Handle reaction messages - redirect to update logic instead of creating new message
        if (message_type === 'reaction') {
          console.log('[QR-Webhook] Reaction received via /qr-message endpoint');

          // Extract target message ID from quoted_stanza_id or a specific field
          const targetMessageId = quoted_stanza_id || qrBody.target_message_id;
          const reactionEmoji = content || qrBody.reaction_emoji;

          if (!targetMessageId) {
            console.warn('[QR-Webhook] Reaction missing target_message_id, ignoring');
            return new Response(JSON.stringify({ status: 'ok', note: 'reaction ignored - no target' }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          // Update the target message with the reaction
          const reactionValue = reactionEmoji && reactionEmoji.trim() !== '' ? reactionEmoji : null;

          // Mesma regra do /qr-reaction (:422): eco da NOSSA reação vai para
          // our_reaction — gravá-la em `reaction` duplicava o badge na bolha.
          const qrMsgReactionColumn = from_me === true ? 'our_reaction' : 'reaction';

          const reactionTargets = await findMessagesByWamid(supabase, targetMessageId, phoneNumber.id, 'conversation_id');
          if ('error' in reactionTargets) {
            console.error('[QR-Webhook] Error loading reaction target:', reactionTargets.error);
            return new Response(JSON.stringify({ error: 'Failed to update reaction' }), {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          if (reactionTargets.rows.length === 0) {
            console.warn(`[QR-Webhook] Target message not found for reaction: ${targetMessageId}`);
            return new Response(JSON.stringify({ status: 'not_found' }), {
              status: 404,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const { error: updateError } = await supabase
            .from('messages')
            .update({ [qrMsgReactionColumn]: reactionValue })
            .in('id', reactionTargets.rows.map((row) => row.id));

          if (updateError) {
            console.error('[QR-Webhook] Error updating reaction:', updateError);
            return new Response(JSON.stringify({ error: 'Failed to update reaction' }), {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          // Fan-out por reator (agregação em grupo)
          await writeReactionRows(supabase, reactionTargets.rows.map((row) => row.id), {
            emoji: reactionValue,
            isFromMe: from_me === true,
            reactorJid: sender_jid || (from ? `${String(from).replace(/\D/g, '')}@s.whatsapp.net` : null),
            reactorName: sender_name || contact_name || null,
          });

          // Update conversation last_message_at
          await supabase
            .from('conversations')
            .update({ last_message_at: new Date().toISOString() })
            .in('id', [...new Set(reactionTargets.rows.map((row) => row.conversation_id))]);

          console.log(`[QR-Webhook] Reaction applied to message(s) ${reactionTargets.rows.map((r) => r.id).join(', ')}: ${reactionValue}`);
          return new Response(JSON.stringify({ status: 'ok', message_id: reactionTargets.rows[0].id }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Find or create conversation
        let conversation = null;

        if (isGroupMessage && group_jid) {
          // GROUP MESSAGE: Find by group_jid
          const { data: existingConv } = await supabase
            .from('conversations')
            // contact_name e group_subject são obrigatórios aqui: a comparação logo abaixo os usa.
            // Sem ele no select, existingConv.contact_name era SEMPRE undefined,
            // a condição dava verdadeira em toda mensagem de grupo com
            // group_subject no payload, e cada mensagem gerava um UPDATE
            // desnecessário em conversations — mais um evento de realtime para
            // todos os painéis abertos. O ramo irmão de /qr-group-event (:1081)
            // sempre selecionou a coluna certa.
            .select('id, contact_phone, is_group, contact_name, group_subject')
            .eq('group_jid', group_jid)
            .eq('phone_number_id', phoneNumber.id)
            .limit(1)
            .maybeSingle();

          if (existingConv) {
            conversation = existingConv;
            // Nome do grupo no WhatsApp; o apelido do lápis (contact_name) não é tocado.
            const nomes = atualizacaoDoNomeDoGrupo(existingConv, group_subject);
            if (nomes) {
              await supabase
                .from('conversations')
                .update(nomes)
                .eq('id', existingConv.id);
            }
          } else {
            // Create new group conversation
            const { data: newConv, error: createError } = await supabase
              .from('conversations')
              .insert({
                contact_phone: group_jid,
                contact_name: group_subject || group_jid.replace('@g.us', ''),
                group_subject: group_subject || null,
                whatsapp_id: `qr_group_${phone_number_id}_${group_jid}`,
                status: 'active',
                phone_number_id: phoneNumber.id,
                is_group: true,
                group_jid: group_jid,
              })
              .select('id')
              .single();

            if (createError?.code === '23505') {
              // Corrida do find-or-create: duas mensagens do mesmo grupo novo em
              // paralelo — a outra request criou a conversa entre o SELECT e o
              // INSERT. Sem o reselect, a SEGUNDA mensagem do grupo morria.
              const { data: racedConv } = await supabase
                .from('conversations')
                // mesmas colunas do SELECT acima: este valor vira `conversation`
                // e segue adiante no fluxo.
                .select('id, contact_phone, is_group, contact_name')
                .eq('group_jid', group_jid)
                .eq('phone_number_id', phoneNumber.id)
                .limit(1)
                .maybeSingle();
              conversation = racedConv;
            } else if (!createError) {
              conversation = newConv;
              console.log('[QR-Webhook] Created new group conversation:', conversation.id);
            }
            if (!conversation) {
              console.error('[QR-Webhook] Error creating group conversation:', createError);
              return new Response(JSON.stringify({ error: 'Failed to create group conversation' }), {
                status: 503,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }
          }
        } else {
          // INDIVIDUAL MESSAGE: Find by phone number variations
          const { normalized, variations } = normalizePhoneNumber(from);

          const { data: existingConv } = await supabase
            .from('conversations')
            .select('id, contact_phone, contact_name')
            .in('contact_phone', variations)
            .eq('phone_number_id', phoneNumber.id)
            .eq('is_group', false)
            .limit(1)
            .maybeSingle();

          if (existingConv) {
            conversation = existingConv;
            // Only update contact_name if current name looks like a phone number (only digits)
            // This means no one has manually set a real name yet
            const looksLikePhone = /^\d+$/.test(existingConv.contact_name);
            if (incomingContactName && incomingContactName !== from && looksLikePhone) {
              await supabase
                .from('conversations')
                .update({ contact_name: incomingContactName })
                .eq('id', existingConv.id);
            }
          } else {
            const { data: newConv, error: createError } = await supabase
              .from('conversations')
              .insert({
                contact_phone: normalized, // Use normalized phone (with country code) to prevent duplicates
                // O unique é (phone_number_id, contact_phone, is_group) e contact_name
                // é NOT NULL — um from vazio de @lid não resolvido não pode virar 23502.
                contact_name: displayName || normalized || 'Desconhecido',
                whatsapp_id: `qr_${phone_number_id}`,
                status: 'active',
                phone_number_id: phoneNumber.id,
                is_group: false,
              })
              .select('id')
              .single();

            if (createError?.code === '23505') {
              // Corrida do find-or-create: contato novo mandando duas mensagens em
              // paralelo. A conversa foi criada pela outra request; sem o reselect,
              // esta mensagem morria com "Failed to create conversation".
              const { data: racedConv } = await supabase
                .from('conversations')
                .select('id, contact_phone, contact_name')
                .in('contact_phone', variations)
                .eq('phone_number_id', phoneNumber.id)
                .eq('is_group', false)
                .limit(1)
                .maybeSingle();
              conversation = racedConv;
            } else if (!createError) {
              conversation = newConv;
            }
            if (!conversation) {
              console.error('[QR-Webhook] Error creating conversation:', createError);
              return new Response(JSON.stringify({ error: 'Failed to create conversation' }), {
                status: 503,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }
          }
        }

        // Process media if present
        let mediaUrl: string | null = null;
        let mediaSizeBytes: number | null = null;
        let mediaDroppedTooLarge = false;
        // Dimensões medidas dos bytes já em memória (caminho legado em base64).
        let base64Dims: MediaDims | null = null;
        // Tipo fora do CHECK jamais chega ao insert (23514 = perda silenciosa).
        const { type: finalMessageType, originalType: unsupportedOriginalType } =
          validateMessageType(message_type);
        if (unsupportedOriginalType) {
          console.warn(`[QR-Webhook] message_type desconhecido "${unsupportedOriginalType}" → unsupported`);
        }

        // fileLength do stanza — chega mesmo quando o binário não chega, e é o único
        // jeito de saber o tamanho do que se perdeu.
        const declaredSizeBytes = Number.isFinite(Number(media_size_declared))
          ? Number(media_size_declared)
          : null;
        // O flag explícito é do serviço novo. A inferência cobre a imagem antiga
        // (push ≠ deploy): tipo de mídia + nome/mime presentes + URL ausente só
        // acontece quando o download falhou — o stanza preenche nome e mime antes
        // de baixar, e sem mídia nenhuma esses campos viriam vazios.
        const isMediaType = ['document', 'image', 'video', 'audio', 'sticker'].includes(finalMessageType);
        const mediaDownloadFailed = media_download_failed === true
          || (isMediaType && !media_url && !media_base64 && !!(media_filename || media_mime_type));

        if (media_url) {
          console.log(`[QR-Webhook] Using pre-uploaded media URL: ${media_url}`);
          mediaUrl = media_url;
          // Set mime type if provided, otherwise default
          media_mime_type = media_mime_type || 'application/octet-stream';

          // We don't have exact size for pre-uploaded files unless passed
          // We could fetch HEAD request to get size but maybe not critical for now
        } else if (media_base64 && media_base64.length > 12_000_000) {
          // ~8MB reais. O decode abaixo é byte-a-byte em JS: mídia grande estourava
          // o CPU do isolate ANTES do insert e a mensagem inteira morria. A mensagem
          // sobrevive sem a mídia, com marcação explícita. (Caminho legado: o
          // qr-service atual manda media_url, não base64.)
          console.warn(`[QR-Webhook] media_base64 com ${media_base64.length} chars — pulando mídia para salvar a mensagem`);
          mediaDroppedTooLarge = true;
        } else if (media_base64 && media_mime_type) {
          try {
            console.log(`[QR-Webhook] Processing media: type=${finalMessageType}, mime=${media_mime_type}`);

            // Decode base64 to buffer
            const binaryString = atob(media_base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            mediaSizeBytes = bytes.length;
            if (finalMessageType === 'image' || finalMessageType === 'video') {
              base64Dims = await probeMediaDimensions(bufferReader(bytes), { timeoutMs: 500 });
            }

            // Generate filename - sanitize to remove special chars
            const ext = media_mime_type.split('/')[1]?.split(';')[0] || 'bin';
            const rawFilename = media_filename || `qr_${Date.now()}.${ext}`;
            // Sanitize: remove accents, replace spaces with underscores, remove special chars
            const sanitizedFilename = rawFilename
              .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
              .replace(/\s+/g, '_') // Replace spaces with underscores
              .replace(/[^a-zA-Z0-9_.\-]/g, ''); // Remove any remaining special chars
            const storagePath = `inbound/${phone_number_id}/${Date.now()}_${sanitizedFilename}`;
            console.log(`[QR-Webhook] Sanitized filename: ${rawFilename} -> ${sanitizedFilename}`);

            // Sanitize content type - strip codec specification (e.g., "audio/ogg; codecs=opus" -> "audio/ogg")
            const sanitizedContentType = media_mime_type.split(';')[0].trim();
            console.log(`[QR-Webhook] Using contentType: ${sanitizedContentType}`);

            // Upload to Supabase Storage
            const { data: uploadData, error: uploadError } = await supabase.storage
              .from('attachments')
              .upload(storagePath, bytes.buffer, {
                contentType: sanitizedContentType,
                upsert: false
              });

            if (uploadError) {
              console.error('[QR-Webhook] Storage upload error:', uploadError);
            } else {
              // Get public URL (a base pública, não a interna: a URL é gravada e vai ao navegador)
              mediaUrl = urlPublicaDoAnexo(storagePath);
              console.log(`[QR-Webhook] Media uploaded to: ${mediaUrl}`);
            }
          } catch (mediaError) {
            console.error('[QR-Webhook] Error processing media:', mediaError);
          }
        }

        // Resolve quoted_message_id from quoted_stanza_id
        let quotedMessageId: string | null = null;
        if (quoted_stanza_id) {
          console.log(`[QR-Webhook] Looking for quoted message with whatsapp_message_id: "${quoted_stanza_id}"`);

          // Escopado à conversa: quando dois números conectados conversam entre si,
          // o mesmo wamid existe em duas conversas e o .maybeSingle() falharia.
          const { data: quotedMsg, error: quotedError } = await supabase
            .from('messages')
            .select('id, whatsapp_message_id, content')
            .eq('whatsapp_message_id', quoted_stanza_id)
            .eq('conversation_id', conversation.id)
            .maybeSingle();

          if (quotedError) {
            console.error(`[QR-Webhook] Error looking up quoted message:`, quotedError);
          } else if (quotedMsg) {
            quotedMessageId = quotedMsg.id;
            console.log(`[QR-Webhook] Found quoted message: ${quoted_stanza_id} -> ${quotedMessageId} (content: "${quotedMsg.content?.substring(0, 30)}...")`);
          } else {
            // Debug: List recent messages in this conversation to see their whatsapp_message_ids
            const { data: recentMsgs } = await supabase
              .from('messages')
              .select('id, whatsapp_message_id, content, direction')
              .eq('conversation_id', conversation.id)
              .order('created_at', { ascending: false })
              .limit(5);

            console.log(`[QR-Webhook] Quoted message NOT found. Looking for: "${quoted_stanza_id}"`);
            console.log(`[QR-Webhook] Recent messages in conversation:`, recentMsgs?.map(m => ({
              id: m.id.substring(0, 8),
              wamid: m.whatsapp_message_id,
              dir: m.direction,
              content: m.content?.substring(0, 20)
            })));
          }
        }

        // Create message with media fields and group sender info
        // from_me = true means sent from Business app, so direction is outbound
        const messageDirection = from_me === true ? 'outbound' : 'inbound';
        const messageInsert: any = {
          conversation_id: conversation.id,
          // content é NOT NULL; um payload sem texto não pode custar a mensagem (23502).
          content: content ?? (unsupportedOriginalType ? '[Mensagem não suportada]' : ''),
          direction: messageDirection,
          // UUID, não Date.now(): o history sync forwarda em lotes paralelos de 10 e
          // duas mensagens sem wamid no mesmo ms colidiam — a perda aparecia no log
          // como "duplicate message skipped".
          whatsapp_message_id: message_id || `qr_${crypto.randomUUID()}`,
          message_type: finalMessageType,
          quoted_message_id: quotedMessageId,
        };
        if (unsupportedOriginalType) {
          messageInsert.metadata = { ...(messageInsert.metadata ?? {}), original_type: unsupportedOriginalType };
        }
        if (mediaDroppedTooLarge) {
          messageInsert.metadata = { ...(messageInsert.metadata ?? {}), media_too_large: true };
        }

        // Hora real da mensagem, não a da gravação: numa mensagem recuperada as
        // duas estão a dias de distância. Ausente/corrompido cai no default do banco.
        const messageCreatedAt = messageTimestampToIso(timestamp);
        if (messageCreatedAt) {
          messageInsert.created_at = messageCreatedAt;
        }

        // Add sender info for group messages
        if (isGroupMessage) {
          messageInsert.sender_phone = sender_phone;
          messageInsert.sender_name = sender_name;
          messageInsert.sender_jid = sender_jid; // Original participant JID for reactions
        }

        if (mediaUrl) {
          messageInsert.media_url = mediaUrl;
          messageInsert.media_mime_type = media_mime_type;
          messageInsert.media_filename = media_filename;
          messageInsert.media_size_bytes = mediaSizeBytes;
        } else if (mediaDownloadFailed) {
          // Nome e tipo vêm do stanza, ANTES do download — descartá-los junto com a
          // URL era o que tornava a falha invisível: sobrava só o rótulo no content
          // e nenhum rastro de QUE arquivo se perdeu. Sem media_url a UI já não
          // oferece download; com os campos preenchidos ela sabe o que dizer.
          messageInsert.media_mime_type = media_mime_type ?? null;
          messageInsert.media_filename = media_filename ?? null;
          messageInsert.media_size_bytes = declaredSizeBytes;
          messageInsert.metadata = { ...(messageInsert.metadata ?? {}), media_download_failed: true };
        }

        // Add contact metadata for contact messages
        // Merge, não atribuição: metadata é compartilhado com o referral de anúncio abaixo,
        // e sobrescrever aqui apagaria a atribuição de um lead que mandou um contato.
        if (finalMessageType === 'contact' && contact_metadata) {
          messageInsert.metadata = { ...(messageInsert.metadata ?? {}), contact: contact_metadata };
        }

        // Atribuição de anúncio Click-to-WhatsApp, repassada crua pelo serviço QR
        const qrCtwa = ctwaMetadata(referral, 'baileys', ctwa_clid);
        if (qrCtwa) {
          messageInsert.metadata = { ...(messageInsert.metadata ?? {}), ...qrCtwa };
          console.log(`[CTWA] Referral gravado (QR) wamid=${message_id} ctwa_clid=${qrCtwa.ctwa_clid ?? 'ausente'}`);
        }

        // Dimensões de exibição (metadata.media): o serviço novo manda `media` validado
        // (source 'proto'); sem isso, mede os bytes. A sonda nunca lança e nunca vira
        // 503/500: sem dimensões a mensagem segue e o chat usa a caixa de reserva.
        // Figurinha é pulada: a caixa dela é fixa.
        const declared = MediaDimensionsSchema.safeParse((qr_metadata as Record<string, unknown> | null)?.media);
        let dims: MediaDims | null = declared.success ? declared.data : null;
        let dimsSource: 'proto' | 'bytes' = 'proto';
        if (!dims && (finalMessageType === 'image' || finalMessageType === 'video')) {
          if (base64Dims) {
            dims = base64Dims;
            dimsSource = 'bytes';
          } else if (mediaUrl && ehAnexoNosso(mediaUrl)) {
            dims = await probeUrlDimensions(mediaUrl, { timeoutMs: 1500 });
            dimsSource = 'bytes';
          }
        }
        if (dims && (finalMessageType === 'image' || finalMessageType === 'video')) {
          messageInsert.metadata = withMediaDims(messageInsert.metadata, dims, dimsSource);
        }
        // ThumbHash (prévia borrada). Se o serviço já mandou um válido, ele veio junto com
        // `dims` acima. Nunca derruba a mensagem: thumbHashFromUrl não lança.
        if (
          finalMessageType === 'image' && dims && !dims.thumbhash && mediaUrl &&
          ehAnexoNosso(mediaUrl)
        ) {
          const th = await thumbHashFromUrl(mediaUrl, Deno.env.get('SUPABASE_URL') ?? '', { timeoutMs: 1500 });
          messageInsert.metadata = withThumbHash(messageInsert.metadata, th);
        }

        // Metadata genérico do qr-service (view_once, ptt, location, link_preview…).
        // Spread por último MAS sem poder carregar as chaves reservadas acima —
        // contact e atribuição de anúncio têm caminhos próprios e não podem ser
        // sobrescritos por um passthrough.
        if (qr_metadata && typeof qr_metadata === 'object' && !Array.isArray(qr_metadata)) {
          const { contact: _c, ctwa_clid: _cc, referral: _r, referral_transport: _rt, media: _m, ...safeMetadata } = qr_metadata;
          if (Object.keys(safeMetadata).length > 0) {
            messageInsert.metadata = { ...(messageInsert.metadata ?? {}), ...safeMetadata };
          }
        }

        // The QR/Baileys service can redeliver the same message, so upsert on the
        // composite unique key turns a duplicate into a silent no-op (0 rows)
        // instead of a 23505 error being logged by Postgres.
        let { data: newMessage, error: msgError } = await supabase
          .from('messages')
          .upsert(messageInsert, {
            onConflict: 'whatsapp_message_id,conversation_id',
            ignoreDuplicates: true,
          })
          .select()
          .maybeSingle();

        // Contrato de erro: 200 só sai daqui com linha confirmada (ou duplicata).
        // Permanente (payload que falharia para sempre) → degrada para uma linha
        // mínima 'unsupported' e segue com 200; transiente → evidência + 503, e o
        // retry do qr-service reentrega. Antes, QUALQUER msgError virava 200 com a
        // mensagem perdida em silêncio — o mesmo buraco de antes.
        let degradedWrite = false;
        if (msgError) {
          const failCode = msgError.code ?? 'unknown';
          const failDetail = `${failCode}: ${msgError.message ?? String(msgError)}`;
          const failToJid = isGroupMessage ? String(group_jid) : String(from ?? 'unknown');
          console.error(
            `[QR-Webhook] MESSAGE_WRITE_FAILED code=${failCode} wamid=${message_id ?? 'none'} conv=${conversation.id}:`,
            msgError
          );

          if (isPermanentDbError(msgError)) {
            const degradedInsert: Record<string, unknown> = {
              conversation_id: conversation.id,
              content: '[Mensagem não processada]',
              direction: messageDirection,
              whatsapp_message_id: messageInsert.whatsapp_message_id,
              message_type: 'unsupported',
              metadata: { original_type: finalMessageType, degraded_reason: failCode },
              ...(messageCreatedAt ? { created_at: messageCreatedAt } : {}),
            };
            const { data: degradedRow, error: degradedError } = await supabase
              .from('messages')
              .upsert(degradedInsert, {
                onConflict: 'whatsapp_message_id,conversation_id',
                ignoreDuplicates: true,
              })
              .select()
              .maybeSingle();

            if (!degradedError && degradedRow) {
              // A mensagem existe (degradada) — o payload completo fica na evidência
              // para reprocessamento manual.
              await logWriteFailure(supabase, {
                phoneNumberDbId: phoneNumber.id,
                toJid: failToJid,
                wamid: String(messageInsert.whatsapp_message_id),
                action: 'msg_write_degraded',
                error: failDetail,
                route: '/qr-message',
                payload: qrBody,
              });
              newMessage = degradedRow;
              msgError = null;
              degradedWrite = true;
            } else {
              const logged = await logWriteFailure(supabase, {
                phoneNumberDbId: phoneNumber.id,
                toJid: failToJid,
                wamid: message_id ?? null,
                action: 'msg_write_failed',
                error: `${failDetail} | degrade: ${degradedError?.code ?? 'no_row'}`,
                route: '/qr-message',
                payload: qrBody,
              });
              // 422 = permanente comprovado E evidenciado: o serviço não deve
              // retentar (iria falhar para sempre). Qualquer outra combinação → 503.
              const status = logged && isPermanentDbError(degradedError ?? msgError) ? 422 : 503;
              return new Response(JSON.stringify({ status: 'failed_permanent', logged }), {
                status,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }
          } else {
            await logWriteFailure(supabase, {
              phoneNumberDbId: phoneNumber.id,
              toJid: failToJid,
              wamid: message_id ?? null,
              action: 'msg_write_failed',
              error: failDetail,
              route: '/qr-message',
              payload: qrBody,
            });
            return new Response(JSON.stringify({ status: 'failed_transient' }), {
              status: 503,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
        }

        if (!newMessage) {
          console.log(`[QR-Webhook] Duplicate message skipped: ${message_id} (already exists)`);
          // Return success - message was already processed
          return new Response(JSON.stringify({ status: 'ok', note: 'duplicate message skipped' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          });
        } else if (!degradedWrite) {
          console.log('[QR-Webhook] Message saved:', newMessage.id);

          // Evidência da mídia que não veio. Depois do insert e só na linha nova:
          // a duplicata sai acima, então o retry do serviço não multiplica a linha
          // de log. Não entra na contagem do alerta (ver FailureAction).
          if (mediaDownloadFailed) {
            console.warn(
              `[QR-Webhook] MEDIA_DOWNLOAD_FAILED wamid=${message_id ?? 'none'} type=${finalMessageType} ` +
              `file=${media_filename ?? 'desconhecido'} size=${declaredSizeBytes ?? 'desconhecido'}`
            );
            await logWriteFailure(supabase, {
              phoneNumberDbId: phoneNumber.id,
              toJid: isGroupMessage ? String(group_jid) : String(from ?? 'unknown'),
              wamid: message_id ?? null,
              action: 'media_download_failed',
              error: `${finalMessageType} sem binário: ${media_filename ?? 'sem nome'} ` +
                     `(${media_mime_type ?? 'mime desconhecido'}, ${declaredSizeBytes ?? '?'} bytes)`,
              route: '/qr-message',
              payload: qrBody,
            });
          }

          // Send webhook
          if (phoneNumber.organization_id) {
            // Aviso único (passo 3): a mesma mensagem chega por cada linha nossa do grupo, e no 1 a 1 pelas duas
            // conversas do contato (com e sem o 9º dígito). A primeira cópia reserva o aviso; as outras não avisam, e a
            // da linha que falou (fromMe) que chega depois vira complemento (_shared/aviso-unico.ts).
            // Cópia de grupo recebida sem remetente nenhum não reserva e sai como hoje: o CRM a trata como possível
            // repetição de fala antiga e não cria mensagem, e ela não pode tomar o lugar do aviso da linha que falou.
            const semRemetente = isGroupMessage && messageDirection === 'inbound'
              && !sender_phone && !sender_jid && !String(sender_name ?? '').trim();
            const chaveUnica = semRemetente ? null : chaveDoAviso({
              grupo: isGroupMessage,
              groupJid: group_jid,
              linhaId: phoneNumber.id,
              contato: from,
              codigo: message_id,
            });
            const webhookPayload = {
              phone_number_id: phone_number_id,
              phone_number_internal_id: phoneNumber.id,
              aviso_unico: chaveUnica
                ? { chave: chaveUnica, saida: messageDirection === 'outbound', tem_autor: false }
                : undefined,
              message: {
                id: newMessage.id,
                content: content,
                type: newMessage.message_type,
                created_at: newMessage.created_at,
                direction: messageDirection,
                media: mediaUrl ? {
                  url: mediaUrl,
                  mime_type: media_mime_type,
                  filename: media_filename,
                  size_bytes: mediaSizeBytes
                } : null,
                // Quoted message info
                quoted_message_id: quotedMessageId || null,
                quoted_whatsapp_id: quoted_stanza_id || null,
                quoted_content: quoted_content || null,
                // Código do WhatsApp só para o campo novo `codigo_whatsapp` (aviso-quem-falou.ts). Em
                // `whatsapp_id` ele viraria a chave de aviso repetido do CRM e descartaria a 2ª linha do grupo.
                codigo: message_id || null,
              },
              contact: {
                id: conversation.id,
                phone: isGroupMessage ? group_jid : from,
                name: isGroupMessage ? group_subject : (contact_name || from)
              },
              conversation: {
                id: conversation.id
              },
              // Group-specific fields
              is_group: isGroupMessage,
              group_jid: isGroupMessage ? group_jid : null,
              group_name: isGroupMessage ? group_subject : null,
              sender_phone: isGroupMessage ? sender_phone : null,
              sender_name: isGroupMessage ? sender_name : null,
              sender_jid: isGroupMessage ? sender_jid : null,
            };
            // Use appropriate event based on direction
            const webhookEvent = messageDirection === 'outbound' ? 'message.sent' : 'message.received';
            await sendOrganizationWebhook(supabase, phoneNumber.organization_id, webhookEvent, webhookPayload);

            // Only execute automations and auto-reply for inbound messages (not from Business app)
            if (messageDirection === 'inbound') {
              // OS push (closed-tab notification) for the involved users.
              triggerWebPush(supabaseUrl, supabaseKey, {
                conversationId: conversation.id,
                title: `Nova mensagem de ${isGroupMessage ? (group_subject || 'Grupo') : (contact_name || from)}`,
                body: content ? content.substring(0, 120) : '📎 Mídia',
              });

              // Execute automation flows (fire-and-forget to separate edge function)
              const automationPayload = {
                organizationId: phoneNumber.organization_id,
                conversationId: conversation.id,
                phoneNumberDbId: phoneNumber.id,
                metaPhoneNumberId: null,
                contactPhone: from,
                accessToken: '',
                connectionType: 'qr',
                message: {
                  content: content,
                  type: finalMessageType,
                  selectionId: selection_id || null,
                  mediaUrl: mediaUrl || null,
                  mediaMimeType: media_mime_type || null,
                  mediaFilename: media_filename || null,
                  mediaBase64: media_base64 || null,
                },
              };
              fetch(`${supabaseUrl}/functions/v1/automation-execute`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${supabaseKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(automationPayload)
              }).catch(err => console.error('[Automation-QR] Trigger error:', err));

              // Auto-reply logic for QR (30m cooldown)
              // Nunca em grupo: em mensagem de grupo o `from` é o JID do grupo,
              // logo o `to: from` abaixo publicaria a resposta automática para
              // todos os participantes.
              // Check atomic cooldown first to prevent race conditions
              if (!isGroupMessage && phoneNumber.auto_reply_message && phoneNumber.auto_reply_message.trim()) {
                const { data: shouldReply } = await supabase.rpc(
                  'check_and_update_auto_reply_cooldown',
                  {
                    p_conversation_id: conversation.id,
                    p_cooldown_minutes: 30
                  }
                );

                if (shouldReply) {
                  console.log(`[AutoReply-QR] Sending auto-reply to ${from}`);
                  try {
                    const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
                    if (qrServiceUrl) {
                      const response = await fetch(`${qrServiceUrl}/message/send/${phoneNumber.id}`, {
                        method: 'POST',
                        headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify({
                          to: from,
                          content: phoneNumber.auto_reply_message.trim(),
                          // Quem grava é este handler, logo abaixo, na conversa já
                          // resolvida. Sem esta flag o qr-service grava por conta
                          // própria: em grupo ele não sabe tratar o "@g.us" e abria
                          // uma conversa 1:1 fantasma com o JID mastigado, deixando
                          // a resposta automática fora da thread do grupo.
                          skipSave: true,
                        }),
                      });
                      const data = await response.json();

                      if (response.ok && (data.success || data.messageId)) {
                        // Save auto-reply message
                        const autoReplyWamid = data.messageId || `qr_auto_${crypto.randomUUID()}`;
                        const { data: autoReplyRow, error: autoReplyError } = await supabase
                          .from('messages')
                          .insert({
                            conversation_id: conversation.id,
                            content: phoneNumber.auto_reply_message.trim(),
                            direction: 'outbound',
                            whatsapp_message_id: autoReplyWamid,
                            message_type: 'text',
                            sent_by: null,
                            // Resposta automática não é gente agindo (aba Disparos).
                            metadata: { automacao: true },
                          })
                          .select('id')
                          .maybeSingle();

                        // O contato JÁ recebeu a resposta — insert falho aqui é
                        // divergência CRM↔WhatsApp. Não dá para reenviar; a
                        // evidência alerta e permite reinserção manual.
                        if (autoReplyError) {
                          await logWriteFailure(supabase, {
                            phoneNumberDbId: phoneNumber.id,
                            toJid: String(from),
                            wamid: autoReplyWamid,
                            action: 'msg_write_failed',
                            error: `${autoReplyError.code ?? 'unknown'}: ${autoReplyError.message}`,
                            route: 'auto-reply-qr',
                            payload: { conversation_id: conversation.id, content: phoneNumber.auto_reply_message.trim() },
                          });
                        }

                        if (autoReplyRow) {
                          await emitMessageSent(supabase, {
                            conversationId: conversation.id,
                            messageId: autoReplyRow.id,
                            whatsappMessageId: autoReplyWamid,
                            content: phoneNumber.auto_reply_message.trim(),
                            messageType: 'text',
                            sentBy: null,
                            origin: 'auto_reply',
                            phoneNumberDbId: phoneNumber.id,
                            organizationId: phoneNumber.organization_id,
                          });
                        }
                      } else {
                        console.error('[AutoReply-QR] Failed to send:', data);
                      }
                    }
                  } catch (e) {
                    console.error('[AutoReply-QR] Error:', e);
                  }
                } else {
                  console.log(`[AutoReply-QR] Skipped - cooldown active`);
                }
              }
            }
          }
        }

        // Update conversation status — só se alcança este ponto com linha persistida
        // (falha transiente/permanente retorna antes). Bumpar a conversa com o insert
        // falho mascarava a perda como "bug de UI": a conversa subia sem mensagem nova.
        // Only promote to 'organic' on inbound (customer reply), not outbound (Business app).
        // Condicional: só escreve se status/source mudam (cada UPDATE vai para o
        // walrus). last_message_at não é mais escrito aqui: o trigger
        // on_message_inserted já fez GREATEST(last_message_at, created_at) no
        // insert acima, com o mesmo created_at (messageCreatedAt ou o default).
        await reativarConversa(supabase, conversation.id, {
          promoverOrganica: messageDirection === 'inbound',
        });

        return new Response(
          JSON.stringify({ status: 'ok', message_id: newMessage?.id, ...(degradedWrite ? { degraded: true } : {}) }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Meta Cloud webhook: verify X-Hub-Signature-256 over the raw body before
      // trusting anything. WHATSAPP_APP_SECRET aceita um segredo por app (lista com
      // vírgula). Segredo cadastrado + WHATSAPP_APP_SECRET_ENFORCE=true exige assinatura
      // válida; sem enforce, a assinatura é conferida e só registrada, para um segredo
      // errado não derrubar todas as linhas de uma vez.
      const raw = await req.text();
      const appSecrets = metaAppSecrets(Deno.env.get('WHATSAPP_APP_SECRET'));
      const signatureHeader = req.headers.get('x-hub-signature-256');
      let metaSignatureValid = false;
      for (const secret of appSecrets) {
        if (await verifyMetaSignature(secret, raw, signatureHeader)) { metaSignatureValid = true; break; }
      }

      // A decisão de assinatura precisa do corpo, mas corpo inválido nunca pode virar 5xx:
      // sem JSON não há como ser um aviso legítimo da Meta.
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        return new Response(JSON.stringify({ error: metaSignatureValid ? 'Invalid body' : 'Invalid signature' }), {
          status: metaSignatureValid ? 400 : 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!metaSignatureValid) {
        if (appSecrets.length > 0 && signatureEnforced()) {
          // O motivo entra no log: sem ele, "assinatura recusada" não distingue segredo de outro
          // app de segredo nenhum cadastrado.
          console.warn(`[whatsapp-webhook] Rejected Meta webhook without valid X-Hub-Signature-256 (header=${Boolean(signatureHeader)}, secrets=${appSecrets.length})`);
          return new Response(JSON.stringify({ error: 'Invalid signature' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        if (appSecrets.length > 0) {
          // Segredo CADASTRADO e a assinatura não confere, com o enforce desligado: este é o
          // ensaio do corte. Enquanto esta linha aparecer, o segredo está errado (outro app, ou
          // vencido) e ligar WHATSAPP_APP_SECRET_ENFORCE derrubaria todas as linhas.
          console.error(`[whatsapp-webhook] SIGNATURE MISMATCH com WHATSAPP_APP_SECRET cadastrado (${appSecrets.length} segredo(s)); enforce DESLIGADO, aceitando. NÃO ligar o enforce enquanto isto aparecer.`);
        } else {
          console.warn('[whatsapp-webhook] Meta webhook accepted without valid signature (no WHATSAPP_APP_SECRET).');
        }
      } else if (!signatureEnforced()) {
        // Assinatura conferiu e o corte ainda não está ligado: é este o sinal de que dá para
        // ligar com segurança. Some sozinho quando o enforce entra.
        console.log('[whatsapp-webhook] Assinatura da Meta conferida; WHATSAPP_APP_SECRET_ENFORCE ainda desligado — seguro ligar quando todas as linhas aparecerem assim.');
      }

      // UMA regra de valor (webhookValue): a mesma que decidiu a assinatura acima.
      // Handle both formats: direct value or nested entry.changes.value.
      const value = webhookValue(body);
      // Resumo do aviso, nunca o corpo: resposta de questionário e texto do cliente não
      // entram aqui. (Os logs de processamento de mensagem, mais abaixo, ainda imprimem o
      // texto — comportamento antigo do Echo, igual em todas as linhas.)
      // signature_valid diz se a assinatura da Meta conferiu: é assim que se confere o
      // segredo antes de ligar o WHATSAPP_APP_SECRET_ENFORCE.
      console.log('Received webhook:', JSON.stringify({
        field: body.entry?.[0]?.changes?.[0]?.field ?? null,
        phone_number_id: value?.metadata?.phone_number_id ?? null,
        messages: value?.messages?.length ?? 0,
        statuses: value?.statuses?.length ?? 0,
        signature_valid: metaSignatureValid,
      }));

      // Handle status updates (sent, delivered, read, failed)
      const statuses = value?.statuses;
      if (statuses && statuses.length > 0) {
        // Escopo por número (sessões espelhadas duplicam o wamid): sem o filtro,
        // o .maybeSingle() estourava com PGRST116 e o status se perdia; os updates
        // de falha marcavam TODAS as cópias, inclusive as de outro número.
        const statusMetaPhoneId = value.metadata?.phone_number_id;

        for (const status of statuses) {
          const messageId = status.id;
          const statusType = status.status; // sent, delivered, read, failed
          const recipientId = status.recipient_id;

          console.log(`Status update: ${statusType} for message ${messageId} to ${recipientId}`);

          // Fetch message to get context (organization, conversation)
          // We need to resolve the organization to send the webhook
          let statusQuery = supabase
            .from('messages')
            .select(`
              id,
              content,
              message_type,
              sent_by,
              created_at,
              error_message,
              metadata,
              conversation:conversations!inner(
                id,
                contact_phone,
                contact_name,
                phone_number:phone_numbers!inner(
                  id,
                  organization_id,
                  phone_number_id,
                  organizations!inner(
                    whatsapp_access_token
                  )
                )
              )
            `)
            .eq('whatsapp_message_id', messageId);
          if (statusMetaPhoneId) {
            statusQuery = statusQuery.eq('conversation.phone_number.phone_number_id', statusMetaPhoneId);
          }
          const { data: statusRows, error: msgFetchError } = await statusQuery;

          if (msgFetchError) {
            console.error(`Error fetching message for status ${statusType}:`, msgFetchError);
          }

          const messageData = statusRows?.[0];
          const scopedMessageIds: string[] = (statusRows ?? []).map((row: { id: string }) => row.id);

          if (messageData) {
            const conversation = messageData.conversation as any;
            const phoneNumber = conversation?.phone_number as any;
            const organizationId = phoneNumber?.organization_id;
            const accessToken = phoneNumber?.organizations?.whatsapp_access_token;
            // Map status string to code
            let statusCode = 0;
            switch (statusType) {
              case 'sent': statusCode = 2; break;
              case 'delivered': statusCode = 3; break;
              case 'read': statusCode = 4; break;
              case 'failed': statusCode = -1; break;
              default: statusCode = 0;
            }

            // Determine template name if applicable
            let templateName = undefined;
            if (messageData.message_type === 'template') {
              templateName = messageData.content;
            }

            // Send webhook for ALL statuses (sent, delivered, read, failed)
            const webhookPayload = {
              phone_number_id: phoneNumber?.phone_number_id,
              phone_number_internal_id: phoneNumber?.id,
              message: {
                id: messageData.id,
                whatsapp_id: messageId,
                content: messageData.content,
                type: messageData.message_type,
                status: statusType, // string status name
                status_code: statusCode, // numeric status code
                sent_by: messageData.sent_by,
                template_name: templateName,
                created_at: messageData.created_at, // vira message_created_at (mesma razão do aviso do QR)
                updated_at: new Date().toISOString()
              },
              contact: {
                id: conversation.id,
                name: conversation.contact_name || 'Unknown',
                phone: conversation.contact_phone,
              },
              conversation: {
                id: conversation.id
              },
              error: statusType === 'failed' ? {
                code: status.errors?.[0]?.code,
                title: status.errors?.[0]?.title,
                message: status.errors?.[0]?.message
              } : null
            };

            // `sent` fica de fora: na Cloud API esse callback era a ÚNICA origem
            // de `message.sent`, e agora quem grava a mensagem emite o evento no
            // ato (emitMessageSent). Manter os dois duplicaria todo envio de
            // linha Business API, com o mesmo message_id. Os demais status
            // (delivered/read/failed) continuam saindo daqui.
            if (organizationId && statusType !== 'sent') {
              await sendOrganizationWebhook(supabase, organizationId, `message.${statusType}`, webhookPayload);
            }

            if (statusType === 'failed') {
              const errorCode = status.errors?.[0]?.code;
              const errorTitle = status.errors?.[0]?.title;
              const errorMessage = status.errors?.[0]?.message;

              console.error(`Message FAILED: ${messageId} - Error: ${errorMessage} (title: ${errorTitle}, code: ${errorCode})`);

              // 9-digit Brazilian fallback logic
              const errorLower = (errorMessage || errorTitle || '').toLowerCase();
              const isUndeliverable = errorLower.includes('undeliverable');
              const alreadyTriedFallback = messageData.error_message?.includes('Fallback attempted');
              const isTemplate = messageData.message_type === 'template';

              // 9-digit fallback only applies to Brazilian numbers explicitly
              // stored with the "55" country code. Numbers without it could be
              // international (e.g., Spanish 11-digit "34..." mobiles), and we
              // must not assume Brazilian DDD logic on them.
              const rawPhone = conversation.contact_phone || '';
              const isBrazilian = rawPhone.startsWith('55') && (rawPhone.length === 12 || rawPhone.length === 13);
              const phoneDigits = rawPhone;

              console.log(`[Fallback] Check: undeliverable=${isUndeliverable} brazilian=${isBrazilian} alreadyTried=${alreadyTriedFallback} hasToken=${!!accessToken} phone=${rawPhone} normalized=${phoneDigits} isTemplate=${isTemplate}`);

              if (isUndeliverable && isBrazilian && !alreadyTriedFallback && accessToken) {
                console.log(`[Fallback] Attempting 9-digit adjustment for ${rawPhone} (normalized: ${phoneDigits})`);

                // Calculate alternative phone (always with "55" for Meta API)
                let altPhone = null;
                const ddd = phoneDigits.substring(2, 4);
                const local = phoneDigits.substring(4);

                if (local.length === 9 && local.startsWith('9')) {
                  altPhone = '55' + ddd + local.substring(1);
                } else if (local.length === 8) {
                  altPhone = '55' + ddd + '9' + local;
                }

                if (altPhone) {
                  console.log(`[Fallback] Resending to alternative: ${altPhone}`);

                  try {
                    // Build request body based on message type
                    let requestBody: any;
                    const metadata = messageData.metadata as any;

                    if (isTemplate && metadata?.template_name) {
                      // Resend as template with same parameters
                      console.log(`[Fallback] Resending template: ${metadata.template_name}`);
                      const templateObj: any = {
                        name: metadata.template_name,
                        language: {
                          code: metadata.language_code || 'pt_BR',
                        },
                      };
                      if (metadata.components && metadata.components.length > 0) {
                        templateObj.components = metadata.components;
                      }
                      requestBody = {
                        messaging_product: 'whatsapp',
                        to: altPhone,
                        type: 'template',
                        template: templateObj,
                      };
                    } else {
                      // Resend as text message
                      requestBody = {
                        messaging_product: 'whatsapp',
                        to: altPhone,
                        type: 'text',
                        text: { body: messageData.content },
                      };
                    }

                    const whatsappResponse = await fetch(
                      `https://graph.facebook.com/v18.0/${phoneNumber.phone_number_id}/messages`,
                      {
                        method: 'POST',
                        headers: {
                          'Authorization': `Bearer ${accessToken}`,
                          'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(requestBody),
                      }
                    );

                    const whatsappData = await whatsappResponse.json();

                    if (whatsappResponse.ok && whatsappData.messages?.[0]?.id) {
                      const newWamid = whatsappData.messages[0].id;
                      console.log(`[Fallback] Resent successfully. New wamid: ${newWamid}`);

                      // The fallback only runs for "55"-prefixed BR numbers,
                      // so altPhone is always the full E.164 form we want to
                      // persist back to the conversation.
                      await supabase
                        .from('conversations')
                        .update({ contact_phone: altPhone })
                        .eq('id', conversation.id);

                      // 2. Marcar o ORIGINAL como failed ANTES de inserir o reenvio:
                      // é a ordem do caminho antigo. Invertida, o CRM recebia o
                      // 'sent' do reenvio antes do 'failed' que o explica.
                      // (escopado: nunca marcar a cópia espelhada de outro número)
                      await supabase
                        .from('messages')
                        .update({
                          status: 'failed',
                          error_message: `${errorMessage} - Fallback attempted to ${altPhone}`
                        })
                        .in('id', scopedMessageIds);

                      // 3. Create new message record for the retry
                      // Mark with 'Fallback attempted' to prevent infinite retry loops
                      // if this message also fails as undeliverable
                      const { data: fallbackRow } = await supabase
                        .from('messages')
                        .insert({
                          conversation_id: conversation.id,
                          content: messageData.content,
                          direction: 'outbound',
                          whatsapp_message_id: newWamid,
                          message_type: messageData.message_type || 'text',
                          sent_by: messageData.sent_by,
                          status: 'sent',
                          error_message: 'Fallback attempted',
                          // Texto leva só as marcas da aba Disparos: sem elas o reenvio de
                          // um disparo contaria como envio de gente e tiraria a conversa da aba.
                          metadata: isTemplate
                            ? metadata
                            : (metadata?.disparo || metadata?.automacao
                              ? { ...(metadata.disparo ? { disparo: metadata.disparo } : {}), ...(metadata.automacao ? { automacao: true } : {}) }
                              : null),
                        })
                        .select('id')
                        .maybeSingle();

                      // O reenvio é uma mensagem nova, com wamid próprio: sem
                      // este evento o CRM só veria o `failed` do original.
                      if (fallbackRow) {
                        await emitMessageSent(supabase, {
                          conversationId: conversation.id,
                          messageId: fallbackRow.id,
                          whatsappMessageId: newWamid,
                          content: messageData.content,
                          messageType: messageData.message_type || 'text',
                          sentBy: messageData.sent_by,
                          origin: 'panel',
                          phoneNumberDbId: phoneNumber?.id,
                          organizationId,
                          metaPhoneNumberId: phoneNumber?.phone_number_id,
                        });
                      }

                      // Skip standard update below
                      continue;
                    } else {
                      console.error(`[Fallback] Resent failed:`, whatsappData);
                    }
                  } catch (e) {
                    console.error(`[Fallback] Error during resend:`, e);
                  }
                }
              }

              // Standard failure update if fallback wasn't triggered or failed
              // (escopado: nunca marcar a cópia espelhada de outro número)
              await supabase
                .from('messages')
                .update({
                  status: 'failed',
                  error_message: errorMessage || errorTitle || 'Falha no envio'
                })
                .in('id', scopedMessageIds);

              // Also update broadcast_recipients if this was a broadcast message
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: errorMessage || errorTitle || 'Falha no envio'
                })
                .eq('whatsapp_message_id', messageId);
            } else {
              // Update other statuses (sent, delivered, read) — escopado
              await supabase
                .from('messages')
                .update({ status: statusType })
                .in('id', scopedMessageIds);
            }
          }
        }
        return new Response(JSON.stringify({ status: 'status_processed' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const messages = value?.messages;

      if (!messages || messages.length === 0) {
        return new Response(JSON.stringify({ status: 'no_messages' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Falha TRANSIENTE em qualquer mensagem → 500 no batch inteiro: a Meta
      // reentrega com backoff e o upsert composto dedupa o que já entrou. O 200
      // incondicional de antes fazia a Meta descartar — perda irreversível.
      // Permanente nunca marca a flag (degrade/evidência + 200), senão seria loop.
      let batchHadTransientFailure = false;

      for (const message of messages) {
       try {
        const contactPhone = message.from;
        const contactName = value.contacts?.[0]?.profile?.name || contactPhone;
        const whatsappMessageId = message.id;
        const metaPhoneNumberId = value.metadata?.phone_number_id;

        // Extract message content based on type
        let messageText = '';
        let messageType = message.type || 'text';
        let cloudContactMetadata:
          | { displayName: string; vcard: string; phones: string[]; contacts: Array<{ displayName: string; vcard: string; phones: string[] }> }
          | null = null;
        let cloudLocationMetadata:
          | { lat: number; lng: number; name: string | null; address: string | null }
          | null = null;

        // Handle reaction messages - update target message instead of creating new
        if (message.type === 'reaction') {
          const targetMessageId = message.reaction?.message_id;
          const reactionEmoji = message.reaction?.emoji || '';

          console.log(`[Reaction] Official API reaction: emoji="${reactionEmoji}", target="${targetMessageId}"`);

          if (!targetMessageId) {
            console.warn('[Reaction] Missing target message_id, skipping');
            continue;
          }

          // Update the target message with the reaction (empty emoji = remove)
          const reactionValue = reactionEmoji && reactionEmoji.trim() !== '' ? reactionEmoji : null;

          // Sessões espelhadas: escopar o wamid pelo número que recebeu o evento.
          // phone row ausente → findMessagesByWamid cai no match largo com warn.
          const { data: reactionPhone } = await supabase
            .from('phone_numbers')
            .select('id')
            .eq('phone_number_id', metaPhoneNumberId)
            .maybeSingle();

          const reactionTargets = await findMessagesByWamid(
            supabase, targetMessageId, reactionPhone?.id, 'conversation_id'
          );

          if ('error' in reactionTargets) {
            console.error('[Reaction] Error loading target message:', reactionTargets.error);
            continue;
          }

          if (reactionTargets.rows.length === 0) {
            console.warn(`[Reaction] Target message not found: ${targetMessageId}`);
            continue;
          }

          const { error: updateError } = await supabase
            .from('messages')
            .update({ reaction: reactionValue })
            .in('id', reactionTargets.rows.map((row) => row.id));

          if (updateError) {
            console.error('[Reaction] Error updating message:', updateError);
            continue;
          }

          // Fan-out por reator (na CA o remetente é sempre o contato do 1:1)
          await writeReactionRows(supabase, reactionTargets.rows.map((row) => row.id), {
            emoji: reactionValue,
            isFromMe: false,
            reactorJid: contactPhone ? `${contactPhone}@s.whatsapp.net` : null,
            reactorName: contactName ?? null,
          });

          // Update conversation last_message_at to reorder in sidebar
          await supabase
            .from('conversations')
            .update({ last_message_at: new Date().toISOString() })
            .in('id', [...new Set(reactionTargets.rows.map((row) => row.conversation_id))]);

          console.log(`[Reaction] Updated message(s) ${reactionTargets.rows.map((r) => r.id).join(', ')} with reaction: ${reactionValue}`);
          continue; // Don't create a new message for reactions
        }

        if (message.type === 'text') {
          messageText = message.text?.body || '';
        } else if (message.type === 'interactive') {
          // Handle interactive message responses (button clicks)
          if (message.interactive?.type === 'button_reply') {
            messageText = message.interactive.button_reply?.title || '';
            messageType = 'button_reply';
            console.log('Received button reply:', messageText);
          } else if (message.interactive?.type === 'list_reply') {
            messageText = message.interactive.list_reply?.title || '';
            messageType = 'list_reply';
            console.log('Received list reply:', messageText);
          } else if (message.interactive?.type === 'nfm_reply') {
            // Handle WhatsApp Flow response (Native Flow Message reply)
            const nfmReply = message.interactive.nfm_reply;
            // Response values stay in protected storage, not application logs.

            // Parse response_json (comes as string)
            let parsedResponse: Record<string, any> = {};
            if (nfmReply?.response_json) {
              try {
                parsedResponse = JSON.parse(nfmReply.response_json);
                // Structured values are handled below without logging personal data.
              } catch (e) {
                console.error('[Flow] Failed to parse response_json:', e);
                parsedResponse = { raw: nfmReply.response_json };
              }
            }

            // Build readable message content from flow response
            const responseKeys = Object.keys(parsedResponse);
            if (responseKeys.length > 0) {
              const responseSummary = responseKeys
                .filter(k => k !== 'flow_token')
                .map(k => `${k}: ${parsedResponse[k]}`)
                .join(', ');
              messageText = `[Flow Response] ${responseSummary || 'Formulário enviado'}`;
            } else {
              messageText = `[Flow Response] Formulário enviado`;
            }
            messageType = 'nfm_reply';
          }
        } else if (message.type === 'button') {
          // Handle quick reply button responses
          messageText = message.button?.text || message.button?.payload || '';
          messageType = 'button_reply';
          console.log('Received quick reply button:', messageText);
        } else if (message.type === 'image') {
          messageText = message.image?.caption || '[Imagem]';
          messageType = 'image';
        } else if (message.type === 'audio') {
          messageText = '[Áudio]';
          messageType = 'audio';
        } else if (message.type === 'video') {
          messageText = message.video?.caption || '[Vídeo]';
          messageType = 'video';
        } else if (message.type === 'document') {
          messageText = message.document?.filename || '[Documento]';
          messageType = 'document';
        } else if (message.type === 'location') {
          messageText = `[Localização: ${message.location?.latitude}, ${message.location?.longitude}]`;
          messageType = 'location';
          // lat/lng estruturado (antes só na string) — a bolha renderiza deste
          const cloudLat = Number(message.location?.latitude);
          const cloudLng = Number(message.location?.longitude);
          if (Number.isFinite(cloudLat) && Number.isFinite(cloudLng)) {
            cloudLocationMetadata = {
              lat: cloudLat,
              lng: cloudLng,
              name: message.location?.name ?? null,
              address: message.location?.address ?? null,
            };
          }
        } else if (message.type === 'sticker') {
          messageText = '[Sticker]';
          messageType = 'sticker';
        } else if (message.type === 'contacts') {
          // Cartões de contato. A Cloud API manda estruturado (sem vCard); o shape
          // gravado espelha o do serviço QR: campos de topo = 1º contato, lista
          // completa em `contacts`. Sem este ramo o type 'contacts' (plural)
          // violava o CHECK de messages.message_type e a mensagem era perdida.
          messageText = '[Contato]';
          messageType = 'contact';
          const sharedContacts = (message.contacts ?? []).map(
            (c: { name?: { formatted_name?: string; first_name?: string }; phones?: Array<{ phone?: string; wa_id?: string }> }) => ({
              displayName: c.name?.formatted_name || c.name?.first_name || 'Sem nome',
              vcard: '',
              phones: (c.phones ?? [])
                .map((p) => p.phone || p.wa_id)
                .filter((ph): ph is string => Boolean(ph)),
            })
          );
          if (sharedContacts.length > 0) {
            cloudContactMetadata = { ...sharedContacts[0], contacts: sharedContacts };
          }
        }

        // Cinto de segurança da cadeia acima: tipo que nenhum branch normalizou
        // (order, system, unknown, evento de boas-vindas, subtipo novo de interactive…)
        // passava cru, violava o CHECK (23514) e a mensagem morria com 200 — a Meta
        // nunca reentregava. Vira 'unsupported' com o original em metadata.
        const { type: cloudSafeType, originalType: cloudOriginalType } = validateMessageType(messageType);
        if (cloudOriginalType) {
          console.warn(`[Webhook] message.type desconhecido "${cloudOriginalType}" → unsupported`);
          messageType = cloudSafeType;
          if (!messageText) messageText = `[Mensagem não suportada: ${cloudOriginalType}]`;
        }

        // Extract media info for download
        let mediaInfo: { id: string; mime_type: string; filename?: string } | null = null;
        if (message.type === 'image' && message.image?.id) {
          mediaInfo = { id: message.image.id, mime_type: message.image.mime_type || 'image/jpeg' };
        } else if (message.type === 'video' && message.video?.id) {
          mediaInfo = { id: message.video.id, mime_type: message.video.mime_type || 'video/mp4' };
        } else if (message.type === 'audio' && message.audio?.id) {
          mediaInfo = { id: message.audio.id, mime_type: message.audio.mime_type || 'audio/ogg' };
        } else if (message.type === 'document' && message.document?.id) {
          mediaInfo = { id: message.document.id, mime_type: message.document.mime_type || 'application/pdf', filename: message.document.filename };
        } else if (message.type === 'sticker' && message.sticker?.id) {
          mediaInfo = { id: message.sticker.id, mime_type: message.sticker.mime_type || 'image/webp' };
        }

        console.log(`Processing message type: ${messageType}, content: ${messageType === 'nfm_reply' ? '[Flow Response omitted]' : messageText}, from phone_number_id: ${metaPhoneNumberId}`);

        // Normalize phone number for matching
        const { normalized: normalizedPhone, variations: phoneVariations } = normalizePhoneNumber(contactPhone);
        console.log(`Phone variations for ${contactPhone}: ${phoneVariations.join(', ')}`);

        // Find phone number in our database
        let phoneNumberDbId = null;
        let organizationId = null;
        let autoReplyMessage: string | null = null;
        let whatsappAccessToken: string | null = null;

        if (metaPhoneNumberId) {
          const { data: phoneNumber, error: phoneLookupError } = await supabase
            .from('phone_numbers')
            .select(`
              id,
              organization_id,
              auto_reply_message,
              organizations(
                whatsapp_access_token
              )
            `)
            .eq('phone_number_id', metaPhoneNumberId)
            .maybeSingle();

          // Erro de consulta NÃO é "número desconhecido". Descartá-lo deixava
          // phoneNumberDbId nulo, o fluxo caía no ramo legado abaixo (que busca
          // conversa com `phone_number_id is null`), não achava nada, e CRIAVA
          // uma conversa com phone_number_id: null — fora do unique
          // (phone_number_id, contact_phone, is_group), invisível no painel e
          // impossível de reencontrar pelo caminho normal.
          //
          // batchHadTransientFailure faz o lote responder 500 (:3141), a Meta
          // reentrega, e o upsert composto (whatsapp_message_id,
          // conversation_id) dedupa o que já tinha entrado. Mesmo contrato que
          // o caminho /qr-message usa desde sempre (:1295).
          if (phoneLookupError) {
            console.error('[Cloud-Webhook] Erro ao resolver phone_number, pulando mensagem para reentrega:', phoneLookupError);
            batchHadTransientFailure = true;
            continue;
          }

          phoneNumberDbId = phoneNumber?.id;
          organizationId = phoneNumber?.organization_id;
          autoReplyMessage = phoneNumber?.auto_reply_message || null;
          const org = phoneNumber?.organizations as any;
          whatsappAccessToken = org?.whatsapp_access_token || null;
          console.log(`Found phone number in DB: ${phoneNumberDbId}, Org: ${organizationId}, AutoReply: ${autoReplyMessage ? 'configured' : 'none'}`);
        }

        // Find or create conversation - now by contact_phone variations AND phone_number_id
        // This allows the same client to have separate conversations with different numbers
        let conversation = null;
        let convError = null;

        if (phoneNumberDbId) {
          // Look for existing conversation with any phone variation
          const result = await supabase
            .from('conversations')
            .select('id, contact_phone, contact_name')
            .in('contact_phone', phoneVariations)
            .eq('phone_number_id', phoneNumberDbId)
            .limit(1)
            .maybeSingle();

          conversation = result.data;
          convError = result.error;

          if (conversation) {
            console.log(`Found existing conversation ${conversation.id} with phone ${conversation.contact_phone}`);
          }
        } else {
          // Legacy: look for conversation without phone_number_id
          const result = await supabase
            .from('conversations')
            // MESMAS colunas do ramo acima. Selecionar só `id` aqui fazia
            // conversation.contact_phone e .contact_name chegarem undefined nos
            // dois pontos que os leem adiante (:2762 e :3148), com dois efeitos
            // reais: um UPDATE de contact_phone disparava em TODA mensagem deste
            // caminho, e o nome nunca era promovido de telefone para pushName
            // (/^\d+$/.test(undefined) testa a string "undefined" e dá false).
            .select('id, contact_phone, contact_name')
            .in('contact_phone', phoneVariations)
            .is('phone_number_id', null)
            .limit(1)
            .maybeSingle();

          conversation = result.data;
          convError = result.error;
        }

        if (convError) {
          // Falha de leitura é transiente: sinalizar o batch para a Meta reentregar,
          // em vez do `continue` + 200 que descartava a mensagem para sempre.
          console.error('Error fetching conversation:', convError);
          batchHadTransientFailure = true;
          continue;
        }

        if (!conversation) {
          const { data: newConv, error: createError } = await supabase
            .from('conversations')
            .insert({
              contact_phone: normalizedPhone, // Use normalized phone (with country code) to prevent duplicates
              contact_name: contactName || normalizedPhone || 'Desconhecido',
              whatsapp_id: value.metadata?.display_phone_number ?? '',
              status: 'active',
              phone_number_id: phoneNumberDbId,
            })
            // idem: o RETURNING precisa da mesma forma dos outros ramos, senão
            // `conversation` vira uma união cujo denominador comum é só { id }.
            .select('id, contact_phone, contact_name')
            .single();

          if (createError?.code === '23505') {
            // Corrida do find-or-create: a conversa nasceu em paralelo — reselect
            // em vez de perder a mensagem.
            const raceQuery = supabase
              .from('conversations')
              .select('id, contact_phone, contact_name')
              .in('contact_phone', phoneVariations)
              .limit(1);
            const { data: racedConv } = await (phoneNumberDbId
              ? raceQuery.eq('phone_number_id', phoneNumberDbId)
              : raceQuery.is('phone_number_id', null)
            ).maybeSingle();
            conversation = racedConv;
          } else if (!createError) {
            conversation = newConv;
          }
          if (!conversation) {
            console.error('Error creating conversation:', createError);
            batchHadTransientFailure = true;
            continue;
          }
        } else {
          // Update contact_phone if different from incoming (WhatsApp format is authoritative)
          if (conversation.contact_phone !== contactPhone) {
            console.log(`[PhoneNormalize] Updating contact_phone from ${conversation.contact_phone} to ${contactPhone}`);
            await supabase
              .from('conversations')
              .update({ contact_phone: contactPhone })
              .eq('id', conversation.id);
          }
        }

        // Resolve quoted message if present (official API sends in message.context)
        let officialQuotedMessageId: string | null = null;
        let officialQuotedWhatsappId: string | null = null;
        let officialQuotedContent: string | null = null;

        if (message.context?.id) {
          officialQuotedWhatsappId = message.context.id;
          console.log(`[Webhook] Looking for quoted message with whatsapp_message_id: "${officialQuotedWhatsappId}"`);

          // Escopado à conversa: o mesmo wamid pode existir em mais de uma conversa
          // (sessões espelhadas), e o .maybeSingle() sem filtro falharia em silêncio.
          const { data: quotedMsg, error: quotedError } = await supabase
            .from('messages')
            .select('id, content')
            .eq('whatsapp_message_id', officialQuotedWhatsappId)
            .eq('conversation_id', conversation.id)
            .maybeSingle();

          if (quotedError) {
            console.error('[Webhook] Error looking up quoted message:', quotedError);
          } else if (quotedMsg) {
            officialQuotedMessageId = quotedMsg.id;
            officialQuotedContent = quotedMsg.content;
            console.log(`[Webhook] Found quoted message: ${officialQuotedMessageId}`);
          } else {
            console.log(`[Webhook] Quoted message not found in DB`);
          }
        }

        // Download and store media if present
        let storedMedia: { url: string; mime_type: string; filename: string; size_bytes: number; dims?: MediaDims | null } | null = null;
        if (mediaInfo && whatsappAccessToken) {
          storedMedia = await downloadAndStoreMedia(
            supabase,
            mediaInfo.id,
            whatsappAccessToken,
            messageType,
            mediaInfo.mime_type,
            mediaInfo.filename
          );
          if (storedMedia) {
            console.log(`[Media] Stored media: ${storedMedia.url}`);
          }
        }

        // Create message with media fields
        const messageInsert: any = {
          conversation_id: conversation.id,
          content: messageText ?? '',
          direction: 'inbound',
          whatsapp_message_id: whatsappMessageId,
          message_type: messageType,
          quoted_message_id: officialQuotedMessageId,
        };
        if (cloudOriginalType) {
          messageInsert.metadata = { ...(messageInsert.metadata ?? {}), original_type: cloudOriginalType };
        }
        // Hora real do envio pelo cliente. created_at continua sendo a chegada
        // (o não-lido compara created_at com last_read_at), mas a Meta reentrega
        // avisos recusados por dias: sem sent_at a janela de 24h e a bolha mentem.
        const cloudTiming = cloudDeliveryTiming(message.timestamp);
        if (cloudTiming.metadata) {
          messageInsert.metadata = { ...(messageInsert.metadata ?? {}), ...cloudTiming.metadata };
          if (cloudTiming.lagMinutes !== null) {
            console.log(`[Webhook] late delivery wamid=${whatsappMessageId ?? 'none'} lag_min=${cloudTiming.lagMinutes}`);
          }
        }

        // Add media fields if media was downloaded
        if (storedMedia) {
          messageInsert.media_url = storedMedia.url;
          messageInsert.media_mime_type = storedMedia.mime_type;
          messageInsert.media_filename = storedMedia.filename;
          messageInsert.media_size_bytes = storedMedia.size_bytes;
          if (storedMedia.dims) {
            messageInsert.metadata = withMediaDims(messageInsert.metadata, storedMedia.dims, 'bytes');
            if (messageType === 'image') {
              const th = await thumbHashFromUrl(storedMedia.url, Deno.env.get('SUPABASE_URL') ?? '', { timeoutMs: 1500 });
              messageInsert.metadata = withThumbHash(messageInsert.metadata, th);
            }
          }
        }

        // Add flow-specific fields if nfm_reply
        if (messageType === 'nfm_reply' && message.interactive?.nfm_reply) {
          const nfmReply = message.interactive.nfm_reply;
          messageInsert.flow_token = nfmReply.body || nfmReply.name || null;
          try {
            const parsed = JSON.parse(nfmReply.response_json || '{}');
            messageInsert.flow_response_json = parsed;
            if (parsed.flow_token && !messageInsert.flow_token) {
              messageInsert.flow_token = parsed.flow_token;
            }
          } catch {
            console.error('[Webhook] Invalid Flow response JSON');
            messageInsert.flow_response_json = { raw: nfmReply.response_json };
          }
        }

        // Metadados do(s) contato(s) compartilhado(s). Merge, não atribuição:
        // metadata também carrega o referral de anúncio logo abaixo.
        if (messageType === 'contact' && cloudContactMetadata) {
          messageInsert.metadata = { ...(messageInsert.metadata ?? {}), contact: cloudContactMetadata };
        }

        // Localização estruturada (a string em content é só fallback legado)
        if (messageType === 'location' && cloudLocationMetadata) {
          messageInsert.metadata = { ...(messageInsert.metadata ?? {}), location: cloudLocationMetadata };
        }

        // Encaminhada pelo contato: a Cloud API expõe em message.context.
        // Mesma chave que o whatsapp-forward grava, então a bolha já renderiza.
        if (message.context?.forwarded === true || message.context?.frequently_forwarded === true) {
          messageInsert.metadata = {
            ...(messageInsert.metadata ?? {}),
            forwarded: true,
            ...(message.context.frequently_forwarded === true ? { frequently_forwarded: true } : {}),
          };
        }

        // Atribuição de anúncio Click-to-WhatsApp. A Cloud API entrega o bloco pronto em
        // `referral`, então ele é gravado exatamente como a Meta mandou.
        const apiCtwa = ctwaMetadata(message.referral, 'cloud_api');
        if (apiCtwa) {
          messageInsert.metadata = { ...(messageInsert.metadata ?? {}), ...apiCtwa };
          console.log(`[CTWA] Referral gravado (API) wamid=${whatsappMessageId} ctwa_clid=${apiCtwa.ctwa_clid ?? 'ausente'}`);
        }

        // Meta retries webhooks aggressively, so the same wamid can arrive more
        // than once. Upsert on the composite unique key turns a duplicate into a
        // silent no-op (returns 0 rows) instead of a 23505 error.
        let { data: newMessage, error: msgError } = await supabase
          .from('messages')
          .upsert(messageInsert, {
            onConflict: 'whatsapp_message_id,conversation_id',
            ignoreDuplicates: true,
          })
          .select()
          .maybeSingle();

        // Mesma máquina do /qr-message: permanente degrada para 'unsupported'
        // (a Meta reentregar o mesmo payload falharia para sempre); transiente
        // marca o batch para 500 → reentrega. O 200 cego de antes = perda definitiva.
        let cloudDegradedWrite = false;
        if (msgError) {
          const failCode = msgError.code ?? 'unknown';
          const failDetail = `${failCode}: ${msgError.message ?? String(msgError)}`;
          console.error(
            `[Webhook] MESSAGE_WRITE_FAILED code=${failCode} wamid=${whatsappMessageId ?? 'none'} type=${messageType}:`,
            msgError
          );

          if (isPermanentDbError(msgError)) {
            const { data: degradedRow, error: degradedError } = await supabase
              .from('messages')
              .upsert({
                conversation_id: conversation.id,
                content: '[Mensagem não processada]',
                direction: 'inbound',
                whatsapp_message_id: whatsappMessageId,
                message_type: 'unsupported',
                metadata: { original_type: messageType, degraded_reason: failCode, ...(cloudTiming.metadata ?? {}) },
              }, {
                onConflict: 'whatsapp_message_id,conversation_id',
                ignoreDuplicates: true,
              })
              .select()
              .maybeSingle();

            if (!degradedError && degradedRow) {
              await logWriteFailure(supabase, {
                phoneNumberDbId,
                toJid: String(contactPhone ?? 'unknown'),
                wamid: whatsappMessageId ?? null,
                action: 'msg_write_degraded',
                error: failDetail,
                route: 'cloud-messages',
                payload: message,
              });
              newMessage = degradedRow;
              msgError = null;
              cloudDegradedWrite = true;
            } else {
              const logged = await logWriteFailure(supabase, {
                phoneNumberDbId,
                toJid: String(contactPhone ?? 'unknown'),
                wamid: whatsappMessageId ?? null,
                action: 'msg_write_failed',
                error: `${failDetail} | degrade: ${degradedError?.code ?? 'no_row'}`,
                route: 'cloud-messages',
                payload: message,
              });
              // Permanente evidenciado NÃO marca o batch (reentrega não resolveria);
              // sem evidência, a reentrega da Meta é a única rede que sobra.
              if (!logged) batchHadTransientFailure = true;
              continue;
            }
          } else {
            await logWriteFailure(supabase, {
              phoneNumberDbId,
              toJid: String(contactPhone ?? 'unknown'),
              wamid: whatsappMessageId ?? null,
              action: 'msg_write_failed',
              error: failDetail,
              route: 'cloud-messages',
              payload: message,
            });
            batchHadTransientFailure = true;
            continue;
          }
        }

        const receivedWebhookPayload = (saved: any) => ({
              phone_number_id: metaPhoneNumberId,
              phone_number_internal_id: phoneNumberDbId,
              message: {
                id: saved.id,
                whatsapp_id: whatsappMessageId,
                content: messageText,
                type: messageType,
                created_at: saved.created_at,
                direction: 'inbound',
                media: storedMedia ? {
                  url: storedMedia.url,
                  mime_type: storedMedia.mime_type,
                  filename: storedMedia.filename,
                  size_bytes: storedMedia.size_bytes
                } : null,
                // Quoted message info
                quoted_message_id: officialQuotedMessageId || null,
                quoted_whatsapp_id: officialQuotedWhatsappId || null,
                quoted_content: officialQuotedContent || null,
              },
              contact: {
                id: conversation.id,
                phone: contactPhone,
                name: contactName
              },
              conversation: {
                id: conversation.id
              }
            });
        if (!newMessage) {
          console.log(`Duplicate message skipped - Type: ${messageType}`);
          // Reentrega idempotente: nada a fazer, e sem re-bump da conversa.
          continue;
        }

        if (!cloudDegradedWrite) {
          console.log(`Message saved - Type: ${messageType}, Content: ${messageType === 'nfm_reply' ? '[Flow Response omitted]' : messageText}`);

          // Send Webhook for received message
          if (organizationId && newMessage) {
            const webhookPayload = receivedWebhookPayload(newMessage);
            await sendOrganizationWebhook(supabase, organizationId, 'message.received', webhookPayload);

            // OS push (closed-tab notification) for the involved users.
            triggerWebPush(supabaseUrl, supabaseKey, {
              conversationId: conversation.id,
              title: `Nova mensagem de ${contactName || contactPhone}`,
              body: messageText ? messageText.substring(0, 120) : '📎 Mídia',
            });

            // Execute automation flows (fire-and-forget to separate edge function)
            if (whatsappAccessToken && metaPhoneNumberId) {
              const automationPayload = {
                organizationId,
                conversationId: conversation.id,
                phoneNumberDbId: phoneNumberDbId,
                metaPhoneNumberId: metaPhoneNumberId,
                contactPhone: contactPhone,
                accessToken: whatsappAccessToken,
                connectionType: 'official',
                message: {
                  content: messageText,
                  type: messageType,
                  selectionId: message.interactive?.list_reply?.id ||
                    message.interactive?.button_reply?.id ||
                    message.interactive?.nfm_reply?.body || null,
                  flowResponseJson: messageType === 'nfm_reply' && message.interactive?.nfm_reply?.response_json
                    ? (() => { try { return JSON.parse(message.interactive.nfm_reply.response_json); } catch { return null; } })()
                    : null,
                  mediaUrl: storedMedia?.url || null,
                  mediaMimeType: storedMedia?.mime_type || null,
                  mediaFilename: storedMedia?.filename || null,
                },
              };
              fetch(`${supabaseUrl}/functions/v1/automation-execute`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${supabaseKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(automationPayload)
              }).catch(err => console.error('[Automation] Trigger error:', err));
            }
          }

          // Send auto-reply if configured (with 30-minute cooldown)
          if (autoReplyMessage && autoReplyMessage.trim() && whatsappAccessToken && metaPhoneNumberId) {
            // Check cooldown atomically via RPC
            const { data: shouldSendAutoReply, error: rpcError } = await supabase.rpc(
              'check_and_update_auto_reply_cooldown',
              {
                p_conversation_id: conversation.id,
                p_cooldown_minutes: 30
              }
            );

            if (rpcError) {
              console.error('[AutoReply] RPC Error:', rpcError);
            }

            if (shouldSendAutoReply) {
              console.log(`[AutoReply] Sending auto-reply to ${contactPhone} (cooldown passed)`);
              try {
                // Send to WhatsApp API
                const whatsappResponse = await fetch(
                  `https://graph.facebook.com/v18.0/${metaPhoneNumberId}/messages`,
                  {
                    method: 'POST',
                    headers: {
                      'Authorization': `Bearer ${whatsappAccessToken}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      messaging_product: 'whatsapp',
                      to: contactPhone,
                      type: 'text',
                      text: { body: autoReplyMessage.trim() },
                    }),
                  }
                );

                const whatsappData = await whatsappResponse.json();

                if (whatsappResponse.ok && whatsappData.messages?.[0]?.id) {
                  console.log(`[AutoReply] Sent successfully: ${whatsappData.messages[0].id}`);

                  // Save auto-reply message to database so it appears in chat
                  const autoReplyWamid = whatsappData.messages[0].id;
                  const { data: autoReplyRow, error: autoReplyError } = await supabase
                    .from('messages')
                    .insert({
                      conversation_id: conversation.id,
                      content: autoReplyMessage.trim(),
                      direction: 'outbound',
                      whatsapp_message_id: autoReplyWamid,
                      message_type: 'text',
                      sent_by: null, // null indicates system/auto message
                      // Resposta automática não é gente agindo (aba Disparos).
                      metadata: { automacao: true },
                    })
                    .select('id')
                    .maybeSingle();

                  // Contato já recebeu; insert falho = divergência CRM↔WhatsApp.
                  if (autoReplyError) {
                    await logWriteFailure(supabase, {
                      phoneNumberDbId,
                      toJid: String(contactPhone ?? 'unknown'),
                      wamid: autoReplyWamid,
                      action: 'msg_write_failed',
                      error: `${autoReplyError.code ?? 'unknown'}: ${autoReplyError.message}`,
                      route: 'auto-reply-cloud',
                      payload: { conversation_id: conversation.id, content: autoReplyMessage.trim() },
                    });
                  }

                  if (autoReplyRow) {
                    await emitMessageSent(supabase, {
                      conversationId: conversation.id,
                      messageId: autoReplyRow.id,
                      whatsappMessageId: autoReplyWamid,
                      content: autoReplyMessage.trim(),
                      messageType: 'text',
                      sentBy: null,
                      origin: 'auto_reply',
                      phoneNumberDbId: phoneNumberDbId,
                      organizationId,
                      metaPhoneNumberId,
                    });
                  }
                  // No need to update last_auto_reply_at here, RPC already did it
                } else {
                  console.error('[AutoReply] Failed to send:', whatsappData);
                }
              } catch (autoReplyError) {
                console.error('[AutoReply] Error:', autoReplyError);
              }
            } else {
              console.log(`[AutoReply] Skipped - cooldown active`);
            }
          }
        }

        // Update conversation — só se alcança este ponto com linha persistida
        // (duplicata e falhas fazem `continue` acima). Bumpar com insert falho
        // mascarava a perda como "bug de UI".
        // Also promote broadcast convos to organic (30-day auto-close instead of 1-day)
        // Only update contact_name if current name looks like a phone number (only digits)
        // Condicional (D1): sem nome novo, só escreve se status/source mudam.
        // last_message_at fica com o trigger on_message_inserted, que já avançou
        // para o created_at (hora de chegada) no insert acima; o timestamp da
        // Meta é sempre <= chegada, então o antigo .lt() nunca casava.
        const looksLikePhone = /^\d+$/.test(conversation.contact_name);
        if (contactName && looksLikePhone && contactName !== conversation.contact_name) {
          await supabase
            .from('conversations')
            .update({ status: 'active', source: 'organic', contact_name: contactName })
            .eq('id', conversation.id);
        } else {
          await reativarConversa(supabase, conversation.id, { promoverOrganica: true });
        }
       } catch (messageError) {
        // Exceção inesperada nesta mensagem (ex.: shape novo da Meta) não pode
        // matar o resto do lote. Payload evidenciado = replay possível = pode
        // seguir sem 5xx; se nem a evidência persistiu, o batch vira 500 e a
        // Meta reentrega.
        console.error('[Webhook] Exceção ao processar mensagem do lote:', messageError);
        const logged = await logWriteFailure(supabase, {
          toJid: String(message?.from ?? 'unknown'),
          wamid: typeof message?.id === 'string' ? message.id : null,
          action: 'msg_handler_throw',
          error: messageError instanceof Error ? messageError.message : String(messageError),
          route: 'cloud-messages',
          payload: message,
        });
        if (!logged) batchHadTransientFailure = true;
       }
      }

      if (batchHadTransientFailure) {
        return new Response(JSON.stringify({ status: 'retry', note: 'transient failure — Meta will redeliver' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Method not allowed', { status: 405 });
  } catch (error: any) {
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});