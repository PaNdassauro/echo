// Volta do login do Instagram: liga a conta profissional a uma linha do Echo.
//
// O link de conexão (instagram.com/oauth/authorize) sai de nós com um "state"
// assinado que diz a organização e a linha e vence em 30 minutos. Quem autoriza
// é um administrador da conta do Instagram; aqui o código vira token longo
// (60 dias), a conta é lida, os avisos de mensagem são assinados e tudo fica
// guardado em instagram_connections. O token nunca aparece na página nem no
// log: toda chamada ao Meta passa por buscar(), que não deixa a URL (onde vão
// token e segredo) chegar ao log quando a rede falha.
//
// A resposta é um redirecionamento para o front do Echo (o domínio *.supabase.co
// entrega HTML de GET como texto cru): link que saiu da tela de Configurações
// (state.app) volta para Configurações > Números > Instagram; o link montado à
// mão volta para a página estática.
//
// Fase 1: conectar não responde ninguém e não muda nada no
// Instagram que o público veja.
//
// verify_jwt = false (é o navegador voltando do Instagram): ver supabase/config.toml.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { IG_CAMPOS_ASSINADOS, IG_GRAPH, lerEstado, linhaPodeHospedar, segredosDoApp } from '../_shared/instagram.ts';
import { siteUrl } from '../_shared/email.ts';
import { basePublica } from '../_shared/url-publica.ts';

type Json = Record<string, unknown>;
type Resultado =
  | 'ok'
  | 'sem-avisos'
  | 'cancelado'
  | 'link-invalido'
  | 'indisponivel'
  | 'linha'
  | 'recusado'
  | 'outra-linha'
  | 'linha-ocupada'
  | 'erro';

/** Origem do front (SITE_URL, obrigatória): para onde o navegador volta depois do login. */
function origemDoFront(): string | null {
  try {
    return new URL(siteUrl()).origin;
  } catch {
    return null;
  }
}

function voltar(resultado: Resultado, conta?: string | null, paraOEcho = false): Response {
  const origem = origemDoFront();
  if (!origem) {
    console.error('[instagram-oauth] SITE_URL ausente ou inválida: não há para onde devolver o navegador');
    return new Response('SITE_URL ausente: configure o segredo SITE_URL da função instagram-oauth.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const paginaDeRetorno = Deno.env.get('INSTAGRAM_PAGINA_RETORNO') || `${origem}/instagram-conexao.html`;
  const destino = paraOEcho ? new URL('/settings', origem) : new URL(paginaDeRetorno);
  if (paraOEcho) destino.searchParams.set('tab', 'appearance');
  destino.searchParams.set(paraOEcho ? 'instagram' : 'r', resultado);
  if (conta) destino.searchParams.set('conta', conta);
  return new Response(null, { status: 302, headers: { Location: destino.toString(), 'Cache-Control': 'no-store' } });
}

async function buscar(etapa: string, url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; corpo: Json }> {
  try {
    const res = await fetch(url, init);
    let corpo: Json = {};
    try {
      corpo = (await res.json()) as Json;
    } catch {
      corpo = {};
    }
    return { ok: res.ok, status: res.status, corpo };
  } catch (e) {
    // Só o nome do erro: a mensagem do fetch traz a URL inteira.
    console.error(`[instagram-oauth] ${etapa}: falha de rede (${e instanceof Error ? e.name : 'erro'})`);
    return { ok: false, status: 0, corpo: { error: { message: 'falha de rede' } } };
  }
}

function erroDoMeta(corpo: Json): string {
  const e = (corpo.error ?? corpo) as Json;
  const msg = typeof e.message === 'string' ? e.message : typeof e.error_message === 'string' ? e.error_message : '';
  const tipo = typeof e.type === 'string' ? e.type : typeof e.error_type === 'string' ? e.error_type : '';
  const codigo = e.code !== undefined ? ` código ${e.code}` : '';
  const sub = e.error_subcode !== undefined ? `/${e.error_subcode}` : '';
  return `${tipo} ${msg}${codigo}${sub}`.trim().slice(0, 300) || 'erro sem detalhe';
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });

  const url = new URL(req.url);
  const estado = await lerEstado(url.searchParams.get('state'), Deno.env.get('INSTAGRAM_OAUTH_STATE_SECRET') ?? '');
  const paraOEcho = estado?.app === true;
  if (url.searchParams.get('error')) return voltar('cancelado', null, paraOEcho);

  const code = url.searchParams.get('code');
  if (!code || !estado) return voltar('link-invalido', null, paraOEcho);

  const appId = Deno.env.get('INSTAGRAM_APP_ID') ?? '';
  const appSecret = segredosDoApp()[0] ?? '';
  const redirectUri = Deno.env.get('INSTAGRAM_OAUTH_REDIRECT_URI')
    ?? `${basePublica()}/functions/v1/instagram-oauth`;
  if (!appId || !appSecret) {
    console.error('[instagram-oauth] INSTAGRAM_APP_ID ou INSTAGRAM_APP_SECRET ausente');
    return voltar('indisponivel', null, paraOEcho);
  }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const { data: linha } = await db
    .from('phone_numbers')
    .select('id, organization_id, connection_type')
    .eq('id', estado.linha)
    .eq('organization_id', estado.org)
    .maybeSingle();
  if (!linha || !linhaPodeHospedar(linha.connection_type)) return voltar('linha', null, paraOEcho);

  // 1) código → token curto
  const troca = await buscar('troca do código', 'https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code: code.replace(/#_$/, ''),
    }),
  });
  const curto = (Array.isArray(troca.corpo.data) ? (troca.corpo.data[0] as Json) : troca.corpo) ?? {};
  const tokenCurto = typeof curto.access_token === 'string' ? curto.access_token : '';
  if (!troca.ok || !tokenCurto) {
    console.error('[instagram-oauth] troca do código recusada', troca.status, erroDoMeta(troca.corpo));
    return voltar('recusado', null, paraOEcho);
  }
  const permissoes = Array.isArray(curto.permissions)
    ? (curto.permissions as unknown[]).map(String)
    : typeof curto.permissions === 'string'
    ? curto.permissions.split(',')
    : [];

  // 2) token curto → token longo (60 dias). A documentação manda GET, mas o
  //    Meta já respondeu "Unsupported request - method type: get"
  //    (IGApiException) com o token real: tenta GET, depois POST com o mesmo
  //    corpo. Se os dois recusarem, segue com o token curto (1 hora) e anota o
  //    motivo: a conexão e a assinatura dos avisos não dependem do token longo.
  const pedidoLongo = { grant_type: 'ig_exchange_token', client_secret: appSecret, access_token: tokenCurto };
  let longo = await buscar('token longo (GET)', `https://graph.instagram.com/access_token?${new URLSearchParams(pedidoLongo)}`);
  if (!longo.ok || typeof longo.corpo.access_token !== 'string') {
    console.warn('[instagram-oauth] token longo por GET recusado', longo.status, erroDoMeta(longo.corpo));
    longo = await buscar('token longo (POST)', 'https://graph.instagram.com/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(pedidoLongo),
    });
  }
  const temLongo = longo.ok && typeof longo.corpo.access_token === 'string' && longo.corpo.access_token.length > 0;
  if (!temLongo) console.error('[instagram-oauth] token longo recusado; seguindo com o curto', longo.status, erroDoMeta(longo.corpo));
  const tokenLongo = temLongo ? (longo.corpo.access_token as string) : tokenCurto;
  const segundos = temLongo
    ? (typeof longo.corpo.expires_in === 'number' ? longo.corpo.expires_in : null)
    : (typeof curto.expires_in === 'number' ? curto.expires_in : 3600);
  const expiraEm = segundos ? new Date(Date.now() + segundos * 1000).toISOString() : null;
  const avisoDoToken = temLongo ? null : `token longo recusado (${erroDoMeta(longo.corpo)}); conexão com token de 1 hora`;

  // 3) qual conta foi autorizada: o user_id do /me é o que chega em entry[].id
  //    nos avisos. Sem ele, não grava (outro id faria os avisos não casarem).
  // Diagnóstico: com o token real o Meta respondeu "Unsupported
  // request" até no /me. Registra o tipo do token (prefixo de 4 letras e
  // tamanho, nunca o valor) e tenta a leitura por caminhos diferentes, na ordem.
  console.log(JSON.stringify({
    fn: 'instagram-oauth',
    diagnostico: 'token',
    prefixo: tokenLongo.slice(0, 4),
    tamanho: tokenLongo.length,
    longo: temLongo,
    chaves_da_troca: Object.keys(troca.corpo),
    user_id_da_troca: typeof curto.user_id,
  }));
  const tentativas: [string, string][] = [
    ['v25 /me', `${IG_GRAPH}/me?${new URLSearchParams({ fields: 'user_id,username', access_token: tokenLongo })}`],
    ['sem versão /me', `https://graph.instagram.com/me?${new URLSearchParams({ fields: 'user_id,username', access_token: tokenLongo })}`],
    ['v21 /me', `https://graph.instagram.com/v21.0/me?${new URLSearchParams({ fields: 'user_id,username', access_token: tokenLongo })}`],
    ['facebook /me', `https://graph.facebook.com/v21.0/me?${new URLSearchParams({ fields: 'id,name', access_token: tokenLongo })}`],
  ];
  let igUserId = '';
  let igUsername: string | null = null;
  for (const [rotulo, endereco] of tentativas) {
    const r = await buscar(`leitura da conta (${rotulo})`, endereco);
    console.log(JSON.stringify({ fn: 'instagram-oauth', diagnostico: rotulo, status: r.status, chaves: Object.keys(r.corpo), erro: r.ok ? null : erroDoMeta(r.corpo) }));
    if (r.ok && typeof r.corpo.user_id === 'string') {
      igUserId = r.corpo.user_id;
      igUsername = typeof r.corpo.username === 'string' ? r.corpo.username : null;
      break;
    }
  }
  if (!igUserId) {
    console.error('[instagram-oauth] leitura da conta sem user_id em todos os caminhos');
    return voltar('recusado', null, paraOEcho);
  }

  // 4) assinar os avisos de mensagem da conta
  const assina = await buscar(
    'assinatura dos avisos',
    `${IG_GRAPH}/me/subscribed_apps?${new URLSearchParams({
      subscribed_fields: IG_CAMPOS_ASSINADOS.join(','),
      access_token: tokenLongo,
    })}`,
    { method: 'POST' },
  );
  const assinou = assina.ok && assina.corpo.success === true;
  if (!assinou) console.error('[instagram-oauth] assinatura dos avisos recusada', assina.status, erroDoMeta(assina.corpo));

  // A linha já é de outra conta do Instagram: gravar por cima trocaria a conta
  // e deixaria as conversas da anterior sem resposta. Reconectar a mesma passa.
  const { data: daLinha, error: daLinhaErro } = await db
    .from('instagram_connections')
    .select('ig_user_id')
    .eq('phone_number_id', estado.linha)
    .maybeSingle();
  if (daLinhaErro) {
    console.error('[instagram-oauth] leitura da conexão da linha falhou', daLinhaErro.code);
    return voltar('erro', null, paraOEcho);
  }
  if (daLinha && daLinha.ig_user_id !== igUserId) return voltar('linha-ocupada', igUsername, paraOEcho);

  const agora = new Date().toISOString();
  const { error } = await db.from('instagram_connections').upsert(
    {
      organization_id: estado.org,
      phone_number_id: estado.linha,
      ig_user_id: igUserId,
      ig_username: igUsername,
      access_token: tokenLongo,
      token_expires_at: expiraEm,
      token_refresh_tried_at: null,
      scopes: permissoes,
      subscribed_fields: assinou ? IG_CAMPOS_ASSINADOS : [],
      status: assinou ? 'connected' : 'error',
      last_error: [assinou ? null : `assinatura dos avisos: ${erroDoMeta(assina.corpo)}`, avisoDoToken]
        .filter(Boolean)
        .join(' | ') || null,
      connected_at: agora,
      updated_at: agora,
    },
    { onConflict: 'phone_number_id' },
  );
  if (error) {
    console.error('[instagram-oauth] gravação falhou', error.code, error.message);
    return voltar(error.code === '23505' ? 'outra-linha' : 'erro', null, paraOEcho);
  }

  console.log(JSON.stringify({ fn: 'instagram-oauth', conectou: igUsername ?? igUserId, linha: estado.linha, avisos: assinou }));
  return voltar(assinou ? 'ok' : 'sem-avisos', igUsername, paraOEcho);
});
