import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { recusarSeDirect } from '../_shared/canal.ts';
import { z } from 'https://esm.sh/zod@3.23.8';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireUser, requirePhoneAccess } from '../_shared/authz.ts';
import { sendMetaTypingIndicator, getLatestInboundWamid } from '../_shared/meta-typing-indicator.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'unauthorized': 'Você não tem permissão para esta ação.',
    'not a member': 'Você não é membro desta organização.',
    'do not have access': 'Você não tem acesso a este número de WhatsApp.',
    'conversation not found': 'Conversa não encontrada.',
    'phone number not found': 'Número de WhatsApp não encontrado.',
    'whatsapp credentials not configured': 'WhatsApp não configurado.',
  };
  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) return value;
  }
  return `Erro: ${error}`;
}

const InputSchema = z.object({
  conversationId: z.string().uuid(),
  phoneNumberId: z.string().min(1).max(64).optional(),
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  try {
    const rawBody = await req.json().catch(() => ({}));
    const parsed = InputSchema.safeParse(rawBody);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Entrada inválida: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { conversationId } = parsed.data;
    const supabase = createClient(supabaseUrl, supabaseKey);
    await recusarSeDirect(supabase, [conversationId]);
    const userId = await requireUser(supabase, req);

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, phone_number_id')
      .eq('id', conversationId)
      .maybeSingle();

    if (convError || !conversation) {
      throw new Error('Conversation not found');
    }

    const { data: phoneData, error: phoneError } = await supabase
      .from('phone_numbers')
      .select(`
        id,
        phone_number_id,
        organization_id,
        connection_type,
        typing_indicator_enabled,
        organizations (
          id,
          whatsapp_access_token
        )
      `)
      .eq('id', conversation.phone_number_id)
      .maybeSingle();

    if (phoneError || !phoneData) {
      throw new Error('Phone number not found');
    }

    await requirePhoneAccess(supabase, userId, phoneData.id, phoneData.organization_id);

    // QR connections handle typing indicator directly via Baileys websocket
    if (phoneData.connection_type === 'qr') {
      return new Response(
        JSON.stringify({ success: true, skipped: 'qr' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if typing indicator is enabled for this phone number
    if (!phoneData.typing_indicator_enabled) {
      return new Response(
        JSON.stringify({ success: true, skipped: 'disabled_by_config' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const org = phoneData.organizations;
    const orgData = Array.isArray(org) ? org[0] : org;
    const accessToken = orgData?.whatsapp_access_token;
    const metaPhoneNumberId = phoneData.phone_number_id;

    if (!accessToken || !metaPhoneNumberId) {
      throw new Error('WhatsApp credentials not configured');
    }

    const inboundWamid = await getLatestInboundWamid(supabase, conversationId);
    if (!inboundWamid) {
      return new Response(
        JSON.stringify({ success: true, skipped: 'no_inbound_message' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = await sendMetaTypingIndicator({
      accessToken,
      metaPhoneNumberId,
      inboundMessageId: inboundWamid,
    });

    return new Response(
      JSON.stringify({ success: result.success, error: result.error }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
