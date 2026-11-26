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
    'whatsapp credentials not configured': 'WhatsApp não configurado. Verifique as configurações.',
    'meta api error': 'Erro ao buscar templates. Tente novamente.',
    'unauthorized': 'Você não tem permissão para esta ação.',
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
    // header qualquer um listava os templates de qualquer organização).
    // verify_jwt = false no gateway; os chamadores (TemplatesSettings,
    // BroadcastBuilder, useTemplates e StartConversationDialog) usam
    // functions.invoke com a sessão. Membro da org ou super admin.
    const userId = await requireUser(supabase, req);

    // name (opcional): o acompanhamento de aprovação do builder consulta um template só,
    // em vez de puxar a WABA inteira a cada volta.
    const { organizationId, name } = await req.json();

    if (!organizationId) {
      throw new Error('Organization ID is required');
    }

    await requireOrgRole(supabase, userId, organizationId, 'member');

    // 2. Fetch Credentials from DB (Strict Mode)
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

    const wabaId = whatsapp_waba_id;
    const accessToken = whatsapp_access_token;

    console.log('Fetching templates for WABA ID:', wabaId);

    // Fetch all templates with pagination. rejected_reason não vem por padrão: a
    // aba Templates mostra o motivo da recusa.
    const allTemplates: any[] = [];
    let nextUrl: string | null = `https://graph.facebook.com/v18.0/${wabaId}/message_templates?limit=100&fields=id,name,language,status,category,components,rejected_reason${typeof name === 'string' && name ? `&name=${encodeURIComponent(name)}` : ''}`;

    while (nextUrl) {
      const templatesResponse: Response = await fetch(nextUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      const templatesData: {
        data?: unknown[];
        error?: { message?: string };
        paging?: { next?: string };
      } = await templatesResponse.json();

      if (!templatesResponse.ok) {
        console.error('Error fetching templates from Meta:', templatesData);
        throw new Error(`Meta API Error: ${templatesData.error?.message || 'Unknown error'}`);
      }

      if (templatesData.data) {
        allTemplates.push(...templatesData.data);
      }

      // Check for next page
      nextUrl = templatesData.paging?.next || null;

      if (nextUrl) {
        console.log(`Fetched ${allTemplates.length} templates, fetching next page...`);
      }
    }

    console.log('Total templates fetched:', allTemplates.length);

    return new Response(JSON.stringify({ data: allTemplates }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
