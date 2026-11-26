// Refaz os avisos do Instagram que não viraram conversa e renova o token longo
// perto de vencer.
//
// O instagram-webhook responde 200 ao Meta antes de levar o aviso à caixa; se
// a caixa falhar ('erro: …') ou o processo cair no meio (processed_at nulo), o
// Meta não reentrega. O cron instagram-reprocessar-avisos (a cada 5 min, só
// quando há o que refazer) chama esta função com a chave de serviço do Vault.
// Cada aviso tenta no máximo 5 vezes.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { type EventoGravado, levarParaACaixa } from '../_shared/instagram-caixa.ts';
import { renovarTokens } from '../_shared/instagram-token.ts';

const LOTE = 50;
const MAX_TENTATIVAS = 5;

/**
 * verify_jwt = true (padrão): o gateway já conferiu a assinatura do token.
 * Aqui só se exige que ele seja o de serviço (o do Vault, que o cron usa),
 * não o de uma pessoa logada.
 */
function ehChaveDeServico(req: Request): boolean {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  const corpo = token.split('.')[1];
  if (!corpo) return false;
  try {
    const dados = JSON.parse(atob(corpo.replace(/-/g, '+').replace(/_/g, '/')));
    return dados?.role === 'service_role';
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!ehChaveDeServico(req)) return new Response('unauthorized', { status: 401 });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const doisMinutos = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('instagram_webhook_events')
    .select('id, ig_account_id, sender_id, recipient_id, event_type, mid, event_at, payload, tentativas')
    .eq('signature_valid', true)
    .lt('tentativas', MAX_TENTATIVAS)
    .or(`and(processed_at.is.null,received_at.lt.${doisMinutos}),process_note.like.erro:*`)
    .order('received_at', { ascending: true })
    .limit(LOTE);
  if (error) {
    console.error('[instagram-reprocessar] leitura falhou', error.code);
    return new Response('retry', { status: 500 });
  }

  const eventos = (data ?? []) as (EventoGravado & { tentativas: number })[];
  for (const ev of eventos) {
    await db.from('instagram_webhook_events').update({ tentativas: ev.tentativas + 1 }).eq('id', ev.id);
  }
  await levarParaACaixa(db, eventos);
  // Token longo perto de vencer (60 dias): renova antes que a linha Instagram pare.
  const tokens = await renovarTokens(db);

  console.log(JSON.stringify({ fn: 'instagram-reprocessar', refeitos: eventos.length, tokens }));
  return new Response(JSON.stringify({ refeitos: eventos.length, tokens }), { headers: { 'Content-Type': 'application/json' } });
});
