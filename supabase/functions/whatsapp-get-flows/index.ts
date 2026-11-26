import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireOrgRole, requireUser } from '../_shared/authz.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'organization id is required': 'Organização não selecionada.',
    'organization error': 'Organização não encontrada.',
    'whatsapp credentials not configured': 'WhatsApp não configurado.',
    'meta api error': 'Erro ao buscar flows. Tente novamente.',
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

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // S6: auth obrigatória (antes só valia `if (authHeader)`, então sem o
    // header qualquer um listava os flows de qualquer organização).
    // verify_jwt = false no gateway. Nenhum chamador no front hoje; quem
    // chamar usa functions.invoke com a sessão. Membro da org ou super admin.
    const userId = await requireUser(supabase, req);

    const { organizationId } = await req.json();

    if (!organizationId) {
      throw new Error('Organization ID is required');
    }

    await requireOrgRole(supabase, userId, organizationId, 'member');

    // Fetch Credentials from DB
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('whatsapp_waba_id, whatsapp_access_token')
      .eq('id', organizationId)
      .single();

    if (orgError || !org) {
      console.error("DB Error fetching org:", orgError);
      throw new Error(`Organization Error: ${orgError?.message || "Not found"}`);
    }

    const { whatsapp_waba_id, whatsapp_access_token } = org;

    if (!whatsapp_waba_id || !whatsapp_access_token) {
      throw new Error("WhatsApp credentials not configured for this organization.");
    }

    console.log('Fetching flows for WABA ID:', whatsapp_waba_id);

    // Fetch flows from Meta Graph API
    // Status can be: DRAFT, PUBLISHED, DEPRECATED, BLOCKED
    const flowsResponse = await fetch(
      `https://graph.facebook.com/v18.0/${whatsapp_waba_id}/flows?fields=id,name,status,categories,validation_errors,json_version,data_api_version,endpoint_uri,preview&limit=100`,
      {
        headers: {
          'Authorization': `Bearer ${whatsapp_access_token}`,
        },
      }
    );

    const flowsData = await flowsResponse.json();

    if (!flowsResponse.ok) {
      console.error('Error fetching flows from Meta:', flowsData);
      throw new Error(`Meta API Error: ${flowsData.error?.message || 'Unknown error'}`);
    }

    console.log('Flows fetched:', flowsData.data?.length || 0);

    return new Response(JSON.stringify(flowsData), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
      return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
