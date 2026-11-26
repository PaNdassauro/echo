import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { z } from 'https://esm.sh/zod@3.23.8';
import { checkInternalCaller } from '../_shared/authz.ts';
import { enviarEmail, esc, estadoDoEmail, siteUrl } from '../_shared/email.ts';

// Notificação humana dos alertas de infraestrutura do Echo.
//
// Chamada por cron (via pg_net, service role) quando um detector acende. Aqui
// saem o e-mail (SMTP ou Resend, ver _shared/email.ts) e o push de
// sistema para os admins (send-web-push com userIds explícitos). O cooldown
// anti-spam fica em quem chama (30 min), não aqui. Sem transporte de e-mail a
// resposta é 200 com `email: "nao_configurado"` e o push segue.
//
// Dois formatos de chamada:
//  - check_message_failure_alerts() manda só {alert_key, count, window_minutes}
//    e a tabela do e-mail é montada aqui, a partir de qr_message_log;
//  - check_qr_service_health() manda também {title, summary, details, hint} e
//    descreve o próprio alerta — esta função só envia. Foi o que permitiu
//    reaproveitar e-mail+push para o health-check sem duplicar o layout.
//
// Destinatários de e-mail: FAILURE_ALERT_EMAILS (secret, CSV, recomendada) com fallback
// nos super admins da instalação. O alerta é da infraestrutura inteira (falhas de todas
// as organizações), então nunca vai para admins de uma organização só.
// verify_jwt = false: invocada servidor-a-servidor com a service role key.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PayloadSchema = z.object({
  alert_key: z.string().min(1),
  count: z.number().int().nonnegative(),
  window_minutes: z.number().int().positive().default(5),
  // Apresentação vinda de quem chama. Sem estes campos o alerta é renderizado
  // como o do pipeline de mensagens, que
  // monta a tabela a partir de qr_message_log. Com eles, quem chama descreve o
  // próprio alerta e esta função continua responsável só pelo envio.
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  details: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  hint: z.string().optional(),
  // 'ok' é o heartbeat periódico (send_pipeline_heartbeat): cabeçalho verde,
  // sem sirene e sem push — é confirmação de vida, não pedido de ação.
  tone: z.enum(['alert', 'ok']).default('alert'),
}).passthrough();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // S6: verify_jwt = false e só existe para chamada servidor-a-servidor.
  // Chamadores: crons check-message-failure-alerts, qr-service-health e
  // pipeline-heartbeat (pg_net, service_role_key do Vault).
  const denied = checkInternalCaller(req, 'send-failure-alert', { headers: corsHeaders });
  if (denied) return denied;
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const parsed = PayloadSchema.safeParse(await req.json());
    if (!parsed.success) {
      return json({ error: 'invalid_payload', issues: parsed.error.issues }, 400);
    }
    const { alert_key, count, window_minutes, title, summary, details, hint, tone } = parsed.data;
    const custom = Boolean(title && summary);
    const isOk = tone === 'ok' && custom;
    const emoji = isOk ? '✅' : '🚨';
    const headerColor = isOk ? '#14B8A6' : '#ef4444';

    // Detalhe da última hora para o corpo do e-mail: agrupado por action no
    // cliente (PostgREST não agrega); o volume de falhas é pequeno por definição.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: failureRows } = custom ? { data: [] } : await supabase
      .from('qr_message_log')
      .select('action, error, created_at')
      .eq('success', false)
      .gte('created_at', oneHourAgo)
      .order('created_at', { ascending: false })
      .limit(500);

    const byAction = new Map<string, { n: number; lastError: string | null; lastAt: string }>();
    for (const row of failureRows ?? []) {
      const cur = byAction.get(row.action) ?? { n: 0, lastError: null, lastAt: row.created_at };
      cur.n += 1;
      if (!cur.lastError && row.error) cur.lastError = row.error;
      byAction.set(row.action, cur);
    }

    // E-mail: secret dedicado, com fallback nos super admins da instalação. O alerta mostra
    // o estado do pipeline de todas as organizações, por isso não usa os e-mails de alerta
    // de desconexão (que são de cada organização).
    let emails = (Deno.env.get('FAILURE_ALERT_EMAILS') ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    if (emails.length === 0) {
      const { data: admins } = await supabase
        .from('profiles')
        .select('email')
        .eq('is_super_admin', true);
      emails = [...new Set((admins ?? []).map((p) => p.email as string).filter(Boolean))];
    }

    // URL do front para o logo e o botão do e-mail (SITE_URL); sem ela o e-mail sai com links relativos.
    let site = '';
    try {
      site = siteUrl();
    } catch (e) {
      console.warn('[send-failure-alert]', e instanceof Error ? e.message : String(e));
    }

    const customRowsHtml = (details ?? []).map((d) => `
            <tr>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 13px; color: #6b7280;">${esc(d.label)}</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-family: monospace; font-size: 13px; color: #1f2937; text-align: right;">${esc(d.value)}</td>
            </tr>`).join('');

    const detailRowsHtml = [...byAction.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([action, info]) => `
            <tr>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-family: monospace; font-size: 13px; color: #1f2937;">${esc(action)}</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 13px; color: #1f2937; text-align: right;">${info.n}</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #6b7280;">${esc((info.lastError ?? '—').slice(0, 120))}</td>
            </tr>`)
      .join('');

    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 560px; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);">
          <tr>
            <td style="background-color: ${headerColor}; padding: 24px 32px;">
              <img src="${site}/echo-logo.png" alt="Echo" style="height: 40px; width: auto;" />
            </td>
          </tr>
          <tr>
            <td style="padding: 40px 32px;">
              <h1 style="color: #1f2937; font-size: 22px; font-weight: 600; margin: 0 0 24px 0;">
                ${emoji} ${custom ? esc(title!) : 'Falha no pipeline de mensagens'}
              </h1>
              <p style="color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">
                ${custom ? esc(summary!) : `<strong style="color: #1f2937;">${count} falha(s)</strong> de processamento de mensagem
                nos últimos ${window_minutes} minutos. Mensagens podem estar sendo perdidas ou degradadas.`}
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 24px 0; border: 1px solid #e5e7eb; border-radius: 6px; border-collapse: separate; overflow: hidden;">
                ${custom ? `
                <tr style="background-color: #f9fafb;">
                  <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Indicador</th>
                  <th style="padding: 8px 12px; text-align: right; font-size: 12px; color: #6b7280; text-transform: uppercase;">Valor</th>
                </tr>${customRowsHtml}` : `
                <tr style="background-color: #f9fafb;">
                  <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Falha (última hora)</th>
                  <th style="padding: 8px 12px; text-align: right; font-size: 12px; color: #6b7280; text-transform: uppercase;">Qtd</th>
                  <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Último erro</th>
                </tr>${detailRowsHtml || `
                <tr><td colspan="3" style="padding: 12px; font-size: 13px; color: #6b7280;">Detalhe indisponível — consulte qr_message_log.</td></tr>`}`}
              </table>
              <p style="color: #6b7280; font-size: 13px; line-height: 1.6; margin: 0 0 24px 0;">
                Diagnóstico: <code style="background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 12px;">${custom ? esc(hint ?? '—') : `SELECT action, count(*), max(created_at) FROM qr_message_log WHERE created_at &gt; now() - interval '1 hour' AND success = false GROUP BY 1;`}</code>
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="background-color: #14B8A6; border-radius: 6px;">
                    <a href="${site}" style="display: block; padding: 14px 48px; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none;">Abrir o Echo</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="border-top: 1px solid #e5e7eb; padding: 24px 32px; text-align: center;">
              <p style="color: #9ca3af; font-size: 12px; margin: 0;">Alerta automático do Echo.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;


    const resultado = await enviarEmail({
      to: emails,
      subject: custom ? `${emoji} Echo: ${title}` : `🚨 Echo: ${count} falha(s) no pipeline de mensagens`,
      html: emailHtml,
    });
    const emailEstado = estadoDoEmail(resultado);
    const emailSent = resultado.ok;
    let emailError: string | null = null;
    if (!resultado.ok) {
      emailError = resultado.motivo === 'falha_envio' ? resultado.erro : resultado.motivo;
      if (resultado.motivo === 'falha_envio') console.error('[send-failure-alert] Erro ao enviar e-mail:', resultado.erro);
      else if (resultado.motivo === 'sem_destinatario') console.warn('[send-failure-alert] nenhum destinatário (configure FAILURE_ALERT_EMAILS)');
    }


    // Push de sistema para as MESMAS pessoas do e-mail: a lista de destinatários
    // é uma só (FAILURE_ALERT_EMAILS, com o mesmo fallback nos super admins),
    // resolvida para user_ids via profiles. Só quem está nessa lista recebe push.
    let pushSent = 0;
    if (isOk) {
      // Heartbeat não vira push: 3 notificações/dia de "tudo bem" só ensinam a ignorar.
    } else try {
      const { data: recipients } = await supabase
        .from('profiles')
        .select('id')
        .in('email', emails);
      const adminIds = [...new Set((recipients ?? []).map((r) => r.id as string).filter(Boolean))];
      if (adminIds.length > 0) {
        const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-web-push`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userIds: adminIds,
            title: custom ? `🚨 ${title}` : '🚨 Falha no pipeline de mensagens',
            body: custom ? summary! : `${count} falha(s) nos últimos ${window_minutes} min — mensagens podem estar sendo perdidas.`,
            url: '/',
            tag: `alert-${alert_key}`,
          }),
        });
        const data = await res.json().catch(() => ({}));
        pushSent = typeof data.sent === 'number' ? data.sent : 0;
      }
    } catch (e) {
      console.error('[send-failure-alert] Erro no push:', e);
    }

    return json({
      success: emailSent || pushSent > 0,
      email: emailEstado,
      email_sent: emailSent,
      email_recipients: emails.length,
      email_error: emailError,
      push_sent: pushSent,
    });
  } catch (error) {
    console.error('[send-failure-alert] Error:', error);
    return json({ success: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
