// deno test --no-config --allow-env --allow-read --allow-net=127.0.0.1 --allow-sys supabase/functions/_shared/email.test.ts
// O teste do SMTP abre um servidor local em 127.0.0.1 (smtp-sink.test-helper.ts, ao lado) e usa o nodemailer de verdade.
import { abrirSink } from './smtp-sink.test-helper.ts';
import { ConfigAusenteError, emailConfigurado, enviarEmail, esc, estadoDoEmail, lerConfigEmail, siteUrl } from './email.ts';

function igual(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
  }
}

const MSG = { to: ['admin@example.com'], subject: 'Assunto', html: '<p>x</p>' };

function comEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const antes = Object.keys(vars).map((k) => [k, Deno.env.get(k)] as const);
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    fn();
  } finally {
    for (const [k, v] of antes) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test('sem nada configurado: nao_configurado tipado, sem lançar', async () => {
  const r = await enviarEmail(MSG, { env: {} });
  igual(r, { ok: false, motivo: 'nao_configurado', faltando: ['SMTP_HOST ou RESEND_API_KEY'] }, 'resultado');
});

Deno.test('variáveis vazias (o compose passa ${VAR:-}) equivalem a ausentes', () => {
  const c = lerConfigEmail({
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_SECURE: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    SMTP_ADMIN_EMAIL: '',
    SMTP_SENDER_NAME: '',
    RESEND_API_KEY: '  ',
    EMAIL_FROM: '',
  });
  igual(c, { configurado: false, faltando: ['SMTP_HOST ou RESEND_API_KEY'] }, 'tudo vazio');
  const smtp = lerConfigEmail({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '', SMTP_SECURE: '', SMTP_ADMIN_EMAIL: 'a@example.com' });
  igual(smtp.configurado && smtp.transporte === 'smtp' && [smtp.port, smtp.secure], [587, 'starttls'], 'padrões do SMTP');
});

Deno.test('valor inválido de SMTP com SMTP_HOST: invalida (não nao_configurado) com a dica da variável', async () => {
  const c = lerConfigEmail({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: 'abc', SMTP_ADMIN_EMAIL: 'a@example.com' });
  igual(c, { configurado: false, invalida: ['SMTP_PORT inválida: use um número de 1 a 65535'] }, 'porta inválida');
  const modo = lerConfigEmail({ SMTP_HOST: 'smtp.example.com', SMTP_SECURE: 'ssl', EMAIL_FROM: 'a@example.com' });
  igual(modo, { configurado: false, invalida: ['SMTP_SECURE inválida: use starttls|tls|none'] }, 'modo inválido');

  const r = await enviarEmail(MSG, { env: { SMTP_HOST: 'smtp.example.com', SMTP_SECURE: 'STARTTLS ', SMTP_PORT: '0', EMAIL_FROM: 'a@example.com' } });
  igual(r.ok, false, 'não enviou');
  igual(!r.ok && r.motivo, 'falha_envio', 'falha, não nao_configurado');
  igual(estadoDoEmail(r), 'falhou', 'estado das edges');
});

Deno.test('SMTP_SECURE ignora a caixa e os espaços', () => {
  const c = lerConfigEmail({ SMTP_HOST: 'smtp.example.com', SMTP_SECURE: ' StartTLS ', EMAIL_FROM: 'a@example.com' });
  igual(c.configurado && c.transporte === 'smtp' && c.secure, 'starttls', 'caixa normalizada');
  const none = lerConfigEmail({ SMTP_HOST: 'mailpit', SMTP_SECURE: 'NONE', EMAIL_FROM: 'a@example.com' });
  igual(none.configurado && none.transporte === 'smtp' && none.secure, 'none', 'NONE');
});

Deno.test('SMTP_PORT/SMTP_SECURE soltos não derrubam quem usa só o Resend', () => {
  const c = lerConfigEmail({ SMTP_PORT: 'abc', SMTP_SECURE: 'ssl', RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@example.com' });
  igual(c.configurado && c.transporte, 'resend', 'Resend segue valendo');
});

Deno.test('SMTP sem remetente: nao_configurado', () => {
  igual(
    lerConfigEmail({ SMTP_HOST: 'smtp.example.com' }),
    { configurado: false, faltando: ['EMAIL_FROM ou SMTP_ADMIN_EMAIL'] },
    'sem remetente',
  );
});

Deno.test('Resend sem EMAIL_FROM: nao_configurado', async () => {
  const r = await enviarEmail(MSG, { env: { RESEND_API_KEY: 're_x' } });
  igual(r, { ok: false, motivo: 'nao_configurado', faltando: ['EMAIL_FROM'] }, 'resultado');
});

Deno.test('SMTP tem prioridade sobre Resend e o remetente sai de SMTP_ADMIN_EMAIL/SMTP_SENDER_NAME', () => {
  const c = lerConfigEmail({
    SMTP_HOST: 'smtp.example.com',
    SMTP_ADMIN_EMAIL: 'noreply@example.com',
    SMTP_SENDER_NAME: 'Echo',
    RESEND_API_KEY: 're_x',
  });
  igual(c.configurado && c.transporte, 'smtp', 'transporte');
  igual(c.configurado && c.from, 'Echo <noreply@example.com>', 'from');
  igual(c.configurado && c.transporte === 'smtp' && c.secure, 'starttls', 'secure padrão 587');
  const c465 = lerConfigEmail({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', EMAIL_FROM: 'a@example.com' });
  igual(c465.configurado && c465.transporte === 'smtp' && c465.secure, 'tls', 'secure 465');
  const comFrom = lerConfigEmail({ SMTP_HOST: 'smtp.example.com', SMTP_ADMIN_EMAIL: 'x@example.com', EMAIL_FROM: 'Echo <e@example.com>' });
  igual(comFrom.configurado && comFrom.from, 'Echo <e@example.com>', 'EMAIL_FROM vence');
});

Deno.test('Resend: monta o POST e devolve o id', async () => {
  let corpo: Record<string, unknown> = {};
  const fakeFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    corpo = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: 'abc' }), { status: 200 });
  }) as typeof fetch;
  const r = await enviarEmail(
    { ...MSG, replyTo: 'r@example.com' },
    { env: { RESEND_API_KEY: 're_x', EMAIL_FROM: 'Echo <noreply@example.com>' }, fetch: fakeFetch },
  );
  igual(r, { ok: true, transporte: 'resend', id: 'abc' }, 'resultado');
  igual(corpo.reply_to, 'r@example.com', 'reply_to');
});

Deno.test('Resend 422: falha_envio tipada', async () => {
  const fakeFetch = (async () => new Response('{"message":"bad"}', { status: 422 })) as typeof fetch;
  const r = await enviarEmail(MSG, { env: { RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@example.com' }, fetch: fakeFetch });
  igual(r.ok === false && r.motivo, 'falha_envio', 'motivo');
});

Deno.test('SMTP de verdade contra o sink local (nodemailer npm:, SMTP_SECURE=none)', async () => {
  const sink = abrirSink();
  try {
    const r = await enviarEmail(MSG, {
      env: {
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(sink.port),
        SMTP_SECURE: 'none',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
        SMTP_ADMIN_EMAIL: 'noreply@example.com',
      },
    });
    if (!r.ok) throw new Error(`envio falhou: ${JSON.stringify(r)}`);
    await new Promise((res) => setTimeout(res, 50));
    igual(sink.recebidas.length, 1, 'mensagens no sink');
    igual(sink.recebidas[0].data.includes('Subject: Assunto'), true, 'assunto na mensagem');
  } finally {
    sink.fechar();
  }
});

Deno.test('SMTP fora do ar: falha_envio, sem lançar', async () => {
  const sink = abrirSink();
  const porta = sink.port;
  sink.fechar();
  const r = await enviarEmail(MSG, {
    env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(porta), SMTP_SECURE: 'none', EMAIL_FROM: 'a@example.com' },
  });
  igual(r.ok === false && r.motivo, 'falha_envio', 'motivo');
});

Deno.test('lista vazia de destinatários: sem_destinatario', async () => {
  const r = await enviarEmail(
    { ...MSG, to: [' ', ''] },
    { env: { RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@example.com' } },
  );
  igual(r, { ok: false, motivo: 'sem_destinatario' }, 'resultado');
});

Deno.test('emailConfigurado lê o ambiente do processo', () => {
  comEnv({ SMTP_HOST: undefined, RESEND_API_KEY: undefined, EMAIL_FROM: undefined }, () => {
    igual(emailConfigurado(), false, 'sem nada');
  });
  comEnv({ SMTP_HOST: 'smtp.example.com', SMTP_ADMIN_EMAIL: 'a@example.com', RESEND_API_KEY: undefined }, () => {
    igual(emailConfigurado(), true, 'com SMTP');
  });
});

Deno.test('siteUrl: sem SITE_URL falha com erro claro; com ele, tira a barra final', () => {
  comEnv({ SITE_URL: undefined }, () => {
    try {
      siteUrl();
      throw new Error('não lançou');
    } catch (e) {
      if (!(e instanceof ConfigAusenteError)) throw e;
      igual(e.message.includes('SITE_URL not configured'), true, 'mensagem');
    }
  });
  comEnv({ SITE_URL: 'https://echo.example.com//' }, () => {
    igual(siteUrl(), 'https://echo.example.com', 'siteUrl');
  });
});

Deno.test('esc: escapa o que quebra HTML', () => {
  igual(esc(`<b>"A" & 'B'</b>`), '&lt;b&gt;&quot;A&quot; &amp; &#39;B&#39;&lt;/b&gt;', 'escape');
});

Deno.test('estadoDoEmail: enviado, nao_configurado e falhou (sem_destinatario conta como falhou)', () => {
  igual(estadoDoEmail({ ok: true, transporte: 'smtp', id: null }), 'enviado', 'ok');
  igual(estadoDoEmail({ ok: false, motivo: 'nao_configurado', faltando: ['SMTP_HOST ou RESEND_API_KEY'] }), 'nao_configurado', 'sem transporte');
  igual(estadoDoEmail({ ok: false, motivo: 'falha_envio', transporte: 'resend', erro: 'HTTP 422' }), 'falhou', 'falha de envio');
  igual(estadoDoEmail({ ok: false, motivo: 'sem_destinatario' }), 'falhou', 'sem destinatário');
});
