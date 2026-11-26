import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.87.1";
import { checkInternalCaller } from "../_shared/authz.ts";
import { enviarEmail, esc, estadoDoEmail, siteUrl } from "../_shared/email.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface DisconnectAlertPayload {
    phone_number_id: string;
    disconnected_at: string;
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    // verify_jwt = false: só existe para chamada servidor-a-servidor.
    // Chamador: qr-service (SessionManager.triggerDisconnectAlert), com a chave de service role.
    const denied = checkInternalCaller(req, "send-disconnect-alert", { headers: corsHeaders });
    if (denied) return denied;

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    try {
        const payload: DisconnectAlertPayload = await req.json();
        const { phone_number_id, disconnected_at } = payload;

        if (!phone_number_id) {
            return new Response(JSON.stringify({ error: "Missing phone_number_id" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        console.log(`[send-disconnect-alert] Processing alert for phone ${phone_number_id}`);

        // 1. Fetch phone number config with organization
        const { data: phoneNumber, error: phoneError } = await supabase
            .from('phone_numbers')
            .select(`
                id,
                display_name,
                phone_number,
                disconnect_alert_enabled,
                disconnect_alert_threshold_minutes,
                disconnect_alert_emails,
                disconnect_alert_cooldown_minutes,
                organization_id,
                organizations (name)
            `)
            .eq('id', phone_number_id)
            .single();

        if (phoneError || !phoneNumber) {
            console.log(`[send-disconnect-alert] Phone number not found: ${phone_number_id}`);
            return new Response(JSON.stringify({ success: false, error: "Phone number not found" }), {
                status: 404,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // 2. Check if alerts are enabled
        if (!phoneNumber.disconnect_alert_enabled) {
            console.log(`[send-disconnect-alert] Alerts not enabled for phone ${phone_number_id}`);
            return new Response(JSON.stringify({ success: true, message: "Alerts not enabled" }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const emails = phoneNumber.disconnect_alert_emails || [];
        if (emails.length === 0) {
            console.log(`[send-disconnect-alert] No emails configured for phone ${phone_number_id}`);
            return new Response(JSON.stringify({ success: true, message: "No emails configured" }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // 3. Check cooldown
        const cooldownMinutes = phoneNumber.disconnect_alert_cooldown_minutes || 15;
        const cooldownTime = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();

        const { data: recentAlert } = await supabase
            .from('disconnect_alert_log')
            .select('id')
            .eq('phone_number_id', phone_number_id)
            .gte('alert_sent_at', cooldownTime)
            .limit(1);

        if (recentAlert && recentAlert.length > 0) {
            console.log(`[send-disconnect-alert] Cooldown active for phone ${phone_number_id}`);
            return new Response(JSON.stringify({ success: true, message: "Cooldown active" }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // 4. Send email (SMTP ou Resend; sem transporte configurado não é erro do servidor: 200 e log abaixo)
        // URL do front para o logo e o botão; sem ela o e-mail sai com links relativos.
        let site = "";
        try {
            site = siteUrl();
        } catch (e) {
            console.warn("[send-disconnect-alert]", (e as Error).message);
        }

        const disconnectedDate = new Date(disconnected_at);
        const formattedTime = disconnectedDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const orgName = esc(((phoneNumber.organizations as { name?: string } | null)?.name) || "Sua organizacao");
        const displayName = esc(phoneNumber.display_name ?? "");
        const numero = phoneNumber.phone_number ? esc(phoneNumber.phone_number) : "";

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
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 520px; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color: #ef4444; padding: 24px 32px;">
              <img src="${site}/echo-logo.png" alt="Echo" style="height: 40px; width: auto;" />
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 32px;">
              <h1 style="color: #1f2937; font-size: 22px; font-weight: 600; margin: 0 0 24px 0;">
                ⚠️ Alerta de Desconexao
              </h1>
              <p style="color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">
                O numero <strong style="color: #1f2937;">${displayName}</strong> ${numero ? `(${numero})` : ''} da organizacao <strong style="color: #14B8A6;">${orgName}</strong> esta desconectado.
              </p>
              <p style="color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0 0 32px 0;">
                <strong>Desconectado desde:</strong> ${formattedTime}
              </p>

              <!-- Action Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto 32px auto;">
                <tr>
                  <td style="background-color: #14B8A6; border-radius: 6px;">
                    <a href="${site}/settings" style="display: block; padding: 14px 48px; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none;">
                      Verificar Conexao
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #9ca3af; font-size: 13px; line-height: 1.5; margin: 0; text-align: center;">
                Este alerta foi configurado nas suas preferencias de numero.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top: 1px solid #e5e7eb; padding: 24px 32px; text-align: center;">
              <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                Enviado pelo Echo desta organização.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

        const resultado = await enviarEmail({
            to: emails,
            subject: `⚠️ Alerta: ${phoneNumber.display_name} desconectado - Echo`,
            html: emailHtml,
        });
        const emailEstado = estadoDoEmail(resultado);
        const emailSent = resultado.ok;
        let errorMessage: string | null = null;
        if (resultado.ok) {
            console.log("[send-disconnect-alert] Email sent successfully:", resultado.id);
        } else if (resultado.motivo === "nao_configurado") {
            errorMessage = "email_nao_configurado";
        } else if (resultado.motivo === "falha_envio") {
            console.error("[send-disconnect-alert] Error sending email:", resultado.erro);
            errorMessage = resultado.erro;
        } else {
            errorMessage = resultado.motivo;
        }

        // 5. Log the alert
        await supabase.from('disconnect_alert_log').insert({
            phone_number_id,
            emails_sent: emails,
            disconnected_at,
            success: emailSent,
            error_message: errorMessage,
        });

        // Sempre 200: sem e-mail configurado (ou com falha de envio) o log acima mantém o cooldown.
        return new Response(JSON.stringify({
            success: emailSent,
            email: emailEstado,
            emails_sent: emails.length,
            error: errorMessage,
        }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

    } catch (error) {
        console.error("[send-disconnect-alert] Error:", error);
        return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
