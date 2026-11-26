const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireOrgRole, requireUser } from '../_shared/authz.ts';

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'template name and organizationid are required': 'Selecione um template para deletar.',
    'no whatsapp credentials': 'WhatsApp não configurado.',
    'failed to delete template': 'Falha ao deletar template.',
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

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  // S7: authenticated não lê mais whatsapp_access_token. A identidade sai do
  // JWT (requireUser) e o token é lido com o client de service role, depois de
  // conferir que o usuário é da organização.
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const userId = await requireUser(supabase, req);
    // templateId (hsm_id) apaga só aquele idioma; sem ele a Meta apaga todos os idiomas do nome.
    const { name, organizationId, templateId } = await req.json();

    if (!name || !organizationId) {
      return new Response(JSON.stringify({
        error: 'Template name and organizationId are required'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Mesmo gate do whatsapp-create-template: membro da org (super admin
    // passa). Admin-only fica só no log, porque a aba Templates aparece para
    // atendente e exigir admin muda o produto.
    await requireOrgRole(supabase, userId, organizationId, 'member');
    try {
      await requireOrgRole(supabase, userId, organizationId, 'admin');
    } catch {
      console.warn(`[delete-template] apagado por não-admin (user ${userId}, org ${organizationId})`);
    }

    // Fetch credentials from organization
    const { data: orgData, error: orgError } = await supabase
      .from('organizations')
      .select('whatsapp_access_token, whatsapp_waba_id')
      .eq('id', organizationId)
      .single();

    if (orgError || !orgData || !orgData.whatsapp_access_token || !orgData.whatsapp_waba_id) {
      console.error('Organization credentials not found:', orgError);
      return new Response(JSON.stringify({ error: 'Organization has no WhatsApp credentials configured' }), { status: 400, headers: corsHeaders });
    }

    const accessToken = orgData.whatsapp_access_token;
    const wabaId = orgData.whatsapp_waba_id;

    console.log('Deleting template:', name, 'for Org:', organizationId);

    const response = await fetch(
      `https://graph.facebook.com/v18.0/${wabaId}/message_templates?name=${encodeURIComponent(name)}${typeof templateId === 'string' && /^\d+$/.test(templateId) ? `&hsm_id=${templateId}` : ''}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );

    const responseData = await response.json();

    if (!response.ok) {
      console.error('Meta API error:', responseData);
      return new Response(JSON.stringify({
        error: responseData.error?.error_user_msg || responseData.error?.message || 'Failed to delete template',
        details: responseData.error,
      }), {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('Template deleted successfully:', responseData);

    return new Response(JSON.stringify({
      success: true,
      message: 'Template deletado com sucesso',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
      return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
