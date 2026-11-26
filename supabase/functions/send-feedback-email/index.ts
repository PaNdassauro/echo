import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { z } from 'https://esm.sh/zod@3.23.8';
import { requireUser } from '../_shared/authz.ts';
import { emailConfigurado, enviarEmail, esc } from '../_shared/email.ts';

// E-mail do pop-up de feedback (FeedbackForm). Sai junto do webhook de feedback
// (feedbackWebhookUrl da config do front), não no lugar dele.
//
// Destinatários: FEEDBACK_EMAILS (CSV). O feedback é para quem opera a instalação,
// não para a organização de quem envia, então a lista é a mesma para todo tenant.
// Transporte e remetente: _shared/email.ts (SMTP ou Resend). Sem transporte ou sem
// destinatários não é erro do servidor: 200 com { enviado: false, motivo: "nao_configurado" }.
//
// verify_jwt = true. Quem enviou sai do JWT verificado (requireUser), nunca do
// corpo; o nome da organização só entra se o usuário for membro dela.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mesmos limites do feedbackSchema do front (src/components/feedback/feedbackSchema.ts).
const PayloadSchema = z.object({
  type: z.enum(['support', 'bug', 'feature', 'other']),
  title: z.string().trim().min(3).max(100),
  details: z.string().trim().min(10).max(1000),
  organization_id: z.string().uuid().nullable().optional(),
  url: z.string().max(2000).optional(),
});

const TYPE_LABELS: Record<z.infer<typeof PayloadSchema>['type'], string> = {
  support: 'Suporte',
  bug: 'Relatar um problema',
  feature: 'Pedido de função',
  other: 'Outro',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function recipients(): string[] {
  return (Deno.env.get('FEEDBACK_EMAILS') ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let userId: string;
  try {
    userId = await requireUser(supabase, req);
  } catch {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = PayloadSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: 'Invalid payload', issues: parsed.error.issues }, 400);
  }
  const { type, title, details, organization_id, url } = parsed.data;

  const to = recipients();
  if (!emailConfigurado() || to.length === 0) {
    console.info(
      `[send-feedback-email] não configurado (${emailConfigurado() ? 'FEEDBACK_EMAILS vazia' : 'sem SMTP nem Resend'}): feedback não enviado por e-mail`,
    );
    return json({ enviado: false, motivo: 'nao_configurado' });
  }

  try {
    const { data: userData } = await supabase.auth.admin.getUserById(userId);
    const userEmail = userData?.user?.email ?? null;

    let orgName: string | null = null;
    if (organization_id) {
      const { data: member } = await supabase
        .from('organization_members')
        .select('organizations (name)')
        .eq('organization_id', organization_id)
        .eq('user_id', userId)
        .maybeSingle();
      const org = member?.organizations as { name?: string } | null | undefined;
      orgName = org?.name ?? null;
    }

    const typeLabel = TYPE_LABELS[type];
    const sentAt = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const rows: [string, string][] = [
      ['Tipo', typeLabel],
      ['Enviado por', userEmail ?? userId],
      ['Organização', orgName ?? '—'],
      ['Quando', sentAt],
      ['Página', url ?? '—'],
    ];

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 560px; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);">
          <tr>
            <td style="padding: 32px 32px 8px;">
              <p style="color: #6b7280; font-size: 13px; margin: 0 0 8px;">Feedback do Echo · ${esc(typeLabel)}</p>
              <h1 style="color: #111827; font-size: 20px; margin: 0;">${esc(title)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 32px;">
              <p style="color: #374151; font-size: 15px; line-height: 1.6; margin: 0; white-space: pre-wrap;">${esc(details)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 32px 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top: 1px solid #e5e7eb;">
                ${rows.map(([label, value]) => `
                <tr>
                  <td style="padding: 8px 12px 0 0; color: #6b7280; font-size: 13px; white-space: nowrap; vertical-align: top;">${esc(label)}</td>
                  <td style="padding: 8px 0 0; color: #111827; font-size: 13px; word-break: break-all;">${esc(value)}</td>
                </tr>`).join('')}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const resultado = await enviarEmail({
      to,
      replyTo: userEmail ?? undefined,
      subject: `[Feedback · ${typeLabel}] ${title}`,
      html: emailHtml,
    });
    if (!resultado.ok) {
      if (resultado.motivo === 'nao_configurado') return json({ enviado: false, motivo: 'nao_configurado' });
      console.error('[send-feedback-email] e-mail não enviado:', resultado);
      return json({ error: 'Email not sent' }, 502);
    }

    return json({ success: true, enviado: true });
  } catch (e) {
    console.error('[send-feedback-email] Erro ao enviar e-mail:', e);
    return json({ error: 'Internal error' }, 500);
  }
});
