import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireOrgRole } from '../_shared/authz.ts';
import { fetchMidia, UrlExternaBloqueadaError } from '../_shared/url-guard.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'missing required fields': 'Preencha todos os campos obrigatórios.',
    'template name must be lowercase': 'Nome do template deve ser minúsculo, sem espaços.',
    'no whatsapp credentials': 'WhatsApp não configurado.',
    'failed to create template': 'Falha ao criar template. Verifique os dados.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

interface TemplateRequest {
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  language: string;
  bodyText: string;
  headerText?: string;
  // For media headers (IMAGE/VIDEO/DOCUMENT) we need a sample asset:
  // the frontend uploads it to storage and provides the public URL — this
  // function then runs Meta's Resumable Upload to obtain the `header_handle`.
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
}

// Run Meta's Resumable Upload protocol to obtain a `header_handle` for a sample asset.
// Docs: https://developers.facebook.com/docs/graph-api/guides/upload
async function uploadSampleToMeta(opts: {
  appId: string;
  accessToken: string;
  fileUrl: string;
  fallbackMimeType?: string;
}): Promise<string> {
  console.log('[create-template] uploadSampleToMeta — fetching sample:', opts.fileUrl);

  // 1) Fetch the sample asset bytes
  // Anexo do nosso Storage vai pela base interna; qualquer outra URL passa pela guarda SSRF.
  let fileResp: Response;
  try {
    fileResp = await fetchMidia(opts.fileUrl);
  } catch (err) {
    if (err instanceof UrlExternaBloqueadaError) {
      // O motivo fica só no log: devolvido ao chamador viraria sonda da rede interna.
      console.warn(`[create-template] URL da amostra bloqueada pela guarda (${err.reason})`);
      throw new Error('Failed to fetch header sample: URL not allowed');
    }
    throw err;
  }
  if (!fileResp.ok) {
    console.error(`[create-template] header sample respondeu ${fileResp.status} em ${opts.fileUrl}`);
    throw new Error(`Failed to fetch header sample (${fileResp.status} ${fileResp.statusText})`);
  }
  const buffer = new Uint8Array(await fileResp.arrayBuffer());
  const fileLength = buffer.byteLength;
  // O content-type real vence: o fallback é adivinhado pela extensão e erra em URL de CDN sem extensão.
  const served = fileResp.headers.get('content-type')?.split(';')[0].trim();
  const mimeType =
    (served && served !== 'application/octet-stream' ? served : undefined) || opts.fallbackMimeType || 'application/octet-stream';
  console.log(`[create-template] fetched sample: ${fileLength} bytes, mime=${mimeType}`);

  // 2) Open an upload session — POST /{app-id}/uploads
  const uploadSessionUrl = new URL(`https://graph.facebook.com/v18.0/${opts.appId}/uploads`);
  uploadSessionUrl.searchParams.set('file_length', String(fileLength));
  uploadSessionUrl.searchParams.set('file_type', mimeType);
  uploadSessionUrl.searchParams.set('access_token', opts.accessToken);

  const sessionResp = await fetch(uploadSessionUrl.toString(), { method: 'POST' });
  const sessionJson = await sessionResp.json();
  console.log('[create-template] session response:', sessionResp.status, JSON.stringify(sessionJson));
  if (!sessionResp.ok || !sessionJson.id) {
    throw new Error(sessionJson.error?.message || `Failed to start Meta resumable upload session (status ${sessionResp.status})`);
  }
  const sessionId: string = sessionJson.id; // shape: "upload:..."

  // 3) Upload the bytes to the session — POST /{session-id} with file_offset: 0
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
  console.log('[create-template] upload response:', uploadResp.status, JSON.stringify(uploadJson));
  if (!uploadResp.ok || !uploadJson.h) {
    throw new Error(uploadJson.error?.message || `Failed to upload header sample to Meta (status ${uploadResp.status})`);
  }
  return uploadJson.h as string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Authentication check
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), { status: 401, headers: corsHeaders });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', details: authError }), { status: 401, headers: corsHeaders });
    }

    const body: TemplateRequest & { organizationId: string } = await req.json();

    if (!body.organizationId) {
      return new Response(JSON.stringify({ error: 'organizationId is required' }), { status: 400, headers: corsHeaders });
    }

    // S6: o usuário precisa ser da organização cujo WABA vai receber o template
    // (super admin passa). Antes bastava qualquer JWT válido. Admin-only fica
    // só no log por enquanto: a aba Templates e o TemplateCreator do disparo
    // aparecem para atendente, então exigir admin muda o produto.
    await requireOrgRole(supabase, user.id, body.organizationId, 'member');
    try {
      await requireOrgRole(supabase, user.id, body.organizationId, 'admin');
    } catch {
      console.warn(`[create-template] criado por não-admin (user ${user.id}, org ${body.organizationId})`);
    }

    // Fetch credentials from organization
    const { data: orgData, error: orgError } = await supabase
      .from('organizations')
      .select('whatsapp_access_token, whatsapp_waba_id, whatsapp_app_id')
      .eq('id', body.organizationId)
      .single();

    if (orgError || !orgData || !orgData.whatsapp_access_token || !orgData.whatsapp_waba_id) {
      console.error('Organization credentials not found:', orgError);
      return new Response(JSON.stringify({ error: 'Organization has no WhatsApp credentials configured' }), { status: 400, headers: corsHeaders });
    }

    const accessToken = orgData.whatsapp_access_token;
    const wabaId = orgData.whatsapp_waba_id;
    const appId = (orgData as any).whatsapp_app_id as string | null;

    console.log('Creating template:', body.name, 'for Org:', body.organizationId);

    // Validate required fields
    if (!body.name || !body.category || !body.language || !body.bodyText) {
      return new Response(JSON.stringify({
        error: 'Missing required fields: name, category, language, bodyText'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validate template name (lowercase, underscores, no spaces)
    const nameRegex = /^[a-z0-9_]+$/;
    if (!nameRegex.test(body.name)) {
      return new Response(JSON.stringify({
        error: 'Template name must be lowercase with only letters, numbers, and underscores'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build components array
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
      console.log(`[create-template] headerFormat=${headerFormat}, headerSampleUrl=${body.headerSampleUrl ? 'present' : 'MISSING'}, appId=${appId ? 'present' : 'MISSING'}`);
      if (!body.headerSampleUrl) {
        console.warn('[create-template] BAILING: headerSampleUrl is required for media headers');
        return new Response(
          JSON.stringify({ error: 'headerSampleUrl is required for media headers' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      if (!appId) {
        console.warn('[create-template] BAILING: organizations.whatsapp_app_id is not set');
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
      // Get unique variables to count how many examples we need
      const uniqueVars = [...new Set(variableMatches)];

      let exampleValues: string[] = [];

      if (body.examples && Array.isArray(body.examples) && body.examples.length > 0) {
        exampleValues = body.examples;
      } else {
        exampleValues = uniqueVars.map((_, index) => `exemplo${index + 1}`);
      }

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
            // If URL has dynamic parameter, add example
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

    const templatePayload = {
      name: body.name,
      category: body.category,
      language: body.language,
      components,
    };

    console.log('Sending template to Meta:', JSON.stringify(templatePayload, null, 2));

    const response = await fetch(
      `https://graph.facebook.com/v18.0/${wabaId}/message_templates`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(templatePayload),
      }
    );

    const responseData = await response.json();

    if (!response.ok) {
      console.error('Meta API error:', responseData);
      return new Response(JSON.stringify({
        // error_user_msg é o texto que a Meta escreve para gente (ex.: nome já usado).
        error: responseData.error?.error_user_msg || responseData.error?.message || 'Failed to create template',
        details: responseData.error,
      }), {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('Template created successfully:', responseData);

    return new Response(JSON.stringify({
      success: true,
      template: responseData,
      message: 'Template enviado para aprovação do WhatsApp',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
      return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
