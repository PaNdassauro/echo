import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireOrgRole, requireUser } from '../_shared/authz.ts';
import { fetchMidia, UrlExternaBloqueadaError } from '../_shared/url-guard.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'template id, body text': 'Preencha todos os campos obrigatórios.',
    'no whatsapp access token': 'WhatsApp não configurado.',
    'failed to edit template': 'Falha ao editar template.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

interface EditTemplateRequest {
  templateId: string;
  bodyText: string;
  headerText?: string;
  // Media header support — same shape as create.
  headerFormat?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  headerSampleUrl?: string;
  headerSampleMimeType?: string;
  footerText?: string;
  buttons?: Array<{
    type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
    text: string;
    url?: string;
    /** URL completa de exemplo, para link com {{1}} no fim. */
    example?: string;
    phone_number?: string;
  }>;
  examples?: string[];
  /** Só quando muda: template recusado por categoria errada volta com a categoria nova. */
  category?: 'MARKETING' | 'UTILITY';
}

// Run Meta's Resumable Upload protocol to obtain a `header_handle` for a sample asset.
async function uploadSampleToMeta(opts: {
  appId: string;
  accessToken: string;
  fileUrl: string;
  fallbackMimeType?: string;
}): Promise<string> {
  console.log('[edit-template] uploadSampleToMeta — fetching sample:', opts.fileUrl);

  // Anexo do nosso Storage vai pela base interna; qualquer outra URL passa pela guarda SSRF.
  let fileResp: Response;
  try {
    fileResp = await fetchMidia(opts.fileUrl);
  } catch (err) {
    if (err instanceof UrlExternaBloqueadaError) {
      // O motivo fica só no log: devolvido ao chamador viraria sonda da rede interna.
      console.warn(`[edit-template] URL da amostra bloqueada pela guarda (${err.reason})`);
      throw new Error('Failed to fetch header sample: URL not allowed');
    }
    throw err;
  }
  if (!fileResp.ok) {
    console.error(`[edit-template] header sample respondeu ${fileResp.status} em ${opts.fileUrl}`);
    throw new Error(`Failed to fetch header sample (${fileResp.status} ${fileResp.statusText})`);
  }
  const buffer = new Uint8Array(await fileResp.arrayBuffer());
  const fileLength = buffer.byteLength;
  // O content-type real vence: o fallback é adivinhado pela extensão e erra em URL de CDN sem extensão.
  const served = fileResp.headers.get('content-type')?.split(';')[0].trim();
  const mimeType =
    (served && served !== 'application/octet-stream' ? served : undefined) || opts.fallbackMimeType || 'application/octet-stream';
  console.log(`[edit-template] fetched sample: ${fileLength} bytes, mime=${mimeType}`);

  const uploadSessionUrl = new URL(`https://graph.facebook.com/v18.0/${opts.appId}/uploads`);
  uploadSessionUrl.searchParams.set('file_length', String(fileLength));
  uploadSessionUrl.searchParams.set('file_type', mimeType);
  uploadSessionUrl.searchParams.set('access_token', opts.accessToken);

  const sessionResp = await fetch(uploadSessionUrl.toString(), { method: 'POST' });
  const sessionJson = await sessionResp.json();
  console.log('[edit-template] session response:', sessionResp.status, JSON.stringify(sessionJson));
  if (!sessionResp.ok || !sessionJson.id) {
    throw new Error(sessionJson.error?.message || `Failed to start Meta resumable upload session (status ${sessionResp.status})`);
  }
  const sessionId: string = sessionJson.id;

  const uploadResp = await fetch(`https://graph.facebook.com/v18.0/${sessionId}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${opts.accessToken}`,
      file_offset: '0',
      'Content-Type': mimeType,
    },
    body: buffer,
  });
  const uploadJson = await uploadResp.json();
  console.log('[edit-template] upload response:', uploadResp.status, JSON.stringify(uploadJson));
  if (!uploadResp.ok || !uploadJson.h) {
    throw new Error(uploadJson.error?.message || `Failed to upload header sample to Meta (status ${uploadResp.status})`);
  }
  return uploadJson.h as string;
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
    const body: EditTemplateRequest & { organizationId: string } = await req.json();

    if (!body.templateId || !body.bodyText || !body.organizationId) {
      return new Response(JSON.stringify({
        error: 'Template ID, body text, and organizationId are required'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Mesmo gate do whatsapp-create-template: membro da org (super admin
    // passa). Admin-only fica só no log, porque a aba Templates aparece para
    // atendente e exigir admin muda o produto.
    await requireOrgRole(supabase, userId, body.organizationId, 'member');
    try {
      await requireOrgRole(supabase, userId, body.organizationId, 'admin');
    } catch {
      console.warn(`[edit-template] editado por não-admin (user ${userId}, org ${body.organizationId})`);
    }

    // Fetch credentials from organization
    const { data: orgData, error: orgError } = await supabase
      .from('organizations')
      .select('whatsapp_access_token, whatsapp_app_id')
      .eq('id', body.organizationId)
      .single();

    if (orgError || !orgData || !orgData.whatsapp_access_token) {
      console.error('Organization credentials not found:', orgError);
      return new Response(JSON.stringify({ error: 'Organization has no WhatsApp Access Token configured' }), { status: 400, headers: corsHeaders });
    }

    const accessToken = orgData.whatsapp_access_token;
    const appId = (orgData as any).whatsapp_app_id as string | null;

    console.log('Editing template:', body.templateId, 'for Org:', body.organizationId);

    // Build components array for update
    const components: any[] = [];

    // Header — TEXT or media (IMAGE/VIDEO/DOCUMENT)
    const headerFormat = body.headerFormat || (body.headerText ? 'TEXT' : null);
    if (headerFormat === 'TEXT' && body.headerText) {
      components.push({
        type: 'HEADER',
        format: 'TEXT',
        text: body.headerText,
      });
    } else if (headerFormat === 'IMAGE' || headerFormat === 'VIDEO' || headerFormat === 'DOCUMENT') {
      console.log(`[edit-template] headerFormat=${headerFormat}, headerSampleUrl=${body.headerSampleUrl ? 'present' : 'MISSING'}, appId=${appId ? 'present' : 'MISSING'}`);
      if (!body.headerSampleUrl) {
        console.warn('[edit-template] BAILING: headerSampleUrl is required for media headers');
        return new Response(
          JSON.stringify({ error: 'headerSampleUrl is required for media headers' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      if (!appId) {
        console.warn('[edit-template] BAILING: organizations.whatsapp_app_id is not set');
        return new Response(
          JSON.stringify({ error: 'Organization is missing the Meta App ID required for media template headers. Configure it in Integration settings.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      const headerHandle = await uploadSampleToMeta({
        appId,
        accessToken,
        fileUrl: body.headerSampleUrl,
        fallbackMimeType: body.headerSampleMimeType,
      });
      components.push({
        type: 'HEADER',
        format: headerFormat,
        example: { header_handle: [headerHandle] },
      });
    }

    // Add body (required)
    const bodyComponent: any = {
      type: 'BODY',
      text: body.bodyText,
    };

    // Extract variables from body text and add example if needed
    const variableMatches = body.bodyText.match(/\{\{\d+\}\}/g);
    if (variableMatches) {
      const uniqueVars = [...new Set(variableMatches)];
      const exampleValues = body.examples && body.examples.length === uniqueVars.length
        ? body.examples
        : uniqueVars.map((_, index) => `exemplo${index + 1}`);
      bodyComponent.example = {
        body_text: [exampleValues],
      };
    }

    components.push(bodyComponent);

    // Add footer if provided
    if (body.footerText) {
      components.push({
        type: 'FOOTER',
        text: body.footerText,
      });
    }

    // Add buttons if provided
    if (body.buttons && body.buttons.length > 0) {
      const buttonsComponent: any = {
        type: 'BUTTONS',
        buttons: body.buttons.map(btn => {
          if (btn.type === 'QUICK_REPLY') {
            return {
              type: 'QUICK_REPLY',
              text: btn.text,
            };
          } else if (btn.type === 'URL') {
            const buttonObj: any = {
              type: 'URL',
              text: btn.text,
              url: btn.url,
            };
            if (btn.url?.includes('{{')) {
              buttonObj.example = [btn.example || btn.url.replace(/\{\{1\}\}$/, '123')];
            }
            return buttonObj;
          } else if (btn.type === 'PHONE_NUMBER') {
            return {
              type: 'PHONE_NUMBER',
              text: btn.text,
              phone_number: btn.phone_number,
            };
          }
          return btn;
        }),
      };
      components.push(buttonsComponent);
    }

    const updatePayload: Record<string, unknown> = {
      components,
    };
    if (body.category === 'MARKETING' || body.category === 'UTILITY') {
      updatePayload.category = body.category;
    }

    console.log('Sending update to Meta:', JSON.stringify(updatePayload, null, 2));

    // Use the template ID to update
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${body.templateId}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatePayload),
      }
    );

    const responseData = await response.json();

    if (!response.ok) {
      console.error('Meta API error:', responseData);
      return new Response(JSON.stringify({
        // error_user_msg é o texto que a Meta escreve para gente (ex.: nome já usado).
        error: responseData.error?.error_user_msg || responseData.error?.message || 'Failed to edit template',
        details: responseData.error,
      }), {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('Template edited successfully:', responseData);

    return new Response(JSON.stringify({
      success: true,
      template: responseData,
      message: 'Template atualizado e enviado para re-aprovação',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
      return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
