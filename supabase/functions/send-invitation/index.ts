import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.87.1";
import { createErrorResponse } from '../_shared/error-utils.ts';
import { baseDoConviteLocal } from '../_shared/convite-base.ts';
import { enviarEmail, esc, estadoDoEmail, siteUrl, type ResultadoEmail } from '../_shared/email.ts';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'email and phonenumberid are required': 'Preencha o email do convidado.',
    'phone number not found': 'Número de WhatsApp não encontrado.',
    'do not have permission': 'Você não tem permissão para convidar usuários.',
    'invalid token': 'Sessão inválida. Faça login novamente.',
    'failed to create profile': 'Erro ao criar perfil do usuário.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

// Envia o e-mail do convite pelo transporte configurado (SMTP ou Resend). Nunca lança.
async function sendInvitationEmail(
  email: string,
  inviteUrl: string,
  siteBase: string,
  phoneNumberName: string,
  inviterName: string
): Promise<ResultadoEmail> {
  // Nome da linha e de quem convida são texto livre: entram escapados no HTML do e-mail.
  const inviter = esc(inviterName);
  const phone = esc(phoneNumberName);
  const link = esc(inviteUrl);
  const base = esc(siteBase);

  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 520px; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);">
          <!-- Header com logo -->
          <tr>
            <td style="background-color: #14B8A6; padding: 24px 32px;">
              <img src="${base}/echo-logo.png" alt="Echo" style="height: 40px; width: auto;" />
            </td>
          </tr>

          <!-- Conteúdo principal -->
          <tr>
            <td style="padding: 40px 32px;">
              <h1 style="color: #1f2937; font-size: 22px; font-weight: 600; margin: 0 0 24px 0;">
                Você foi convidado para o Echo
              </h1>
              <p style="color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0 0 8px 0;">
                Olá!
              </p>
              <p style="color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0 0 32px 0;">
                <strong style="color: #1f2937;">${inviter}</strong> convidou você para participar do número <strong style="color: #14B8A6;">${phone}</strong> no Echo.
              </p>

              <!-- Botão -->
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto 32px auto;">
                <tr>
                  <td style="background-color: #14B8A6; border-radius: 6px;">
                    <a href="${link}" style="display: block; padding: 14px 48px; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none;">
                      Aceitar Convite
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Link alternativo -->
              <p style="color: #9ca3af; font-size: 13px; line-height: 1.5; margin: 0 0 12px 0; text-align: center;">
                ou copie e cole este link no navegador:
              </p>
              <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 16px; margin-bottom: 32px;">
                <a href="${link}" style="color: #6b7280; font-size: 13px; word-break: break-all; text-decoration: none;">${link}</a>
              </div>

              <p style="color: #9ca3af; font-size: 13px; line-height: 1.5; margin: 0; text-align: center;">
                Este convite foi enviado para você por ${inviter}. Se você não esperava este email ou não deseja participar, pode ignorá-lo com segurança.
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

  return await enviarEmail({
    to: [email],
    subject: `Convite para Echo - ${phoneNumberName}`,
    html: emailHtml,
  });
}

interface UsuarioExistente {
  id: string;
  email: string;
}

/**
 * Usuário que já tem conta com este e-mail: uma consulta em `profiles.email` (o trigger grava o e-mail do Auth, que o
 * GoTrue guarda em minúsculas). Não varre o Auth: convidar e-mail novo é o caso normal e a varredura custaria
 * ceil(N/200) chamadas admin por convite. Conta sem perfil (trigger que falhou) cai no convite comum, e o aceite do
 * convite resolve o `email_exists`.
 */
async function acharUsuarioExistente(supabase: SupabaseClient, email: string): Promise<UsuarioExistente | null> {
  const { data: perfil, error } = await supabase.from('profiles').select('id, email').eq('email', email).maybeSingle();
  if (error) throw new Error(`Falha ao buscar perfil por e-mail: ${error.message}`);
  return perfil ? { id: perfil.id, email: perfil.email ?? email } : null;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify user is admin
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { email, phoneNumberId } = await req.json();

    if (!email || !phoneNumberId) {
      return new Response(
        JSON.stringify({ error: "Email and phoneNumberId are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Get Phone Number & Organization
    const { data: phoneNumber, error: phoneError } = await supabase
      .from("phone_numbers")
      .select("id, display_name, organization_id")
      .eq("id", phoneNumberId)
      .single();

    if (phoneError || !phoneNumber) {
      return new Response(
        JSON.stringify({ error: "Phone number not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Check if User is Admin of this Organization
    // We allow Super Admins (via profile) OR Org Admins
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_super_admin, first_name, last_name, email')
      .eq('id', user.id)
      .single();

    // Get inviter name for email
    const inviterName = profile?.first_name && profile?.last_name
      ? `${profile.first_name} ${profile.last_name}`
      : profile?.first_name || profile?.email || user.email || 'Um administrador';

    const isSuperAdmin = profile?.is_super_admin || false;
    let isOrgAdmin = false;

    if (!isSuperAdmin && phoneNumber.organization_id) {
      const { data: member } = await supabase
        .from('organization_members')
        .select('role')
        .eq('organization_id', phoneNumber.organization_id)
        .eq('user_id', user.id)
        .eq('role', 'admin')
        .single();
      isOrgAdmin = !!member;
    }

    if (!isSuperAdmin && !isOrgAdmin) {
      return new Response(
        JSON.stringify({ error: "You do not have permission to invite users to this number." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if user with this email already exists
    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await acharUsuarioExistente(supabase, normalizedEmail);

    if (existingUser) {
      // User already exists - add them directly to organization and phone number
      const existingUserId = existingUser.id;

      // Add to organization_members if not already a member
      if (phoneNumber.organization_id) {
        const { error: memberError } = await supabase
          .from('organization_members')
          .upsert({
            organization_id: phoneNumber.organization_id,
            user_id: existingUserId,
            role: 'agent'
          }, { onConflict: 'organization_id,user_id' });

        if (memberError) {
          console.error("Error adding to organization:", memberError);
        }
      }

      // Add to user_phone_numbers
      const { error: phoneAccessError } = await supabase
        .from('user_phone_numbers')
        .upsert({
          user_id: existingUserId,
          phone_number_id: phoneNumberId
        }, { onConflict: 'user_id,phone_number_id' });

      if (phoneAccessError) {
        console.error("Error adding phone access:", phoneAccessError);
        return new Response(
          JSON.stringify({ error: phoneAccessError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`Existing user ${normalizedEmail} added directly to phone ${phoneNumber.display_name}`);

      return new Response(
        JSON.stringify({
          success: true,
          existingUser: true,
          message: `Usuário ${normalizedEmail} já existe e foi adicionado ao número ${phoneNumber.display_name}`,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // User doesn't exist - create invitation as before.
    // A URL do front vem de SITE_URL (valor canônico por instalação, obrigatório). Só a origem de quem chama vale em
    // desenvolvimento local; senão o referer de outro front vazaria o domínio dele para o link. Na auto-hospedagem
    // (docker) o admin pode abrir o painel por localhost enquanto o convidado entra por outro endereço: lá o canônico
    // sempre vence. `new URL().origin` também tira o path (o referer traz a URL inteira). Sem base não há link de
    // convite: falha antes de gravar o convite.
    let baseUrl = baseDoConviteLocal(req.headers, Deno.env.get("ECHO_PUBLIC_URL"));
    if (!baseUrl) {
      try {
        baseUrl = siteUrl();
      } catch (error) {
        console.error("[send-invitation]", (error as Error).message);
        return new Response(
          JSON.stringify({ error: "SITE_URL not configured" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Generate unique token
    const token_invite = crypto.randomUUID();

    // Create invitation
    const { data: invitation, error: inviteError } = await supabase
      .from("user_invitations")
      .insert({
        email: normalizedEmail,
        phone_number_id: phoneNumberId,
        invited_by: user.id,
        token: token_invite,
      })
      .select()
      .single();

    if (inviteError) {
      console.error("Error creating invitation:", inviteError);
      return new Response(
        JSON.stringify({ error: inviteError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const inviteUrl = `${baseUrl}/auth?invite=${token_invite}`;

    console.log(`Invitation created for ${normalizedEmail} (expira ${invitation.expires_at})`);

    // Send invitation email via Resend
    const emailResult = await sendInvitationEmail(
      normalizedEmail,
      inviteUrl,
      baseUrl,
      phoneNumber.display_name,
      inviterName
    );

    const estadoEmail = estadoDoEmail(emailResult);
    if (emailResult.ok) {
      console.log(`Invitation email sent to ${normalizedEmail}`);
    } else if (emailResult.motivo === 'falha_envio') {
      console.warn(`Failed to send invitation email: ${emailResult.erro}`);
    }

    // Nunca 5xx por falta de e-mail: o convite existe e o link vai na resposta para o admin copiar.
    return new Response(
      JSON.stringify({
        success: true,
        existingUser: false,
        email: estadoEmail,
        emailSent: emailResult.ok,
        emailError: emailResult.ok ? undefined : emailResult.motivo === 'falha_envio' ? emailResult.erro : emailResult.motivo,
        invitation: {
          id: invitation.id,
          email: invitation.email,
          phoneNumberName: phoneNumber.display_name,
          inviteUrl,
          expiresAt: invitation.expires_at,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
      return createErrorResponse(error, corsHeaders, friendlyError);
  }
});