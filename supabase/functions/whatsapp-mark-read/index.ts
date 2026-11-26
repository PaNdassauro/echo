// Recibo de leitura (tique azul p/ o contato) ao abrir a conversa no painel.
//
// Opt-in por número (phone_numbers.send_read_receipts, DEFAULT false) — o
// painel chama fire-and-forget e este early-out barato decide. Sem
// idempotência própria: recibo repetido é inofensivo nos dois protocolos.
// ("Digitando" na Cloud API é outra função: whatsapp-typing-start, com o
// toggle typing_indicator_enabled próprio.)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { z } from 'https://esm.sh/zod@3.23.8';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireUser, requirePhoneAccess } from '../_shared/authz.ts';
import { qrAuthHeaders } from '../_shared/qr.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function friendlyError(error: string): string {
  return `Erro: ${error}`;
}

const InputSchema = z.object({
  conversationId: z.string().uuid(),
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
    const { conversationId } = parsed.data;

    const supabase = createClient(supabaseUrl, supabaseKey);
    const userId = await requireUser(supabase, req);

    const { data: conversation } = await supabase
      .from('conversations')
      .select('id, contact_phone, is_group, group_jid, phone_number_id, channel')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conversation?.phone_number_id) {
      return new Response(JSON.stringify({ skipped: true, reason: 'conversation_not_found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Direct do Instagram: o recibo de leitura do WhatsApp não se aplica.
    if (conversation.channel === 'instagram') {
      return new Response(JSON.stringify({ skipped: true, reason: 'instagram' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: phoneData } = await supabase
      .from('phone_numbers')
      .select('id, phone_number_id, organization_id, connection_type, send_read_receipts, organizations (whatsapp_access_token)')
      .eq('id', conversation.phone_number_id)
      .maybeSingle();
    if (!phoneData) {
      return new Response(JSON.stringify({ skipped: true, reason: 'phone_not_found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Early-out: nada ligado neste número → no-op barato.
    if (!phoneData.send_read_receipts) {
      return new Response(JSON.stringify({ skipped: true, reason: 'receipts_disabled' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    await requirePhoneAccess(supabase, userId, phoneData.id, phoneData.organization_id);

    if (phoneData.connection_type === 'qr') {
      const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
      if (!qrServiceUrl) {
        throw new Error('QR_SERVICE_URL not configured');
      }

      // Inbound recentes (48h, cap 100) — o recibo só faz sentido para o que
      // acabou de ser lido; histórico antigo não precisa azular.
      const { data: inbound } = await supabase
        .from('messages')
        .select('whatsapp_message_id, sender_jid')
        .eq('conversation_id', conversationId)
        .eq('direction', 'inbound')
        // Card juntado ao Direct: id do Instagram não vale para o WhatsApp.
        .or('metadata->>canal.is.null,metadata->>canal.neq.instagram')
        .not('whatsapp_message_id', 'is', null)
        .gt('created_at', new Date(Date.now() - 48 * 3_600_000).toISOString())
        .order('created_at', { ascending: false })
        .limit(100);

      if (!inbound || inbound.length === 0) {
        return new Response(JSON.stringify({ skipped: true, reason: 'no_recent_inbound' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const jid = conversation.is_group && conversation.group_jid
        ? conversation.group_jid
        : `${conversation.contact_phone.replace(/\D/g, '')}@s.whatsapp.net`;

      const keys = inbound.map((m) => ({
        id: m.whatsapp_message_id as string,
        // Em grupo o recibo sem participant é ignorado pelo WhatsApp
        participant: conversation.is_group ? (m.sender_jid ?? null) : null,
      }));

      const qrResponse = await fetch(`${qrServiceUrl}/message/mark-read/${phoneData.id}`, {
        method: 'POST',
        headers: qrAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ jid, keys }),
      });
      const qrData = await qrResponse.json();
      if (!qrResponse.ok || !qrData.success) {
        throw new Error(qrData.error || 'Failed to mark messages read');
      }

      return new Response(JSON.stringify({ success: true, count: keys.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Cloud API: status:read no inbound mais novo
    const org = phoneData.organizations;
    const orgData = Array.isArray(org) ? org[0] : org;
    const accessToken = orgData?.whatsapp_access_token;
    if (!accessToken) {
      throw new Error('WhatsApp credentials not configured for this organization');
    }

    const { data: newest } = await supabase
      .from('messages')
      .select('whatsapp_message_id')
      .eq('conversation_id', conversationId)
      .eq('direction', 'inbound')
      // Card juntado ao Direct: id do Instagram não vale para o WhatsApp.
      .or('metadata->>canal.is.null,metadata->>canal.neq.instagram')
      .not('whatsapp_message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!newest?.whatsapp_message_id) {
      return new Response(JSON.stringify({ skipped: true, reason: 'no_inbound' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: newest.whatsapp_message_id,
    };

    const metaResponse = await fetch(
      `https://graph.facebook.com/v18.0/${phoneData.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    const metaData = await metaResponse.json();
    if (!metaResponse.ok) {
      // wamid velho demais (>30d) ou já lido: falha silenciosa aceitável
      console.warn('[MarkRead] Cloud API error:', metaData);
      return new Response(JSON.stringify({ skipped: true, reason: 'meta_rejected' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    console.error('[MarkRead] Error:', error);
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
