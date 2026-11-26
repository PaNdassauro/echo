// Recebe os avisos do Meta para o Instagram Direct da conta ligada ao Echo.
//
// Fase 1: cada evento assinado vira uma linha em
// instagram_webhook_events, como veio.
// Fase 2: depois de gravado, o evento vai para a caixa do Echo
// (_shared/instagram-caixa.ts), conforme instagram_connections.inbox_mode.
// Não chama webhook da organização, automação nem resposta automática.
//
// GET  = aperto de mão do Meta (hub.verify_token = INSTAGRAM_VERIFY_TOKEN).
// POST = aviso assinado (X-Hub-Signature-256 com INSTAGRAM_APP_SECRET).
//        Assinatura que não confere → 401 e, no máximo 60 vezes por hora, uma
//        impressão (sha256, tamanho, cabeçalho presente) para um segredo
//        trocado aparecer. O corpo de quem não é o Meta nunca é guardado.
//
// verify_jwt = false (o Meta não manda JWT): ver supabase/config.toml.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { abrirAvisos, assinaturaConfere, segredosDoApp, sha256Hex } from '../_shared/instagram.ts';
import { type EventoGravado, levarParaACaixa } from '../_shared/instagram-caixa.ts';

// Um aviso do Meta traz no máximo 1000 atualizações; texto de Direct é curto.
const LIMITE_DO_CORPO_BYTES = 512 * 1024;
// Impressões de aviso sem assinatura válida guardadas por hora, no máximo.
const TETO_SEM_ASSINATURA_POR_HORA = 60;

const enc = new TextEncoder();

function resposta(texto: string, status = 200): Response {
  return new Response(texto, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const esperado = Deno.env.get('INSTAGRAM_VERIFY_TOKEN') ?? '';
    const modo = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const desafio = url.searchParams.get('hub.challenge');
    if (modo === 'subscribe' && esperado && token === esperado && desafio) {
      return resposta(desafio);
    }
    return resposta('forbidden', 403);
  }

  if (req.method !== 'POST') return resposta('method not allowed', 405);

  const declarado = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declarado) && declarado > LIMITE_DO_CORPO_BYTES) return resposta('payload too large', 413);
  const corpoCru = await req.text();
  const bytes = enc.encode(corpoCru).length;
  if (bytes > LIMITE_DO_CORPO_BYTES) return resposta('payload too large', 413);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const cabecalho = req.headers.get('x-hub-signature-256');
  const assinaturaValida = await assinaturaConfere(corpoCru, cabecalho, segredosDoApp());

  if (!assinaturaValida) {
    if (Deno.env.get('INSTAGRAM_WEBHOOK_REGISTRAR_INVALIDOS') !== 'false') {
      const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count } = await db
        .from('instagram_webhook_events')
        .select('id', { count: 'exact', head: true })
        .eq('signature_valid', false)
        .gte('received_at', umaHoraAtras);
      if ((count ?? 0) < TETO_SEM_ASSINATURA_POR_HORA) {
        const impressao = await sha256Hex(corpoCru);
        await db.from('instagram_webhook_events').upsert(
          {
            signature_valid: false,
            event_type: 'unsigned',
            event_hash: `sem-assinatura:${impressao}`,
            payload: { sha256: impressao, bytes, tem_cabecalho: Boolean(cabecalho) },
          },
          { onConflict: 'event_hash', ignoreDuplicates: true },
        );
      }
    }
    console.warn(JSON.stringify({ fn: 'instagram-webhook', assinatura_valida: false, bytes, tem_cabecalho: Boolean(cabecalho) }));
    return resposta('invalid signature', 401);
  }

  let corpo: unknown;
  try {
    // \u0000 derruba o jsonb do lote inteiro; o Meta não manda, mas o texto do
    // cliente pode trazer.
    corpo = JSON.parse(corpoCru.replace(/\\u0000/g, ''));
  } catch {
    return resposta('bad request', 400);
  }

  const objeto = (corpo as { object?: unknown })?.object;
  const linhas = (await abrirAvisos(corpo)).map((a) => ({
    signature_valid: true,
    object: typeof objeto === 'string' ? objeto : null,
    ig_account_id: a.igAccountId,
    sender_id: a.senderId,
    recipient_id: a.recipientId,
    event_type: a.tipo,
    event_hash: a.hash,
    mid: a.mid,
    event_at: a.eventAt,
    payload: a.payload,
  }));

  // Reentrega do Meta repete a impressão do evento: ignora a repetição (e só
  // o que entrou agora volta para ir à caixa).
  const { data: novos, error } = await db
    .from('instagram_webhook_events')
    .upsert(linhas, { onConflict: 'event_hash', ignoreDuplicates: true })
    .select('id, ig_account_id, sender_id, recipient_id, event_type, mid, event_at, payload');

  // Resumo no log, nunca o texto do cliente.
  console.log(JSON.stringify({
    fn: 'instagram-webhook',
    eventos: linhas.length,
    tipos: linhas.map((l) => l.event_type),
    gravou: !error,
  }));

  if (error) {
    console.error('[instagram-webhook] falha ao gravar', error.code, error.message);
    // 500 faz o Meta reentregar (até 36 horas).
    return resposta('retry', 500);
  }
  // A caixa roda depois da resposta: download de mídia e leitura do perfil não
  // podem segurar o 200 que o Meta espera. O aviso cru já está salvo: o que
  // falhar fica com process_note 'erro: …' (ou processed_at nulo, se o
  // processo cair no meio) em instagram_webhook_events. Antes do modo 'on',
  // uma rotina precisa reprocessar esses avisos.
  const caixa = levarParaACaixa(db, (novos ?? []) as EventoGravado[]);
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(caixa);
  else await caixa;
  return resposta('EVENT_RECEIVED');
});
