// Envio de enquete — SÓ QR/Baileys (a Cloud API não tem poll de saída).
// A linha nasce com metadata.poll completo, incluindo o message_secret que o
// qr-service devolve: é ele que decripta os votos depois de um restart.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { recusarSeDirect } from '../_shared/canal.ts';
import { z } from 'https://esm.sh/zod@3.23.8';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireUser, requirePhoneAccess } from '../_shared/authz.ts';
import { qrAuthHeaders } from '../_shared/qr.ts';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { reativarConversa } from '../_shared/conversation-touch.ts';
import { mesclarMetadata } from '../_shared/metadata-merge.ts';

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
    'polls only on qr': 'Enquetes só estão disponíveis em números conectados via QR.',
    'failed to send poll': 'Falha ao enviar enquete. Tente novamente.',
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
  question: z.string().trim().min(1).max(255),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(12),
  /** 1 = escolha única; 0 = múltipla (convenção do WhatsApp). */
  selectableCount: z.number().int().min(0).default(1),
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
    const { to, conversationId, phoneNumberId, question, options, selectableCount } = parsed.data;
    if (selectableCount > options.length) {
      throw new Error('selectableCount não pode exceder o número de opções');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    await recusarSeDirect(supabase, [conversationId]);
    const userId = await requireUser(supabase, req);

    let phoneData: { id: string; phone_number_id: string | null; organization_id: string; connection_type: string | null } | null = null;
    if (isUUID(phoneNumberId)) {
      const { data } = await supabase
        .from('phone_numbers')
        .select('id, phone_number_id, organization_id, connection_type')
        .eq('id', phoneNumberId)
        .maybeSingle();
      phoneData = data;
    }
    if (!phoneData) {
      const { data } = await supabase
        .from('phone_numbers')
        .select('id, phone_number_id, organization_id, connection_type')
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle();
      phoneData = data;
    }
    if (!phoneData) {
      throw new Error('Phone number not found');
    }
    if (phoneData.connection_type !== 'qr') {
      throw new Error('Polls only on QR lines');
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

    const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
    if (!qrServiceUrl) {
      throw new Error('QR_SERVICE_URL not configured');
    }

    let qrResponse: Response;
    try {
      qrResponse = await fetch(`${qrServiceUrl}/message/send-poll/${phoneData.id}`, {
        method: 'POST',
        headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ to, question, options, selectableCount }),
      });
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      throw new Error(`QR service unreachable: ${msg}`);
    }

    const qrData = await qrResponse.json();
    if (!qrResponse.ok || !qrData.success) {
      throw new Error(qrData.error || 'Failed to send poll');
    }
    const whatsappMessageId: string = qrData.messageId || `qr_${Date.now()}`;

    const { data: newMessage, error: msgError } = await supabase
      .from('messages')
      .upsert({
        conversation_id: conversationId,
        content: question,
        direction: 'outbound',
        sent_by: userId,
        whatsapp_message_id: whatsappMessageId,
        message_type: 'poll',
        metadata: {
          poll: {
            question,
            options,
            selectable_count: selectableCount,
            message_secret: qrData.messageSecret ?? null,
            votes: {},
          },
        },
      }, {
        onConflict: 'whatsapp_message_id,conversation_id',
        ignoreDuplicates: true,
      })
      .select()
      .maybeSingle();

    if (msgError) {
      console.error('[SendPoll] Error saving message to DB:', msgError);
    }

    // Eco do Baileys pode ter gravado a linha antes SEM o secret (o eco não o
    // carrega decriptável do nosso lado do jeito que o result do send carrega):
    // garante o secret na linha viva.
    if (!newMessage && qrData.messageSecret) {
      // Merge atômico em dois níveis, nunca substituição: a linha do eco já pode trazer chat_jid,
      // creator_jid, votos e outras chaves (ctwa, link_preview). O patch NÃO leva `votes`: o
      // nivel2 mescla dentro de `poll` e deixa o que record_poll_vote gravou intacto.
      const { data: existing } = await supabase
        .from('messages')
        .select('id')
        .eq('whatsapp_message_id', whatsappMessageId)
        .eq('conversation_id', conversationId)
        .maybeSingle();

      if (existing?.id) {
        try {
          await mesclarMetadata(supabase, existing.id, {
            poll: {
              question,
              options,
              selectable_count: selectableCount,
              message_secret: qrData.messageSecret,
            },
          }, { nivel2: true });
        } catch (err) {
          console.error('[SendPoll] Error merging poll metadata:', err);
        }
      }
    }

    // Update conversation. O trigger on_message_inserted já avançou
    // last_message_at no insert; aqui só reabre, e só se não estiver 'active' (D1).
    await reativarConversa(supabase, conversationId);

    if (newMessage) {
      await emitMessageSent(supabase, {
        conversationId,
        messageId: newMessage.id,
        whatsappMessageId,
        content: question,
        messageType: 'poll',
        sentBy: userId,
        origin: 'panel',
        phoneNumberDbId: phoneData.id,
        organizationId: phoneData.organization_id,
        metaPhoneNumberId: phoneData.phone_number_id,
      });
    }

    return new Response(
      JSON.stringify({ success: true, messageId: whatsappMessageId, message: newMessage }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: unknown) {
    console.error('[SendPoll] Error:', error);
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
