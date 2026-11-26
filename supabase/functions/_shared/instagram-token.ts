// Renovação do token longo do Instagram.
//
// O token longo vale 60 dias e não se renova sozinho: sem isto a linha
// Instagram para de responder e de ler perfis no dia em que ele vence. A rotina
// instagram-reprocessar chama renovarTokens() a cada 5 minutos (só quando o
// banco diz que há o que fazer; ver instagram_reprocessar_avisos).
//
// O token nunca vai ao log: só o motivo da recusa do Meta.
import { precisaRenovar } from './instagram.ts';

// deno-lint-ignore no-explicit-any
type Db = any;
type Json = Record<string, unknown>;

type ConexaoDoToken = {
  id: string;
  ig_username: string | null;
  status: string;
  access_token: string;
  token_expires_at: string | null;
  token_refresh_tried_at: string | null;
  last_error: string | null;
};

const MARCA_DO_ERRO = 'renovação do token:';

function motivo(corpo: Json): string {
  const e = (corpo.error ?? corpo) as Json;
  const msg = typeof e.message === 'string' ? e.message : typeof e.error_message === 'string' ? e.error_message : '';
  const codigo = e.code !== undefined ? ` código ${e.code}` : '';
  return `${msg}${codigo}`.trim().slice(0, 200) || 'sem detalhe';
}

async function pedir(init: RequestInit | undefined, url: string): Promise<{ ok: boolean; corpo: Json }> {
  try {
    const res = await fetch(url, init);
    const corpo = (await res.json().catch(() => ({}))) as Json;
    return { ok: res.ok, corpo };
  } catch (e) {
    // Só o nome: a mensagem do fetch traz a URL, e a URL traz o token.
    return { ok: false, corpo: { error: { message: `falha de rede (${e instanceof Error ? e.name : 'erro'})` } } };
  }
}

/** Troca o token por um novo de 60 dias. GET é o documentado; o Meta já recusou GET no login, então tenta POST também. */
async function renovar(token: string): Promise<{ token: string; expiraEm: string | null } | { erro: string }> {
  const pedido = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
  let r = await pedir(undefined, `https://graph.instagram.com/refresh_access_token?${pedido}`);
  if (!r.ok || typeof r.corpo.access_token !== 'string') {
    r = await pedir(
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: pedido },
      'https://graph.instagram.com/refresh_access_token',
    );
  }
  if (!r.ok || typeof r.corpo.access_token !== 'string' || !r.corpo.access_token) return { erro: motivo(r.corpo) };
  const segundos = typeof r.corpo.expires_in === 'number' ? r.corpo.expires_in : null;
  return { token: r.corpo.access_token, expiraEm: segundos ? new Date(Date.now() + segundos * 1000).toISOString() : null };
}

/** Tira do last_error só a nota da renovação (as outras notas ficam). */
function semNotaDaRenovacao(texto: string | null): string | null {
  const resto = (texto ?? '').split(' | ').filter((p) => p && !p.startsWith(MARCA_DO_ERRO)).join(' | ');
  return resto || null;
}

/** Renova os tokens perto de vencer. Nunca lança: devolve quantos renovou. */
export async function renovarTokens(db: Db): Promise<{ renovados: number; falhas: number }> {
  const { data, error } = await db
    .from('instagram_connections')
    .select('id, ig_username, status, access_token, token_expires_at, token_refresh_tried_at, last_error')
    .eq('status', 'connected')
    .not('token_expires_at', 'is', null);
  if (error) {
    console.error('[instagram-token] leitura das conexões falhou', error.code);
    return { renovados: 0, falhas: 0 };
  }

  let renovados = 0;
  let falhas = 0;
  for (const conexao of (data ?? []) as ConexaoDoToken[]) {
    if (!precisaRenovar(conexao)) continue;
    const agora = new Date().toISOString();
    const r = await renovar(conexao.access_token);
    if ('erro' in r) {
      falhas++;
      console.error('[instagram-token] renovação recusada', conexao.ig_username ?? conexao.id, r.erro);
      const nota = `${MARCA_DO_ERRO} ${r.erro}; reconecte a conta antes de ${conexao.token_expires_at?.slice(0, 10)}`;
      await db
        .from('instagram_connections')
        .update({
          token_refresh_tried_at: agora,
          last_error: [semNotaDaRenovacao(conexao.last_error), nota].filter(Boolean).join(' | '),
          updated_at: agora,
        })
        .eq('id', conexao.id);
      continue;
    }
    const { error: gravaErro } = await db
      .from('instagram_connections')
      .update({
        access_token: r.token,
        token_expires_at: r.expiraEm,
        token_refresh_tried_at: agora,
        last_error: semNotaDaRenovacao(conexao.last_error),
        updated_at: agora,
      })
      .eq('id', conexao.id);
    if (gravaErro) {
      falhas++;
      console.error('[instagram-token] gravação do token renovado falhou', conexao.id, gravaErro.code);
      continue;
    }
    renovados++;
    console.log(JSON.stringify({ fn: 'instagram-token', renovou: conexao.ig_username ?? conexao.id, vence: r.expiraEm }));
  }
  return { renovados, falhas };
}
