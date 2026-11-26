// Repete os avisos ao webhook da organização que não tiveram ok. O cron aviso-de-mensagem-repetir
// (a cada minuto, só quando há aviso vencido) chama esta função com a chave de serviço do Vault. Cada aviso tenta até
// 10 vezes depois da 1ª entrega; na 6ª tentativa e na última, webhook_dead em qr_message_log alerta a equipe. Regra
// em _shared/aviso-unico.ts.
//
// verify_jwt = true: o gateway confere o JWT (a chave do Vault é JWT legado, diferente da SUPABASE_SERVICE_ROLE_KEY
// injetada aqui), e aqui só passa o papel service_role.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { isInternalCaller } from '../_shared/authz.ts';
import { repetirAvisos } from '../_shared/aviso-unico.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const auth = isInternalCaller(req, { jwtVerifiedByGateway: true });
  if (!auth.ok) {
    console.warn('[aviso-repetir] chamada recusada:', auth.reason);
    return new Response('unauthorized', { status: 401 });
  }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  try {
    const placar = await repetirAvisos(db);
    console.log(JSON.stringify({ fn: 'aviso-repetir', ...placar }));
    return new Response(JSON.stringify(placar), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[aviso-repetir]', error);
    return new Response('retry', { status: 500 });
  }
});
