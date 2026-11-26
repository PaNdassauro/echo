// Envio de e-mail das edges, opcional: um único ponto (`enviarEmail`) que escolhe o transporte pelo ambiente.
//
//   SMTP_HOST definido                  -> SMTP (nodemailer, importado sob demanda)
//   senão RESEND_API_KEY + EMAIL_FROM   -> Resend (HTTP)
//   senão                               -> { ok: false, motivo: 'nao_configurado' }  (nunca lança, nunca 5xx)
//
// Os nomes SMTP_* são os mesmos que o compose passa ao Auth como GOTRUE_SMTP_*: uma configuração, dois leitores.
// Remetente SMTP: EMAIL_FROM se houver, senão "<SMTP_SENDER_NAME> <SMTP_ADMIN_EMAIL>".
import { z } from 'https://esm.sh/zod@3.23.8';

/** Variável de ambiente obrigatória que não foi configurada. */
export class ConfigAusenteError extends Error {
  constructor(public readonly variavel: string, dica: string) {
    super(`${variavel} not configured: ${dica}`);
    this.name = 'ConfigAusenteError';
  }
}

export type ModoSmtp = 'starttls' | 'tls' | 'none';

export type ConfigEmail =
  | {
    configurado: true;
    transporte: 'smtp';
    from: string;
    host: string;
    port: number;
    secure: ModoSmtp;
    user?: string;
    pass?: string;
  }
  | { configurado: true; transporte: 'resend'; from: string; apiKey: string }
  | { configurado: false; faltando: string[] }
  /** `SMTP_HOST` definido, mas outra variável SMTP com valor que não existe: erro do operador, não "sem e-mail". */
  | { configurado: false; invalida: string[] };

export interface MensagemEmail {
  to: string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export type ResultadoEmail =
  | { ok: true; transporte: 'smtp' | 'resend'; id: string | null }
  | { ok: false; motivo: 'nao_configurado'; faltando: string[] }
  | { ok: false; motivo: 'sem_destinatario' }
  | { ok: false; motivo: 'falha_envio'; transporte: 'smtp' | 'resend'; erro: string };

/** Como o e-mail aparece na resposta das edges: enviado, sem transporte configurado, ou falha de envio. */
export type EstadoEmail = 'enviado' | 'nao_configurado' | 'falhou';

export function estadoDoEmail(r: ResultadoEmail): EstadoEmail {
  if (r.ok) return 'enviado';
  return r.motivo === 'nao_configurado' ? 'nao_configurado' : 'falhou';
}

const EnvSchema = z.object({
  SMTP_HOST: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_ADMIN_EMAIL: z.string().optional(),
  SMTP_SENDER_NAME: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
});

// Só lidos com SMTP_HOST definido: um SMTP_PORT solto não deve derrubar quem usa o Resend.
const SmtpSchema = z.object({
  SMTP_PORT: z.coerce
    .number({ invalid_type_error: 'SMTP_PORT inválida: use um número de 1 a 65535' })
    .int('SMTP_PORT inválida: use um número de 1 a 65535')
    .min(1, 'SMTP_PORT inválida: use um número de 1 a 65535')
    .max(65535, 'SMTP_PORT inválida: use um número de 1 a 65535')
    .optional(),
  // 'starttls' (587, padrão), 'tls' (465, TLS implícito) ou 'none' (só rede interna). Caixa não importa.
  SMTP_SECURE: z
    .enum(['starttls', 'tls', 'none'], { errorMap: () => ({ message: 'SMTP_SECURE inválida: use starttls|tls|none' }) })
    .optional(),
});

const CHAVES_LIDAS = [...Object.keys(EnvSchema.shape), ...Object.keys(SmtpSchema.shape)];

/** Variável vazia ou só com espaços (o compose passa `${VAR:-}`) equivale a ausente. */
function normalizar(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const saida: Record<string, string | undefined> = {};
  for (const chave of CHAVES_LIDAS) {
    const valor = (env[chave] ?? '').trim();
    saida[chave] = valor === '' ? undefined : valor;
  }
  if (saida.SMTP_SECURE) saida.SMTP_SECURE = saida.SMTP_SECURE.toLowerCase();
  return saida;
}

/** Leitura pura do ambiente: nunca lança; valor inválido de SMTP vira `invalida` com o nome da variável. */
export function lerConfigEmail(env: Record<string, string | undefined>): ConfigEmail {
  const bruto = normalizar(env);
  const lido = EnvSchema.safeParse(bruto);
  if (!lido.success) {
    return { configurado: false, faltando: lido.error.issues.map((i) => `${i.path.join('.')} inválida`) };
  }
  const e = lido.data;
  if (e.SMTP_HOST) {
    const smtp = SmtpSchema.safeParse(bruto);
    if (!smtp.success) return { configurado: false, invalida: smtp.error.issues.map((i) => i.message) };
    const deSmtp = e.SMTP_ADMIN_EMAIL
      ? (e.SMTP_SENDER_NAME ? `${e.SMTP_SENDER_NAME} <${e.SMTP_ADMIN_EMAIL}>` : e.SMTP_ADMIN_EMAIL)
      : '';
    const from = e.EMAIL_FROM ?? deSmtp;
    if (!from) return { configurado: false, faltando: ['EMAIL_FROM ou SMTP_ADMIN_EMAIL'] };
    const port = smtp.data.SMTP_PORT ?? 587;
    return {
      configurado: true,
      transporte: 'smtp',
      from,
      host: e.SMTP_HOST,
      port,
      secure: smtp.data.SMTP_SECURE ?? (port === 465 ? 'tls' : 'starttls'),
      user: e.SMTP_USER,
      pass: e.SMTP_PASS,
    };
  }
  if (e.RESEND_API_KEY) {
    if (!e.EMAIL_FROM) return { configurado: false, faltando: ['EMAIL_FROM'] };
    return { configurado: true, transporte: 'resend', from: e.EMAIL_FROM, apiKey: e.RESEND_API_KEY };
  }
  return { configurado: false, faltando: ['SMTP_HOST ou RESEND_API_KEY'] };
}

/** Há algum transporte de e-mail configurado neste ambiente? */
export function emailConfigurado(): boolean {
  return lerConfigEmail(Deno.env.toObject()).configurado;
}

type ConfigSmtp = Extract<ConfigEmail, { transporte: 'smtp' }>;

interface TransporteSmtp {
  sendMail(m: {
    from: string;
    to: string[];
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
  }): Promise<{ messageId?: string }>;
  close?(): void;
}

interface ModuloNodemailer {
  default: { createTransport(opcoes: Record<string, unknown>): TransporteSmtp };
}

export interface DepsEmail {
  /** Padrão: o ambiente do processo. */
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** Injeção para teste; o padrão importa o nodemailer sob demanda (só quem usa SMTP paga o import). */
  criarTransporteSmtp: (c: ConfigSmtp) => Promise<TransporteSmtp>;
}

async function transporteSmtpPadrao(c: ConfigSmtp): Promise<TransporteSmtp> {
  // Especificador literal: o `deno cache` do build só segue literais, e o runtime roda com --cached-only.
  const nodemailer = (await import('npm:nodemailer@10.3.1')) as unknown as ModuloNodemailer;
  return nodemailer.default.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure === 'tls',
    ignoreTLS: c.secure === 'none',
    requireTLS: c.secure === 'starttls',
    auth: c.user ? { user: c.user, pass: c.pass ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

function mensagemDeErro(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Envia pelo transporte configurado. Nunca lança: falta de configuração e falha de envio viram resultado tipado. */
export async function enviarEmail(msg: MensagemEmail, deps: Partial<DepsEmail> = {}): Promise<ResultadoEmail> {
  const cfg = lerConfigEmail(deps.env ?? Deno.env.toObject());
  if (!cfg.configurado && 'invalida' in cfg) {
    // Com SMTP_HOST definido o resto do sistema (gateway, GoTrue) acha que há e-mail: dizer "não configurado" enganaria.
    const erro = cfg.invalida.join('; ');
    console.error(`[email] configuração SMTP inválida (${erro}): e-mail "${msg.subject}" não enviado`);
    return { ok: false, motivo: 'falha_envio', transporte: 'smtp', erro: `configuração SMTP inválida: ${erro}` };
  }
  if (!cfg.configurado) {
    console.info(`[email] não configurado (${cfg.faltando.join(', ')}): e-mail "${msg.subject}" não enviado`);
    return { ok: false, motivo: 'nao_configurado', faltando: cfg.faltando };
  }
  const to = [...new Set(msg.to.map((t) => t.trim()).filter(Boolean))];
  if (to.length === 0) return { ok: false, motivo: 'sem_destinatario' };

  if (cfg.transporte === 'resend') {
    try {
      const res = await (deps.fetch ?? fetch)('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          from: cfg.from,
          to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
        }),
      });
      const dados = await res.json().catch(() => null) as { id?: string } | null;
      if (!res.ok) {
        return {
          ok: false,
          motivo: 'falha_envio',
          transporte: 'resend',
          erro: `HTTP ${res.status}: ${JSON.stringify(dados)}`,
        };
      }
      return { ok: true, transporte: 'resend', id: dados?.id ?? null };
    } catch (e) {
      return { ok: false, motivo: 'falha_envio', transporte: 'resend', erro: mensagemDeErro(e) };
    }
  }

  try {
    const transporte = await (deps.criarTransporteSmtp ?? transporteSmtpPadrao)(cfg);
    try {
      const info = await transporte.sendMail({
        from: cfg.from,
        to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        replyTo: msg.replyTo,
      });
      return { ok: true, transporte: 'smtp', id: info.messageId ?? null };
    } finally {
      transporte.close?.();
    }
  } catch (e) {
    return { ok: false, motivo: 'falha_envio', transporte: 'smtp', erro: mensagemDeErro(e) };
  }
}

/** URL pública do front (SITE_URL), sem a barra final. O compose sempre a define. */
export function siteUrl(): string {
  const valor = (Deno.env.get('SITE_URL') ?? '').trim().replace(/\/+$/, '');
  if (!valor) {
    throw new ConfigAusenteError(
      'SITE_URL',
      'defina SITE_URL com a URL pública do front, ex.: https://echo.seu-dominio.com',
    );
  }
  return valor;
}

/** Escape HTML para texto que entra num e-mail (nome de linha, de organização, texto livre). */
export function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
