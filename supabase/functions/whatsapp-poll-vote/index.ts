// Voto do PAINEL numa enquete — SÓ QR (a Cloud API nem recebe enquete).
// Resolve o contexto da enquete a partir da própria linha (wamid, criador,
// message_secret persistido), manda o voto cifrado pelo qr-service e grava em
// metadata.poll.votes via RPC atômica. selectedOptions = [] retira o voto.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { z } from 'https://esm.sh/zod@3.23.8';
import { recusarSeDirect } from '../_shared/canal.ts';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireUser, requirePhoneAccess } from '../_shared/authz.ts';
import { qrAuthHeaders } from '../_shared/qr.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'session not connected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp.',
    'not connected': 'WhatsApp desconectado. Tente novamente.',
    'qr service unreachable': 'Serviço temporariamente indisponível. Tente novamente.',
    'polls only on qr': 'Votar em enquete só está disponível em números conectados via QR.',
    'poll secret missing': 'Esta enquete chegou sem a chave de votação — vote pelo celular.',
    'invalid option': 'Opção fora da enquete.',
    'failed to vote': 'Falha ao votar. Tente novamente.',
    'direct: esta ação só existe no whatsapp': 'Esta ação só existe no WhatsApp.',
  };
  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) return value;
  }
  return `Erro: ${error}`;
}

const InputSchema = z.object({
  messageId: z.string().uuid(),
  /** Nomes das opções escolhidas; [] retira o voto. */
  selectedOptions: z.array(z.string().min(1).max(100)).max(12),
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
    const { messageId, selectedOptions } = parsed.data;

    const supabase = createClient(supabaseUrl, supabaseKey);
    const userId = await requireUser(supabase, req);

    const { data: row } = await supabase
      .from('messages')
      .select('id, whatsapp_message_id, direction, sender_jid, metadata, conversation_id')
      .eq('id', messageId)
      .maybeSingle();
    if (!row?.whatsapp_message_id || row.metadata?.poll == null) {
      throw new Error('Poll not found');
    }
    // Enquete só existe no WhatsApp: conversa do Direct tem 'ig:<id>' como telefone.
    await recusarSeDirect(supabase, [row.conversation_id]);

    const poll = row.metadata.poll as {
      options?: unknown;
      selectable_count?: number;
      message_secret?: string | null;
      /** JID do criador na forma recebida (lid em chats LID) — chave do voto. */
      creator_jid?: string | null;
      /** remoteJid do chat: o servidor dele decide LID vs PN no relay do voto. */
      chat_jid?: string | null;
    };
    const pollOptions = Array.isArray(poll.options)
      ? (poll.options as unknown[]).filter((o): o is string => typeof o === 'string')
      : [];
    if (!poll.message_secret) {
      throw new Error('Poll secret missing');
    }
    if (selectedOptions.some((o) => !pollOptions.includes(o))) {
      throw new Error('Invalid option');
    }
    if ((poll.selectable_count ?? 1) === 1 && selectedOptions.length > 1) {
      throw new Error('Invalid option'); // escolha única: no máximo 1
    }

    const { data: conversation } = await supabase
      .from('conversations')
      .select('id, contact_phone, is_group, group_jid, phone_number_id')
      .eq('id', row.conversation_id)
      .maybeSingle();
    if (!conversation?.phone_number_id) {
      throw new Error('Conversa não encontrada');
    }

    const { data: phoneData } = await supabase
      .from('phone_numbers')
      .select('id, organization_id, connection_type')
      .eq('id', conversation.phone_number_id)
      .maybeSingle();
    if (!phoneData) {
      throw new Error('Phone number not found');
    }
    if (phoneData.connection_type !== 'qr') {
      throw new Error('Polls only on QR lines');
    }

    await requirePhoneAccess(supabase, userId, phoneData.id, phoneData.organization_id);

    const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
    if (!qrServiceUrl) {
      throw new Error('QR_SERVICE_URL not configured');
    }

    const to = conversation.is_group && conversation.group_jid
      ? conversation.group_jid
      : conversation.contact_phone;
    // Criador: nossa enquete → fromMe; do contato/participante → o JID gravado
    const pollCreatorFromMe = row.direction === 'outbound';
    // creator_jid vem NA FORMA que os aparelhos usam p/ derivar a chave (lid em
    // chats LID). sender_jid/PN são fallbacks p/ enquetes anteriores à captura.
    const pollCreatorJid = pollCreatorFromMe
      ? null
      : poll.creator_jid || row.sender_jid || `${conversation.contact_phone.replace(/\D/g, '')}@s.whatsapp.net`;

    let qrResponse: Response;
    try {
      qrResponse = await fetch(`${qrServiceUrl}/message/poll-vote/${phoneData.id}`, {
        method: 'POST',
        headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          to,
          pollMsgId: row.whatsapp_message_id,
          pollCreatorFromMe,
          pollCreatorJid,
          // Endereçamento do chat (lid/pn): o qr-service precisa relayar o voto
          // no MESMO modo em que cifrou, senão o aparelho descarta em silêncio.
          pollChatJid: poll.chat_jid ?? null,
          messageSecret: poll.message_secret,
          selectedOptions,
        }),
      });
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      throw new Error(`QR service unreachable: ${msg}`);
    }

    const qrData = await qrResponse.json();
    if (!qrResponse.ok || !qrData.success) {
      throw new Error(qrData.error || 'Failed to vote');
    }

    // Grava o voto na própria linha (o eco do aparelho, quando vier, colide na
    // mesma chave de voter e apenas reescreve o mesmo valor).
    const voterJid: string = qrData.voterJid || 'painel';
    const { error: rpcError } = await supabase.rpc('record_poll_vote', {
      p_message_id: row.id,
      p_voter: voterJid,
      p_voter_name: 'Você',
      p_options: selectedOptions,
    });
    if (rpcError) {
      // O voto FOI para o WhatsApp, mas a bolha ficaria mostrando uma escolha
      // que não está persistida — melhor o painel saber e recarregar.
      console.error('[PollVote] RPC error (voto foi enviado ao WhatsApp):', rpcError);
      throw new Error('Voto enviado ao WhatsApp, mas não foi possível registrá-lo no painel');
    }

    return new Response(JSON.stringify({ success: true, voterJid }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    console.error('[PollVote] Error:', error);
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
