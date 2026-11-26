import { montarAvisoQuemFalou } from './aviso-quem-falou.ts';
import {
  type AvisoUnicoEntrada,
  chaveDoAviso,
  chaveDoComplemento,
  guardarCorpo,
  precisaComplemento,
  registrarEntrega,
  ERRO_URL_BLOQUEADA,
  reservarAviso,
} from './aviso-unico.ts';
import { fetchExterno, UrlExternaBloqueadaError } from './url-guard.ts';
// Emissão de webhooks para a organização (`organization_webhooks`).
//
// Antes deste módulo, `buildWebhookPayload`/`sendOrganizationWebhook` viviam
// dentro de `whatsapp-webhook/index.ts`. Consequência: só nascia `message.sent`
// quando a própria função de webhook criava a linha em `messages` — ou seja,
// apenas no eco do aparelho (Baileys `messages.upsert` com `fromMe`). Toda
// mensagem que nasce no Echo (painel, API, automação, agendamento) era gravada
// por OUTRA função, que não tinha como emitir evento nenhum.
//
// Em conversa 1:1 a falha ficava mascarada: o Baileys manda recibo de entrega
// (`messages.update` com status >= 3), o QR service repassa para
// `/qr-delivery-update` e o CRM recebia `message.delivered`/`message.read` com o
// mesmo `message_id`. Em grupo o WhatsApp não manda esse recibo por
// `messages.update` (vai por `message-receipt.update`, por participante), então
// não sobrava nada: 100% das mensagens de painel em grupo sumiam do CRM.
//
// `emitMessageSent` fecha esse buraco na origem: quem grava a mensagem emite o
// evento, com o contexto de grupo e a autoria carregados aqui dentro.

// `message.author` (aviso único, passo 3): o complemento de quem digitou e por onde, para uma mensagem que o CRM já
// recebeu pela cópia de outra linha. Tem montagem própria: nunca vira `message.status`.
export type WebhookEvent = 'message.received' | 'message.sent' | 'message.status' | 'message.author';

// Um CRM lento não pode segurar o envio de mensagem nem o processamento do
// webhook de entrada. Passado o limite, aborta e segue.
const WEBHOOK_TIMEOUT_MS = 8_000;

/** Monta o payload achatado que os consumidores externos recebem. */
export async function buildWebhookPayload(
  supabase: any,
  event: WebhookEvent,
  data: any,
) {
  // 1. Get Organization Name
  let organizationName = 'Echo';
  if (data.organization_id) {
    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', data.organization_id)
      .maybeSingle();
    if (org?.name) organizationName = org.name;
  }

  // 2. Base Payload (Common fields)
  const basePayload = {
    event,
    ts: Date.now(),
    ts_iso: new Date().toISOString(),
    // `ts`/`ts_iso` são a hora do AVISO. A hora em que a mensagem aconteceu vai
    // aqui: numa linha que volta depois de dias desconectada as duas ficam a dias
    // de distância, e o CRM que lia `ts_iso` mostrava fala de sábado como
    // "enviada agora". Sem hora, a chave some.
    message_created_at: data.message_created_at ?? undefined,
    // Aviso único, passo 1: aviso_id, codigo_whatsapp, falou e linhas_no_grupo (só em mensagem; ver aviso-quem-falou.ts).
    ...(data.aviso ?? {}),
    organization: organizationName,
    organization_id: data.organization_id,
    phone_number_id: data.phone_number_id, // Meta ID
    phone_number: data.phone_number_display_name || null, // Display Name
    conversation_id: data.conversation_id,
    message_id: data.message_id, // UUID
    whatsapp_message_id: data.whatsapp_message_id, // wamid
    contact_phone: data.contact_phone,
    error: data.error || false,
    error_message: data.error_message || "",

    // Quoted message info
    is_quoted: !!data.quoted_message_id,
    quoted: data.quoted_message_id ? {
      message_id: data.quoted_message_id,
      whatsapp_message_id: data.quoted_whatsapp_id || null,
      content: data.quoted_content || null,
    } : null,

    // Group message info
    is_group: data.is_group || false,
    group: data.is_group ? {
      jid: data.group_jid || null,
      name: data.group_name || null,
    } : null,
    sender: data.is_group ? {
      phone: data.sender_phone || null,
      name: data.sender_name || null,
      jid: data.sender_jid || null,
    } : null,

    // NEW: Enriched Context
    contact: {
      name: data.contact_name,
      phone: data.contact_phone,
      tags: data.contact_tags || []
    },
    conversation: {
      id: data.conversation_id,
      assigned_to: data.assigned_to || null,
      status: data.conversation_status || 'active',
      agent: data.agent || null, // Enriched agent details
      is_group: data.is_group || false
    }
  };

  // 3. Event-Specific Fields
  if (event === 'message.received') {
    return {
      status: 0, // 0 = pending/received
      ...basePayload,
      direction: 'incoming',
      from_me: false,
      actor_type: 'customer',

      text: data.content,
      message_type: data.message_type || 'text',
      media: data.media || null,
      read: false
    };
  }

  if (event === 'message.sent') {
    return {
      status: data.status_code ?? 2, // 2 = sent
      ...basePayload,
      direction: 'outgoing',
      from_me: true,
      // Só automação e resposta automática são 'system'. O eco do aparelho vem
      // sem `origin` e sem `sent_by`, mas foi uma pessoa que digitou — continua
      // 'agent', como sempre foi, para não quebrar quem já consome o evento.
      actor_type:
        data.origin === 'automation' || data.origin === 'auto_reply'
          ? 'system'
          : 'agent',
      // Sem `?? null`: quando não há autor a chave some do JSON, como sempre
      // sumiu. Quem valida `sent_by` como opcional continua aceitando o payload.
      sent_by: data.sent_by,
      sent_by_name: data.sent_by_name ?? null,
      sent_by_email: data.sent_by_email ?? null,
      origin: data.origin ?? null,
      text: data.content,
      message_type: data.message_type || 'text',
      media: data.media || null,
      template_name: data.template_name || undefined
    };
  }

  if (event === 'message.author') {
    // Sem texto e sem mídia: não é mensagem nova. Diz qual aviso completa (`aviso_original`), quem falou (`falou`),
    // a conversa e a linha de quem falou, e quem digitou.
    return {
      ...basePayload,
      aviso_original: data.aviso_original,
      direction: 'outgoing',
      from_me: true,
      actor_type:
        data.origin === 'automation' || data.origin === 'auto_reply'
          ? 'system'
          : 'agent',
      sent_by: data.sent_by,
      sent_by_name: data.sent_by_name ?? null,
      sent_by_email: data.sent_by_email ?? null,
      origin: data.origin ?? null,
      message_type: data.message_type || 'text',
    };
  }

  if (event === 'message.status') {
    return {
      status: data.status_code, // 3=delivered, 4=read, -1=failed
      status_name: data.status_name, // delivered, read, failed
      ...basePayload,
      text: data.content, // Include message content
      message_type: data.message_type || 'text',
      media: data.media || null,
    };
  }

  return basePayload;
}

/** A organização tem webhook ligado? Usado para sair cedo, antes de montar nada. */
async function hasActiveWebhook(supabase: any, organizationId: string): Promise<boolean> {
  const { data } = await supabase
    .from('organization_webhooks')
    .select('url, is_active')
    .eq('organization_id', organizationId)
    .maybeSingle();
  return !!(data?.is_active && data?.url);
}

export async function sendOrganizationWebhook(
  supabase: any,
  organizationId: string,
  event: string,
  payload: any,
) {
  console.log(`[sendOrganizationWebhook] Called with orgId: ${organizationId}, event: ${event}`);
  // Aviso único (passo 3): reserva da cópia que está sendo avisada; com ela, a entrega é guardada e repetida.
  let reservaId: string | null = null;
  try {
    const { data: webhookConfig } = await supabase
      .from('organization_webhooks')
      .select('url, is_active')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!webhookConfig?.is_active || !webhookConfig?.url) {
      console.log(`[sendOrganizationWebhook] No active webhook found or URL missing`);
      return { skipped: 'webhook_disabled' };
    }

    // A primeira cópia da mensagem reserva o aviso; as outras não avisam. A cópia da linha que falou que chega depois
    // da de quem ouviu vira o complemento `message.author` (ver aviso-unico.ts).
    const unico = payload.aviso_unico as AvisoUnicoEntrada | undefined;
    const ehMensagem = event === 'message.received' || event === 'message.sent';
    if (unico?.chave && payload.message?.id && (ehMensagem || event === 'message.author')) {
      // O envio pelo Echo já reservou no emitMessageSent; a gravação do /qr-message e o complemento reservam aqui.
      const reserva = unico.reserva ?? await reservarAviso(supabase, {
        organizationId,
        chave: unico.chave,
        messageId: payload.message.id,
        evento: event,
        temAutor: unico.tem_autor === true,
      });
      if (reserva.tipo === 'copia') {
        if (!ehMensagem || !precisaComplemento(unico, reserva.dono)) {
          console.log(`[sendOrganizationWebhook] Aviso ${unico.chave} já saiu por outra cópia; ${event} sem aviso`);
          return { skipped: 'aviso_ja_enviado' };
        }
        console.log(`[sendOrganizationWebhook] Aviso ${unico.chave} saiu pela cópia de quem ouviu; vai o complemento`);
        return await sendOrganizationWebhook(supabase, organizationId, 'message.author', {
          ...payload,
          aviso_unico: {
            chave: chaveDoComplemento(unico.chave, unico.tem_autor === true),
            saida: true,
            tem_autor: unico.tem_autor === true,
            original: unico.chave,
          } satisfies AvisoUnicoEntrada,
        });
      }
      if (reserva.tipo === 'reservado') reservaId = reserva.id;
      // 'sem_reserva': banco fora; o aviso sai assim mesmo e o CRM descarta o repetido pelo aviso_id.
    }

    console.log(`[sendOrganizationWebhook] Sending ${event} webhook to ${webhookConfig.url}`);

    // Build the new payload format
    // We need to fetch additional context (tags, assignment) if not present in payload
    let conversationData = payload.conversation_data;
    if (!conversationData && payload.conversation?.id) {
      const { data: conv } = await supabase
        .from('conversations')
        .select(`
          id,
          assigned_to,
          status,
          conversation_tags(
            tags(name, color)
          ),
          assigned_agent:assigned_to (
            id,
            email,
            first_name,
            last_name
          )
        `)
        .eq('id', payload.conversation.id)
        .maybeSingle();

      if (conv) {
        // Fetch agent sector if assigned
        let agentSector = null;
        if (conv.assigned_to) {
          const { data: memberData } = await supabase
            .from('organization_members')
            .select('sectors(name)')
            .eq('user_id', conv.assigned_to)
            .eq('organization_id', organizationId)
            .maybeSingle();

          // Access the nested sector name safely
          if (memberData?.sectors) {
            // @ts-ignore - Supabase type inference for nested relations can be tricky in Deno without full generation
            agentSector = memberData.sectors.name;
          }
        }

        conversationData = {
          assigned_to: conv.assigned_to,
          status: conv.status,
          tags: conv.conversation_tags?.map((t: any) => t.tags?.name).filter(Boolean) || [],
          agent: conv.assigned_agent ? {
            id: conv.assigned_agent.id,
            name: [conv.assigned_agent.first_name, conv.assigned_agent.last_name].filter(Boolean).join(' ') || 'Unknown',
            email: conv.assigned_agent.email,
            sector: agentSector
          } : null
        };
      }
    }

    let phoneDisplayName = payload.phone_number_display_name;
    if (!phoneDisplayName && payload.phone_number_internal_id) {
      const { data: phone } = await supabase
        .from('phone_numbers')
        .select('display_name')
        .eq('id', payload.phone_number_internal_id)
        .maybeSingle();
      phoneDisplayName = phone?.display_name;
    }

    // Map payload to buildWebhookPayload input
    const buildData = {
      organization_id: organizationId,
      phone_number_id: payload.phone_number_id, // Meta ID
      phone_number_display_name: phoneDisplayName,
      conversation_id: payload.conversation?.id,
      message_id: payload.message?.id,
      whatsapp_message_id: payload.message?.whatsapp_id,
      message_created_at: payload.message?.created_at ?? null,
      contact_phone: payload.contact?.phone,
      contact_name: payload.contact?.name,
      contact_tags: conversationData?.tags,
      assigned_to: conversationData?.assigned_to,
      agent: conversationData?.agent, // Pass the agent object
      conversation_status: conversationData?.status,
      content: payload.message?.content,
      message_type: payload.message?.type,
      media: payload.message?.media || null,
      error: !!payload.error,
      error_message: payload.error?.message,
      sent_by: payload.message?.sent_by,
      sent_by_name: payload.message?.sent_by_name,
      sent_by_email: payload.message?.sent_by_email,
      origin: payload.message?.origin,
      status_code: payload.message?.status_code,
      status_name: payload.message?.status,
      template_name: payload.message?.template_name,
      // Quoted message info
      quoted_message_id: payload.message?.quoted_message_id || null,
      quoted_whatsapp_id: payload.message?.quoted_whatsapp_id || null,
      quoted_content: payload.message?.quoted_content || null,
      // Group message info
      is_group: payload.is_group || false,
      group_jid: payload.group_jid || null,
      group_name: payload.group_name || null,
      sender_phone: payload.sender_phone || null,
      sender_name: payload.sender_name || null,
      sender_jid: payload.sender_jid || null,
      aviso_original: payload.aviso_unico?.original ?? undefined,
    };

    // Determine event type for builder
    let builderEvent: WebhookEvent = 'message.status';

    if (event === 'message.received') builderEvent = 'message.received';
    else if (event === 'message.sent') builderEvent = 'message.sent';
    else if (event === 'message.author') builderEvent = 'message.author';
    else if (event.startsWith('message.')) builderEvent = 'message.status'; // message.active, message.delivered, etc.

    const webhookBody = await buildWebhookPayload(supabase, builderEvent, {
      ...buildData,
      aviso: await montarAvisoQuemFalou(supabase, organizationId, event, payload, phoneDisplayName ?? null),
    });
    if (reservaId) await guardarCorpo(supabase, reservaId, webhookBody);
    // URL escolhida pela organização: passa pela guarda SSRF (fetchExterno) em cada salto.
    const response = await fetchExterno(webhookConfig.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookBody),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    console.log(`[sendOrganizationWebhook] Response status: ${response.status}`);
    // Só o ok do CRM conta como entregue; sem ele, o cron aviso-de-mensagem-repetir repete pelo corpo guardado.
    if (reservaId) await registrarEntrega(supabase, reservaId, 1, response.ok, response.ok ? null : `HTTP ${response.status}`);
    return { status: response.status };
  } catch (error) {
    if (reservaId) {
      // URL recusada pela guarda: repetir não adianta, o aviso encerra na 1ª tentativa.
      const bloqueio = error instanceof UrlExternaBloqueadaError ? error : null;
      await registrarEntrega(
        supabase,
        reservaId,
        1,
        false,
        bloqueio ? `${ERRO_URL_BLOQUEADA}${bloqueio.reason}` : String((error as Error)?.message ?? error),
        bloqueio !== null,
      );
    }
    if (error instanceof UrlExternaBloqueadaError) {
      console.warn(`[sendOrganizationWebhook] URL do webhook bloqueada pela guarda (${error.reason})`);
    } else {
      console.error('[sendOrganizationWebhook] Error:', error);
    }
  }
}

/** De onde a mensagem saiu. Vai no payload como `origin`. */
export type MessageOrigin =
  | 'panel'
  | 'api'
  | 'automation'
  | 'auto_reply'
  | 'scheduled'
  | 'broadcast'
  | 'device';

export interface EmitMessageSentInput {
  conversationId: string;
  /** UUID da linha em `messages` — vira `message_id` no payload. */
  messageId: string;
  whatsappMessageId?: string | null;
  content?: string | null;
  messageType?: string | null;
  /** `messages.sent_by`: usuário do painel, ou null para mensagem de sistema. */
  sentBy?: string | null;
  origin?: MessageOrigin;
  /** `phone_numbers.id`. Resolve organização e Meta ID sozinho quando faltarem. */
  phoneNumberDbId?: string | null;
  organizationId?: string | null;
  metaPhoneNumberId?: string | null;
  media?: {
    url: string | null;
    mime_type?: string | null;
    filename?: string | null;
    size_bytes?: number | null;
  } | null;
  quotedMessageId?: string | null;
  quotedWhatsappId?: string | null;
  quotedContent?: string | null;
  templateName?: string | null;
}

/**
 * Emite `message.sent` para uma mensagem que o Echo acabou de gravar.
 *
 * Chame no ponto em que a linha de `messages` nasce — painel, API pública,
 * automação, agendamento. Carrega sozinho o contexto de grupo (`is_group`,
 * `group.jid`, `group.name`) e o nome de quem escreveu, porque nenhum dos
 * pontos de envio tinha isso em mãos.
 *
 * Nunca lança: falha de webhook não pode derrubar um envio que já saiu.
 */
export async function emitMessageSent(
  supabase: any,
  input: EmitMessageSentInput,
): Promise<void> {
  // Aviso único (passo 3): a conversa, a linha e a reserva do aviso saem aqui, antes de o envio responder. Assim a
  // cópia da linha que falou disputa a reserva com a de quem ouviu desde a gravação; montar e entregar o aviso fica
  // para o waitUntil.
  let contexto: ContextoDoEnvio | null = null;
  try {
    contexto = await prepararEnvio(supabase, input);
  } catch (error) {
    console.error('[emitMessageSent] Error:', error);
  }
  if (!contexto) return;
  const task = deliverMessageSent(supabase, input, contexto);

  // O painel esvazia a fila de envio em série e a bolha fica "enviando" até a
  // edge function responder. Com o webhook no caminho da resposta, um CRM lento
  // viraria segundos de espera visível por mensagem. `waitUntil` mantém a
  // isolate viva até a entrega terminar sem segurar a resposta; onde ele não
  // existe (dev local), o await continua sendo a garantia de que a POST sai.
  const edgeRuntime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (typeof edgeRuntime?.waitUntil === 'function') {
    edgeRuntime.waitUntil(task);
    return;
  }

  return task;
}

/** O que o envio resolve antes de responder: a conversa, a linha e a reserva do aviso único. */
interface ContextoDoEnvio {
  conversation: any;
  isGroup: boolean;
  groupJid: string | null;
  phoneNumberDbId: string | null;
  organizationId: string;
  metaPhoneNumberId: string | null;
  ownPhoneNumber: string | null;
  avisoUnico?: AvisoUnicoEntrada;
}

/** Null = não há o que avisar (sem webhook, sem conversa, sem organização). */
async function prepararEnvio(
  supabase: any,
  input: EmitMessageSentInput,
): Promise<ContextoDoEnvio | null> {
  if (!input.conversationId || !input.messageId) {
    console.warn('[emitMessageSent] Missing conversationId or messageId, skipping');
    return null;
  }

  // Antes de qualquer outra coisa: a maioria das organizações não tem webhook
  // configurado, e esta função agora roda em TODO envio. Sem esta saída
  // antecipada, cada mensagem enviada pagaria 2 a 3 consultas sequenciais para
  // no fim descobrir que não havia para quem entregar.
  if (input.organizationId && !(await hasActiveWebhook(supabase, input.organizationId))) {
    return null;
  }

  // A conversa é a única fonte confiável de contexto de grupo: nenhum ponto de
  // envio seleciona `is_group`/`group_jid` hoje.
  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('id, contact_phone, contact_name, is_group, group_jid, phone_number_id')
    .eq('id', input.conversationId)
    .maybeSingle();

  if (convError || !conversation) {
    console.error(
      `[emitMessageSent] Conversation ${input.conversationId} not found; webhook skipped`,
      convError,
    );
    return null;
  }

  const isGroup = conversation.is_group === true;
  const phoneNumberDbId = input.phoneNumberDbId || conversation.phone_number_id;

  let organizationId = input.organizationId ?? null;
  let metaPhoneNumberId = input.metaPhoneNumberId ?? null;
  let ownPhoneNumber: string | null = null;

  // `whatsapp-send-template` e `whatsapp-send-flow` só têm o id da organização
  // por join, e nenhum ponto de envio seleciona `phone_number`. Uma consulta
  // resolve os três — e só roda quando falta alguma coisa. Em grupo ela roda
  // sempre, porque `sender.phone` é o nosso próprio número e só vem daqui.
  if (phoneNumberDbId && (!organizationId || !metaPhoneNumberId || isGroup)) {
    const { data: phone } = await supabase
      .from('phone_numbers')
      .select('id, organization_id, phone_number_id, phone_number')
      .eq('id', phoneNumberDbId)
      .maybeSingle();

    if (phone) {
      organizationId = organizationId || phone.organization_id;
      metaPhoneNumberId = metaPhoneNumberId || phone.phone_number_id;
      ownPhoneNumber = phone.phone_number;
    }
  }

  if (!organizationId) {
    console.error(
      `[emitMessageSent] Could not resolve organization for conversation ${input.conversationId}; webhook skipped`,
    );
    return null;
  }

  // Conversa de grupo guarda o JID em `contact_phone`; `group_jid` é a coluna
  // canônica, mas conversas antigas podem ter só a primeira preenchida.
  const groupJid = isGroup ? (conversation.group_jid || conversation.contact_phone) : null;

  // Aviso único (passo 3), só linha QR (o placeholder 'qr_' de phone_numbers.phone_number_id): a cópia de quem ouviu
  // pode ter reservado o aviso antes, porque no QR o código só existe depois que o serviço de envio responde. Este
  // envio sabe quem digitou e por onde, e então complementa.
  const chave = metaPhoneNumberId?.startsWith('qr_')
    ? chaveDoAviso({
        grupo: isGroup,
        groupJid,
        linhaId: phoneNumberDbId,
        contato: conversation.contact_phone,
        codigo: input.whatsappMessageId,
      })
    : null;
  let avisoUnico: AvisoUnicoEntrada | undefined;
  if (chave) {
    // Sem a organização na entrada, o webhook ainda não foi conferido: não reserva para quem não recebe aviso.
    if (!input.organizationId && !(await hasActiveWebhook(supabase, organizationId))) return null;
    const temAutor = !!input.sentBy || (!!input.origin && input.origin !== 'device');
    avisoUnico = {
      chave,
      saida: true,
      tem_autor: temAutor,
      reserva: await reservarAviso(supabase, {
        organizationId,
        chave,
        messageId: input.messageId,
        evento: 'message.sent',
        temAutor,
      }),
    };
  }

  return { conversation, isGroup, groupJid, phoneNumberDbId, organizationId, metaPhoneNumberId, ownPhoneNumber, avisoUnico };
}

async function deliverMessageSent(
  supabase: any,
  input: EmitMessageSentInput,
  contexto: ContextoDoEnvio,
): Promise<void> {
  try {
    const { conversation, isGroup, groupJid, phoneNumberDbId, organizationId, metaPhoneNumberId, ownPhoneNumber } =
      contexto;

    // O CRM não tem endpoint de usuários do Echo, então o nome do autor precisa
    // viajar junto com o evento.
    let sentByName: string | null = null;
    let sentByEmail: string | null = null;
    if (input.sentBy) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('first_name, last_name, email')
        .eq('id', input.sentBy)
        .maybeSingle();

      if (profile) {
        sentByEmail = profile.email ?? null;
        sentByName =
          [profile.first_name, profile.last_name].filter(Boolean).join(' ') ||
          profile.email?.split('@')[0] ||
          null;
      }
    }

    // Linha de QR não tem id da Meta: a coluna `phone_number_id` guarda um
    // placeholder `qr_<timestamp>`, e o que o /qr-message publica no
    // `message.received` é o UUID da linha (é com ele que o qr-service é
    // chamado). Publicar o placeholder aqui faria received e sent chegarem no
    // CRM com chaves diferentes para a mesma linha.
    const payloadPhoneNumberId =
      metaPhoneNumberId && !metaPhoneNumberId.startsWith('qr_')
        ? metaPhoneNumberId
        : phoneNumberDbId;

    const payload = {
      phone_number_id: payloadPhoneNumberId,
      phone_number_internal_id: phoneNumberDbId,
      // A reserva já foi feita no emitMessageSent, antes de o envio responder.
      aviso_unico: contexto.avisoUnico,
      message: {
        id: input.messageId,
        // Hora do envio: numa repetição do aviso, o CRM mostra a mensagem na hora em que ela saiu (message_created_at),
        // não na hora em que o aviso enfim chegou.
        created_at: new Date().toISOString(),
        whatsapp_id: input.whatsappMessageId || null,
        content: input.content ?? null,
        type: input.messageType || 'text',
        sent_by: input.sentBy ?? undefined,
        sent_by_name: sentByName,
        sent_by_email: sentByEmail,
        origin: input.origin ?? null,
        status_code: 2,
        media: input.media?.url
          ? {
              url: input.media.url,
              mime_type: input.media.mime_type ?? null,
              filename: input.media.filename ?? null,
              size_bytes: input.media.size_bytes ?? null,
            }
          : null,
        template_name: input.templateName || undefined,
        quoted_message_id: input.quotedMessageId || null,
        quoted_whatsapp_id: input.quotedWhatsappId || null,
        quoted_content: input.quotedContent || null,
      },
      contact: {
        id: conversation.id,
        // Em grupo, o "contato" é o próprio grupo — mesmo formato que o evento
        // de eco do aparelho já usa hoje.
        phone: conversation.contact_phone,
        name: conversation.contact_name,
      },
      conversation: { id: conversation.id },
      is_group: isGroup,
      group_jid: groupJid,
      group_name: isGroup ? conversation.contact_name : null,
      // Quem escreveu no grupo foi o nosso próprio número, operado por um agente.
      sender_phone: isGroup ? ownPhoneNumber : null,
      sender_name: isGroup ? sentByName : null,
      sender_jid: null,
    };

    await sendOrganizationWebhook(supabase, organizationId, 'message.sent', payload);
  } catch (error) {
    // Um envio que já chegou no WhatsApp não pode falhar porque o webhook falhou.
    console.error('[emitMessageSent] Error:', error);
  }
}
