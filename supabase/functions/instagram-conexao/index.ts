// Início da conexão do Instagram pela tela (Configurações > Números > Instagram).
//
// Só admin da organização (ou super admin). Confere a linha QR/API com que a
// linha Instagram vai dividir a caixa, assina o "state" (organização + linha,
// vale 30 min, marca app = volta para o Echo) e devolve o link do login do
// Instagram. Quem conecta de fato é instagram-oauth, na volta do Instagram.
//
// Ligar/desligar, trocar de linha, renomear e desconectar são RPCs do banco
// (instagram_configurar_conexao / instagram_desconectar): não precisam do Meta.
//
// verify_jwt = true (padrão): o gateway confere o token; aqui se lê quem é.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { z } from 'https://esm.sh/zod@3.23.8';
import { requireUser } from '../_shared/authz.ts';
import { assinarEstado, linhaPodeHospedar, linkDeAutorizacao, SEGREDO_MINIMO } from '../_shared/instagram.ts';
import { basePublica } from '../_shared/url-publica.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PedidoSchema = z.object({
  acao: z.literal('iniciar'),
  linha: z.string().uuid(),
});

const VALIDADE_DO_LINK_SEG = 30 * 60;

function responder(status: number, corpo: Record<string, unknown>): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return responder(405, { error: 'method not allowed' });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  let userId: string;
  try {
    userId = await requireUser(db, req);
  } catch {
    return responder(401, { error: 'Entre de novo no Echo.' });
  }

  const pedido = PedidoSchema.safeParse(await req.json().catch(() => null));
  if (!pedido.success) return responder(400, { error: 'Pedido inválido.' });

  const appId = Deno.env.get('INSTAGRAM_APP_ID') ?? '';
  const segredo = Deno.env.get('INSTAGRAM_OAUTH_STATE_SECRET') ?? '';
  const redirectUri = Deno.env.get('INSTAGRAM_OAUTH_REDIRECT_URI')
    ?? `${basePublica()}/functions/v1/instagram-oauth`;
  if (!appId || segredo.length < SEGREDO_MINIMO) {
    console.error('[instagram-conexao] INSTAGRAM_APP_ID ou INSTAGRAM_OAUTH_STATE_SECRET ausente/curto');
    return responder(503, { error: 'A conexão do Instagram ainda não está configurada no servidor.' });
  }

  const { data: linha, error: linhaErro } = await db
    .from('phone_numbers')
    .select('id, organization_id, connection_type')
    .eq('id', pedido.data.linha)
    .maybeSingle();
  if (linhaErro) {
    console.error('[instagram-conexao] leitura da linha falhou', linhaErro.code);
    return responder(500, { error: 'Não deu para ler a linha. Tente de novo.' });
  }
  if (!linha?.organization_id) return responder(404, { error: 'Linha não encontrada.' });
  if (!linhaPodeHospedar(linha.connection_type)) {
    return responder(400, { error: 'Essa linha não pode receber o Direct.' });
  }

  const [{ data: perfil }, { data: membro }] = await Promise.all([
    db.from('profiles').select('is_super_admin').eq('id', userId).maybeSingle(),
    db
      .from('organization_members')
      .select('role')
      .eq('organization_id', linha.organization_id)
      .eq('user_id', userId)
      .maybeSingle(),
  ]);
  if (!perfil?.is_super_admin && membro?.role !== 'admin') {
    return responder(403, { error: 'Só administradores conectam o Instagram.' });
  }

  // Linha que já tem conta serve só para reconectar a mesma conta: o
  // instagram-oauth recusa outra conta por cima ('linha-ocupada').
  const state = await assinarEstado(
    {
      org: linha.organization_id,
      linha: linha.id,
      exp: Math.floor(Date.now() / 1000) + VALIDADE_DO_LINK_SEG,
      n: crypto.randomUUID(),
      app: true,
    },
    segredo,
  );

  console.log(JSON.stringify({ fn: 'instagram-conexao', acao: 'iniciar', linha: linha.id, por: userId }));
  return responder(200, { url: linkDeAutorizacao(appId, redirectUri, state) });
});
