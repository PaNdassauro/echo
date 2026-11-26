import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { qrAuthHeaders } from '../_shared/qr.ts';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { lerDisparo } from '../_shared/disparo.ts';
import { lerIa } from '../_shared/ia.ts';
import { urlPublicaDoAnexo } from '../_shared/url-publica.ts';
import { fetchMidia } from '../_shared/url-guard.ts';
import { sendMetaTypingIndicator, getLatestInboundWamid } from '../_shared/meta-typing-indicator.ts';
import {
  apiKeyOwnerStillAllowed,
  apiOriginMetadata,
  lastUsedIsStale,
  parseApiSource,
  LAST_USED_WRITE_INTERVAL_MS,
  type ApiCaller,
} from './apiKeyAuth.ts';
import { resolveApiAuthor, withAgentHeader } from './author.ts';
import { criarGrupo } from './grupos.ts';
import { passarGrupo } from './passar-grupo.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key, x-echo-source',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
};

/** Sufixo de JID de grupo do WhatsApp. */
const GROUP_JID_SUFFIX = '@g.us';

/**
 * Teto de linhas por resposta do PostgREST neste projeto (`db-max-rows`). Pedir
 * mais que isto NÃO devolve mais: devolve 1000 em silêncio, indistinguível de
 * uma resposta completa.
 */
const POSTGREST_MAX_ROWS = 1000;

/** Ids por `.in()` antes de a URL passar de ~30KB e o gateway responder 400. */
const MAX_IN_IDS = 250;

/**
 * limit/offset do cliente com guarda de NaN, de negativo e do teto do PostgREST.
 *
 * Sem a guarda, `?limit=abc` virava NaN e ia parar num `.range(NaN, NaN)`; e um
 * limit acima de 1000 era cortado em silêncio, com o cliente acreditando ter
 * recebido tudo. O padrão já existia em dois handlers mais novos deste arquivo
 * (:3916 e :4708) — aqui vira função para o resto poder usar.
 */
function clampPage(url: URL, defLimit: number, maxLimit = POSTGREST_MAX_ROWS) {
  const rawLimit = parseInt(url.searchParams.get('limit') || String(defLimit), 10);
  const rawOffset = parseInt(url.searchParams.get('offset') || '0', 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : defLimit, 1), maxLimit);
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
  return { limit, offset };
}

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'session not connected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp.',
    'not connected': 'WhatsApp desconectado. Tente novamente.',
    'qr service unreachable': 'Serviço temporariamente indisponível. Tente novamente.',
    'failed to send': 'Falha ao enviar. Tente novamente.',
    'whatsapp credentials not found': 'WhatsApp não configurado.',
    'phone number not found': 'Número de WhatsApp não encontrado.',
    'conversation not found': 'Conversa não encontrada.',
    'failed to create conversation': 'Erro ao criar conversa. Tente novamente.',
    'api key': 'Chave de API inválida ou não fornecida.',
    'organization not found': 'Organização não encontrada.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

// Simple hash function for API key validation
async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const resource = pathParts[1] || '';

    // Health endpoint doesn't require authentication
    if (resource === 'health') {
      return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // Validate API key for all other endpoints
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey) {
      return jsonResponse({
        error: 'API key required',
        message: 'Include your API key in the x-api-key header'
      }, 401);
    }

    // Hash the provided key and check against database
    const keyHash = await hashApiKey(apiKey);
    const { data: keyData, error: keyError } = await supabase
      .from('api_keys')
      .select('id, name, is_active, user_id, organization_id, last_used_at')
      .eq('key_hash', keyHash)
      .single();

    if (keyError || !keyData) {
      console.log('Invalid API key attempt');
      return jsonResponse({ error: 'Invalid API key' }, 401);
    }

    if (!keyData.is_active) {
      return jsonResponse({ error: 'API key is inactive' }, 401);
    }

    // Validate organization scope
    const organizationId = keyData.organization_id;
    if (!organizationId) {
      return jsonResponse({
        error: 'API key not associated with an organization',
        message: 'This API key needs to be regenerated with an organization scope. Please create a new API key in Settings.'
      }, 403);
    }

    // S2: a chave só vale enquanto o dono ainda for membro da organização dela
    // (super admin passa, como em requirePhoneAccess). A policy de INSERT de
    // api_keys conferia só o user_id, então dava para criar chave para a org de
    // outro; e chave de ex-membro continuava abrindo a API. As duas param aqui.
    const ownerCheck = await apiKeyOwnerStillAllowed(supabase, keyData.user_id, organizationId);
    if (ownerCheck === 'error') {
      return jsonResponse({ error: 'Temporarily unavailable', message: 'Try again in a few seconds.' }, 503);
    }
    if (ownerCheck === 'denied') {
      console.warn(`[echo-api] chave ${keyData.id} recusada: dono não é membro da organização ${organizationId}`);
      return jsonResponse({ error: 'Invalid API key' }, 401);
    }

    // Update last_used_at — exceto em /typing. É o único endpoint que a
    // integração é ESPERADA chamar a cada ~8s para manter o indicador vivo:
    // dezenas de conversas ativas viram vários writes por segundo na MESMA linha
    // de api_keys, com contenção de lock e bloat. Nenhum outro endpoint tem esse
    // perfil, e perder o last_used_at de um sinal cosmético não custa nada.
    // Nos outros, no máximo uma escrita por minuto por chave: o filtro no
    // UPDATE cobre duas requisições simultâneas que leram o mesmo valor.
    if (resource !== 'typing' && lastUsedIsStale(keyData.last_used_at, Date.now())) {
      const staleBefore = new Date(Date.now() - LAST_USED_WRITE_INTERVAL_MS).toISOString();
      await supabase
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', keyData.id)
        .or(`last_used_at.is.null,last_used_at.lt.${staleBefore}`);
    }

    // Quem está chamando: vai para metadata de toda mensagem que a API grava.
    const caller: ApiCaller = {
      keyId: keyData.id,
      keyName: keyData.name ?? null,
      source: parseApiSource(req.headers.get('x-echo-source')),
    };

    console.log(`API Request authenticated: ${req.method} /${resource} (org: ${organizationId})`);

    // Path format: /echo-api/{resource}/{id?}/{action?}
    const resourceId = pathParts[2] || '';
    const action = pathParts[3] || '';

    // Route handling
    switch (resource) {
      case 'conversations':
        return await handleConversations(req, supabase, resourceId, action, url, organizationId);
      case 'messages':
        return await handleMessages(req, supabase, resourceId, url, organizationId);
      case 'templates':
        return await handleTemplates(req, supabase, resourceId, organizationId);
      case 'phone-numbers':
        return await handlePhoneNumbers(req, supabase, resourceId, organizationId);
      case 'tags':
        return await handleTags(req, supabase, resourceId, organizationId);
      case 'close-reasons':
        return await handleCloseReasons(req, supabase, resourceId, organizationId);
      case 'send-message':
        return await handleSendMessage(req, supabase, organizationId, caller);
      case 'send-template':
        return await handleSendTemplate(req, supabase, organizationId, caller);
      case 'send-image':
        return await handleSendImage(req, supabase, organizationId, caller);
      case 'send-voice':
        return await handleSendVoice(req, supabase, organizationId, caller);
      case 'send-sticker':
        return await handleSendSticker(req, supabase, organizationId, caller);
      case 'react':
        return await handleReact(req, supabase, organizationId);
      case 'typing':
        return await handleTyping(req, supabase, organizationId);
      case 'scheduled-messages':
        return await handleScheduledMessages(req, supabase, resourceId, url, organizationId);
      case 'broadcasts':
        return await handleBroadcasts(req, supabase, resourceId, action, url, organizationId);
      case 'groups':
        return await handleGroups(req, supabase, resourceId, organizationId);
      default:
        return jsonResponse({
          error: 'Not found',
          available_endpoints: [
            'GET /conversations - List all conversations',
            'GET /conversations?status=active|waiting|closed - Filter by status',
            'GET /conversations?phone_number_id=uuid - Filter by phone number',
            'GET /conversations?assigned_to=uuid - Filter by assignee',
            'GET /conversations/{id} - Get single conversation',
            'POST /conversations - Create conversation',
            'PATCH /conversations/{id} - Update conversation',
            'POST /conversations/{id}/assign - Assign conversation. Body: { user_id } or { user_email }, optional avisar, se_sem_dono',
            'POST /conversations/{id}/release - Release conversation. Optional body: { se_sem_dono }',
            'POST /conversations/{id}/close - Close conversation',
            'GET /conversations/{id}/co-owners - List co-owners (shared custody)',
            'POST /conversations/{id}/co-owners - Add a co-owner (body: { user_id })',
            'DELETE /conversations/{id}/co-owners?user_id=uuid - Remove a co-owner',
            'GET /conversations?co_owner=uuid - Filter by co-ownership',
            'GET /conversations/{id}/invite-link - Get group invite link (QR groups only)',
            'POST /groups - Create an EMPTY group on a QR line and get its invite link. Body: { phone_number_id, subject, description?, picture_url? }. People join through invite_url',
            'POST /groups/handover - Hand a group over from one QR line to another: the new line joins by the invite link and becomes admin, then the old line leaves. Body: { group_jid, from_phone_number_id, to_phone_number_id, dry_run? }',
            'POST /groups/add-line - Bring another QR line of the organization into a group: it joins by the invite link of the from line (already in the group, admin) and becomes admin; nobody leaves. Body: { group_jid, from_phone_number_id, to_phone_number_id, make_admin?, dry_run? }',
            'GET /conversations/{id}/messages - Get conversation messages',
            'GET /messages?conversation_id=uuid - List messages',
            'POST /send-message - Send WhatsApp message; accepts mentions (QR groups) and reply_to',
            'POST /react - React to a message with an emoji; empty emoji removes it. Body: { message_id, phone_number_id, emoji? }',
            'POST /send-template - Send WhatsApp template',
            'POST /send-image - Send WhatsApp image/media (multipart/form-data)',
            'POST /send-voice - Send WhatsApp voice note (PTT); accepts any audio format, transcoded to opus (QR only)',
            'POST /send-sticker - Send a sticker (webp, or any image converted to spec); accepts sticker_url, sticker_id or multipart file',
            'POST /typing - Show typing/recording to a contact; expires in ~10s (QR) or ~25s (Cloud API). Body: { to, phone_number_id, state? }',
            'POST /scheduled-messages - Schedule a message for later (text or template)',
            'GET /scheduled-messages?status=scheduled|processing|sent|failed|cancelled - List scheduled messages',
            'GET /scheduled-messages/{id} - Get single scheduled message',
            'PATCH /scheduled-messages/{id} - Reschedule or edit a pending scheduled message',
            'DELETE /scheduled-messages/{id} - Cancel a pending scheduled message (sets status=cancelled)',
            'POST /broadcasts - Create a template broadcast (up to 5000 recipients; Business API only)',
            'GET /broadcasts?status=draft|scheduled|processing|completed|failed|cancelled - List broadcasts',
            'GET /broadcasts/{id} - Get single broadcast with progress counters',
            'GET /broadcasts/{id}/recipients?status=pending|sending|sent|failed - List broadcast recipients',
            'DELETE /broadcasts/{id} - Cancel a broadcast (drains the queue) or delete a draft',
            'POST /broadcasts/{id}/retry - Requeue the failed recipients of a finished broadcast',
            'GET /templates - List WhatsApp templates',
            'GET /templates?phone_number_id=uuid&name=x - One template by name, in any status (follow Meta review)',
            'POST /templates - Submit a text template to Meta review. Body: { phone_number_id, name, language, category, components }',
            'GET /phone-numbers - List phone numbers',
            'POST /phone-numbers - Create phone number',
            'PATCH /phone-numbers/{id} - Update phone number',
            'DELETE /phone-numbers/{id} - Delete phone number',
            'GET /tags - List tags',
            'POST /tags - Create tag',
            'PATCH /tags/{id} - Update tag',
            'DELETE /tags/{id} - Delete tag',
            'GET /close-reasons - List close reasons',
            'POST /close-reasons - Create close reason',
            'DELETE /close-reasons/{id} - Delete close reason',
            'GET /health - Health check (no auth required)',
          ]
        }, 404);
    }
  } catch (error: any) {
    console.error('API Error:', error);
    return jsonResponse({ success: false, error: friendlyError(error.message) }, 500);
  }
});

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Avisa a pessoa que recebeu a conversa, no mesmo canal que o painel usa ao
 * transferir (useConversation → GlobalNotificationListener). Vai pela API REST
 * do Realtime porque aqui não há canal assinado. Falha não desfaz a atribuição.
 */
async function avisarTransferencia(userId: string, conversationId: string, contactName: string | null) {
  try {
    const chave = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: chave, Authorization: `Bearer ${chave}` },
      body: JSON.stringify({
        messages: [{
          topic: `user-${userId}-notifications`,
          event: 'conversation-transfer',
          payload: { conversationId, contactName: contactName || 'Conversa' },
          private: false,
        }],
      }),
    });
    if (!res.ok) console.error('[echo-api] aviso de transferência falhou', res.status);
  } catch (e) {
    console.error('[echo-api] aviso de transferência falhou', e instanceof Error ? e.message : e);
  }
}

// ============ CONVERSATIONS ============
async function handleConversations(
  req: Request,
  supabase: any,
  id: string,
  action: string,
  url: URL,
  organizationId: string
) {
  const method = req.method;

  // POST /conversations/read — leitura feita no CRM (ver handleMarkReadFromCrm).
  if (id === 'read' && !action) {
    if (method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
    return await handleMarkReadFromCrm(req, supabase, organizationId);
  }

  // Handle actions on specific conversation
  if (id && action) {
    // Verify conversation belongs to organization
    const hasAccess = await verifyConversationOrg(supabase, id, organizationId);
    if (!hasAccess) {
      return jsonResponse({ error: 'Conversation not found' }, 404);
    }

    const body = method === 'POST' ? await req.json().catch(() => ({})) : {};

    switch (action) {
      case 'assign': {
        // Por user_id ou user_email: quem chama nem sempre conhece o id do Echo (uma
        // integração pode passar a conversa da IA para a pessoa pelo e-mail dela). Os dois
        // juntos têm de apontar para o mesmo membro. `avisar: true` manda o aviso da
        // transferência; sem ele, como antes (a integração que atribui em lote segue calada).
        // `se_sem_dono: true` só atribui conversa que ainda não é de ninguém: a IA
        // nunca tira a conversa de quem já assumiu (409).
        const { user_id, user_email, avisar, se_sem_dono } = body;
        if (!user_id && !user_email) return jsonResponse({ error: 'user_id or user_email is required' }, 400);

        const resolucao = await resolveApiAuthor(supabase, organizationId, { userId: user_id, userEmail: user_email });
        if (!resolucao.ok) return jsonResponse({ error: 'user_id and user_email point to different users' }, 400);
        if (!resolucao.author) return jsonResponse({ error: 'User not found in organization' }, 404);
        const destino = resolucao.author.id;

        let atribuir = supabase
          .from('conversations')
          .update({ assigned_to: destino, status: 'active' })
          .eq('id', id);
        if (se_sem_dono === true) atribuir = atribuir.is('assigned_to', null);
        const { data, error } = await atribuir.select().maybeSingle();

        if (error) return jsonResponse({ error: error.message }, 400);
        if (!data) return jsonResponse({ error: 'Conversation already has an owner' }, 409);
        // Mesmo aviso da transferência pelo painel (som e "Nova conversa
        // transferida"): sem ele a pessoa só descobre a conversa olhando a lista.
        if (avisar === true) await avisarTransferencia(destino, id, data?.contact_name ?? null);
        return jsonResponse({ message: 'Conversation assigned', conversation: data });
      }

      case 'release': {
        // Liberar devolve a conversa para a fila do time: também tira de Com a IA
        // (é o que a IA faz quando para e não tem para quem passar). Com
        // `se_sem_dono: true`, conversa que alguém já assumiu fica com essa pessoa (409).
        let liberar = supabase
          .from('conversations')
          .update({ assigned_to: null, status: 'waiting', ia_desde: null, ia_sem_resposta_desde: null })
          .eq('id', id);
        if (body.se_sem_dono === true) liberar = liberar.is('assigned_to', null);
        const { data, error } = await liberar.select().maybeSingle();

        if (error) return jsonResponse({ error: error.message }, 400);
        if (!data) return jsonResponse({ error: 'Conversation already has an owner' }, 409);
        return jsonResponse({ message: 'Conversation released', conversation: data });
      }

      case 'close': {
        const { reason } = body;
        const { data, error } = await supabase
          .from('conversations')
          .update({
            status: 'closed',
            closed_at: new Date().toISOString(),
            close_reason: reason || null
          })
          .eq('id', id)
          .select()
          .single();

        if (error) return jsonResponse({ error: error.message }, 400);
        return jsonResponse({ message: 'Conversation closed', conversation: data });
      }

      case 'messages': {
        // Sem paginação, o PostgREST cortava em max_rows (1000) EM SILÊNCIO — e
        // como a ordem é created_at ASC, o consumidor recebia as 1000 mais
        // ANTIGAS e nunca via as recentes. Conversa longa passa fácil de mil
        // mensagens, então um consumidor de sync que lê body.messages e não
        // pagina perdia as mais novas — o oposto do que um sync precisa.
        //
        // RETROCOMPATÍVEL de propósito: `messages` e `count` mantêm exatamente
        // o significado de antes (count sempre foi "linhas nesta resposta",
        // apesar do nome), o default de limit reproduz o teto que já vigorava, e
        // o default de ordem continua ASC. `limit`, `offset`, `order` e
        // `has_more` são ADITIVOS — é o has_more que permite ao consumidor saber
        // que não recebeu tudo.
        //
        // `order=desc` existe porque paginar em ASC não serve a um SYNC: para
        // chegar às mensagens novas de uma conversa de 10.564, o consumidor
        // teria de puxar 21 páginas — e o runtime das Edge Functions barra em
        // ~30 chamadas de saída por invocação. Pedindo DESC, a primeira página
        // já traz as mais recentes, que é exatamente o que um sync precisa.
        const { limit, offset } = clampPage(url, POSTGREST_MAX_ROWS);
        const ascending = (url.searchParams.get('order') || 'asc').toLowerCase() !== 'desc';

        const { data, error } = await supabase
          .from('messages')
          .select('*')
          .eq('conversation_id', id)
          .order('created_at', { ascending })
          // Desempate: mensagens importadas em lote dividem o mesmo created_at
          // e sem ele as páginas se sobrepõem ou pulam linhas.
          .order('id', { ascending })
          .range(offset, offset + limit - 1);

        if (error) return jsonResponse({ error: error.message }, 400);
        return jsonResponse({
          messages: data,
          count: data.length,
          limit,
          offset,
          order: ascending ? 'asc' : 'desc',
          has_more: data.length === limit,
        });
      }

      case 'tags': {
        if (method === 'GET') {
          const { data, error } = await supabase
            .from('conversation_tags')
            .select('*, tag:tags(*)')
            .eq('conversation_id', id);

          if (error) return jsonResponse({ error: error.message }, 400);
          return jsonResponse({ tags: data.map((ct: any) => ct.tag) });
        }

        if (method === 'POST') {
          const { tag_id } = body;
          if (!tag_id) return jsonResponse({ error: 'tag_id is required' }, 400);

          // Verify tag belongs to organization
          const { data: tagCheck } = await supabase
            .from('tags')
            .select('id')
            .eq('id', tag_id)
            .eq('organization_id', organizationId)
            .single();

          if (!tagCheck) {
            return jsonResponse({ error: 'Tag not found in organization' }, 404);
          }

          const { data, error } = await supabase
            .from('conversation_tags')
            .insert({ conversation_id: id, tag_id })
            .select()
            .single();

          if (error) return jsonResponse({ error: error.message }, 400);
          return jsonResponse({ message: 'Tag added', data });
        }

        if (method === 'DELETE') {
          const tagId = url.searchParams.get('tag_id');
          if (!tagId) return jsonResponse({ error: 'tag_id query param is required' }, 400);

          // Verify tag belongs to organization
          const { data: tagCheck } = await supabase
            .from('tags')
            .select('id')
            .eq('id', tagId)
            .eq('organization_id', organizationId)
            .single();

          if (!tagCheck) {
            return jsonResponse({ error: 'Tag not found in organization' }, 404);
          }

          const { error } = await supabase
            .from('conversation_tags')
            .delete()
            .eq('conversation_id', id)
            .eq('tag_id', tagId);

          if (error) return jsonResponse({ error: error.message }, 400);
          return jsonResponse({ message: 'Tag removed' });
        }
        return jsonResponse({ error: 'Method not allowed on /tags' }, 405);
      }

      // Shared custody endpoints (co-owners)
      case 'co-owners': {
        if (method === 'GET') {
          const { data, error } = await supabase
            .from('conversation_assignees')
            .select('user_id, added_by, added_at, role, user:profiles!conversation_assignees_user_id_fkey(id, first_name, last_name, full_name, email)')
            .eq('conversation_id', id)
            .order('added_at', { ascending: true });

          if (error) return jsonResponse({ error: error.message }, 400);
          return jsonResponse({ co_owners: data, count: data?.length ?? 0 });
        }

        if (method === 'POST') {
          const { user_id } = body;
          if (!user_id) return jsonResponse({ error: 'user_id is required' }, 400);

          // Verify target user belongs to this organization
          const { data: userCheck } = await supabase
            .from('organization_members')
            .select('id')
            .eq('user_id', user_id)
            .eq('organization_id', organizationId)
            .single();

          if (!userCheck) {
            return jsonResponse({ error: 'User not found in organization' }, 404);
          }

          // Verify target user is not already the primary assignee
          const { data: convCheck } = await supabase
            .from('conversations')
            .select('assigned_to')
            .eq('id', id)
            .single();

          if (convCheck?.assigned_to === user_id) {
            return jsonResponse({ error: 'User is already the primary assignee' }, 409);
          }

          const { data, error } = await supabase
            .from('conversation_assignees')
            .insert({ conversation_id: id, user_id })
            .select()
            .single();

          if (error) return jsonResponse({ error: error.message }, 400);
          return jsonResponse({ message: 'Co-owner added', co_owner: data }, 201);
        }

        if (method === 'DELETE') {
          const userId = url.searchParams.get('user_id');
          if (!userId) return jsonResponse({ error: 'user_id query param is required' }, 400);

          const { error } = await supabase
            .from('conversation_assignees')
            .delete()
            .eq('conversation_id', id)
            .eq('user_id', userId);

          if (error) return jsonResponse({ error: error.message }, 400);
          return jsonResponse({ message: 'Co-owner removed' });
        }

        return jsonResponse({ error: 'Method not allowed on /co-owners' }, 405);
      }

      case 'invite-link': {
        if (method !== 'GET') {
          return jsonResponse({ error: 'Method not allowed on /invite-link' }, 405);
        }

        const { data: conv, error: convError } = await supabase
          .from('conversations')
          .select('is_group, group_jid, phone_number_id')
          .eq('id', id)
          .single();

        if (convError || !conv) {
          return jsonResponse({ error: 'Conversation not found' }, 404);
        }

        if (!conv.is_group || !conv.group_jid) {
          return jsonResponse({ error: 'Conversation is not a group' }, 400);
        }

        const { data: phoneData } = await supabase
          .from('phone_numbers')
          .select('connection_type')
          .eq('id', conv.phone_number_id)
          .eq('organization_id', organizationId)
          .single();

        if (!phoneData) {
          return jsonResponse({ error: 'Phone number not found in organization' }, 404);
        }

        if (phoneData.connection_type !== 'qr') {
          return jsonResponse({
            error: 'Group invite links are only available for QR (Baileys) connections'
          }, 400);
        }

        const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
        if (!qrServiceUrl) {
          return jsonResponse({ error: 'QR_SERVICE_URL not configured. Please add it to Edge Function secrets.' }, 500);
        }

        let qrResponse: Response;
        try {
          qrResponse = await fetch(
            `${qrServiceUrl}/groups/${conv.phone_number_id}/${encodeURIComponent(conv.group_jid)}/invite-code`,
            { headers: qrAuthHeaders() }
          );
        } catch (fetchErr: any) {
          console.error('[InviteLink] QR service unreachable:', fetchErr?.message || String(fetchErr));
          return jsonResponse({ error: `QR service unreachable: ${fetchErr?.message || 'Network error'}` }, 502);
        }

        const qrData = await qrResponse.json().catch(() => ({}));

        if (!qrResponse.ok || !qrData.success) {
          // Typical failures: session disconnected or session is not a group admin
          console.error('[InviteLink] QR service error:', qrData);
          return jsonResponse({ error: qrData.error || 'Failed to fetch group invite link' }, 400);
        }

        return jsonResponse({ invite_code: qrData.code, invite_url: qrData.inviteUrl });
      }

      default:
        return jsonResponse({ error: 'Unknown action' }, 404);
    }
  }

  // GET single conversation
  if (id && method === 'GET') {
    const { data, error } = await supabase
      .from('conversations')
      .select('*, phone_number:phone_numbers!inner(*), assigned_user:profiles!conversations_assigned_to_fkey(*)')
      .eq('id', id)
      .eq('phone_number.organization_id', organizationId)
      .single();

    if (error) return jsonResponse({ error: 'Conversation not found' }, 404);

    // Fetch tags for this conversation
    const { data: tagsData } = await supabase
      .from('conversation_tags')
      .select('tag:tags(*)')
      .eq('conversation_id', id);

    const tags = tagsData?.map((ct: any) => ct.tag) || [];

    return jsonResponse({ conversation: { ...data, tags } });
  }

  // PATCH update conversation
  if (id && method === 'PATCH') {
    // Verify conversation belongs to organization
    const hasAccess = await verifyConversationOrg(supabase, id, organizationId);
    if (!hasAccess) {
      return jsonResponse({ error: 'Conversation not found' }, 404);
    }

    const body = await req.json();
    const allowedFields = ['contact_name', 'assigned_to', 'status', 'close_reason'];
    const updates: any = {};

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    // Verify assigned_to user belongs to organization (if being updated)
    if (updates.assigned_to) {
      const { data: userCheck } = await supabase
        .from('organization_members')
        .select('id')
        .eq('user_id', updates.assigned_to)
        .eq('organization_id', organizationId)
        .single();

      if (!userCheck) {
        return jsonResponse({ error: 'User not found in organization' }, 404);
      }
    }

    const { data, error } = await supabase
      .from('conversations')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ conversation: data });
  }

  // GET list conversations
  if (method === 'GET') {
    // Filter conversations by organization (via phone_numbers)
    let query = supabase
      .from('conversations')
      .select('*, phone_number:phone_numbers!inner(*), assigned_user:profiles!conversations_assigned_to_fkey(*)')
      .eq('phone_number.organization_id', organizationId);

    // Filters
    const status = url.searchParams.get('status');
    const phoneNumberId = url.searchParams.get('phone_number_id');
    const assignedTo = url.searchParams.get('assigned_to');
    const coOwner = url.searchParams.get('co_owner');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');

    if (status) query = query.eq('status', status);
    if (phoneNumberId) query = query.eq('phone_number_id', phoneNumberId);
    // Conversa só do Direct do Instagram guarda 'ig:<id>' em contact_phone, que
    // não é telefone: fica fora da lista, salvo quem pedir channel=instagram.
    // O campo `channel` vem em cada conversa (whatsapp | instagram).
    query = query.eq('channel', url.searchParams.get('channel') === 'instagram' ? 'instagram' : 'whatsapp');
    if (assignedTo === 'null') {
      query = query.is('assigned_to', null);
    } else if (assignedTo) {
      query = query.eq('assigned_to', assignedTo);
    }

    // Shared custody: filter by conversations where a specific user is a co-owner.
    // We use a subquery via .in() because PostgREST doesn't support direct joins
    // in filters. First fetch conversation_ids the user co-owns, then filter.
    if (coOwner) {
      const { data: coOwnedIds } = await supabase
        .from('conversation_assignees')
        .select('conversation_id')
        .eq('user_id', coOwner);

      const ids = (coOwnedIds || []).map((r: { conversation_id: string }) => r.conversation_id);
      if (ids.length === 0) {
        // No co-owned conversations — short-circuit with empty result
        return jsonResponse({ conversations: [], count: 0, offset, limit });
      }
      query = query.in('id', ids);
    }

    query = query.order('last_message_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) return jsonResponse({ error: error.message }, 400);

    // Fetch tags for all conversations, EM BLOCOS: os ids viajam no `.in()`
    // dentro da URL, e um UUID custa ~39 bytes ali. Com limit alto (o cliente
    // pode pedir até 1000) isso passava dos ~30KB que o gateway aceita e a
    // resposta virava 400 — a mesma armadilha que import-history/index.ts:158
    // documenta e contorna com POST.
    const conversationIds = data.map((c: any) => c.id);
    const allTags: any[] = [];
    for (let i = 0; i < conversationIds.length; i += MAX_IN_IDS) {
      const { data: page } = await supabase
        .from('conversation_tags')
        .select('conversation_id, tag:tags(*)')
        .in('conversation_id', conversationIds.slice(i, i + MAX_IN_IDS));
      if (page) allTags.push(...page);
    }

    // Group tags by conversation_id
    const tagsByConversation: Record<string, any[]> = {};
    allTags.forEach((ct: any) => {
      if (!tagsByConversation[ct.conversation_id]) {
        tagsByConversation[ct.conversation_id] = [];
      }
      tagsByConversation[ct.conversation_id].push(ct.tag);
    });

    // Add tags to each conversation
    const conversationsWithTags = data.map((c: any) => ({
      ...c,
      tags: tagsByConversation[c.id] || []
    }));

    return jsonResponse({ conversations: conversationsWithTags, count: data.length, offset, limit });
  }

  // POST create conversation
  if (method === 'POST') {
    const body = await req.json();
    const { contact_phone, contact_name, phone_number_id, assigned_to } = body;

    if (!contact_phone || !phone_number_id) {
      return jsonResponse({ error: 'contact_phone and phone_number_id are required' }, 400);
    }

    // Verify phone_number_id belongs to organization
    const { data: phoneCheck } = await supabase
      .from('phone_numbers')
      .select('id')
      .eq('id', phone_number_id)
      .eq('organization_id', organizationId)
      .single();

    if (!phoneCheck) {
      return jsonResponse({ error: 'Phone number not found in organization' }, 404);
    }

    // Verify assigned_to user belongs to organization (if provided)
    if (assigned_to) {
      const { data: userCheck } = await supabase
        .from('organization_members')
        .select('id')
        .eq('user_id', assigned_to)
        .eq('organization_id', organizationId)
        .single();

      if (!userCheck) {
        return jsonResponse({ error: 'User not found in organization' }, 404);
      }
    }

    // Mesma armadilha do findOrCreateConversation: cleanPhoneForStorage faz
    // replace(/\D/g,'') e comeria o "@g.us". Para grupo o JID É a identidade, e
    // is_group precisa ir no insert senão o trigger normaliza o campo.
    const isGroup = String(contact_phone).endsWith(GROUP_JID_SUFFIX);
    const cleanedPhone = isGroup ? String(contact_phone) : cleanPhoneForStorage(contact_phone);

    const { data, error } = await supabase
      .from('conversations')
      .insert({
        contact_phone: cleanedPhone,
        contact_name:
          contact_name || (isGroup ? cleanedPhone.replace(GROUP_JID_SUFFIX, '') : cleanedPhone),
        phone_number_id,
        assigned_to,
        whatsapp_id: isGroup
          ? `qr_group_${phone_number_id}_${cleanedPhone}`
          : `${cleanedPhone}_${phone_number_id}`,
        status: assigned_to ? 'active' : 'waiting',
        ...(isGroup ? { is_group: true, group_jid: cleanedPhone } : {})
      })
      .select()
      .single();

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ conversation: data }, 201);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

// ============ MESSAGES ============
async function handleMessages(
  req: Request,
  supabase: any,
  id: string,
  url: URL,
  organizationId: string
) {
  const method = req.method;

  if (method === 'GET') {
    const conversationId = url.searchParams.get('conversation_id');
    if (!conversationId) {
      return jsonResponse({ error: 'conversation_id is required' }, 400);
    }

    // Este endpoint já paginava, mas sem guarda: `?limit=abc` virava NaN e
    // chegava como .range(NaN, NaN), e limit acima de 1000 era cortado em
    // silêncio pelo max_rows com o cliente achando que recebeu tudo.
    const { limit, offset } = clampPage(url, 100);

    const { data, error } = await supabase
      .from('messages')
      .select('*, conversation:conversations!inner(phone_number:phone_numbers!inner(organization_id))')
      .eq('conversation_id', conversationId)
      .eq('conversation.phone_number.organization_id', organizationId)
      .order('created_at', { ascending: true })
      // Desempate: sem ele, páginas se sobrepõem nas conversas com mensagens
      // importadas no mesmo created_at.
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ messages: data, count: data.length, limit, offset, has_more: data.length === limit });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

// Helper to check if string is valid UUID
const isUUID = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

/** Conversas por aviso de leitura de um sistema externo: é a conversa que a pessoa abriu lá, não um lote. */
const MAX_LEITURAS_DO_CRM = 50;

/**
 * Leitura feita num sistema externo (CRM): alguém abriu a conversa lá, então ela
 * fica lida AQUI para essa mesma pessoa, como se tivesse aberto no painel. A
 * leitura do Echo é por pessoa (conversation_reads); a pessoa é achada pelo
 * e-mail, dentro da organização da chave.
 *
 * Mesma regra de `mark_conversations_read`: só entram conversas das linhas que
 * ela enxerga (admin da organização = todas; atendente = as dela), a marca
 * d'água avança e a marca "não lida" manual some. Como lá, o setor não entra:
 * a gravação é só a leitura da própria pessoa.
 *
 * Não avisa o CRM de volta (conversation-webhook): quem avisou foi ele.
 */
async function handleMarkReadFromCrm(req: Request, supabase: any, organizationId: string) {
  const body = await req.json().catch(() => ({}));
  const email = String(body?.user_email ?? '').trim().toLowerCase();
  const ids: string[] = Array.isArray(body?.conversation_ids)
    ? [...new Set((body.conversation_ids as unknown[]).filter((x): x is string => typeof x === 'string' && isUUID(x)))]
        .slice(0, MAX_LEITURAS_DO_CRM)
    : [];
  if (!email || ids.length === 0) {
    return jsonResponse({ error: 'user_email and conversation_ids are required' }, 400);
  }

  // ilike sem curinga: "_" é comum em e-mail e casaria qualquer caractere.
  const { data: perfis, error: perfisErr } = await supabase
    .from('profiles')
    .select('id')
    .ilike('email', email.replace(/[\\%_]/g, (c) => `\\${c}`))
    .limit(5);
  if (perfisErr) return jsonResponse({ error: perfisErr.message }, 500);
  const perfilIds = (perfis ?? []).map((p: { id: string }) => p.id);
  if (perfilIds.length === 0) return jsonResponse({ marked: 0, user_found: false });

  const { data: membros, error: membrosErr } = await supabase
    .from('organization_members')
    .select('user_id, role')
    .eq('organization_id', organizationId)
    .in('user_id', perfilIds)
    .limit(1);
  if (membrosErr) return jsonResponse({ error: membrosErr.message }, 500);
  const membro = membros?.[0] as { user_id: string; role: string } | undefined;
  if (!membro) return jsonResponse({ marked: 0, user_found: false });

  const { data: linhasDaOrg, error: linhasErr } = await supabase
    .from('phone_numbers')
    .select('id')
    .eq('organization_id', organizationId);
  if (linhasErr) return jsonResponse({ error: linhasErr.message }, 500);
  let linhas = (linhasDaOrg ?? []).map((l: { id: string }) => l.id);
  if (membro.role !== 'admin') {
    const { data: minhas, error: minhasErr } = await supabase
      .from('user_phone_numbers')
      .select('phone_number_id')
      .eq('user_id', membro.user_id);
    if (minhasErr) return jsonResponse({ error: minhasErr.message }, 500);
    const permitidas = new Set((minhas ?? []).map((m: { phone_number_id: string }) => m.phone_number_id));
    linhas = linhas.filter((id: string) => permitidas.has(id));
  }
  if (linhas.length === 0) return jsonResponse({ marked: 0, user_found: true });

  const { data: conversas, error: convErr } = await supabase
    .from('conversations')
    .select('id')
    .in('id', ids)
    .in('phone_number_id', linhas);
  if (convErr) return jsonResponse({ error: convErr.message }, 500);
  if (!conversas || conversas.length === 0) return jsonResponse({ marked: 0, user_found: true });

  const agora = new Date().toISOString();
  const { error: upErr } = await supabase
    .from('conversation_reads')
    .upsert(
      conversas.map((c: { id: string }) => ({
        user_id: membro.user_id,
        conversation_id: c.id,
        last_read_at: agora,
        marked_unread_at: null,
      })),
      { onConflict: 'user_id,conversation_id' },
    );
  if (upErr) return jsonResponse({ error: upErr.message }, 500);
  return jsonResponse({ marked: conversas.length, user_found: true });
}

// Helper to verify conversation belongs to organization
async function verifyConversationOrg(supabase: any, conversationId: string, organizationId: string): Promise<boolean> {
  const { data } = await supabase
    .from('conversations')
    .select('id, phone_number:phone_numbers!inner(organization_id)')
    .eq('id', conversationId)
    .eq('phone_number.organization_id', organizationId)
    .single();
  return !!data;
}

// Direct do Instagram (ver _shared/canal.ts): conversa channel = 'instagram'
// guarda 'ig:<id>' em contact_phone. Todo envio desta API sai por QR/Cloud API,
// que tratariam o id do Instagram como telefone — então recusa antes de tudo.
const DIRECT_ERROR = 'Conversa do Instagram Direct: use o painel do Echo';

function directRejection(route: string, ref: unknown): Response {
  console.warn(`[${route}] Refusing Instagram Direct target: ${String(ref)}`);
  return jsonResponse({ error: DIRECT_ERROR }, 400);
}

async function rejectIfDirect(
  supabase: ReturnType<typeof createClient>,
  route: string,
  to: unknown,
  conversationId?: unknown,
): Promise<Response | null> {
  if (typeof to === 'string' && to.trim().toLowerCase().startsWith('ig:')) {
    return directRejection(route, to);
  }
  // id que não é uuid cai no 404 do verifyConversationOrg logo depois.
  if (typeof conversationId !== 'string' || !isUUID(conversationId)) return null;
  const { data, error } = await supabase
    .from('conversations')
    .select('channel')
    .eq('id', conversationId)
    .maybeSingle<{ channel: string | null }>();
  if (error) {
    console.error(`[${route}] Failed to check conversation channel:`, error);
    return jsonResponse({ error: 'Failed to validate conversation' }, 500);
  }
  return data?.channel === 'instagram' ? directRejection(route, conversationId) : null;
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

// A leading "+" in the caller's input is the international flag: when present
// we trust the digits as a complete E.164 number and never prepend "55". This
// is what keeps Spanish 11-digit mobiles ("+34" + 9 digits) from being mangled
// into "55" + their full number.
//
// Without "+", a 10–11 digit value is assumed Brazilian without country code
// and gets "55" prepended for storage, with all the usual 9-digit variations
// emitted for lookup.
function normalizePhoneNumber(phone: string | number): { normalized: string; variations: string[] } {
  if (!phone) return { normalized: '', variations: [] };

  const phoneStr = String(phone).trim();
  const hasIntlPrefix = phoneStr.startsWith('+');
  const digits = phoneStr.replace(/\D/g, '');

  if (hasIntlPrefix) {
    return { normalized: digits, variations: [digits] };
  }

  const variations: string[] = [];

  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const countryCode = '55';
    const ddd = digits.substring(2, 4);
    const localNumber = digits.substring(4);

    if (digits.length === 13 && localNumber.startsWith('9')) {
      const without9 = countryCode + ddd + localNumber.substring(1);
      variations.push(digits, without9);
    } else if (digits.length === 12) {
      const with9 = countryCode + ddd + '9' + localNumber;
      variations.push(digits, with9);
    }
  } else if (digits.length >= 10 && digits.length <= 11) {
    const withCountry = '55' + digits;
    const ddd = digits.substring(0, 2);
    const localNumber = digits.substring(2);

    if (digits.length === 11 && localNumber.startsWith('9')) {
      const without9 = '55' + ddd + localNumber.substring(1);
      variations.push(withCountry, digits, without9, ddd + localNumber.substring(1));
    } else if (digits.length === 10) {
      const with9 = '55' + ddd + '9' + localNumber;
      variations.push(with9, digits, withCountry, ddd + '9' + localNumber);
    } else {
      variations.push(withCountry, digits);
    }
  }

  if (variations.length === 0) {
    variations.push(digits);
  }

  const uniqueVariations = [...new Set(variations)];

  console.log(`Phone normalization: ${phone} -> variations: ${uniqueVariations.join(', ')}`);

  return { normalized: uniqueVariations[0], variations: uniqueVariations };
}

// Clean phone for storage - only remove non-numeric characters
// User is responsible for entering complete number with country code
function cleanPhoneForStorage(phone: string | number): string {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '');
}

/**
 * Conversa de grupo, espelhando o que o whatsapp-webhook faz: lookup por
 * group_jid + phone_number_id, e insert com is_group/group_jid preenchidos.
 * Assim os dois lados convergem no MESMO registro em vez de criarem um cada.
 *
 * `is_group: true` no insert não é decoração — o trigger
 * `trg_normalize_conversation_phone` só preserva o contact_phone quando a flag
 * está ligada (`IF NEW.is_group = false THEN ... normalize_phone(...)`). Sem
 * ela o JID perde o "@g.us" e a conversa nasce órfã da thread real do grupo.
 */
async function findOrCreateGroupConversation(
  supabase: any,
  groupJid: string,
  phoneNumberDbId: string,
  assignedTo?: string
): Promise<{ id: string; isNew: boolean } | null> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('group_jid', groupJid)
    .eq('phone_number_id', phoneNumberDbId)
    .limit(1)
    .maybeSingle();

  if (existing) {
    console.log(`Found existing group conversation ${existing.id} for ${groupJid}`);
    return { id: existing.id, isNew: false };
  }

  const { data: newConv, error } = await supabase
    .from('conversations')
    .insert({
      contact_phone: groupJid,
      // O assunto real do grupo chega pelo webhook, que faz o update depois.
      // Até lá, o mesmo fallback que ele usa.
      contact_name: groupJid.replace(GROUP_JID_SUFFIX, ''),
      phone_number_id: phoneNumberDbId,
      whatsapp_id: `qr_group_${phoneNumberDbId}_${groupJid}`,
      is_group: true,
      group_jid: groupJid,
      assigned_to: assignedTo || null,
      status: assignedTo ? 'active' : 'waiting'
    })
    .select('id')
    .single();

  if (error) {
    console.error('Error creating group conversation:', error);
    return null;
  }

  console.log(`Created group conversation ${newConv.id} for ${groupJid}`);
  return { id: newConv.id, isNew: true };
}

/**
 * POST /groups: grupo vazio numa linha QR + link de convite (regra e passos em ./grupos.ts).
 * O qr-service, ao criar, também avisa o webhook (`group_joined`), que cria a mesma conversa: se as duas
 * inserções correrem juntas, a nossa perde no índice único e a conversa é relida.
 */
async function handleGroups(req: Request, supabase: any, id: string, organizationId: string) {
  if (req.method !== 'POST' || (id && id !== 'handover' && id !== 'add-line')) {
    return jsonResponse({ error: 'Method not allowed', allowed: ['POST /groups', 'POST /groups/handover', 'POST /groups/add-line'] }, 405);
  }
  const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
  if (!qrServiceUrl) {
    return jsonResponse({ error: 'QR_SERVICE_URL not configured. Please add it to Edge Function secrets.' }, 500);
  }
  const corpo = await req.json().catch(() => null);
  if (id === 'handover' || id === 'add-line') {
    // POST /groups/handover: passa o grupo de uma linha para outra (regra e passos em ./passar-grupo.ts).
    // POST /groups/add-line: a outra entra pelo link e vira admin, e ninguém sai (mesmos passos, sem a saída).
    const passou = await passarGrupo(corpo, organizationId, {
      async buscarLinha(idOuMeta) {
        const coluna = isUUID(idOuMeta) ? 'id' : 'phone_number_id';
        const { data } = await supabase
          .from('phone_numbers')
          .select('id, organization_id, connection_type, phone_number, display_name')
          .eq(coluna, idOuMeta)
          .eq('organization_id', organizationId)
          .maybeSingle();
        return data ?? null;
      },
      qr(path, init = {}) {
        const headers = qrAuthHeaders(Object.fromEntries(new Headers(init.headers).entries()));
        return fetch(`${qrServiceUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
      },
      async conversaDoGrupo(groupJid, linhaId) {
        const achada = await findOrCreateGroupConversation(supabase, groupJid, linhaId);
        if (achada) return achada.id;
        const { data } = await supabase
          .from('conversations')
          .select('id')
          .eq('group_jid', groupJid)
          .eq('phone_number_id', linhaId)
          .limit(1)
          .maybeSingle();
        return data?.id ?? null;
      },
      async conversaExistente(groupJid, linhaId) {
        const { data } = await supabase
          .from('conversations')
          .select('id')
          .eq('is_group', true)
          .or(`group_jid.eq."${groupJid}",contact_phone.eq."${groupJid}"`)
          .eq('phone_number_id', linhaId)
          .order('last_message_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        return data?.id ?? null;
      },
      esperar: (ms) => new Promise((r) => setTimeout(r, ms)),
      agora: () => Date.now(),
    }, id === 'add-line' ? 'entrar' : 'passar');
    return jsonResponse(passou.body, passou.status);
  }
  const resposta = await criarGrupo(corpo, organizationId, {
    async buscarLinha(idOuMeta) {
      const coluna = isUUID(idOuMeta) ? 'id' : 'phone_number_id';
      const { data } = await supabase
        .from('phone_numbers')
        .select('id, organization_id, connection_type')
        .eq(coluna, idOuMeta)
        .eq('organization_id', organizationId)
        .maybeSingle();
      return data ?? null;
    },
    qr(path, init = {}) {
      const headers = qrAuthHeaders(Object.fromEntries(new Headers(init.headers).entries()));
      // Criar tem 30 s; descrição, foto e link, 15 s cada: no pior caso 75 s, abaixo da espera de quem chama.
      const prazo = path.endsWith('/create') ? 30_000 : 15_000;
      return fetch(`${qrServiceUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(prazo) });
    },
    async conversaDoGrupo(groupJid, linhaId) {
      const achada = await findOrCreateGroupConversation(supabase, groupJid, linhaId);
      if (achada) return achada.id;
      const { data } = await supabase
        .from('conversations')
        .select('id')
        .eq('group_jid', groupJid)
        .eq('phone_number_id', linhaId)
        .limit(1)
        .maybeSingle();
      return data?.id ?? null;
    },
  });
  return jsonResponse(resposta.body, resposta.status);
}

// Helper to find or create conversation
async function findOrCreateConversation(
  supabase: any,
  contactPhone: string,
  phoneNumberDbId: string,
  assignedTo?: string
): Promise<{ id: string; isNew: boolean } | null> {
  // Integrador mandando "to" como número JSON (sem aspas) chegava aqui como
  // number e o .endsWith estourava em TypeError 500 — nos cinco endpoints.
  contactPhone = String(contactPhone ?? '');
  // Grupo é identificado pelo JID, não por telefone. normalizePhoneNumber faz
  // replace(/\D/g,'') e comeria o "@g.us", deixando o registro sem casar com o
  // do webhook — era assim que todo envio para grupo pela API pública ia parar
  // numa conversa fantasma.
  if (contactPhone.endsWith(GROUP_JID_SUFFIX)) {
    return findOrCreateGroupConversation(supabase, contactPhone, phoneNumberDbId, assignedTo);
  }

  const { normalized, variations } = normalizePhoneNumber(contactPhone);

  // Try to find existing conversation with any phone variation
  const { data: existing } = await supabase
    .from('conversations')
    .select('id, contact_phone')
    .in('contact_phone', variations)
    .eq('phone_number_id', phoneNumberDbId)
    .limit(1)
    .maybeSingle();

  if (existing) {
    console.log(`Found existing conversation ${existing.id} for phone ${existing.contact_phone}`);
    return { id: existing.id, isNew: false };
  }

  // Create new conversation with normalized phone
  const { data: newConv, error } = await supabase
    .from('conversations')
    .insert({
      contact_phone: normalized,
      contact_name: normalized,
      phone_number_id: phoneNumberDbId,
      whatsapp_id: `${normalized}_${phoneNumberDbId}`,
      assigned_to: assignedTo || null,
      status: assignedTo ? 'active' : 'waiting'
    })
    .select('id')
    .single();

  if (error) {
    console.error('Error creating conversation:', error);
    return null;
  }

  console.log(`Created new conversation ${newConv.id} for phone ${normalized}`);
  return { id: newConv.id, isNew: true };
}

// ============ TYPING (chat state) ============
// Sinal efêmero: não grava mensagem, não cria conversa, não emite webhook.
const CHAT_STATES = ['composing', 'recording', 'paused'] as const;
type ChatState = (typeof CHAT_STATES)[number];

// O WhatsApp expira o chatstate sozinho em ~10s.
const CHAT_STATE_TTL_SECONDS = 10;
const MAX_TYPING_MS = CHAT_STATE_TTL_SECONDS * 1000;

async function postChatState(
  dbId: string,
  to: string,
  state: ChatState
): Promise<{ ok: boolean; error?: string; unreachable?: boolean; notConfigured?: boolean }> {
  const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
  if (!qrServiceUrl) {
    return { ok: false, notConfigured: true, error: 'QR_SERVICE_URL not configured. Please add it to Edge Function secrets.' };
  }

  try {
    const res = await fetch(`${qrServiceUrl}/message/presence/${dbId}`, {
      method: 'POST',
      headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ to, state }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      return { ok: false, error: data.error || `qr-service responded ${res.status}` };
    }
    return { ok: true };
  } catch (fetchErr: any) {
    return { ok: false, unreachable: true, error: fetchErr?.message || 'Network error' };
  }
}

async function handleTyping(req: Request, supabase: any, organizationId: string) {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const { to, phone_number_id, state = 'composing' } = await req.json().catch(() => ({}));

  if (!to || !phone_number_id) {
    return jsonResponse({
      error: 'Missing required fields',
      required: ['to', 'phone_number_id'],
      optional: ['state'],
      note: 'state defaults to "composing". phone_number_id can be either database UUID or Meta WhatsApp phone number ID'
    }, 400);
  }

  if (!CHAT_STATES.includes(state)) {
    return jsonResponse({
      error: 'Invalid state',
      allowed: [...CHAT_STATES],
      note: '"composing" shows typing, "recording" shows recording audio, "paused" clears it early'
    }, 400);
  }

  const direct = await rejectIfDirect(supabase, 'Typing', to);
  if (direct) return direct;

  const phoneNumber = await resolvePhoneNumberId(supabase, phone_number_id);
  if (!phoneNumber) {
    return jsonResponse({
      error: 'Phone number not found',
      message: 'The provided phone_number_id does not exist in the database'
    }, 404);
  }

  const { data: phoneData } = await supabase
    .from('phone_numbers')
    .select(`
      id,
      connection_type,
      organization:organizations (
        whatsapp_access_token
      )
    `)
    .eq('id', phoneNumber.dbId)
    .eq('organization_id', organizationId)
    .single();

  if (!phoneData) {
    return jsonResponse({ error: 'Phone number not found in organization' }, 404);
  }

  if (phoneData.connection_type === 'qr') {
    const result = await postChatState(phoneNumber.dbId, to, state);

    if (result.notConfigured) return jsonResponse({ error: result.error }, 500);
    if (result.unreachable) return jsonResponse({ error: `QR service unreachable: ${result.error}` }, 502);

    // Sessão fora do ar devolve 200 com success:false de propósito. "Digitando" é
    // cosmético — um bot não deve abortar o fluxo por causa dele, e vai descobrir
    // o problema de verdade no /send-message seguinte, que reporta erro. O `reason`
    // deixa a falha legível por máquina em vez de silenciosa.
    if (!result.ok) {
      return jsonResponse({ success: false, reason: 'session_unavailable', error: result.error });
    }

    return jsonResponse({
      success: true,
      state,
      expires_in_seconds: CHAT_STATE_TTL_SECONDS,
      note: state === 'paused'
        ? undefined
        : `Expires automatically. Call again every ~8s to keep it, or send state="paused" to clear it early.`
    });
  }

  // Cloud API (Meta WhatsApp Business API)
  if (state === 'paused') {
    return jsonResponse({
      success: true,
      state: 'paused',
      note: 'Cloud API does not support explicit pause (typing indicator expires automatically).'
    });
  }

  const orgData = Array.isArray(phoneData.organization) ? phoneData.organization[0] : phoneData.organization;
  const accessToken = orgData?.whatsapp_access_token;
  if (!accessToken || !phoneNumber.metaId) {
    return jsonResponse({ error: 'WhatsApp credentials not configured for this organization' }, 500);
  }

  const { variations } = normalizePhoneNumber(to);
  const { data: existingConv } = await supabase
    .from('conversations')
    .select('id')
    .in('contact_phone', variations)
    .eq('phone_number_id', phoneNumber.dbId)
    .limit(1)
    .maybeSingle();

  if (!existingConv) {
    return jsonResponse({
      success: false,
      reason: 'no_inbound_message',
      message: 'Typing indicator on Cloud API requires at least one previous inbound message from the contact'
    });
  }

  const inboundWamid = await getLatestInboundWamid(supabase, existingConv.id);
  if (!inboundWamid) {
    return jsonResponse({
      success: false,
      reason: 'no_inbound_message',
      message: 'Typing indicator on Cloud API requires at least one previous inbound message from the contact'
    });
  }

  const result = await sendMetaTypingIndicator({
    accessToken,
    metaPhoneNumberId: phoneNumber.metaId,
    inboundMessageId: inboundWamid,
  });

  if (!result.success) {
    return jsonResponse({
      success: false,
      reason: 'meta_api_error',
      error: result.error
    });
  }

  return jsonResponse({
    success: true,
    state: 'composing',
    expires_in_seconds: 25,
    note: 'Cloud API typing indicator active for up to 25s or until next message is sent.'
  });
}


// ============ SEND MESSAGE ============
// ============ RESPOSTA CITADA (reply_to) ============
// O integrador tem DOIS ids em mãos: o uuid interno (que /messages devolve) e o
// wamid (que toda resposta de envio devolve em whatsapp_message_id). Aceitar os
// dois evita obrigar o CRM a guardar um id novo só para citar.
type QuotedContext = {
  quotedLocalId: string;
  quotedWhatsappId: string;
  quotedContent: string | null;
  quotedFromMe: boolean;
  quotedParticipant: string | null;
};

/**
 * Resolve reply_to (uuid do Echo OU wamid) no contexto que o qr-service e a
 * Cloud API precisam. Espelha scheduled-message-execute.
 *
 * O filtro por conversation_id não é conveniência: sessão espelhada grava a
 * MESMA wamid em duas conversas, e sem ele a citação sairia apontando para a
 * mensagem da outra linha.
 */
async function resolveQuoted(
  supabase: any,
  replyTo: string,
  convId: string
): Promise<{ quoted: QuotedContext } | { failure: Record<string, unknown> }> {
  const ref = String(replyTo).trim();
  if (!ref) {
    return { failure: { error: 'reply_to is empty', note: 'Send the message uuid or its whatsapp_message_id, or omit the field.' } };
  }

  const column = isUUID(ref) ? 'id' : 'whatsapp_message_id';
  const { data: row } = await supabase
    .from('messages')
    .select('id, whatsapp_message_id, content, direction, sender_phone')
    .eq(column, ref)
    .eq('conversation_id', convId)
    .maybeSingle();

  if (!row) {
    return {
      failure: {
        error: 'reply_to does not belong to this conversation',
        note: 'A reply can only quote a message from the same conversation. Accepts the message uuid or its whatsapp_message_id.',
      },
    };
  }

  if (!row.whatsapp_message_id) {
    return {
      failure: {
        error: 'reply_to message has no WhatsApp id',
        note: 'This message never reached WhatsApp (it failed or is still sending), so there is nothing to quote.',
      },
    };
  }

  return {
    quoted: {
      quotedLocalId: row.id,
      quotedWhatsappId: row.whatsapp_message_id,
      quotedContent: row.content ?? null,
      quotedFromMe: row.direction === 'outbound',
      quotedParticipant: row.sender_phone
        ? `${String(row.sender_phone).replace(/\D/g, '')}@s.whatsapp.net`
        : null,
    },
  };
}

// ============ MENÇÃO (mentions) ============
/**
 * Formas do MESMO celular brasileiro com e sem o nono dígito.
 *
 * O WhatsApp guarda uns contatos como 55+DDD+9+8 dígitos e outros como
 * 55+DDD+8 — um grupo pode ter "551199990001" para um número que o CRM
 * conhece como "5511999990001". Sem tolerar as duas formas, um participante que
 * ESTÁ no grupo volta como não resolvido e a menção some.
 *
 * Isto NÃO monta JID: as variantes só servem para procurar na lista real de
 * participantes, e o JID mencionado é sempre o que o grupo devolveu. Gerar
 * número por conta própria é o erro clássico daqui — o 9 a mais (ou a menos)
 * aponta para OUTRA linha.
 */
function brPhoneVariants(digits: string): string[] {
  const variants = [digits];
  // 55 + DDD(2) + 9 + 8 dígitos = 13: existe também a forma sem o 9.
  if (digits.length === 13 && digits.startsWith('55') && digits[4] === '9') {
    variants.push(digits.slice(0, 4) + digits.slice(5));
  }
  // 55 + DDD(2) + 8 dígitos = 12: existe também a forma com o 9.
  if (digits.length === 12 && digits.startsWith('55')) {
    variants.push(`${digits.slice(0, 4)}9${digits.slice(4)}`);
  }
  return variants;
}

/**
 * Resolve números em JIDs de menção consultando os participantes do grupo.
 *
 * Montar o JID concatenando dígitos seria o caminho curto e errado: o nono
 * dígito de BR faz "5511999990001" e "551199990001" serem números DIFERENTES
 * para o WhatsApp, e participante conhecido só por @lid não tem JID de telefone
 * nenhum. Os participantes do grupo são a única fonte que sabe qual é qual.
 *
 * Também ajusta o texto: o WhatsApp só DESTACA a menção se o corpo contiver o
 * token "@<numero>" correspondente ao JID mencionado (o painel faz isso na
 * digitação). Sem isso a pessoa é notificada mas a mensagem não mostra menção
 * nenhuma — pior que não mencionar.
 */
async function resolveMentions(
  mentions: unknown[],
  groupJid: string,
  phoneDbId: string,
  text: string
): Promise<{ jids: string[]; unresolved: string[]; text: string }> {
  const entries = mentions.map((m) => String(m ?? '').trim()).filter(Boolean);
  if (entries.length === 0) return { jids: [], unresolved: [], text };

  const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
  let participants: Array<{ id: string; phone: string; jid?: string; isLid?: boolean }> = [];

  if (qrServiceUrl) {
    try {
      const res = await fetch(
        `${qrServiceUrl}/groups/${phoneDbId}/${encodeURIComponent(groupJid)}?picture=0`,
        { headers: qrAuthHeaders() }
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && Array.isArray(data.group?.participants)) {
        participants = data.group.participants;
      } else {
        console.warn('[Mentions] qr-service did not return participants:', data?.error);
      }
    } catch (fetchErr: any) {
      // Menção é o enfeite, o texto é o conteúdo: seguir sem menção e contar a
      // verdade na resposta é melhor que abortar o envio.
      console.warn('[Mentions] qr-service unreachable:', fetchErr?.message || String(fetchErr));
    }
  }

  const jids: string[] = [];
  const unresolved: string[] = [];
  let body = text;

  for (const entry of entries) {
    // JID completo veio pronto (ex.: copiado de /conversations): usa como está.
    const jid = entry.includes('@')
      ? entry
      : (() => {
          const digits = entry.replace(/\D/g, '');
          const wanted = brPhoneVariants(digits);
          const hits = participants.filter((p) =>
            wanted.includes(String(p.phone ?? '').replace(/\D/g, ''))
          );
          // Duas pessoas casando variantes diferentes do mesmo número seria um
          // chute disfarçado de acerto: prefere não mencionar a mencionar errado.
          if (hits.length !== 1) return null;
          return hits[0].jid || hits[0].id;
        })();

    if (!jid) {
      unresolved.push(entry);
      continue;
    }

    if (!jids.includes(jid)) jids.push(jid);

    // Token no texto. Se o integrador escreveu o número numa forma diferente da
    // que o grupo conhece (nono dígito), troca o token dele pelo que destaca.
    const jidDigits = jid.split('@')[0];
    const requested = entry.includes('@') ? '' : entry.replace(/\D/g, '');
    if (!body.includes(`@${jidDigits}`)) {
      if (requested && body.includes(`@${requested}`)) {
        body = body.replace(`@${requested}`, `@${jidDigits}`);
      } else {
        body = `${body} @${jidDigits}`;
      }
    }
  }

  return { jids, unresolved, text: body };
}

async function handleSendMessage(req: Request, supabase: any, organizationId: string, caller: ApiCaller) {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const {
    to,
    message,
    conversation_id,
    user_id,
    user_email,
    phone_number_id,
    typing_ms,
    mentions,
    reply_to,
    disparo,
    ia,
  } = await req.json();
  const marcaDisparo = lerDisparo(disparo);
  const marcaIa = lerIa(ia);

  if (!to || !message || !phone_number_id) {
    return jsonResponse({
      error: 'Missing required fields',
      required: ['to', 'message', 'phone_number_id'],
      optional: ['conversation_id', 'user_id', 'user_email', 'typing_ms', 'mentions', 'reply_to', 'disparo', 'ia'],
      note: 'phone_number_id can be either database UUID or Meta WhatsApp phone number ID'
    }, 400);
  }

  // typing_ms é ESTRITAMENTE opt-in: ausente, inválido ou <= 0 deixa este caminho
  // inteiro inerte — nenhuma chamada extra, nenhum atraso, e a resposta sai com a
  // mesma forma de sempre. Integração que não conhece o campo não muda de
  // comportamento em nada.
  const typingMs = Number.isFinite(Number(typing_ms))
    ? Math.min(Math.max(Math.trunc(Number(typing_ms)), 0), MAX_TYPING_MS)
    : 0;
  const typingRequested = typingMs > 0;

  const direct = await rejectIfDirect(supabase, 'SendMessage', to, conversation_id);
  if (direct) return direct;

  // Resolve phone number ID
  const phoneNumber = await resolvePhoneNumberId(supabase, phone_number_id);
  if (!phoneNumber) {
    return jsonResponse({
      error: 'Phone number not found',
      message: 'The provided phone_number_id does not exist in the database'
    }, 404);
  }

  // Autor: só membro da organização. Quem não é sai sem nome (e sem sent_by)
  // em vez de travar o envio.
  const authorResolution = await resolveApiAuthor(supabase, organizationId, { userId: user_id, userEmail: user_email });
  if (!authorResolution.ok) {
    return jsonResponse({
      error: 'Author mismatch',
      message: 'user_id and user_email must point to the same member of this organization'
    }, 400);
  }
  const author = authorResolution.author;
  const sentBy = author?.id ?? null;

  // Find or create conversation if not provided
  let convId = conversation_id;
  let conversationCreated = false;

  if (convId) {
    // Verify conversation belongs to organization
    const hasAccess = await verifyConversationOrg(supabase, convId, organizationId);
    if (!hasAccess) {
      return jsonResponse({ error: 'Conversation not found in organization' }, 404);
    }
  } else {
    const conv = await findOrCreateConversation(supabase, to, phoneNumber.dbId, sentBy ?? undefined);
    if (!conv) {
      return jsonResponse({ error: 'Failed to find or create conversation' }, 500);
    }
    convId = conv.id;
    conversationCreated = conv.isNew;
    console.log(`Conversation ${conversationCreated ? 'created' : 'found'}: ${convId}`);
  }

  // Get phone number details including connection_type
  const { data: phoneData, error: phoneError } = await supabase
    .from('phone_numbers')
    .select(`
      connection_type,
      append_agent_name,
      organization:organizations(
        whatsapp_access_token
      )
    `)
    .eq('id', phoneNumber.dbId)
    .eq('organization_id', organizationId)
    .single();

  if (phoneError) {
    return jsonResponse({ error: 'Phone number not found in organization' }, 500);
  }

  // Citação: resolvida ANTES de qualquer envio — reply_to inválido é 400, não
  // uma mensagem que sai sem a citação que o integrador pediu.
  let quoted: QuotedContext | null = null;
  if (reply_to) {
    const resolved = await resolveQuoted(supabase, reply_to, convId);
    if ('failure' in resolved) return jsonResponse(resolved.failure, 400);
    quoted = resolved.quoted;
  }

  // Menção. Só existe em grupo de número QR: na Cloud API não há grupo, e em 1:1
  // marcar o próprio destinatário não significa nada.
  let finalMessage = message;
  let mentionJids: string[] = [];
  let mentionsUnresolved: string[] = [];
  const mentionsRequested = Array.isArray(mentions) && mentions.length > 0;

  if (mentionsRequested) {
    if (phoneData.connection_type !== 'qr') {
      return jsonResponse({
        error: 'Mentions are only supported on QR (Baileys) numbers',
        detail: `This phone number uses connection_type="${phoneData.connection_type}"`,
        note: 'Groups — and therefore mentions — only exist on QR connections.',
      }, 400);
    }

    const { data: convData } = await supabase
      .from('conversations')
      .select('is_group, group_jid')
      .eq('id', convId)
      .maybeSingle();

    if (!convData?.is_group || !convData.group_jid) {
      return jsonResponse({
        error: 'Mentions are only supported in group conversations',
        note: 'In a 1:1 chat there is nobody to mention but the recipient.',
      }, 400);
    }

    // "to" é quem recebe de fato; a conversa é só onde arquiva. Um conversation_id
    // de grupo com um "to" de número resolveria as menções contra os participantes
    // do grupo e mandaria a mensagem para outra pessoa.
    if (String(to).trim() !== convData.group_jid) {
      return jsonResponse({
        error: 'Recipient does not match the group of this conversation',
        detail: `"to" is "${to}" but the conversation is the group "${convData.group_jid}"`,
        note: 'When mentioning, send "to" as the group JID (…@g.us) of the conversation.',
      }, 400);
    }

    const resolved = await resolveMentions(mentions, convData.group_jid, phoneNumber.dbId, message);
    mentionJids = resolved.jids;
    mentionsUnresolved = resolved.unresolved;
    finalMessage = resolved.text;
  }

  // Igual ao painel: com "Identificar agente" ligado na linha, o nome de quem
  // escreveu vai em negrito no próprio texto (o cliente vê no WhatsApp).
  if (author && phoneData.append_agent_name) {
    finalMessage = withAgentHeader(finalMessage, author.name);
  }

  // "Digitando" antes de enviar (suporta QR e Cloud API).
  // Falha do typing indicator não aborta o envio — o typing_applied na resposta
  // conta a verdade sem quebrar nada.
  let typingApplied = false;
  if (typingRequested) {
    if (phoneData.connection_type === 'qr') {
      const typingResult = await postChatState(phoneNumber.dbId, to, 'composing');
      typingApplied = typingResult.ok;
      if (!typingResult.ok) {
        console.warn('[SendMessage] typing_ms requested but chat state failed:', typingResult.error);
      }
    } else {
      const orgData = Array.isArray(phoneData.organization) ? phoneData.organization[0] : phoneData.organization;
      const accessToken = orgData?.whatsapp_access_token;
      if (accessToken && phoneNumber.metaId && convId) {
        const inboundWamid = await getLatestInboundWamid(supabase, convId);
        if (inboundWamid) {
          const result = await sendMetaTypingIndicator({
            accessToken,
            metaPhoneNumberId: phoneNumber.metaId,
            inboundMessageId: inboundWamid,
          });
          typingApplied = result.success;
        }
      }
    }
    // Espera mesmo se o typing falhou: o consumidor pediu um atraso e mudar a
    // cadência do envio por causa do enfeite seria pior que não mostrar o enfeite.
    await new Promise((resolve) => setTimeout(resolve, typingMs));
  }


  let whatsappMessageId: string;

  // Route based on connection_type
  if (phoneData.connection_type === 'qr') {
    // QR Connection - send via Baileys service
    const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
    if (!qrServiceUrl) {
      return jsonResponse({ error: 'QR_SERVICE_URL not configured. Please add it to Edge Function secrets.' }, 500);
    }

    console.log('[QR Send] Routing to Baileys service:', qrServiceUrl);

    let qrResponse: Response;
    try {
      qrResponse = await fetch(`${qrServiceUrl}/message/send/${phoneNumber.dbId}`, {
        method: 'POST',
        headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          to,
          content: finalMessage,
          ...(quoted ? {
            quotedMessageId: quoted.quotedWhatsappId,
            quotedContent: quoted.quotedContent,
            quotedFromMe: quoted.quotedFromMe,
            quotedParticipant: quoted.quotedParticipant,
          } : {}),
          ...(mentionJids.length > 0 ? { mentions: mentionJids } : {}),
          skipSave: true,
        }),
      });
    } catch (fetchErr: any) {
      console.error('[QR Send] FETCH FAILED (network error):', fetchErr?.message || String(fetchErr));
      return jsonResponse({ error: `QR service unreachable: ${fetchErr?.message || 'Network error'}` }, 500);
    }

    const qrData = await qrResponse.json();

    if (!qrResponse.ok || !qrData.success) {
      console.error('[QR Send] Baileys service error:', qrData);
      return jsonResponse({ error: qrData.error || 'Failed to send message via QR service' }, 400);
    }

    console.log('[QR Send] Message sent successfully:', qrData.messageId);
    whatsappMessageId = qrData.messageId || `qr_${Date.now()}`;
  } else {
    // Business API - send via Meta
    const accessToken = phoneData.organization?.whatsapp_access_token;
    if (!accessToken) {
      return jsonResponse({ error: 'WhatsApp credentials not found for this phone number' }, 500);
    }

    const whatsappResponse = await fetch(
      `https://graph.facebook.com/v18.0/${phoneNumber.metaId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          ...(quoted ? { context: { message_id: quoted.quotedWhatsappId } } : {}),
          type: 'text',
          text: { body: finalMessage },
        }),
      }
    );

    const whatsappData = await whatsappResponse.json();

    if (!whatsappResponse.ok) {
      console.error('WhatsApp API error:', whatsappData);
      return jsonResponse({ error: whatsappData.error?.message || 'Failed to send message' }, 400);
    }

    console.log('Message sent successfully via Meta API:', whatsappData);
    whatsappMessageId = whatsappData.messages[0].id;
  }

  // Save to database
  // content = finalMessage: o que fica gravado tem de ser o que saiu (o token de
  // menção pode ter sido acrescentado ao texto).
  const { data: msgData, error: msgError } = await supabase.from('messages').insert({
    conversation_id: convId,
    content: finalMessage,
    direction: 'outbound',
    sent_by: sentBy,
    whatsapp_message_id: whatsappMessageId,
    quoted_message_id: quoted?.quotedLocalId ?? null,
    metadata: { ...apiOriginMetadata(caller), ...(marcaDisparo ? { disparo: marcaDisparo } : {}), ...(marcaIa ? { ia: marcaIa } : {}) },
  }).select().single();

  if (msgError) {
    console.error('Error saving message:', msgError);
    return jsonResponse({
      error: 'Message sent to WhatsApp but failed to save to database',
      whatsapp_message_id: whatsappMessageId,
      db_error: msgError.message
    }, 500);
  }

  // Disparo: quem decide posição e status é o gatilho on_message_inserted
  // (aba Disparos); bumpar aqui jogaria para o topo quem está em atendimento.
  if (!marcaDisparo) {
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString(), status: 'active' })
      .eq('id', convId);
  }

  if (msgData) {
    await emitMessageSent(supabase, {
      conversationId: convId,
      messageId: msgData.id,
      whatsappMessageId,
      content: finalMessage,
      messageType: 'text',
      sentBy,
      origin: 'api',
      phoneNumberDbId: phoneNumber.dbId,
      organizationId,
      metaPhoneNumberId: phoneNumber.metaId,
    });
  }

  console.log(`Message saved: ${msgData.id} for conversation: ${convId}`);

  return jsonResponse({
    success: true,
    whatsapp_message_id: whatsappMessageId,
    conversation_id: convId,
    conversation_created: conversationCreated,
    // Só aparece para quem pediu typing_ms: a resposta de quem não usa o campo
    // continua com exatamente as mesmas chaves de antes.
    ...(typingRequested ? { typing_applied: typingApplied } : {}),
    // Número que não está no grupo (ou @lid que o WhatsApp ainda não resolveu)
    // não pode virar menção silenciosamente perdida.
    ...(mentionsUnresolved.length > 0 ? { mentions_unresolved: mentionsUnresolved } : {}),
    // Autor pedido e não achado entre os membros: a mensagem saiu sem nome.
    ...(authorResolution.unresolved ? { author_unresolved: true } : {}),
    message: msgData
  });
}

// ============ REACT ============
// Espelha a edge function whatsapp-react (usada pelo painel), trocando a auth de
// usuário pelo escopo de organização da API key. Suporta QR e Cloud API.
async function handleReact(req: Request, supabase: any, organizationId: string) {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const { message_id, phone_number_id, emoji, user_id, conversation_id } = await req.json().catch(() => ({}));

  if (!message_id || !phone_number_id) {
    return jsonResponse({
      error: 'Missing required fields',
      required: ['message_id', 'phone_number_id'],
      optional: ['emoji', 'user_id', 'conversation_id'],
      note: 'message_id accepts the message uuid or its whatsapp_message_id. An empty emoji (or omitting it) removes the reaction.',
    }, 400);
  }

  // Emoji não-string cairia em "" e REMOVERIA a reação em silêncio, que é o
  // oposto do que quem mandou o campo queria.
  if (emoji !== undefined && emoji !== null && typeof emoji !== 'string') {
    return jsonResponse({
      error: 'emoji must be a string',
      note: 'Send the emoji itself (e.g. "👍"), or an empty string to remove the reaction.',
    }, 400);
  }

  const phoneNumber = await resolvePhoneNumberId(supabase, phone_number_id);
  if (!phoneNumber) {
    return jsonResponse({
      error: 'Phone number not found',
      message: 'The provided phone_number_id does not exist in the database'
    }, 404);
  }

  // Escopo de organização: o client é service-role e ignora RLS, então este
  // filtro é a única fronteira de tenant.
  const { data: phoneData } = await supabase
    .from('phone_numbers')
    .select('id, connection_type, organization:organizations(whatsapp_access_token)')
    .eq('id', phoneNumber.dbId)
    .eq('organization_id', organizationId)
    .single();

  if (!phoneData) {
    return jsonResponse({ error: 'Phone number not found in organization' }, 404);
  }

  if (user_id && !(await isOrgMember(supabase, user_id, organizationId))) {
    return jsonResponse({
      error: 'User not found in organization',
      message: 'The provided user_id is not a member of this organization'
    }, 404);
  }

  // Localiza a mensagem. Por wamid pode haver mais de uma linha (sessão
  // espelhada grava a mesma wamid em conversas diferentes) — o filtro por
  // phone_number_id resolve o caso normal, e conversation_id desempata o resto.
  const ref = String(message_id).trim();
  let query = supabase
    .from('messages')
    .select('id, whatsapp_message_id, direction, sender_jid, conversation_id, conversations!inner(contact_phone, is_group, group_jid, phone_number_id, channel)')
    .eq(isUUID(ref) ? 'id' : 'whatsapp_message_id', ref)
    .eq('conversations.phone_number_id', phoneNumber.dbId);

  if (conversation_id) {
    query = query.eq('conversation_id', conversation_id);
  }

  const { data: rows, error: msgError } = await query.limit(2);

  if (msgError) {
    console.error('[React] Error loading message:', msgError);
    return jsonResponse({ error: 'Failed to load message' }, 500);
  }

  if (!rows || rows.length === 0) {
    return jsonResponse({
      error: 'Message not found for this phone number',
      note: 'message_id accepts the message uuid or its whatsapp_message_id, and the message must belong to a conversation of this phone_number_id.',
    }, 404);
  }

  if (rows.length > 1) {
    return jsonResponse({
      error: 'Ambiguous message_id',
      note: 'This whatsapp_message_id exists in more than one conversation of this phone number. Send "conversation_id" to disambiguate, or use the message uuid.',
    }, 400);
  }

  const message = rows[0];
  const conversation = Array.isArray(message.conversations) ? message.conversations[0] : message.conversations;

  if (conversation.channel === 'instagram') {
    return directRejection('React', message.conversation_id);
  }

  if (!message.whatsapp_message_id) {
    return jsonResponse({
      error: 'Message has no WhatsApp id',
      note: 'This message never reached WhatsApp, so there is nothing to react to.',
    }, 400);
  }

  const to = conversation.is_group && conversation.group_jid
    ? conversation.group_jid
    : conversation.contact_phone;

  // fromMe: a mensagem reagida foi nossa? Em grupo, quando não é nossa, o
  // Baileys precisa do JID de quem mandou.
  const fromMe = message.direction === 'outbound';
  const participant = conversation.is_group && !fromMe ? message.sender_jid : undefined;
  const emojiValue = typeof emoji === 'string' ? emoji : '';

  if (phoneData.connection_type === 'qr') {
    const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
    if (!qrServiceUrl) {
      return jsonResponse({ error: 'QR_SERVICE_URL not configured. Please add it to Edge Function secrets.' }, 500);
    }

    let qrResponse: Response;
    try {
      qrResponse = await fetch(`${qrServiceUrl}/message/react/${phoneNumber.dbId}`, {
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
    } catch (fetchErr: any) {
      console.error('[React] QR service unreachable:', fetchErr?.message || String(fetchErr));
      return jsonResponse({ error: `QR service unreachable: ${fetchErr?.message || 'Network error'}` }, 502);
    }

    const qrData = await qrResponse.json().catch(() => ({}));
    if (!qrResponse.ok || !qrData.success) {
      console.error('[React] QR service error:', qrData);
      return jsonResponse({ error: qrData.error || 'Failed to send reaction via QR service' }, 400);
    }
  } else {
    const orgData = Array.isArray(phoneData.organization) ? phoneData.organization[0] : phoneData.organization;
    const accessToken = orgData?.whatsapp_access_token;
    if (!accessToken) {
      return jsonResponse({ error: 'WhatsApp credentials not found for this phone number' }, 500);
    }

    const metaResponse = await fetch(
      `https://graph.facebook.com/v18.0/${phoneNumber.metaId}/messages`,
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
          reaction: { message_id: message.whatsapp_message_id, emoji: emojiValue },
        }),
      }
    );

    const metaData = await metaResponse.json().catch(() => ({}));
    if (!metaResponse.ok) {
      console.error('[React] Cloud API error:', metaData);
      return jsonResponse({ error: metaData.error?.message || 'Failed to send reaction' }, 400);
    }
  }

  // Escalar (our_reaction) + fan-out (message_reactions), como whatsapp-react:
  // a NOSSA reação é uma só por mensagem, então a linha é reciclada em vez de
  // duplicar quando o eco do Baileys chega.
  const reactionValue = emojiValue || null;
  await supabase.from('messages').update({ our_reaction: reactionValue }).eq('id', message.id);

  try {
    await supabase
      .from('message_reactions')
      .delete()
      .eq('message_id', message.id)
      .eq('is_from_me', true)
      .is('reactor_jid', null);

    if (reactionValue) {
      await supabase.from('message_reactions').insert({
        message_id: message.id,
        reactor_jid: null,
        reactor_user_id: user_id || null,
        is_from_me: true,
        emoji: reactionValue,
      });
    }
  } catch (fanoutErr) {
    console.error('[React] Fan-out falhou (escalar segue válido):', fanoutErr);
  }

  return jsonResponse({
    success: true,
    message_id: message.id,
    whatsapp_message_id: message.whatsapp_message_id,
    conversation_id: message.conversation_id,
    emoji: reactionValue,
    removed: !reactionValue,
  });
}

// Helper to format template content like the UI does
function formatTemplateContent(
  template: any,
  bodyParameters: string[] = [],
  buttonParameters: string[] = []
): string {
  const bodyComponent = template.components?.find((c: any) => c.type === 'BODY');
  const buttonsComponent = template.components?.find((c: any) => c.type === 'BUTTONS');

  let messageContent = bodyComponent?.text || template.name;

  // Fill in body parameters
  bodyParameters.forEach((param, index) => {
    // Todas as ocorrências: {{1}} repetido ficava cru no histórico.
    messageContent = messageContent.split(`{{${index + 1}}}`).join(param);
  });

  // Add buttons to message content if present
  if (buttonsComponent && Array.isArray(buttonsComponent.buttons)) {
    const buttons = buttonsComponent.buttons as Array<{ type: string; text: string; url?: string; phone_number?: string }>;
    if (buttons.length > 0) {
      // buttonParameters segue só os links dinâmicos, não a posição entre todos os botões.
      let dynamicIdx = 0;
      messageContent += '\n\n---BUTTONS---\n' + buttons.map((btn) => {
        if (btn.type === 'URL' && btn.url) {
          let url = btn.url;
          if (url.includes('{{')) {
            const suffix = buttonParameters[dynamicIdx++];
            if (suffix) url = url.replace(/\{\{\d+\}\}/g, suffix);
          }
          return `[URL:${url}]${btn.text}`;
        } else if (btn.type === 'PHONE_NUMBER' && btn.phone_number) {
          return `[PHONE:${btn.phone_number}]${btn.text}`;
        } else {
          return `[QUICK]${btn.text}`;
        }
      }).join('\n');
    }
  }

  return messageContent;
}

// ============ SEND TEMPLATE ============
async function handleSendTemplate(req: Request, supabase: any, organizationId: string, caller: ApiCaller) {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const {
    to,
    template_name,
    language_code = 'pt_BR',
    components,
    body_parameters: rawBodyParams = [],
    button_parameters: rawButtonParams = [],
    conversation_id,
    user_id,
    phone_number_id,
    disparo,
    ia,
  } = await req.json();
  const marcaDisparo = lerDisparo(disparo);
  const marcaIa = lerIa(ia);

  // Support both array and semicolon-separated string formats
  const body_parameters = Array.isArray(rawBodyParams)
    ? rawBodyParams
    : (typeof rawBodyParams === 'string' && rawBodyParams.trim()
      ? rawBodyParams.split(';').map((s: string) => s.trim())
      : []);

  const button_parameters = Array.isArray(rawButtonParams)
    ? rawButtonParams
    : (typeof rawButtonParams === 'string' && rawButtonParams.trim()
      ? rawButtonParams.split(';').map((s: string) => s.trim())
      : []);

  if (!to || !template_name || !phone_number_id) {
    return jsonResponse({
      error: 'Missing required fields',
      required: ['to', 'template_name', 'phone_number_id'],
      optional: ['language_code', 'components', 'body_parameters', 'button_parameters', 'conversation_id', 'user_id', 'disparo', 'ia'],
      note: 'body_parameters and button_parameters can be arrays or semicolon-separated strings. Example: ["João", "10:00"] or "João; 10:00"'
    }, 400);
  }

  const direct = await rejectIfDirect(supabase, 'SendTemplate', to, conversation_id);
  if (direct) return direct;

  // Resolve phone number ID
  const phoneNumber = await resolvePhoneNumberId(supabase, phone_number_id);
  if (!phoneNumber) {
    return jsonResponse({
      error: 'Phone number not found',
      message: 'The provided phone_number_id does not exist in the database'
    }, 404);
  }

  // Get credentials for this phone number
  const { data: phoneData, error: phoneError } = await supabase
    .from('phone_numbers')
    .select(`
      organization:organizations(
        whatsapp_access_token,
        whatsapp_waba_id
      )
    `)
    .eq('id', phoneNumber.dbId)
    .eq('organization_id', organizationId)
    .single();

  if (phoneError || !phoneData?.organization?.whatsapp_access_token || !phoneData?.organization?.whatsapp_waba_id) {
    return jsonResponse({ error: 'WhatsApp credentials not found for this phone number' }, 500);
  }

  const accessToken = phoneData.organization.whatsapp_access_token;
  const wabaId = phoneData.organization.whatsapp_waba_id;

  // Fetch template details from Meta API to build formatted content
  let templateData: any = null;
  try {
    const templatesResponse = await fetch(
      `https://graph.facebook.com/v18.0/${wabaId}/message_templates?name=${template_name}&status=APPROVED`,
      {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      }
    );
    const templatesJson = await templatesResponse.json();
    if (templatesJson.data && templatesJson.data.length > 0) {
      templateData = templatesJson.data[0];
    }
  } catch (e) {
    console.error('Failed to fetch template details:', e);
  }

  // Find or create conversation if not provided
  let convId = conversation_id;
  let conversationCreated = false;

  if (convId) {
    // Verify conversation belongs to organization
    const hasAccess = await verifyConversationOrg(supabase, convId, organizationId);
    if (!hasAccess) {
      return jsonResponse({ error: 'Conversation not found in organization' }, 404);
    }
  } else {
    const conv = await findOrCreateConversation(supabase, to, phoneNumber.dbId, user_id);
    if (!conv) {
      return jsonResponse({ error: 'Failed to find or create conversation' }, 500);
    }
    convId = conv.id;
    conversationCreated = conv.isNew;
    console.log(`Conversation ${conversationCreated ? 'created' : 'found'}: ${convId}`);
  }

  // Build template object for WhatsApp API
  const templateObj: any = {
    name: template_name,
    language: { code: language_code },
  };

  // If components provided directly, use them; otherwise build from body_parameters
  if (components && components.length > 0) {
    templateObj.components = components;
  } else if (body_parameters.length > 0 || button_parameters.length > 0) {
    const builtComponents: any[] = [];

    if (body_parameters.length > 0) {
      builtComponents.push({
        type: "body",
        parameters: body_parameters.map((text: string) => ({
          type: "text",
          text: text
        }))
      });
    }

    // Add button parameters for URL buttons with dynamic params
    if (templateData && button_parameters.length > 0) {
      const buttonsComponent = templateData.components?.find((c: any) => c.type === 'BUTTONS');
      if (buttonsComponent && Array.isArray(buttonsComponent.buttons)) {
        let buttonParamIdx = 0;
        buttonsComponent.buttons.forEach((btn: any, index: number) => {
          if (btn.type === 'URL' && btn.url?.includes('{{')) {
            builtComponents.push({
              type: "button",
              sub_type: "url",
              index: String(index),
              parameters: [{
                type: "text",
                text: button_parameters[buttonParamIdx] || ''
              }]
            });
            buttonParamIdx++;
          }
        });
      }
    }

    if (builtComponents.length > 0) {
      templateObj.components = builtComponents;
    }
  }

  // Disparo condicional do typing indicator (apenas se houver inbound recente nas últimas 24h)
  if (convId) {
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    void (async () => {
      try {
        const inboundWamid = await getLatestInboundWamid(supabase, convId, {
          maxAgeMs: TWENTY_FOUR_HOURS_MS,
        });
        if (inboundWamid && accessToken && phoneNumber.metaId) {
          await sendMetaTypingIndicator({
            accessToken,
            metaPhoneNumberId: phoneNumber.metaId,
            inboundMessageId: inboundWamid,
          });
        }
      } catch (typingErr) {
        console.warn('[handleSendTemplate] Error sending typing indicator:', typingErr);
      }
    })();
  }

  // Send to WhatsApp API
  const whatsappResponse = await fetch(
    `https://graph.facebook.com/v18.0/${phoneNumber.metaId}/messages`,
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
    console.error('WhatsApp API error:', whatsappData);
    return jsonResponse({ error: whatsappData.error?.message || 'Failed to send template' }, 400);
  }

  // Build formatted message content
  let messageContent = `[Template: ${template_name}]`;
  if (templateData) {
    messageContent = formatTemplateContent(templateData, body_parameters, button_parameters);
  }

  // Save message to database (include metadata for fallback resend support)
  const { data: msgData, error: msgError } = await supabase.from('messages').insert({
    conversation_id: convId,
    content: messageContent,
    direction: 'outbound',
    sent_by: user_id || null,
    message_type: 'template',
    whatsapp_message_id: whatsappData.messages[0].id,
    metadata: {
      template_name,
      language_code,
      components: templateObj.components || null,
      ...apiOriginMetadata(caller),
      ...(marcaDisparo ? { disparo: marcaDisparo } : {}),
      ...(marcaIa ? { ia: marcaIa } : {}),
    },
  }).select().single();

  if (msgError) {
    console.error('Error saving message:', msgError);
    return jsonResponse({
      error: 'Template sent to WhatsApp but failed to save to database',
      whatsapp_message_id: whatsappData.messages[0].id,
      db_error: msgError.message
    }, 500);
  }

  // Disparo: posição e status ficam com o gatilho on_message_inserted (aba Disparos).
  if (!marcaDisparo) {
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString(), status: 'active' })
      .eq('id', convId);
  }

  if (msgData) {
    await emitMessageSent(supabase, {
      conversationId: convId,
      messageId: msgData.id,
      whatsappMessageId: whatsappData.messages[0].id,
      content: messageContent,
      messageType: 'template',
      sentBy: user_id || null,
      origin: 'api',
      phoneNumberDbId: phoneNumber.dbId,
      organizationId,
      metaPhoneNumberId: phoneNumber.metaId,
      templateName: template_name,
    });
  }

  console.log(`Template message saved: ${msgData.id} for conversation: ${convId}`);

  return jsonResponse({
    success: true,
    whatsapp_message_id: whatsappData.messages[0].id,
    conversation_id: convId,
    conversation_created: conversationCreated,
    message: msgData
  });
}

// ============ TEMPLATES ============
async function handleTemplates(
  req: Request,
  supabase: any,
  id: string,
  organizationId: string
) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(req.url);
  const status = url.searchParams.get('status') || 'APPROVED';
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const phoneNumberId = req.method === 'POST' ? body.phone_number_id : url.searchParams.get('phone_number_id');

  if (!phoneNumberId) {
    return jsonResponse({
      error: 'phone_number_id is required',
      example: req.method === 'POST' ? '{ "phone_number_id": "uuid-or-meta-id", ... }' : '/templates?phone_number_id=uuid-or-meta-id'
    }, 400);
  }

  // Resolve phone number and get credentials
  let phoneData;

  // Try by database UUID first
  const { data: byId } = await supabase
    .from('phone_numbers')
    .select(`
      id,
      organization:organizations(
        whatsapp_access_token,
        whatsapp_waba_id
      )
    `)
    .eq('id', phoneNumberId)
    .eq('organization_id', organizationId)
    .single();

  if (byId) {
    phoneData = byId;
  } else {
    // Try by Meta's phone_number_id
    const { data: byMeta } = await supabase
      .from('phone_numbers')
      .select(`
        id,
        organization:organizations(
          whatsapp_access_token,
          whatsapp_waba_id
        )
      `)
      .eq('phone_number_id', phoneNumberId)
      .eq('organization_id', organizationId)
      .single();

    phoneData = byMeta;
  }

  if (!phoneData?.organization?.whatsapp_access_token || !phoneData?.organization?.whatsapp_waba_id) {
    return jsonResponse({ error: 'WhatsApp credentials not found for this phone number' }, 404);
  }

  const accessToken = phoneData.organization.whatsapp_access_token;
  const wabaId = phoneData.organization.whatsapp_waba_id;

  if (req.method === 'POST') {
    return await createTemplate(body, accessToken, wabaId);
  }

  // One template by name in any status (PENDING, APPROVED, REJECTED), so whoever
  // submitted it can follow Meta's review without listing the whole account.
  const name = url.searchParams.get('name');
  if (name) {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${wabaId}/message_templates?name=${encodeURIComponent(name)}` +
        '&fields=name,status,language,category,components,rejected_reason&limit=100',
      { headers: { 'Authorization': `Bearer ${accessToken}` } },
    );
    const data: { data?: Array<{ name?: string }>; error?: { message?: string } } = await response.json();
    if (!response.ok) {
      return jsonResponse({ error: data.error?.message || 'Failed to fetch template' }, 400);
    }
    // Meta's name filter matches by substring: keep only the exact name.
    const found = (data.data ?? []).filter((t) => t.name === name);
    return jsonResponse({ templates: found, count: found.length });
  }

  // Fetch all templates following Meta's cursor pagination (paging.next)
  const allTemplates: unknown[] = [];
  let nextUrl: string | null =
    `https://graph.facebook.com/v18.0/${wabaId}/message_templates?status=${status}&limit=100`;
  let pages = 0;

  while (nextUrl && pages < 20) { // backstop: 20 páginas = 2000 templates
    const response: Response = await fetch(nextUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    const data: { data?: unknown[]; paging?: { next?: string }; error?: { message?: string } } = await response.json();

    if (!response.ok) {
      return jsonResponse({ error: data.error?.message || 'Failed to fetch templates' }, 400);
    }

    if (data.data) allTemplates.push(...data.data);
    nextUrl = data.paging?.next || null;
    pages++;
  }

  return jsonResponse({
    templates: allTemplates,
    count: allTemplates.length
  });
}

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;

// Submits a text template to Meta's review. Media headers go through the
// whatsapp-create-template function (they need a sample upload first).
async function createTemplate(body: any, accessToken: string, wabaId: string) {
  const { name, language, category, components } = body ?? {};
  if (typeof name !== 'string' || !TEMPLATE_NAME.test(name)) {
    return jsonResponse({ error: 'name must use only lowercase letters, numbers and underscores' }, 400);
  }
  if (category !== 'MARKETING' && category !== 'UTILITY') {
    return jsonResponse({ error: 'category must be MARKETING or UTILITY' }, 400);
  }
  if (typeof language !== 'string' || !language) {
    return jsonResponse({ error: 'language is required (e.g. pt_BR)' }, 400);
  }
  if (!Array.isArray(components) || !components.some((c: any) => c?.type === 'BODY' && typeof c.text === 'string')) {
    return jsonResponse({ error: 'components must include a BODY with text' }, 400);
  }

  const response = await fetch(`https://graph.facebook.com/v18.0/${wabaId}/message_templates`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, language, category, components, parameter_format: 'POSITIONAL' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return jsonResponse({
      error: data.error?.error_user_msg || data.error?.message || 'Failed to create template',
      code: data.error?.code ?? null,
    }, 400);
  }
  return jsonResponse({ template: { id: data.id, name, status: data.status, category: data.category } }, 201);
}

// ============ PHONE NUMBERS ============
async function handlePhoneNumbers(req: Request, supabase: any, id: string, organizationId: string) {
  const method = req.method;

  if (method === 'GET' && !id) {
    // Filter by organization. Linha QR leva junto o estado da sessão (conectada ou
    // não, quando caiu e quando voltou) para o CRM mostrar à equipe; session_data
    // (a credencial do WhatsApp) nunca sai daqui.
    const { data, error } = await supabase
      .from('phone_numbers')
      .select('*, phone_number_sessions(connection_status, last_connected_at, last_disconnected_at)')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) return jsonResponse({ error: error.message }, 400);
    const phoneNumbers = (data ?? []).map(({ phone_number_sessions, ...phone }: any) => {
      const session = Array.isArray(phone_number_sessions) ? phone_number_sessions[0] : phone_number_sessions;
      return {
        ...phone,
        connection_status: session?.connection_status ?? null,
        last_connected_at: session?.last_connected_at ?? null,
        last_disconnected_at: session?.last_disconnected_at ?? null,
      };
    });
    return jsonResponse({ phone_numbers: phoneNumbers });
  }

  if (method === 'GET' && id) {
    // Verify phone number belongs to organization
    const { data, error } = await supabase
      .from('phone_numbers')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (error) return jsonResponse({ error: error.message }, 404);
    return jsonResponse({ phone_number: data });
  }

  if (method === 'POST') {
    const body = await req.json();
    const { phone_number, phone_number_id, display_name, theme_hue, is_active } = body;

    if (!phone_number || !phone_number_id || !display_name) {
      return jsonResponse({
        error: 'Missing required fields',
        required: ['phone_number', 'phone_number_id', 'display_name'],
        optional: ['theme_hue', 'is_active']
      }, 400);
    }

    // Always use organizationId from API key, not from body
    const { data, error } = await supabase
      .from('phone_numbers')
      .insert({
        organization_id: organizationId,
        phone_number,
        phone_number_id,
        display_name,
        theme_hue: theme_hue || 15,
        is_active: is_active !== false
      })
      .select()
      .single();

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ phone_number: data }, 201);
  }

  if (method === 'PATCH' && id) {
    const body = await req.json();
    const allowedFields = ['display_name', 'theme_hue', 'is_active'];
    const updates: any = {};

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    // Verify phone number belongs to organization
    const { data, error } = await supabase
      .from('phone_numbers')
      .update(updates)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error) return jsonResponse({ error: 'Phone number not found' }, 404);
    return jsonResponse({ phone_number: data });
  }

  if (method === 'DELETE' && id) {
    // Verify phone number belongs to organization before deleting
    const { error } = await supabase
      .from('phone_numbers')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ message: 'Phone number deleted' });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

// ============ TAGS ============
async function handleTags(req: Request, supabase: any, id: string, organizationId: string) {
  const method = req.method;

  if (method === 'GET' && !id) {
    // Filter by organization
    const { data, error } = await supabase
      .from('tags')
      .select('*')
      .eq('organization_id', organizationId)
      .order('name', { ascending: true });

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ tags: data });
  }

  if (method === 'GET' && id) {
    // Verify tag belongs to organization
    const { data, error } = await supabase
      .from('tags')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (error) return jsonResponse({ error: error.message }, 404);
    return jsonResponse({ tag: data });
  }

  if (method === 'POST') {
    const body = await req.json();
    const { name, color, user_id } = body;

    if (!name || !user_id) {
      return jsonResponse({
        error: 'Missing required fields',
        required: ['name', 'user_id'],
        optional: ['color']
      }, 400);
    }

    // Include organization_id in insert
    const { data, error } = await supabase
      .from('tags')
      .insert({ name, color: color || '#3b82f6', user_id, organization_id: organizationId })
      .select()
      .single();

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ tag: data }, 201);
  }

  if (method === 'PATCH' && id) {
    const body = await req.json();
    const allowedFields = ['name', 'color'];
    const updates: any = {};

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    // Validate tag belongs to organization
    const { data, error } = await supabase
      .from('tags')
      .update(updates)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ tag: data });
  }

  if (method === 'DELETE' && id) {
    // Validate tag belongs to organization before deleting
    const { error } = await supabase
      .from('tags')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ message: 'Tag deleted' });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

// ============ CLOSE REASONS ============
async function handleCloseReasons(req: Request, supabase: any, id: string, organizationId: string) {
  const method = req.method;

  if (method === 'GET') {
    // Filter by organization
    const { data, error } = await supabase
      .from('close_reasons')
      .select('*')
      .eq('organization_id', organizationId)
      .order('name', { ascending: true });

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ close_reasons: data });
  }

  if (method === 'POST') {
    const body = await req.json();
    const { name, user_id } = body;

    if (!name || !user_id) {
      return jsonResponse({
        error: 'Missing required fields',
        required: ['name', 'user_id']
      }, 400);
    }

    // Include organization_id in insert
    const { data, error } = await supabase
      .from('close_reasons')
      .insert({ name, user_id, organization_id: organizationId })
      .select()
      .single();

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ close_reason: data }, 201);
  }

  if (method === 'DELETE' && id) {
    // Validate close_reason belongs to organization before deleting
    const { error } = await supabase
      .from('close_reasons')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ message: 'Close reason deleted' });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

// ============ SEND IMAGE/MEDIA ============
async function handleSendImage(req: Request, supabase: any, organizationId: string, caller: ApiCaller) {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const contentType = req.headers.get('content-type') || '';

    let to: string;
    let phoneNumberId: string;
    let caption: string | null = null;
    let conversationId: string | null = null;
    let userId: string | null = null;
    let mediaUrl: string;
    let mimeType: string;
    let filename: string;
    let fileSize: number | null = null;
    let replyTo: string | null = null;
    let marcaDisparo: ReturnType<typeof lerDisparo> = null;

    // Handle both JSON (with media_url) and FormData (with file)
    if (contentType.includes('application/json')) {
      // JSON request with media_url
      const body = await req.json();
      marcaDisparo = lerDisparo(body.disparo);
      to = body.to;
      phoneNumberId = body.phone_number_id;
      caption = body.caption || null;
      conversationId = body.conversation_id || null;
      userId = body.user_id || null;
      replyTo = body.reply_to || null;
      mediaUrl = body.media_url;
      mimeType = body.mime_type || 'application/octet-stream';
      filename = body.filename || 'file';

      if (!to || !phoneNumberId || !mediaUrl) {
        return jsonResponse({
          error: 'Missing required fields',
          required: ['to', 'phone_number_id', 'media_url'],
          optional: ['caption', 'conversation_id', 'user_id', 'mime_type', 'filename', 'reply_to', 'disparo'],
          note: 'Use JSON with media_url or multipart/form-data with file'
        }, 400);
      }
    } else {
      // FormData request with file upload
      const formData = await req.formData();
      const file = formData.get('file') as File;
      to = formData.get('to') as string;
      phoneNumberId = formData.get('phone_number_id') as string;
      caption = formData.get('caption') as string | null;
      conversationId = formData.get('conversation_id') as string | null;
      userId = formData.get('user_id') as string | null;
      replyTo = (formData.get('reply_to') as string | null) || null;

      if (!file || !to || !phoneNumberId) {
        return jsonResponse({
          error: 'Missing required fields',
          required: ['file', 'to', 'phone_number_id'],
          optional: ['caption', 'conversation_id', 'user_id', 'reply_to'],
          note: 'Use multipart/form-data with file or JSON with media_url'
        }, 400);
      }

      mimeType = file.type;
      filename = file.name;
      fileSize = file.size;

      // Sanitize filename for storage path
      const sanitizeFilename = (name: string) => {
        return name
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-zA-Z0-9.-]/g, "_")
          .replace(/_{2,}/g, "_");
      };

      // Upload file to Supabase Storage
      const fileBuffer = await file.arrayBuffer();
      const sanitizedName = sanitizeFilename(file.name);
      const storagePath = `outbound/${userId || 'api'}/${Date.now()}_${sanitizedName}`;

      const { error: uploadError } = await supabase.storage
        .from('attachments')
        .upload(storagePath, fileBuffer, {
          contentType: mimeType,
          upsert: false
        });

      if (uploadError) {
        console.error('Storage upload error:', uploadError);
        return jsonResponse({ error: 'Failed to upload file to storage' }, 500);
      }

      // Get public URL (a base pública: a URL é gravada e segue ao canal)
      mediaUrl = urlPublicaDoAnexo(storagePath);
      console.log(`[SendImage] Uploaded to: ${mediaUrl}`);
    }

    const direct = await rejectIfDirect(supabase, 'SendImage', to, conversationId);
    if (direct) return direct;

    // Resolve phone number ID
    const resolvedPhone = await resolvePhoneNumberId(supabase, phoneNumberId);
    if (!resolvedPhone) {
      return jsonResponse({
        error: 'Phone number not found',
        message: 'The provided phone_number_id does not exist in the database'
      }, 404);
    }

    // Get phone number details including connection_type and credentials
    const { data: phoneData, error: phoneError } = await supabase
      .from('phone_numbers')
      .select(`
        id,
        phone_number_id,
        connection_type,
        organization:organizations(
          whatsapp_access_token
        )
      `)
      .eq('id', resolvedPhone.dbId)
      .eq('organization_id', organizationId)
      .single();

    if (phoneError || !phoneData) {
      return jsonResponse({ error: 'Phone number not found in organization' }, 404);
    }

    // Find or create conversation if not provided
    let convId = conversationId;
    let conversationCreated = false;

    if (convId) {
      // Verify conversation belongs to organization
      const hasAccess = await verifyConversationOrg(supabase, convId, organizationId);
      if (!hasAccess) {
        return jsonResponse({ error: 'Conversation not found in organization' }, 404);
      }
    } else {
      const conv = await findOrCreateConversation(supabase, to, resolvedPhone.dbId, userId || undefined);
      if (!conv) {
        return jsonResponse({ error: 'Failed to find or create conversation' }, 500);
      }
      convId = conv.id;
      conversationCreated = conv.isNew;
    }

    // Citação, se pedida — resolvida antes de qualquer envio.
    let quoted: QuotedContext | null = null;
    if (replyTo) {
      const resolved = await resolveQuoted(supabase, replyTo, convId);
      if ('failure' in resolved) return jsonResponse(resolved.failure, 400);
      quoted = resolved.quoted;
    }

    // Determine media type from MIME type
    let mediaType: 'image' | 'video' | 'audio' | 'document' = 'document';
    if (mimeType.startsWith('image/')) {
      mediaType = 'image';
    } else if (mimeType.startsWith('video/')) {
      mediaType = 'video';
    } else if (mimeType.startsWith('audio/')) {
      mediaType = 'audio';
    }

    let whatsappMessageId: string;

    // Send to WhatsApp based on connection type
    if (phoneData.connection_type === 'qr') {
      // QR Connection - send via Baileys service
      const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
      if (!qrServiceUrl) {
        return jsonResponse({ error: 'QR_SERVICE_URL not configured' }, 500);
      }

      // Fetch file from URL to send to QR service
      let fileBlob: Blob;
      try {
        const fileResponse = await fetchMidia(mediaUrl);
        if (!fileResponse.ok) {
          return jsonResponse({ error: 'Failed to fetch media from URL' }, 400);
        }
        fileBlob = await fileResponse.blob();
      } catch (fetchErr: any) {
        console.error('[SendImage] Failed to fetch media URL:', fetchErr?.message);
        return jsonResponse({ error: `Failed to fetch media: ${fetchErr?.message}` }, 400);
      }

      // Create FormData and send to QR service
      const qrFormData = new FormData();
      qrFormData.append('file', fileBlob, filename);
      qrFormData.append('to', to);
      if (caption) {
        qrFormData.append('caption', caption);
      }
      if (quoted) {
        qrFormData.append('quotedMessageId', quoted.quotedWhatsappId);
        if (quoted.quotedContent) qrFormData.append('quotedContent', quoted.quotedContent);
        qrFormData.append('quotedFromMe', String(quoted.quotedFromMe));
        if (quoted.quotedParticipant) qrFormData.append('quotedParticipant', quoted.quotedParticipant);
      }
      qrFormData.append('skipSave', 'true');

      console.log(`[SendImage] Sending to QR service: ${qrServiceUrl}/message/send-media/${phoneData.id}`);

      let qrResponse: Response;
      try {
        qrResponse = await fetch(`${qrServiceUrl}/message/send-media/${phoneData.id}`, {
          method: 'POST',
          headers: qrAuthHeaders(),
          body: qrFormData,
        });
      } catch (fetchErr: any) {
        console.error('[SendImage] QR service error:', fetchErr?.message);
        return jsonResponse({ error: `QR service unreachable: ${fetchErr?.message || 'Network error'}` }, 500);
      }

      const qrData = await qrResponse.json();

      if (!qrResponse.ok) {
        console.error('[SendImage] Baileys service error:', qrData);
        return jsonResponse({ error: qrData.error || 'Failed to send media via QR' }, 400);
      }

      whatsappMessageId = qrData.messageId || `qr_${Date.now()}`;
    } else {
      // Business API - send via Meta
      const accessToken = phoneData.organization?.whatsapp_access_token;
      if (!accessToken) {
        return jsonResponse({ error: 'WhatsApp credentials not found for this phone number' }, 500);
      }

      // Build message body based on media type
      const messageBody: any = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: mediaType,
        // A Cloud API aceita context em qualquer tipo de mídia.
        ...(quoted ? { context: { message_id: quoted.quotedWhatsappId } } : {}),
      };

      messageBody[mediaType] = {
        link: mediaUrl,
      };

      // Add caption for image/video/document
      if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
        messageBody[mediaType].caption = caption;
      }

      // Add filename for documents
      if (mediaType === 'document') {
        messageBody[mediaType].filename = filename;
      }

      console.log(`[SendImage] Sending to WhatsApp:`, JSON.stringify(messageBody));

      const whatsappResponse = await fetch(
        `https://graph.facebook.com/v18.0/${resolvedPhone.metaId}/messages`,
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
        console.error('WhatsApp API error:', JSON.stringify(whatsappData, null, 2));

        // Provide helpful error messages based on common WhatsApp API errors
        let errorMessage = whatsappData.error?.message || 'Failed to send media';
        let errorDetails = whatsappData.error?.error_data?.details || null;

        // If media upload error, provide more context
        if (errorMessage.toLowerCase().includes('media upload') || errorMessage.toLowerCase().includes('media download')) {
          errorDetails = 'A URL da mídia deve ser: (1) publicamente acessível, (2) retornar o arquivo diretamente (não HTML/redirect), (3) ter certificado SSL válido. URLs do Google Drive, Dropbox ou compartilhamento de arquivos geralmente não funcionam. Use links diretos de CDN ou URLs do Supabase Storage.';
        }

        return jsonResponse({
          error: errorMessage,
          error_code: whatsappData.error?.code,
          error_details: errorDetails,
          whatsapp_error: whatsappData.error
        }, 400);
      }

      whatsappMessageId = whatsappData.messages[0].id;
    }

    // Save message to database
    const messageContent = caption || `[${mediaType === 'image' ? 'Imagem' : mediaType === 'video' ? 'Vídeo' : mediaType === 'audio' ? 'Áudio' : 'Documento'}]`;

    const { data: newMessage, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: convId,
        content: messageContent,
        direction: 'outbound',
        sent_by: userId || null,
        whatsapp_message_id: whatsappMessageId,
        message_type: mediaType,
        media_url: mediaUrl,
        media_mime_type: mimeType,
        media_filename: filename,
        media_size_bytes: fileSize,
        quoted_message_id: quoted?.quotedLocalId ?? null,
        metadata: { ...apiOriginMetadata(caller), ...(marcaDisparo ? { disparo: marcaDisparo } : {}) },
      })
      .select()
      .single();

    if (msgError) {
      console.error('Error saving message to DB:', msgError);
      return jsonResponse({
        error: 'Media sent to WhatsApp but failed to save to database',
        whatsapp_message_id: whatsappMessageId,
        media_url: mediaUrl,
        db_error: msgError.message
      }, 500);
    }

    // Disparo: posição e status ficam com o gatilho on_message_inserted (aba Disparos).
    if (!marcaDisparo) {
      await supabase
        .from('conversations')
        .update({
          last_message_at: new Date().toISOString(),
          status: 'active'
        })
        .eq('id', convId);
    }

    if (newMessage) {
      await emitMessageSent(supabase, {
        conversationId: convId,
        messageId: newMessage.id,
        whatsappMessageId,
        content: messageContent,
        messageType: mediaType,
        sentBy: userId || null,
        origin: 'api',
        phoneNumberDbId: phoneData.id,
        organizationId,
        metaPhoneNumberId: phoneData.phone_number_id,
        media: {
          url: mediaUrl,
          mime_type: mimeType,
          filename,
          size_bytes: fileSize,
        },
      });
    }

    return jsonResponse({
      success: true,
      whatsapp_message_id: whatsappMessageId,
      media_url: mediaUrl,
      conversation_id: convId,
      conversation_created: conversationCreated,
      message: newMessage
    });
  } catch (error: any) {
    console.error('Error sending image:', error);
    return jsonResponse({ success: false, error: friendlyError(error.message) }, 500);
  }
}

// Envia uma mensagem de VOZ (PTT / nota de voz), a "bolinha com onda" gravada.
// Aceita áudio em qualquer formato (MP3, M4A, OGG, WebM...) via JSON media_url ou
// multipart file — o qr-service transcodifica para OGG/Opus antes de enviar.
// Só funciona em números conectados por QR: PTT é recurso do app/WhatsApp Web e o
// caminho é o qr-service /message/send-voice. Business API não envia nota de voz.
async function handleSendVoice(req: Request, supabase: any, organizationId: string, caller: ApiCaller) {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const contentType = req.headers.get('content-type') || '';

    let to: string;
    let phoneNumberId: string;
    let conversationId: string | null = null;
    let userId: string | null = null;
    let mediaUrl: string;
    let mimeType: string;
    let filename: string;
    let replyTo: string | null = null;
    let marcaDisparo: ReturnType<typeof lerDisparo> = null;

    // Aceita JSON (media_url) ou multipart/form-data (file), como o /send-image
    if (contentType.includes('application/json')) {
      const body = await req.json();
      marcaDisparo = lerDisparo(body.disparo);
      to = body.to;
      phoneNumberId = body.phone_number_id;
      conversationId = body.conversation_id || null;
      userId = body.user_id || null;
      replyTo = body.reply_to || null;
      mediaUrl = body.media_url;
      mimeType = body.mime_type || 'audio/ogg';
      filename = body.filename || 'audio';

      if (!to || !phoneNumberId || !mediaUrl) {
        return jsonResponse({
          error: 'Missing required fields',
          required: ['to', 'phone_number_id', 'media_url'],
          optional: ['conversation_id', 'user_id', 'mime_type', 'filename', 'reply_to', 'disparo'],
          note: 'Use JSON with media_url or multipart/form-data with file'
        }, 400);
      }
    } else {
      const formData = await req.formData();
      const file = formData.get('file') as File;
      to = formData.get('to') as string;
      phoneNumberId = formData.get('phone_number_id') as string;
      conversationId = formData.get('conversation_id') as string | null;
      userId = formData.get('user_id') as string | null;
      replyTo = (formData.get('reply_to') as string | null) || null;

      if (!file || !to || !phoneNumberId) {
        return jsonResponse({
          error: 'Missing required fields',
          required: ['file', 'to', 'phone_number_id'],
          optional: ['conversation_id', 'user_id', 'reply_to'],
          note: 'Use multipart/form-data with file or JSON with media_url'
        }, 400);
      }

      mimeType = file.type || 'audio/ogg';
      filename = file.name || 'audio';

      const sanitizeFilename = (name: string) => name
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-zA-Z0-9.-]/g, "_")
        .replace(/_{2,}/g, "_");

      const fileBuffer = await file.arrayBuffer();
      const sanitizedName = sanitizeFilename(filename);
      const storagePath = `outbound/${userId || 'api'}/${Date.now()}_${sanitizedName}`;

      const { error: uploadError } = await supabase.storage
        .from('attachments')
        .upload(storagePath, fileBuffer, { contentType: mimeType, upsert: false });

      if (uploadError) {
        console.error('[SendVoice] Storage upload error:', uploadError);
        return jsonResponse({ error: 'Failed to upload file to storage' }, 500);
      }

      mediaUrl = urlPublicaDoAnexo(storagePath);
      console.log(`[SendVoice] Uploaded to: ${mediaUrl}`);
    }

    const direct = await rejectIfDirect(supabase, 'SendVoice', to, conversationId);
    if (direct) return direct;

    // Resolve phone number ID
    const resolvedPhone = await resolvePhoneNumberId(supabase, phoneNumberId);
    if (!resolvedPhone) {
      return jsonResponse({
        error: 'Phone number not found',
        message: 'The provided phone_number_id does not exist in the database'
      }, 404);
    }

    const { data: phoneData, error: phoneError } = await supabase
      .from('phone_numbers')
      .select('id, phone_number_id, connection_type')
      .eq('id', resolvedPhone.dbId)
      .eq('organization_id', organizationId)
      .single();

    if (phoneError || !phoneData) {
      return jsonResponse({ error: 'Phone number not found in organization' }, 404);
    }

    // PTT só é suportado em conexões QR (Baileys). Business API (Meta) não envia nota de voz.
    if (phoneData.connection_type !== 'qr') {
      return jsonResponse({
        error: 'Voice notes (PTT) are only supported on QR-connected numbers',
        detail: 'This phone number uses the WhatsApp Business API, which does not send push-to-talk voice notes. Use a QR-connected number, or send the audio as a file via /send-image.'
      }, 400);
    }

    // Find or create conversation if not provided
    let convId = conversationId;
    let conversationCreated = false;
    if (convId) {
      const hasAccess = await verifyConversationOrg(supabase, convId, organizationId);
      if (!hasAccess) {
        return jsonResponse({ error: 'Conversation not found in organization' }, 404);
      }
    } else {
      const conv = await findOrCreateConversation(supabase, to, resolvedPhone.dbId, userId || undefined);
      if (!conv) {
        return jsonResponse({ error: 'Failed to find or create conversation' }, 500);
      }
      convId = conv.id;
      conversationCreated = conv.isNew;
    }

    // Citação, se pedida — resolvida antes do envio.
    let quoted: QuotedContext | null = null;
    if (replyTo) {
      const resolved = await resolveQuoted(supabase, replyTo, convId);
      if ('failure' in resolved) return jsonResponse(resolved.failure, 400);
      quoted = resolved.quoted;
    }

    // Encaminha pro qr-service, que transcodifica p/ opus e envia como PTT
    const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
    if (!qrServiceUrl) {
      return jsonResponse({ error: 'QR_SERVICE_URL not configured' }, 500);
    }

    let fileBlob: Blob;
    try {
      const fileResponse = await fetchMidia(mediaUrl);
      if (!fileResponse.ok) {
        return jsonResponse({ error: 'Failed to fetch media from URL' }, 400);
      }
      fileBlob = await fileResponse.blob();
    } catch (fetchErr: any) {
      console.error('[SendVoice] Failed to fetch media URL:', fetchErr?.message);
      return jsonResponse({ error: `Failed to fetch media: ${fetchErr?.message}` }, 400);
    }

    const qrFormData = new FormData();
    qrFormData.append('file', fileBlob, filename);
    qrFormData.append('to', to);
    if (quoted) {
      qrFormData.append('quotedMessageId', quoted.quotedWhatsappId);
      if (quoted.quotedContent) qrFormData.append('quotedContent', quoted.quotedContent);
      qrFormData.append('quotedFromMe', String(quoted.quotedFromMe));
      if (quoted.quotedParticipant) qrFormData.append('quotedParticipant', quoted.quotedParticipant);
    }
    qrFormData.append('skipSave', 'true');

    console.log(`[SendVoice] Sending to QR service: ${qrServiceUrl}/message/send-voice/${phoneData.id}`);

    let qrResponse: Response;
    try {
      qrResponse = await fetch(`${qrServiceUrl}/message/send-voice/${phoneData.id}`, {
        method: 'POST',
        headers: qrAuthHeaders(),
        body: qrFormData,
      });
    } catch (fetchErr: any) {
      console.error('[SendVoice] QR service error:', fetchErr?.message);
      return jsonResponse({ error: `QR service unreachable: ${fetchErr?.message || 'Network error'}` }, 500);
    }

    const qrData = await qrResponse.json();
    if (!qrResponse.ok) {
      console.error('[SendVoice] QR service error:', qrData);
      return jsonResponse({ error: qrData.error || 'Failed to send voice via QR' }, 400);
    }

    const whatsappMessageId = qrData.messageId || `qr_${Date.now()}`;

    // Save message to database (message_type 'ptt'; entregue como opus)
    const { data: newMessage, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: convId,
        content: '[Mensagem de voz]',
        direction: 'outbound',
        sent_by: userId || null,
        whatsapp_message_id: whatsappMessageId,
        message_type: 'ptt',
        media_url: mediaUrl,
        media_mime_type: 'audio/ogg; codecs=opus',
        media_filename: filename,
        quoted_message_id: quoted?.quotedLocalId ?? null,
        metadata: { ...apiOriginMetadata(caller), ...(marcaDisparo ? { disparo: marcaDisparo } : {}) },
      })
      .select()
      .single();

    if (msgError) {
      console.error('[SendVoice] Error saving message to DB:', msgError);
      return jsonResponse({
        error: 'Voice sent to WhatsApp but failed to save to database',
        whatsapp_message_id: whatsappMessageId,
        media_url: mediaUrl,
        db_error: msgError.message
      }, 500);
    }

    if (!marcaDisparo) {
      await supabase
        .from('conversations')
        .update({ last_message_at: new Date().toISOString(), status: 'active' })
        .eq('id', convId);
    }

    if (newMessage) {
      await emitMessageSent(supabase, {
        conversationId: convId,
        messageId: newMessage.id,
        whatsappMessageId,
        content: '[Mensagem de voz]',
        messageType: 'ptt',
        sentBy: userId || null,
        origin: 'api',
        phoneNumberDbId: phoneData.id,
        organizationId,
        metaPhoneNumberId: phoneData.phone_number_id,
        media: {
          url: mediaUrl,
          mime_type: 'audio/ogg; codecs=opus',
          filename,
        },
      });
    }

    return jsonResponse({
      success: true,
      whatsapp_message_id: whatsappMessageId,
      media_url: mediaUrl,
      conversation_id: convId,
      conversation_created: conversationCreated,
      message: newMessage
    });
  } catch (error: any) {
    console.error('Error sending voice:', error);
    return jsonResponse({ success: false, error: friendlyError(error.message) }, 500);
  }
}

// ============ SEND STICKER ============
// Figurinha é webp com regras próprias: 512x512 e ≤100KB (estático) ou ≤500KB
// (animado). O Baileys envia qualquer webp; a Meta rejeita fora da spec com erro
// críptico. Três fontes de entrada:
//   sticker_id  → figurinha da coleção de um usuário (já normalizada, com a flag
//                 meta_compliant conferida)
//   sticker_url → webp pronto (enviado como está) ou imagem comum (convertida
//                 pelo /sticker/convert do qr-service)
//   file        → o mesmo, por multipart
async function handleSendSticker(req: Request, supabase: any, organizationId: string, caller: ApiCaller) {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const contentType = req.headers.get('content-type') || '';

    let to: string;
    let phoneNumberId: string;
    let conversationId: string | null = null;
    let userId: string | null = null;
    let replyTo: string | null = null;
    let stickerId: string | null = null;
    let stickerUrl: string | null = null;
    let uploaded: { bytes: ArrayBuffer; mimeType: string } | null = null;

    if (contentType.includes('application/json')) {
      const body = await req.json();
      to = body.to;
      phoneNumberId = body.phone_number_id;
      conversationId = body.conversation_id || null;
      userId = body.user_id || null;
      replyTo = body.reply_to || null;
      stickerId = body.sticker_id || null;
      stickerUrl = body.sticker_url || null;

      if (!to || !phoneNumberId || (!stickerUrl && !stickerId)) {
        return jsonResponse({
          error: 'Missing required fields',
          required: ['to', 'phone_number_id'],
          optional: ['sticker_url', 'sticker_id', 'conversation_id', 'user_id', 'reply_to'],
          note: 'Send "sticker_url" (a webp, or any image to be converted), "sticker_id" (from a user collection, requires user_id), or multipart/form-data with file.'
        }, 400);
      }
    } else {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      to = formData.get('to') as string;
      phoneNumberId = formData.get('phone_number_id') as string;
      conversationId = formData.get('conversation_id') as string | null;
      userId = formData.get('user_id') as string | null;
      replyTo = (formData.get('reply_to') as string | null) || null;
      stickerId = (formData.get('sticker_id') as string | null) || null;

      if (!to || !phoneNumberId || (!file && !stickerId)) {
        return jsonResponse({
          error: 'Missing required fields',
          required: ['to', 'phone_number_id'],
          optional: ['file', 'sticker_id', 'conversation_id', 'user_id', 'reply_to'],
          note: 'Send "file" (a webp, or any image to be converted) or "sticker_id" (requires user_id).'
        }, 400);
      }

      if (file) {
        uploaded = { bytes: await file.arrayBuffer(), mimeType: file.type || 'application/octet-stream' };
      }
    }

    if (stickerId && !userId) {
      return jsonResponse({
        error: 'sticker_id requires user_id',
        note: 'A sticker collection belongs to a user, so the owner must be identified.',
      }, 400);
    }

    const direct = await rejectIfDirect(supabase, 'SendSticker', to, conversationId);
    if (direct) return direct;

    const resolvedPhone = await resolvePhoneNumberId(supabase, phoneNumberId);
    if (!resolvedPhone) {
      return jsonResponse({
        error: 'Phone number not found',
        message: 'The provided phone_number_id does not exist in the database'
      }, 404);
    }

    const { data: phoneData } = await supabase
      .from('phone_numbers')
      .select('id, phone_number_id, connection_type, organization:organizations(whatsapp_access_token)')
      .eq('id', resolvedPhone.dbId)
      .eq('organization_id', organizationId)
      .single();

    if (!phoneData) {
      return jsonResponse({ error: 'Phone number not found in organization' }, 404);
    }

    if (userId && !(await isOrgMember(supabase, userId, organizationId))) {
      return jsonResponse({
        error: 'User not found in organization',
        message: 'The provided user_id is not a member of this organization'
      }, 404);
    }

    const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
    let mediaUrl: string;
    let sizeBytes: number | null = null;
    let isAnimated = false;

    if (stickerId) {
      const { data: sticker } = await supabase
        .from('user_stickers')
        .select('user_id, file_url, is_animated, size_bytes, meta_compliant')
        .eq('id', stickerId)
        .maybeSingle();

      // Mesma resposta para "não existe" e "não é seu": não vazar existência.
      if (!sticker || sticker.user_id !== userId) {
        return jsonResponse({
          error: 'Sticker not found',
          note: 'The sticker does not exist or does not belong to the given user_id.',
        }, 404);
      }

      if (phoneData.connection_type !== 'qr' && !sticker.meta_compliant) {
        return jsonResponse({
          error: 'Sticker outside WhatsApp spec',
          note: 'This sticker is outside the Meta spec (512x512, ≤100KB static / ≤500KB animated) and can only be sent from a QR number.',
        }, 400);
      }

      mediaUrl = sticker.file_url;
      sizeBytes = sticker.size_bytes;
      isAnimated = sticker.is_animated === true;
    } else {
      // Bytes de entrada: do upload, ou baixados da sticker_url.
      let bytes: ArrayBuffer;
      let inputMime: string;

      if (uploaded) {
        bytes = uploaded.bytes;
        inputMime = uploaded.mimeType;
      } else {
        try {
          const res = await fetchMidia(stickerUrl!);
          if (!res.ok) {
            return jsonResponse({ error: 'Failed to fetch sticker_url', detail: `Responded ${res.status}` }, 400);
          }
          inputMime = res.headers.get('content-type') || 'application/octet-stream';
          bytes = await res.arrayBuffer();
        } catch (fetchErr: any) {
          return jsonResponse({ error: `Failed to fetch sticker_url: ${fetchErr?.message || 'Network error'}` }, 400);
        }
      }

      // webp já é figurinha; qualquer outra imagem passa pelo conversor do
      // qr-service (sharp), que é o único caminho que codifica webp ANIMADO.
      if (!inputMime.includes('webp')) {
        if (!qrServiceUrl) {
          return jsonResponse({ error: 'QR_SERVICE_URL not configured. Please add it to Edge Function secrets.' }, 500);
        }

        const convertForm = new FormData();
        convertForm.append('file', new Blob([bytes], { type: inputMime }), 'input');

        let convertRes: Response;
        try {
          convertRes = await fetch(`${qrServiceUrl}/sticker/convert`, {
            method: 'POST',
            headers: qrAuthHeaders(),
            body: convertForm,
          });
        } catch (fetchErr: any) {
          return jsonResponse({ error: `QR service unreachable: ${fetchErr?.message || 'Network error'}` }, 502);
        }

        if (!convertRes.ok) {
          const err = await convertRes.json().catch(() => ({}));
          // 422 do conversor = imagem complexa demais para caber no limite.
          return jsonResponse(
            { error: err.error || 'Failed to convert image to sticker' },
            convertRes.status === 422 ? 422 : 400
          );
        }

        isAnimated = convertRes.headers.get('X-Sticker-Animated') === 'true';
        bytes = await convertRes.arrayBuffer();
      }

      sizeBytes = bytes.byteLength;

      // A figurinha precisa de URL pública: é o que a Cloud API manda como link
      // e o que o painel usa para renderizar a bolha depois.
      const storagePath = `outbound/${userId || 'api'}/${Date.now()}_sticker.webp`;
      const { error: uploadError } = await supabase.storage
        .from('attachments')
        .upload(storagePath, bytes, { contentType: 'image/webp', upsert: false });

      if (uploadError) {
        console.error('[SendSticker] Storage upload error:', uploadError);
        return jsonResponse({ error: 'Failed to upload sticker to storage' }, 500);
      }

      mediaUrl = urlPublicaDoAnexo(storagePath);
    }

    // Conversa
    let convId = conversationId;
    let conversationCreated = false;
    if (convId) {
      const hasAccess = await verifyConversationOrg(supabase, convId, organizationId);
      if (!hasAccess) {
        return jsonResponse({ error: 'Conversation not found in organization' }, 404);
      }
    } else {
      const conv = await findOrCreateConversation(supabase, to, resolvedPhone.dbId, userId || undefined);
      if (!conv) {
        return jsonResponse({ error: 'Failed to find or create conversation' }, 500);
      }
      convId = conv.id;
      conversationCreated = conv.isNew;
    }

    let quoted: QuotedContext | null = null;
    if (replyTo) {
      const resolved = await resolveQuoted(supabase, replyTo, convId);
      if ('failure' in resolved) return jsonResponse(resolved.failure, 400);
      quoted = resolved.quoted;
    }

    let whatsappMessageId: string;

    if (phoneData.connection_type === 'qr') {
      if (!qrServiceUrl) {
        return jsonResponse({ error: 'QR_SERVICE_URL not configured. Please add it to Edge Function secrets.' }, 500);
      }

      let fileBlob: Blob;
      try {
        const fileResponse = await fetchMidia(mediaUrl);
        if (!fileResponse.ok) {
          return jsonResponse({ error: 'Failed to fetch sticker file' }, 400);
        }
        fileBlob = await fileResponse.blob();
      } catch (fetchErr: any) {
        return jsonResponse({ error: `Failed to fetch sticker file: ${fetchErr?.message || 'Network error'}` }, 400);
      }

      const qrFormData = new FormData();
      qrFormData.append('file', fileBlob, 'sticker.webp');
      qrFormData.append('to', to);
      // Sticker não tem caption no WhatsApp — nem mandamos o campo.
      qrFormData.append('isSticker', 'true');
      qrFormData.append('isAnimated', String(isAnimated));
      if (quoted) {
        qrFormData.append('quotedMessageId', quoted.quotedWhatsappId);
        if (quoted.quotedContent) qrFormData.append('quotedContent', quoted.quotedContent);
        qrFormData.append('quotedFromMe', String(quoted.quotedFromMe));
        if (quoted.quotedParticipant) qrFormData.append('quotedParticipant', quoted.quotedParticipant);
      }
      qrFormData.append('skipSave', 'true');

      let qrResponse: Response;
      try {
        qrResponse = await fetch(`${qrServiceUrl}/message/send-media/${phoneData.id}`, {
          method: 'POST',
          headers: qrAuthHeaders(),
          body: qrFormData,
        });
      } catch (fetchErr: any) {
        console.error('[SendSticker] QR service error:', fetchErr?.message);
        return jsonResponse({ error: `QR service unreachable: ${fetchErr?.message || 'Network error'}` }, 502);
      }

      const qrData = await qrResponse.json().catch(() => ({}));
      if (!qrResponse.ok) {
        console.error('[SendSticker] Baileys service error:', qrData);
        return jsonResponse({ error: qrData.error || 'Failed to send sticker via QR' }, 400);
      }

      whatsappMessageId = qrData.messageId || `qr_${Date.now()}`;
    } else {
      const orgData = Array.isArray(phoneData.organization) ? phoneData.organization[0] : phoneData.organization;
      const accessToken = orgData?.whatsapp_access_token;
      if (!accessToken) {
        return jsonResponse({ error: 'WhatsApp credentials not found for this phone number' }, 500);
      }

      const whatsappResponse = await fetch(
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
            to,
            ...(quoted ? { context: { message_id: quoted.quotedWhatsappId } } : {}),
            type: 'sticker',
            sticker: { link: mediaUrl },
          }),
        }
      );

      const whatsappData = await whatsappResponse.json().catch(() => ({}));
      if (!whatsappResponse.ok) {
        console.error('[SendSticker] Cloud API error:', whatsappData);
        return jsonResponse({
          error: whatsappData.error?.message || 'Failed to send sticker',
          error_code: whatsappData.error?.code,
          // A Meta recusa webp fora da spec com mensagem obscura — dizer o que
          // costuma ser poupa uma hora de investigação de quem integra.
          note: 'The Meta API only accepts stickers within spec: webp, 512x512, ≤100KB static / ≤500KB animated.',
        }, 400);
      }

      whatsappMessageId = whatsappData.messages[0].id;
    }

    const { data: newMessage, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: convId,
        content: '[Sticker]',
        direction: 'outbound',
        sent_by: userId || null,
        whatsapp_message_id: whatsappMessageId,
        message_type: 'sticker',
        media_url: mediaUrl,
        media_mime_type: 'image/webp',
        media_filename: 'sticker.webp',
        media_size_bytes: sizeBytes,
        quoted_message_id: quoted?.quotedLocalId ?? null,
        metadata: apiOriginMetadata(caller),
      })
      .select()
      .single();

    if (msgError) {
      console.error('[SendSticker] Error saving message to DB:', msgError);
      return jsonResponse({
        error: 'Sticker sent to WhatsApp but failed to save to database',
        whatsapp_message_id: whatsappMessageId,
        media_url: mediaUrl,
        db_error: msgError.message
      }, 500);
    }

    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString(), status: 'active' })
      .eq('id', convId);

    if (newMessage) {
      await emitMessageSent(supabase, {
        conversationId: convId,
        messageId: newMessage.id,
        whatsappMessageId,
        content: '[Sticker]',
        messageType: 'sticker',
        sentBy: userId || null,
        origin: 'api',
        phoneNumberDbId: phoneData.id,
        organizationId,
        metaPhoneNumberId: phoneData.phone_number_id,
        media: {
          url: mediaUrl,
          mime_type: 'image/webp',
          filename: 'sticker.webp',
          size_bytes: sizeBytes,
        },
      });
    }

    return jsonResponse({
      success: true,
      whatsapp_message_id: whatsappMessageId,
      media_url: mediaUrl,
      animated: isAnimated,
      conversation_id: convId,
      conversation_created: conversationCreated,
      message: newMessage
    });
  } catch (error: any) {
    console.error('Error sending sticker:', error);
    return jsonResponse({ success: false, error: friendlyError(error.message) }, 500);
  }
}

// ============ SCHEDULED MESSAGES ============
//
// Tradução do agendamento que já existia só no dashboard. O motor de execução
// não muda: uma linha inserida aqui é indistinguível da que o front insere, e o
// cron `process-scheduled-messages` a entrega para a função
// `scheduled-message-execute` na hora marcada.
//
// DELETE é cancelamento lógico (status='cancelled'), não remoção, igual ao
// dashboard — o histórico de "isso ia ser enviado e foi cancelado" tem valor.

/** Estados que o filtro de listagem aceita. Espelha o CHECK da coluna. */
const SCHEDULED_STATUSES = ['scheduled', 'processing', 'sent', 'failed', 'cancelled'] as const;

/** Formatos de header de template que a Meta aceita como mídia. */
const HEADER_MEDIA_FORMATS = ['IMAGE', 'VIDEO', 'DOCUMENT'] as const;

/**
 * O cron roda a cada minuto, então qualquer coisa abaixo de uma tick é "agora"
 * com passos extras. Recusar é mais honesto que aceitar e entregar atrasado.
 */
const MIN_SCHEDULE_LEAD_MS = 60 * 1000;

const MAX_SCHEDULED_PAGE_SIZE = 200;

/**
 * `scheduled_at` exige offset explícito (`-03:00`) ou `Z`.
 *
 * O dashboard só funciona sem isso porque o `<input type="datetime-local">` é
 * resolvido pelo fuso do browser antes de virar ISO. A API não tem browser: um
 * "2026-08-20T15:00:00" cru não tem resposta certa, e escolher um fuso por
 * omissão erraria silenciosamente para todo integrador fora dele — do tipo de
 * erro que só aparece quando a mensagem chega três horas fora de hora.
 */
function parseScheduledAt(raw: unknown): { at: Date } | { error: Record<string, unknown> } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return {
      error: {
        error: 'Invalid scheduled_at',
        note: 'scheduled_at must be an ISO 8601 string with an explicit UTC offset or "Z". Example: "2026-08-20T15:00:00-03:00"',
      },
    };
  }

  const value = raw.trim();

  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    return {
      error: {
        error: 'scheduled_at is missing a timezone offset',
        example: '2026-08-20T15:00:00-03:00',
        note: 'A naive datetime like "2026-08-20T15:00:00" is ambiguous — the API has no browser timezone to resolve it against. Append the offset ("-03:00") or send UTC ("Z").',
      },
    };
  }

  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    return {
      error: {
        error: 'Invalid scheduled_at',
        example: '2026-08-20T15:00:00-03:00',
        note: 'Could not parse the value as a date.',
      },
    };
  }

  if (at.getTime() - Date.now() < MIN_SCHEDULE_LEAD_MS) {
    return {
      error: {
        error: 'scheduled_at is too soon',
        note: 'scheduled_at must be at least 60 seconds in the future (the scheduler runs once a minute). To send right now, use POST /send-message or /send-template instead.',
      },
    };
  }

  return { at };
}

/** Aceita array ou string separada por ponto-e-vírgula, igual /send-template. */
function toVariableArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v));
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(';').map((s) => s.trim());
  }
  return [];
}

/**
 * Normaliza o header de mídia para a forma que o executor espera. Ele faz
 * `String(format).toLowerCase()` e checa image/video/document, então aceitar
 * qualquer caixa aqui é seguro; gravamos em maiúsculas para casar com o que o
 * dashboard grava (`src/lib/templateMedia.ts`).
 */
function normalizeHeaderMedia(
  raw: unknown
): { media: Record<string, string> } | { error: Record<string, unknown> } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      error: {
        error: 'header_media must be an object',
        example: { format: 'IMAGE', link: 'https://cdn.exemplo.com/foto.jpg' },
      },
    };
  }

  const { format, link, filename } = raw as Record<string, unknown>;
  const upper = String(format || '').toUpperCase();

  if (!HEADER_MEDIA_FORMATS.includes(upper as typeof HEADER_MEDIA_FORMATS[number])) {
    return { error: { error: 'Invalid header_media.format', allowed: [...HEADER_MEDIA_FORMATS] } };
  }

  if (typeof link !== 'string' || !link.trim()) {
    return {
      error: {
        error: 'header_media.link is required',
        note: 'Must be a public URL that returns the file directly.',
      },
    };
  }

  const media: Record<string, string> = { format: upper, link: link.trim() };
  if (typeof filename === 'string' && filename.trim()) media.filename = filename.trim();
  return { media };
}

/** Membro da org? Mesmo padrão dos outros endpoints que aceitam user_id. */
async function isOrgMember(supabase: any, userId: string, organizationId: string): Promise<boolean> {
  const { data } = await supabase
    .from('organization_members')
    .select('user_id')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  return !!data;
}

/**
 * Carrega o agendamento garantindo escopo de organização. O client é
 * service-role e ignora RLS, então esse filtro é a única fronteira de tenant.
 */
async function loadScheduledMessage(supabase: any, id: string, organizationId: string) {
  const { data } = await supabase
    .from('scheduled_messages')
    .select('*')
    .eq('id', id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  return data;
}

async function createScheduledMessage(req: Request, supabase: any, organizationId: string) {
  const {
    to,
    phone_number_id,
    scheduled_at,
    message,
    template_name,
    language_code = 'pt_BR',
    body_parameters,
    button_parameters,
    header_media,
    conversation_id,
    user_id,
    quoted_message_id,
    mentions,
    contact_name,
  } = await req.json().catch(() => ({}));

  // message_type é inferido, não recebido: um campo a mais para o integrador
  // contradizer o próprio payload não compra nada.
  const isTemplate = !!template_name;

  if (isTemplate && message) {
    return jsonResponse({
      error: 'Ambiguous message type',
      note: 'Send either "message" (free text) or "template_name" (approved template), never both. message_type is inferred from which one you use.',
    }, 400);
  }

  // Destinatário: "to" ou "conversation_id" (com conversation_id o destino sai
  // da conversa e o "to" é ignorado). Este erro não pode ter chave required: —
  // o teste de contrato da doc intersecta os arrays required deste handler.
  if (!to && !conversation_id) {
    return jsonResponse({
      error: 'Missing recipient',
      note: 'Provide "to" (phone number, or group JID on QR numbers) or "conversation_id".',
    }, 400);
  }

  if (isTemplate) {
    if (!phone_number_id || !scheduled_at || !template_name) {
      return jsonResponse({
        error: 'Missing required fields',
        required: ['phone_number_id', 'scheduled_at', 'template_name'],
        optional: ['to', 'language_code', 'body_parameters', 'button_parameters', 'header_media', 'conversation_id', 'user_id', 'contact_name'],
        note: '"to" is required unless "conversation_id" is provided. Template scheduling requires a Business API number. For free text send "message" instead of "template_name".',
      }, 400);
    }
  } else if (!phone_number_id || !scheduled_at || !message) {
    return jsonResponse({
      error: 'Missing required fields',
      required: ['phone_number_id', 'scheduled_at', 'message'],
      optional: ['to', 'conversation_id', 'user_id', 'quoted_message_id', 'mentions', 'contact_name'],
      note: '"to" is required unless "conversation_id" is provided. scheduled_at must be ISO 8601 with an explicit offset ("2026-08-20T15:00:00-03:00"). To schedule a template, send "template_name" instead of "message".',
    }, 400);
  }

  const parsed = parseScheduledAt(scheduled_at);
  if ('error' in parsed) return jsonResponse(parsed.error, 400);

  const direct = await rejectIfDirect(supabase, 'ScheduleMessage', to, conversation_id);
  if (direct) return direct;

  const phoneNumber = await resolvePhoneNumberId(supabase, phone_number_id);
  if (!phoneNumber) {
    return jsonResponse({
      error: 'Phone number not found',
      message: 'The provided phone_number_id does not exist in the database'
    }, 404);
  }

  const { data: phoneData } = await supabase
    .from('phone_numbers')
    .select('connection_type')
    .eq('id', phoneNumber.dbId)
    .eq('organization_id', organizationId)
    .single();

  if (!phoneData) {
    return jsonResponse({ error: 'Phone number not found in organization' }, 404);
  }

  // Falhar AQUI, e não na hora do envio. O executor também rejeita template em
  // qr, mas isso acontece horas depois, quando o único sinal é uma linha
  // 'failed' que ninguém está olhando.
  if (isTemplate && phoneData.connection_type !== 'business_api') {
    return jsonResponse({
      error: 'Templates are only supported on Business API numbers',
      detail: `This phone number uses connection_type="${phoneData.connection_type}"`,
      note: 'Schedule free text with "message" instead, or use a Business API number.',
    }, 400);
  }

  // Mesma razão da guarda de template: grupos só existem em conexões QR, e sem
  // esta checagem o agendamento para @g.us num número Cloud API vira uma
  // linha 'failed' horas depois, que ninguém está olhando. O caminho via
  // conversation_id dispensa a guarda: conversa de grupo só nasce em número QR
  // e a checagem conversa×número abaixo já amarra os dois.
  const targetsGroup = typeof to === 'string' && to.trim().endsWith(GROUP_JID_SUFFIX);
  if (targetsGroup && !conversation_id && phoneData.connection_type !== 'qr') {
    return jsonResponse({
      error: 'Group messages are only supported on QR (Baileys) numbers',
      detail: `This phone number uses connection_type="${phoneData.connection_type}"`,
      note: 'Group JIDs ("...@g.us") only exist on QR connections.',
    }, 400);
  }

  let headerMedia: Record<string, string> | null = null;
  if (header_media !== undefined && header_media !== null) {
    const normalized = normalizeHeaderMedia(header_media);
    if ('error' in normalized) return jsonResponse(normalized.error, 400);
    headerMedia = normalized.media;
  }

  if (user_id && !(await isOrgMember(supabase, user_id, organizationId))) {
    return jsonResponse({
      error: 'User not found in organization',
      message: 'The provided user_id is not a member of this organization'
    }, 404);
  }

  // Resolve a conversa
  let convId = conversation_id;
  let conversationCreated = false;

  if (convId) {
    const hasAccess = await verifyConversationOrg(supabase, convId, organizationId);
    if (!hasAccess) {
      return jsonResponse({ error: 'Conversation not found in organization' }, 404);
    }
  } else {
    const conv = await findOrCreateConversation(supabase, to, phoneNumber.dbId, user_id);
    if (!conv) {
      return jsonResponse({ error: 'Failed to find or create conversation' }, 500);
    }
    convId = conv.id;
    conversationCreated = conv.isNew;
  }

  // O destino gravado vem da CONVERSA, não do `to` cru.
  //
  // O executor usa `scheduled_messages.contact_phone` como destinatário. A
  // conversa guarda a forma canônica: JID completo com "@g.us" em grupo, número
  // normalizado com "55" em 1:1. Copiar o `to` do integrador aqui reintroduziria
  // exatamente a divergência que findOrCreateGroupConversation existe para
  // evitar — o envio iria para um endereço que não é o da thread arquivada.
  const { data: convData } = await supabase
    .from('conversations')
    .select('contact_phone, contact_name, phone_number_id')
    .eq('id', convId)
    .single();

  if (!convData) {
    return jsonResponse({ error: 'Conversation not found' }, 404);
  }

  // A conversa tem de ser DESTE número, não só da mesma organização.
  //
  // verifyConversationOrg só checa a organização, e os endpoints de envio param
  // aí porque a mensagem vai embora na hora. Aqui a linha fica gravada: um
  // conversation_id de outro número produziria um agendamento que envia pelo
  // número Y e arquiva na thread do número X. Barato de checar (o phone_number_id
  // vem no mesmo select) e caro de descobrir depois.
  if (convData.phone_number_id !== phoneNumber.dbId) {
    return jsonResponse({
      error: 'Conversation belongs to a different phone number',
      note: 'The conversation_id must belong to the phone_number_id you are scheduling from.',
    }, 400);
  }

  if (quoted_message_id) {
    const { data: quoted } = await supabase
      .from('messages')
      .select('id')
      .eq('id', quoted_message_id)
      .eq('conversation_id', convId)
      .maybeSingle();

    if (!quoted) {
      return jsonResponse({
        error: 'quoted_message_id does not belong to this conversation',
        note: 'A reply can only quote a message from the same conversation.',
      }, 400);
    }
  }

  const row: Record<string, unknown> = {
    organization_id: organizationId,
    phone_number_id: phoneNumber.dbId,
    conversation_id: convId,
    message_type: isTemplate ? 'template' : 'text',
    contact_phone: convData.contact_phone,
    contact_name: contact_name || convData.contact_name || null,
    scheduled_at: parsed.at.toISOString(),
    created_by: user_id || null,
  };

  if (isTemplate) {
    row.template_name = template_name;
    row.template_language = language_code || 'pt_BR';
    row.body_variables = toVariableArray(body_parameters);
    row.button_variables = toVariableArray(button_parameters);
    row.header_media = headerMedia;
  } else {
    row.content = message;
    row.quoted_message_id = quoted_message_id || null;
    row.mentions = Array.isArray(mentions) ? mentions : [];
  }

  const { data, error } = await supabase
    .from('scheduled_messages')
    .insert(row)
    .select()
    .single();

  if (error) {
    console.error('Error creating scheduled message:', error);
    return jsonResponse({ error: 'Failed to create scheduled message', db_error: error.message }, 400);
  }

  return jsonResponse({
    success: true,
    scheduled_message: data,
    conversation_id: convId,
    conversation_created: conversationCreated,
  }, 201);
}

async function handleScheduledMessages(
  req: Request,
  supabase: any,
  id: string,
  url: URL,
  organizationId: string
) {
  const method = req.method;

  if (method === 'POST' && !id) {
    return await createScheduledMessage(req, supabase, organizationId);
  }

  if (method === 'GET' && !id) {
    const status = url.searchParams.get('status');
    const conversationId = url.searchParams.get('conversation_id');
    const phoneNumberId = url.searchParams.get('phone_number_id');
    const limit = Math.min(
      parseInt(url.searchParams.get('limit') || '50', 10) || 50,
      MAX_SCHEDULED_PAGE_SIZE
    );
    const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;

    if (status && !SCHEDULED_STATUSES.includes(status as typeof SCHEDULED_STATUSES[number])) {
      return jsonResponse({ error: 'Invalid status', allowed: [...SCHEDULED_STATUSES] }, 400);
    }

    let query = supabase
      .from('scheduled_messages')
      .select('*')
      .eq('organization_id', organizationId)
      .order('scheduled_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (conversationId) query = query.eq('conversation_id', conversationId);

    if (phoneNumberId) {
      // Aceita UUID interno ou Meta ID, como o resto da API.
      const resolved = await resolvePhoneNumberId(supabase, phoneNumberId);
      if (!resolved) return jsonResponse({ error: 'Phone number not found' }, 404);
      query = query.eq('phone_number_id', resolved.dbId);
    }

    const { data, error } = await query;
    if (error) return jsonResponse({ error: error.message }, 400);

    return jsonResponse({ scheduled_messages: data, limit, offset });
  }

  if (method === 'GET' && id) {
    const data = await loadScheduledMessage(supabase, id, organizationId);
    if (!data) return jsonResponse({ error: 'Scheduled message not found' }, 404);
    return jsonResponse({ scheduled_message: data });
  }

  if (method === 'PATCH' && id) {
    const body = await req.json().catch(() => ({}));

    const existing = await loadScheduledMessage(supabase, id, organizationId);
    if (!existing) return jsonResponse({ error: 'Scheduled message not found' }, 404);

    // 409, não 404: "já foi enviada" e "não existe" pedem reações diferentes de
    // quem integra, e devolver 404 para uma linha que a listagem acabou de
    // mostrar seria mentira.
    if (existing.status !== 'scheduled') {
      return jsonResponse({
        error: 'Scheduled message can no longer be edited',
        status: existing.status,
        note: 'Only messages still in status "scheduled" can be updated.',
      }, 409);
    }

    const updates: Record<string, unknown> = {};

    if (body.scheduled_at !== undefined) {
      const parsed = parseScheduledAt(body.scheduled_at);
      if ('error' in parsed) return jsonResponse(parsed.error, 400);
      updates.scheduled_at = parsed.at.toISOString();
      // Reagendar limpa o backoff de uma tentativa anterior: o horário novo é a
      // intenção mais recente e deve valer sozinho.
      updates.next_attempt_at = null;
    }

    if (body.message !== undefined) {
      if (existing.message_type !== 'text') {
        return jsonResponse({
          error: 'Cannot set "message" on a template schedule',
          note: 'Use body_parameters / button_parameters to change a template schedule.',
        }, 400);
      }
      updates.content = body.message;
    }

    if (body.body_parameters !== undefined) {
      if (existing.message_type !== 'template') {
        return jsonResponse({ error: 'body_parameters only applies to template schedules' }, 400);
      }
      updates.body_variables = toVariableArray(body.body_parameters);
    }

    if (body.button_parameters !== undefined) {
      if (existing.message_type !== 'template') {
        return jsonResponse({ error: 'button_parameters only applies to template schedules' }, 400);
      }
      updates.button_variables = toVariableArray(body.button_parameters);
    }

    if (body.contact_name !== undefined) {
      updates.contact_name = body.contact_name;
    }

    if (Object.keys(updates).length === 0) {
      return jsonResponse({
        error: 'Nothing to update',
        allowed: ['scheduled_at', 'message', 'body_parameters', 'button_parameters', 'contact_name'],
      }, 400);
    }

    const { data, error } = await supabase
      .from('scheduled_messages')
      .update(updates)
      .eq('id', id)
      .eq('organization_id', organizationId)
      // Corrida com o cron: entre o SELECT acima e este UPDATE a linha pode ter
      // sido reivindicada. O filtro faz o update virar no-op nesse caso, em vez
      // de editar uma mensagem que já está sendo enviada.
      .eq('status', 'scheduled')
      .select()
      .maybeSingle();

    if (error) return jsonResponse({ error: error.message }, 400);
    if (!data) {
      return jsonResponse({
        error: 'Scheduled message can no longer be edited',
        note: 'It was picked up for sending while this request was in flight.',
      }, 409);
    }

    return jsonResponse({ success: true, scheduled_message: data });
  }

  if (method === 'DELETE' && id) {
    const existing = await loadScheduledMessage(supabase, id, organizationId);
    if (!existing) return jsonResponse({ error: 'Scheduled message not found' }, 404);

    if (existing.status !== 'scheduled') {
      return jsonResponse({
        error: 'Scheduled message can no longer be cancelled',
        status: existing.status,
        note: 'Only messages still in status "scheduled" can be cancelled.',
      }, 409);
    }

    const { data, error } = await supabase
      .from('scheduled_messages')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .eq('status', 'scheduled')
      .select()
      .maybeSingle();

    if (error) return jsonResponse({ error: error.message }, 400);
    if (!data) {
      return jsonResponse({
        error: 'Scheduled message can no longer be cancelled',
        note: 'It was picked up for sending while this request was in flight.',
      }, 409);
    }

    return jsonResponse({ success: true, scheduled_message: data });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

// ============================================================================
// BROADCASTS (disparo em massa)
// ============================================================================
//
// Tradução do wizard de 5 passos (src/components/broadcasts/BroadcastBuilder.tsx)
// para a API. O motor de entrega não muda em nada: uma linha criada aqui é
// indistinguível da que o dashboard insere, e quem entrega continua sendo o cron
// `dispatch-broadcast-work` chamando `broadcast-execute`.
//
// Três coisas que o /scheduled-messages não precisava e aqui são o núcleo:
//
// 1. ORDEM DE ESCRITA. O pai nasce 'draft' e só vira 'processing'/'scheduled' no
//    ÚLTIMO statement. Nenhum dos três crons vê um 'draft'
//    (process_scheduled_broadcasts exige 'scheduled'; o FINALIZER e o DRIVER de
//    dispatch_broadcast_work exigem 'processing'), então um timeout no meio da
//    inserção deixa uma linha inerte em vez de um disparo corrompido. Inserir já
//    como 'processing' seria uma corrida real: com zero destinatários gravados, o
//    `NOT EXISTS (pending|sending)` do FINALIZER é trivialmente verdadeiro e ele
//    marca 'completed' no meio do loop de chunks -- as outras 4.800 linhas ficam
//    'pending' para sempre, porque o DRIVER só olha 'processing'.
//
//    E o delete compensatório do front (BroadcastBuilder.tsx, insert parcial ->
//    apaga o pai) NÃO é portado: o ON DELETE CASCADE dispara
//    tr_broadcast_counts_delete por linha, então apagar um disparo com 4.800
//    linhas é o statement com mais chance de estourar o timeout -- exatamente no
//    caminho que só se alcança porque algo já estourou.
//
// 2. O TEMPLATE VEM DA META. O integrador manda só `template_name`; id,
//    components e as duas contagens de variáveis são derivadas aqui. Exigir o
//    JSON de components do integrador acoplaria ele ao formato da Meta e deixaria
//    payload inconsistente passar (contagem errada = 5.000 erros 132000, um por
//    destinatário, descobertos horas depois).
//
// 3. VALIDAÇÃO ANTES DE QUALQUER ESCRITA. Todo erro de payload é 400 com zero
//    linha gravada. O motor não tem como reclamar de um disparo mal formado: ele
//    apenas falha destinatário por destinatário, e ninguém está olhando.

/** Espelha o CHECK de broadcasts.status. */
const BROADCAST_STATUSES = ['draft', 'scheduled', 'processing', 'completed', 'failed', 'cancelled'] as const;

/** Espelha broadcast_recipients_status_check. Não existe 'cancelled' aqui. */
const BROADCAST_RECIPIENT_STATUSES = ['pending', 'sending', 'sent', 'failed'] as const;

/** Mesmo teto do importador de planilha do dashboard (MAX_IMPORT_ROWS). */
const MAX_BROADCAST_RECIPIENTS = 5000;

/** Mesmo tamanho de chunk do dashboard (RECIPIENT_INSERT_CHUNK). */
const BROADCAST_RECIPIENT_CHUNK = 200;

/**
 * Teto de corpo da requisição. 5.000 destinatários com nome e 5 variáveis dão
 * ~2 MB; 6 MB é folga para isso e recusa cedo o que não caberia na memória do
 * isolate. Sem esta guarda o excesso volta como 500 opaco.
 */
const MAX_BROADCAST_BODY_BYTES = 6 * 1024 * 1024;

const MAX_BROADCAST_PAGE_SIZE = 200;
const MAX_BROADCAST_RECIPIENT_PAGE_SIZE = 500;

/** Limite da Meta para texto de parâmetro de template. */
const MAX_TEMPLATE_VARIABLE_LENGTH = 1024;

/**
 * Nudge no worker, só para latência.
 *
 * `broadcast-execute` não está no config.toml, então roda com verify_jwt=true --
 * mas dispatch_broadcast_work já o chama em produção com Bearer service_role_key,
 * e esta função tem a mesma chave.
 *
 * Nunca `supabase.functions.invoke` esperado: o worker tem WORKER_BUDGET_MS de
 * 40s e o POST ficaria pendurado o tempo todo. Abortar o cliente não mata a
 * invocação -- o net.http_post do dispatcher não passa timeout_milliseconds,
 * então usa o default de 5s do pg_net contra um worker de 40s, e é assim que a
 * entrega funciona em produção hoje.
 *
 * Falha aqui não é falha do disparo: `dispatch-broadcast-work` roda a cada
 * minuto e é o dono real da entrega. Por isso nada disso vaza para a resposta.
 */
async function nudgeBroadcastWorker(broadcastId: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/broadcast-execute`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ broadcastId }),
      signal: controller.signal,
    });
  } catch (_e) {
    // Latência apenas. O cron entrega de qualquer forma.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Busca o template aprovado na Meta, no idioma pedido.
 *
 * `?name=X` devolve UMA ENTRADA POR IDIOMA. handleSendTemplate pega
 * `data[0]` e por isso pode acertar o envio com os components do template
 * errado; aqui isso seria pior, porque os components ficam GRAVADOS na linha e
 * passam a valer para toda a campanha.
 */
async function fetchApprovedTemplate(
  wabaId: string,
  accessToken: string,
  templateName: string,
  languageCode: string
): Promise<{ template: any } | { error: Record<string, unknown> }> {
  let payload: any;
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}&status=APPROVED`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    payload = await response.json();
  } catch (e: any) {
    return { error: { error: 'Could not reach the WhatsApp API to validate the template', detail: e?.message } };
  }

  if (payload?.error) {
    return { error: { error: 'WhatsApp API rejected the template lookup', detail: payload.error?.message } };
  }

  const candidates: any[] = Array.isArray(payload?.data) ? payload.data : [];

  if (candidates.length === 0) {
    return {
      error: {
        error: 'Template not found or not approved',
        template_name: templateName,
        note: 'The template must exist in this organization WABA with status APPROVED. Check GET /templates.',
      },
    };
  }

  const match = candidates.find((t) => t.language === languageCode);
  if (!match) {
    return {
      error: {
        error: 'Template is not approved in this language',
        template_name: templateName,
        language_code: languageCode,
        available_languages: candidates.map((t) => t.language),
      },
    };
  }

  return { template: match };
}

/**
 * Deriva do template tudo que o worker precisa ler depois.
 *
 * body_variable_count é o MAIOR ÍNDICE de {{n}}, não a quantidade de matches: um
 * corpo "Olá {{1}}, seu pedido {{1}}" precisa de UM parâmetro, e contar matches
 * (como o dashboard faz) pediria dois -- a Meta responde 132000 em todos os
 * destinatários. Exigir 1..N contíguo é o que torna as duas leituras
 * equivalentes, e um template com {{1}} e {{3}} não é servível por um array
 * posicional de jeito nenhum.
 */
function deriveTemplateShape(
  components: any[]
): { shape: { bodyCount: number; buttonCount: number; headerFormat: string | null } } | { error: Record<string, unknown> } {
  const list = Array.isArray(components) ? components : [];

  const header = list.find((c: any) => String(c?.type).toUpperCase() === 'HEADER');
  const body = list.find((c: any) => String(c?.type).toUpperCase() === 'BODY');
  const buttons = list.find((c: any) => String(c?.type).toUpperCase() === 'BUTTONS');

  const headerFormatRaw = String(header?.format || '').toUpperCase();
  const headerFormat = HEADER_MEDIA_FORMATS.includes(headerFormatRaw as typeof HEADER_MEDIA_FORMATS[number])
    ? headerFormatRaw
    : null;

  // O worker nunca monta parâmetro de header de texto, então um header TEXT com
  // variável falha em 100% dos destinatários.
  if (!headerFormat && typeof header?.text === 'string' && header.text.includes('{{')) {
    return {
      error: {
        error: 'Templates with a variable in a TEXT header are not supported by broadcasts',
        note: 'Use a template whose header is static text or media (IMAGE/VIDEO/DOCUMENT).',
      },
    };
  }

  const bodyText = typeof body?.text === 'string' ? body.text : '';

  // Parâmetro nomeado ({{nome}}): a contagem posicional daria 0 e todo envio
  // falharia. Recusar aqui é a única forma de dizer isso ao integrador.
  const allPlaceholders = bodyText.match(/\{\{[^}]*\}\}/g) || [];
  const positional = bodyText.match(/\{\{(\d+)\}\}/g) || [];
  if (allPlaceholders.length !== positional.length) {
    return {
      error: {
        error: 'Templates with named parameters are not supported by broadcasts',
        note: 'Broadcast variables are positional ({{1}}, {{2}}, ...). Recreate the template with numbered placeholders.',
      },
    };
  }

  const indices = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => parseInt(m[1], 10));
  const bodyCount = indices.length ? Math.max(...indices) : 0;

  for (let i = 1; i <= bodyCount; i++) {
    if (!indices.includes(i)) {
      return {
        error: {
          error: 'Template body placeholders are not contiguous',
          note: `The body uses {{${bodyCount}}} but never {{${i}}}. Positional variables must run 1..N with no gaps.`,
        },
      };
    }
  }

  // Mesma regra do worker: só botão URL com variável consome parâmetro.
  const buttonList = Array.isArray(buttons?.buttons) ? buttons.buttons : [];
  const buttonCount = buttonList.filter(
    (b: any) => String(b?.type).toUpperCase() === 'URL' && typeof b?.url === 'string' && b.url.includes('{{')
  ).length;

  return { shape: { bodyCount, buttonCount, headerFormat } };
}

/**
 * Telefone de destinatário, preservando o '+'.
 *
 * O dashboard grava `.replace(/\D/g,'')` e destrói o único sinal de "estes
 * dígitos já são um número internacional completo": normalizePhoneNumber do
 * worker decide pelo '+' inicial, e sem ele um +34612345678 espanhol vira
 * 5534612345678. Aqui o '+' do integrador é preservado byte a byte.
 */
function normalizeRecipientPhone(raw: unknown): { phone: string } | { error: string } {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { error: 'phone_number is required and must be a string or number' };
  }

  const value = String(raw).trim();
  if (!value) return { error: 'phone_number is empty' };

  // Grupo só existe em conexão QR, e broadcast é Cloud API por definição. Sem
  // esta guarda o JID viraria um número numérico sem sentido enviado à Meta.
  if (value.includes('@')) {
    return { error: 'group JIDs are not supported in broadcasts (Business API numbers have no groups)' };
  }

  // Direct do Instagram: sem isto o 'ig:' sumia no replace e o IGSID virava telefone.
  if (value.toLowerCase().startsWith('ig:')) {
    return { error: 'Instagram Direct ids are not phone numbers (broadcasts are WhatsApp only)' };
  }

  const hasPlus = value.startsWith('+');
  const digits = value.replace(/\D/g, '');

  if (digits.length < 10 || digits.length > 15) {
    return { error: `phone_number must have between 10 and 15 digits (got ${digits.length})` };
  }

  return { phone: hasPlus ? `+${digits}` : digits };
}

/** Insere os destinatários em lotes. Sem .select(): o retorno não é usado. */
async function insertRecipientChunks(
  supabase: any,
  broadcastId: string,
  rows: Record<string, unknown>[]
): Promise<{ error: string } | null> {
  for (let i = 0; i < rows.length; i += BROADCAST_RECIPIENT_CHUNK) {
    const chunk = rows.slice(i, i + BROADCAST_RECIPIENT_CHUNK).map((r) => ({ ...r, broadcast_id: broadcastId }));
    const { error } = await supabase.from('broadcast_recipients').insert(chunk);
    if (error) return { error: error.message };
  }
  return null;
}

/**
 * Carrega o disparo garantindo escopo de organização. O client é service-role e
 * ignora RLS, então esse filtro é a única fronteira de tenant.
 */
async function loadBroadcast(supabase: any, id: string, organizationId: string) {
  const { data } = await supabase
    .from('broadcasts')
    .select('*')
    .eq('id', id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  return data;
}

async function createBroadcast(req: Request, supabase: any, organizationId: string) {
  const declaredLength = parseInt(req.headers.get('content-length') || '0', 10);
  if (declaredLength > MAX_BROADCAST_BODY_BYTES) {
    return jsonResponse({
      error: 'Request body too large',
      max_bytes: MAX_BROADCAST_BODY_BYTES,
      note: `Split the list into calls of at most ${MAX_BROADCAST_RECIPIENTS} recipients each.`,
    }, 413);
  }

  // Sem `.catch(() => ({}))` aqui de propósito: num corpo de 2 MB truncado no
  // meio, engolir o erro de parse faria a resposta dizer "Missing required
  // fields" e mandar o integrador procurar o problema no lugar errado.
  let payload: any;
  try {
    payload = await req.json();
  } catch (e: any) {
    return jsonResponse({ error: 'Invalid JSON body', detail: e?.message }, 400);
  }

  const {
    name,
    phone_number_id,
    template_name,
    recipients,
    language_code = 'pt_BR',
    scheduled_at,
    header_media,
    user_id,
  } = payload || {};

  if (!name || !phone_number_id || !template_name || !Array.isArray(recipients) || recipients.length === 0) {
    return jsonResponse({
      error: 'Missing required fields',
      required: ['name', 'phone_number_id', 'template_name', 'recipients'],
      optional: ['language_code', 'scheduled_at', 'header_media', 'user_id'],
      note: `"recipients" must be a non-empty array of { phone_number, contact_name?, variables? }, at most ${MAX_BROADCAST_RECIPIENTS} items. Omit "scheduled_at" to start sending immediately.`,
    }, 400);
  }

  if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
    return jsonResponse({
      error: 'Too many recipients',
      max_recipients: MAX_BROADCAST_RECIPIENTS,
      received: recipients.length,
      note: 'Split the list into more than one broadcast.',
    }, 400);
  }

  if (typeof name !== 'string' || !name.trim()) {
    return jsonResponse({ error: '"name" must be a non-empty string' }, 400);
  }

  // Agendado só quando scheduled_at vem: a ausência é "disparar agora", que é o
  // caminho mais usado por integração.
  let scheduledAtIso: string | null = null;
  if (scheduled_at !== undefined && scheduled_at !== null) {
    const parsedSchedule = parseScheduledAt(scheduled_at);
    if ('error' in parsedSchedule) {
      const baseNote = typeof parsedSchedule.error.note === 'string' ? parsedSchedule.error.note : '';
      return jsonResponse({
        ...parsedSchedule.error,
        note: `${baseNote} Omit "scheduled_at" entirely to start the broadcast immediately.`.trim(),
      }, 400);
    }
    scheduledAtIso = parsedSchedule.at.toISOString();
  }

  const phoneNumber = await resolvePhoneNumberId(supabase, phone_number_id);
  if (!phoneNumber) {
    return jsonResponse({
      error: 'Phone number not found',
      message: 'The provided phone_number_id does not exist in the database'
    }, 404);
  }

  const { data: phoneData } = await supabase
    .from('phone_numbers')
    .select('connection_type, organization:organizations(whatsapp_access_token, whatsapp_waba_id)')
    .eq('id', phoneNumber.dbId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (!phoneData) {
    return jsonResponse({ error: 'Phone number not found in organization' }, 404);
  }

  // Disparo é template puro, e template é Cloud API: o worker posta em
  // graph.facebook.com/{phone_number_id}/messages e não tem caminho QR nenhum.
  // Falhar aqui, e não como 5.000 linhas 'failed' que ninguém está olhando.
  if (phoneData.connection_type !== 'business_api') {
    return jsonResponse({
      error: 'Broadcasts are only supported on Business API numbers',
      detail: `This phone number uses connection_type="${phoneData.connection_type}"`,
      note: 'Broadcasts deliver approved WhatsApp templates through the Cloud API.',
    }, 400);
  }

  const accessToken = phoneData.organization?.whatsapp_access_token;
  const wabaId = phoneData.organization?.whatsapp_waba_id;
  if (!accessToken || !wabaId) {
    return jsonResponse({ error: 'WhatsApp credentials not found for this phone number' }, 500);
  }

  const languageCode = typeof language_code === 'string' && language_code.trim() ? language_code.trim() : 'pt_BR';

  const fetched = await fetchApprovedTemplate(wabaId, accessToken, String(template_name), languageCode);
  if ('error' in fetched) return jsonResponse(fetched.error, 400);

  const templateComponents = Array.isArray(fetched.template.components) ? fetched.template.components : [];
  const derived = deriveTemplateShape(templateComponents);
  if ('error' in derived) return jsonResponse(derived.error, 400);

  const { bodyCount, buttonCount, headerFormat } = derived.shape;

  // Header de mídia: hard-fail nos DOIS sentidos. O worker monta o componente
  // olhando apenas o header_media gravado, sem consultar o template, então
  // qualquer divergência aqui é 132000 em todos os destinatários.
  let headerMedia: Record<string, string> | null = null;
  if (header_media !== undefined && header_media !== null) {
    if (!headerFormat) {
      return jsonResponse({
        error: 'This template has no media header',
        note: 'Remove "header_media" -- sending it would attach a header the template does not declare and every message would be rejected.',
      }, 400);
    }
    const normalized = normalizeHeaderMedia(header_media);
    if ('error' in normalized) return jsonResponse(normalized.error, 400);
    if (normalized.media.format !== headerFormat) {
      return jsonResponse({
        error: 'header_media.format does not match the template header',
        template_header_format: headerFormat,
        received: normalized.media.format,
      }, 400);
    }
    headerMedia = normalized.media;
  } else if (headerFormat) {
    return jsonResponse({
      error: 'header_media is required for this template',
      template_header_format: headerFormat,
      example: { format: headerFormat, link: 'https://cdn.exemplo.com/arquivo' },
      note: 'This template declares a media header, so every message needs the media to send.',
    }, 400);
  }

  if (user_id && !(await isOrgMember(supabase, user_id, organizationId))) {
    return jsonResponse({
      error: 'User not found in organization',
      message: 'The provided user_id is not a member of this organization'
    }, 404);
  }

  // Destinatários: validação completa em memória, com o índice no erro. Nada foi
  // escrito ainda, então qualquer problema aqui é 400 limpo.
  const expectedVariables = bodyCount + buttonCount;
  const recipientRows: Record<string, unknown>[] = [];
  const seenPhones = new Set<string>();
  let duplicatesSkipped = 0;

  for (let i = 0; i < recipients.length; i++) {
    const entry = recipients[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return jsonResponse({
        error: 'Invalid recipient',
        recipient_index: i,
        note: 'Each recipient must be an object: { phone_number, contact_name?, variables? }',
      }, 400);
    }

    const phone = normalizeRecipientPhone((entry as any).phone_number);
    if ('error' in phone) {
      return jsonResponse({ error: 'Invalid recipient', recipient_index: i, detail: phone.error }, 400);
    }

    const variables = toVariableArray((entry as any).variables);
    if (variables.length !== expectedVariables) {
      return jsonResponse({
        error: 'Wrong number of variables for this template',
        recipient_index: i,
        expected: expectedVariables,
        received: variables.length,
        body_variable_count: bodyCount,
        button_variable_count: buttonCount,
        note: 'A single positional array: body variables first, then the URL button variables.',
      }, 400);
    }

    for (let v = 0; v < variables.length; v++) {
      const value = variables[v];
      if (!value.trim()) {
        return jsonResponse({
          error: 'Empty template variable',
          recipient_index: i,
          variable_index: v,
          note: 'WhatsApp rejects empty parameter text.',
        }, 400);
      }
      if (value.length > MAX_TEMPLATE_VARIABLE_LENGTH) {
        return jsonResponse({
          error: 'Template variable too long',
          recipient_index: i,
          variable_index: v,
          max_length: MAX_TEMPLATE_VARIABLE_LENGTH,
        }, 400);
      }
      // A Meta recusa parâmetro com newline, tab ou 5+ espaços seguidos.
      if (/[\n\r\t]/.test(value) || /\s{5,}/.test(value)) {
        return jsonResponse({
          error: 'Invalid characters in template variable',
          recipient_index: i,
          variable_index: v,
          note: 'WhatsApp rejects parameter text containing newlines, tabs or 5+ consecutive spaces.',
        }, 400);
      }
    }

    // broadcast_recipients não tem unique em (broadcast_id, phone_number), então
    // uma linha repetida na planilha do integrador seria uma mensagem repetida
    // (e cobrada duas vezes). Deduplicar é mais útil que recusar a lista toda.
    if (seenPhones.has(phone.phone)) {
      duplicatesSkipped++;
      continue;
    }
    seenPhones.add(phone.phone);

    const contactName = (entry as any).contact_name;
    recipientRows.push({
      phone_number: phone.phone,
      contact_name: typeof contactName === 'string' && contactName.trim() ? contactName.trim() : null,
      variables,
    });
  }

  if (recipientRows.length === 0) {
    return jsonResponse({ error: 'No valid recipients after de-duplication' }, 400);
  }

  // ---- Primeira escrita. Nasce 'draft': inerte para os três crons. ----
  const { data: created, error: createError } = await supabase
    .from('broadcasts')
    .insert({
      organization_id: organizationId,
      phone_number_id: phoneNumber.dbId,
      name: name.trim(),
      status: 'draft',
      scheduled_at: scheduledAtIso,
      // Zero, sempre: broadcast_counts_on_insert SOMA ao valor existente, então
      // mandar recipientRows.length dobraria o total para sempre.
      total_recipients: 0,
      template_id: fetched.template.id,
      template_name: fetched.template.name,
      template_language: languageCode,
      template_components: templateComponents,
      body_variable_count: bodyCount,
      button_variable_count: buttonCount,
      header_media: headerMedia,
      created_by: user_id || null,
    })
    .select()
    .single();

  if (createError || !created) {
    console.error('Error creating broadcast:', createError);
    return jsonResponse({ error: 'Failed to create broadcast', db_error: createError?.message }, 400);
  }

  const insertError = await insertRecipientChunks(supabase, created.id, recipientRows);
  if (insertError) {
    console.error('Error inserting broadcast recipients:', insertError.error);
    return jsonResponse({
      error: 'Failed to insert recipients',
      db_error: insertError.error,
      broadcast_id: created.id,
      status: 'draft',
      note: 'The broadcast was left as a draft and sent nothing. Delete it with DELETE /broadcasts/{id} and try again.',
    }, 500);
  }

  const { count: persisted } = await supabase
    .from('broadcast_recipients')
    .select('*', { count: 'exact', head: true })
    .eq('broadcast_id', created.id);

  if (persisted !== recipientRows.length) {
    return jsonResponse({
      error: 'Recipient list was persisted only partially',
      expected: recipientRows.length,
      persisted,
      broadcast_id: created.id,
      status: 'draft',
      note: 'The broadcast was left as a draft and sent nothing. Delete it with DELETE /broadcasts/{id} and try again.',
    }, 500);
  }

  // ---- Último statement: a partir daqui o motor pode ver o disparo. ----
  const targetStatus = scheduledAtIso ? 'scheduled' : 'processing';
  const { data: activated, error: activateError } = await supabase
    .from('broadcasts')
    .update({
      status: targetStatus,
      started_at: scheduledAtIso ? null : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', created.id)
    .eq('status', 'draft')
    .select()
    .maybeSingle();

  if (activateError) {
    return jsonResponse({ error: 'Failed to activate broadcast', db_error: activateError.message, broadcast_id: created.id }, 500);
  }
  if (!activated) {
    return jsonResponse({
      error: 'Broadcast is no longer a draft',
      broadcast_id: created.id,
      note: 'Its status changed while this request was in flight. Check GET /broadcasts/{id}.',
    }, 409);
  }

  if (!scheduledAtIso) {
    await nudgeBroadcastWorker(created.id);
  }

  return jsonResponse({
    success: true,
    broadcast: activated,
    recipients_created: recipientRows.length,
    duplicates_skipped: duplicatesSkipped,
  }, 201);
}

async function listBroadcastRecipients(
  supabase: any,
  broadcastId: string,
  url: URL,
  organizationId: string
) {
  const parent = await loadBroadcast(supabase, broadcastId, organizationId);
  if (!parent) return jsonResponse({ error: 'Broadcast not found' }, 404);

  const status = url.searchParams.get('status');
  if (status && !BROADCAST_RECIPIENT_STATUSES.includes(status as typeof BROADCAST_RECIPIENT_STATUSES[number])) {
    return jsonResponse({ error: 'Invalid status', allowed: [...BROADCAST_RECIPIENT_STATUSES] }, 400);
  }

  const limit = Math.min(
    parseInt(url.searchParams.get('limit') || '100', 10) || 100,
    MAX_BROADCAST_RECIPIENT_PAGE_SIZE
  );
  const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;

  let query = supabase
    .from('broadcast_recipients')
    .select('*')
    .eq('broadcast_id', broadcastId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return jsonResponse({ error: error.message }, 400);

  return jsonResponse({ recipients: data, limit, offset });
}

async function handleBroadcasts(
  req: Request,
  supabase: any,
  id: string,
  action: string,
  url: URL,
  organizationId: string
) {
  const method = req.method;

  if (method === 'POST' && !id) {
    return await createBroadcast(req, supabase, organizationId);
  }

  if (method === 'GET' && !id) {
    const status = url.searchParams.get('status');
    const phoneNumberId = url.searchParams.get('phone_number_id');
    const limit = Math.min(
      parseInt(url.searchParams.get('limit') || '50', 10) || 50,
      MAX_BROADCAST_PAGE_SIZE
    );
    const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;

    if (status && !BROADCAST_STATUSES.includes(status as typeof BROADCAST_STATUSES[number])) {
      return jsonResponse({ error: 'Invalid status', allowed: [...BROADCAST_STATUSES] }, 400);
    }

    let query = supabase
      .from('broadcasts')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);

    if (phoneNumberId) {
      // Aceita UUID interno ou Meta ID, como o resto da API.
      const resolved = await resolvePhoneNumberId(supabase, phoneNumberId);
      if (!resolved) return jsonResponse({ error: 'Phone number not found' }, 404);
      query = query.eq('phone_number_id', resolved.dbId);
    }

    const { data, error } = await query;
    if (error) return jsonResponse({ error: error.message }, 400);

    return jsonResponse({ broadcasts: data, limit, offset });
  }

  if (method === 'GET' && id && action === 'recipients') {
    return await listBroadcastRecipients(supabase, id, url, organizationId);
  }

  if (method === 'GET' && id && !action) {
    const data = await loadBroadcast(supabase, id, organizationId);
    if (!data) return jsonResponse({ error: 'Broadcast not found' }, 404);
    return jsonResponse({ broadcast: data });
  }

  if (method === 'POST' && id && action === 'retry') {
    const { data, error } = await supabase.rpc('retry_broadcast_failures', {
      p_broadcast_id: id,
      p_organization_id: organizationId,
    });

    if (error) return jsonResponse({ error: 'Failed to retry broadcast', db_error: error.message }, 400);

    if (!data?.ok) {
      if (data?.reason === 'not_found') return jsonResponse({ error: 'Broadcast not found' }, 404);
      if (data?.reason === 'nothing_to_retry') {
        return jsonResponse({
          error: 'No failed recipients to retry',
          note: 'Only recipients in status "failed" are requeued.',
        }, 409);
      }
      // 409, não 404: "ainda está enviando" e "não existe" pedem reações
      // diferentes de quem integra.
      return jsonResponse({
        error: 'Broadcast cannot be retried',
        status: data?.status,
        note: 'Only broadcasts in status "completed" or "failed" can be retried.',
      }, 409);
    }

    await nudgeBroadcastWorker(id);

    return jsonResponse({ success: true, requeued: data.requeued });
  }

  if (method === 'DELETE' && id && !action) {
    const existing = await loadBroadcast(supabase, id, organizationId);
    if (!existing) return jsonResponse({ error: 'Broadcast not found' }, 404);

    // Draft nunca enviou nada, e mantê-lo como 'cancelled' guardaria até 5.000
    // linhas inúteis. Apagar de verdade -- em lotes, porque o CASCADE dispara
    // tr_broadcast_counts_delete POR LINHA.
    if (existing.status === 'draft') {
      // Guarda de iteração: um DELETE que devolve sucesso sem apagar nada
      // (política nova, trigger, o que for) transformaria este loop num isolate
      // preso até o timeout da plataforma. O teto é o máximo de lotes que a
      // lista pode ter, com folga.
      const maxBatches = Math.ceil(MAX_BROADCAST_RECIPIENTS / BROADCAST_RECIPIENT_CHUNK) + 2;

      for (let batchNumber = 0; ; batchNumber++) {
        if (batchNumber >= maxBatches) {
          return jsonResponse({
            error: 'Could not delete the recipient list',
            broadcast_id: id,
            note: 'The delete stopped making progress. The broadcast is still a draft and sends nothing.',
          }, 500);
        }

        const { data: batch, error: pickError } = await supabase
          .from('broadcast_recipients')
          .select('id')
          .eq('broadcast_id', id)
          .limit(BROADCAST_RECIPIENT_CHUNK);

        if (pickError) return jsonResponse({ error: pickError.message }, 400);
        if (!batch || batch.length === 0) break;

        const { error: deleteError } = await supabase
          .from('broadcast_recipients')
          .delete()
          .in('id', batch.map((r: any) => r.id));

        if (deleteError) return jsonResponse({ error: deleteError.message }, 400);
      }

      const { error: parentError } = await supabase
        .from('broadcasts')
        .delete()
        .eq('id', id)
        .eq('organization_id', organizationId)
        .eq('status', 'draft');

      if (parentError) return jsonResponse({ error: parentError.message }, 400);
      return jsonResponse({ success: true, deleted: true, broadcast_id: id });
    }

    const { data, error } = await supabase.rpc('cancel_broadcast', {
      p_broadcast_id: id,
      p_organization_id: organizationId,
    });

    if (error) return jsonResponse({ error: 'Failed to cancel broadcast', db_error: error.message }, 400);

    if (!data?.ok) {
      if (data?.reason === 'not_found') return jsonResponse({ error: 'Broadcast not found' }, 404);
      return jsonResponse({
        error: 'Broadcast can no longer be cancelled',
        status: data?.status,
        note: 'Only broadcasts in status "draft", "scheduled" or "processing" can be cancelled.',
      }, 409);
    }

    return jsonResponse({
      success: true,
      broadcast_id: id,
      cancelled_from: data.previous_status,
      recipients_drained: data.drained,
      note: 'No new message is sent from now on. Messages already claimed by a running worker (up to ~45s) may still be delivered.',
    });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}
