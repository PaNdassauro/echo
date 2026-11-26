// Carga da janela de uma conversa para prompts de IA e IO de produção da leitura de mídia.
//
// Todo ponto (`created_at`, `reacted_at`) que chega do banco passa por `isoUs`:
// o PostgREST devolve microssegundos e `new Date()` os perderia.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { z } from 'https://esm.sh/zod@3.23.8';
import type { MsgCtx, Ponto, ReacaoCtx } from './conversa-contexto.ts';
import { isoUs } from './iso-us.ts';
import { parsearLeitura, type LeituraIO } from './leitura-midia.ts';
import { mesclarMetadata, reservarLeitura } from './metadata-merge.ts';
import { baseInterna, basePublica, caminhoDoAnexoNosso } from './url-publica.ts';

export interface CarregarOpcoes {
  conversationId: string;
  cursor: Ponto; // OBRIGATÓRIO: só entram como novas as mensagens depois dele; { at: '1970-…', id: null } = todas
  ate: Ponto; // teto: (created_at, id) da mensagem mais recente que entra na janela
  reacaoDesde: string; // isoUs: só reações depois deste instante
  reacaoAte: string; // isoUs: só reações até este instante
  anteriores?: number; // 20 (contexto antes do cursor)
  limiteNovas?: number; // 200
}
export interface Janela {
  mensagens: MsgCtx[];
  citadas: MsgCtx[];
  reacoes: ReacaoCtx[];
  novasTruncadas: boolean;
}

export const COLUNAS_MSG =
  'id, conversation_id, created_at, direction, message_type, content, status, reaction, sender_name, sender_phone, sent_by, is_deleted, is_edited, quoted_message_id, media_url, media_filename, media_mime_type, media_size_bytes, metadata';

const COLUNAS_REACAO = 'id, message_id, emoji, is_from_me, reactor_name, reacted_at, messages!inner(conversation_id)';
const LOTE_IN = 150; // URL acima de ~30 KB dá 400
const LIMITE_REACOES = 300;

// ---- Linhas do banco (jsonb e colunas externas: validadas) ----

const MsgRowSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  created_at: z.string(),
  direction: z.enum(['inbound', 'outbound']),
  message_type: z.string().nullable(),
  content: z.string().nullable(),
  status: z.string().nullable(),
  reaction: z.string().nullable(),
  sender_name: z.string().nullable(),
  sender_phone: z.string().nullable(),
  sent_by: z.string().nullable(),
  is_deleted: z.boolean().nullable(),
  is_edited: z.boolean().nullable(),
  quoted_message_id: z.string().nullable(),
  media_url: z.string().nullable(),
  media_filename: z.string().nullable(),
  media_mime_type: z.string().nullable(),
  media_size_bytes: z.number().nullable(),
  metadata: z.record(z.unknown()).nullable(),
});

const ReacaoRowSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  emoji: z.string(),
  is_from_me: z.boolean().nullable(),
  reactor_name: z.string().nullable(),
  reacted_at: z.string(),
});

function paraMsgCtx(linhas: unknown[]): MsgCtx[] {
  const saida: MsgCtx[] = [];
  for (const bruta of linhas) {
    const r = MsgRowSchema.safeParse(bruta);
    if (!r.success) {
      console.error('[conversa-contexto-db] linha de messages inválida, ignorada:', r.error.issues[0]?.path.join('.'));
      continue;
    }
    saida.push({ ...r.data, created_at: isoUs(r.data.created_at), is_deleted: r.data.is_deleted ?? false, is_edited: r.data.is_edited ?? false });
  }
  return saida;
}

function paraReacaoCtx(linhas: unknown[]): ReacaoCtx[] {
  const saida: ReacaoCtx[] = [];
  for (const bruta of linhas) {
    const r = ReacaoRowSchema.safeParse(bruta);
    if (!r.success) {
      console.error('[conversa-contexto-db] linha de message_reactions inválida, ignorada:', r.error.issues[0]?.path.join('.'));
      continue;
    }
    saida.push({
      id: r.data.id,
      message_id: r.data.message_id,
      emoji: r.data.emoji,
      is_from_me: r.data.is_from_me ?? false,
      reactor_name: r.data.reactor_name,
      reacted_at: isoUs(r.data.reacted_at),
    });
  }
  return saida;
}

// ---- Filtros por par (created_at, id) ----
// Os pontos vêm do banco (isoUs) e o id é uuid: nunca de entrada do usuário.

/** Condições (lista de um `or`) para (created_at, id) > p. Com id nulo, só created_at > p.at. */
function condDepois(p: Ponto): string {
  if (p.id === null) return `created_at.gt.${p.at}`;
  return `created_at.gt.${p.at},and(created_at.eq.${p.at},id.gt.${p.id})`;
}
/** Condições (lista de um `or`) para (created_at, id) <= p. Com id nulo, created_at <= p.at. */
function condAteInclusive(p: Ponto): string {
  if (p.id === null) return `created_at.lte.${p.at}`;
  return `created_at.lt.${p.at},and(created_at.eq.${p.at},id.lte.${p.id})`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function exigirPonto(p: Ponto, nome: string): Ponto {
  const at = isoUs(p.at);
  if (p.id !== null && !UUID.test(p.id)) throw new Error(`carregarJanela: ${nome}.id inválido`);
  return { at, id: p.id };
}

export async function carregarJanela(db: SupabaseClient, o: CarregarOpcoes): Promise<Janela> {
  if (!UUID.test(o.conversationId)) throw new Error('carregarJanela: conversationId inválido');
  const cursor = exigirPonto(o.cursor, 'cursor');
  const ate = exigirPonto(o.ate, 'ate');
  const reacaoDesde = isoUs(o.reacaoDesde);
  const reacaoAte = isoUs(o.reacaoAte);
  const nAnteriores = o.anteriores ?? 20;
  const limiteNovas = o.limiteNovas ?? 200;

  // novas: (created_at,id) > cursor E <= ate, mais recentes primeiro (+1 para saber se truncou)
  const novasP = db
    .from('messages')
    .select(COLUNAS_MSG)
    .eq('conversation_id', o.conversationId)
    // Dois `.or()` seguidos viram dois parâmetros `or=`, que o PostgREST combina com AND.
    .or(condDepois(cursor))
    .or(condAteInclusive(ate))
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limiteNovas + 1);

  const anterioresP = nAnteriores > 0
    ? db
      .from('messages')
      .select(COLUNAS_MSG)
      .eq('conversation_id', o.conversationId)
      .or(condAteInclusive(cursor))
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(nAnteriores)
    : Promise.resolve({ data: [] as unknown[], error: null });

  const reacoesP = db
    .from('message_reactions')
    .select(COLUNAS_REACAO)
    .eq('messages.conversation_id', o.conversationId)
    .gt('reacted_at', reacaoDesde)
    .lte('reacted_at', reacaoAte)
    .order('reacted_at', { ascending: true })
    .limit(LIMITE_REACOES);

  const [novasR, anterioresR, reacoesR] = await Promise.all([novasP, anterioresP, reacoesP]);
  if (novasR.error) throw new Error(`carregarJanela(novas): ${novasR.error.message}`);
  if (anterioresR.error) throw new Error(`carregarJanela(anteriores): ${anterioresR.error.message}`);
  if (reacoesR.error) throw new Error(`carregarJanela(reacoes): ${reacoesR.error.message}`);

  const novasBrutas = (novasR.data ?? []) as unknown[];
  const novasTruncadas = novasBrutas.length > limiteNovas;
  // vieram em ordem decrescente: as mais antigas (o excedente) ficam de fora
  const novas = paraMsgCtx(novasBrutas.slice(0, limiteNovas)).reverse();
  const anteriores = paraMsgCtx((anterioresR.data ?? []) as unknown[]).reverse();
  const reacoes = paraReacaoCtx((reacoesR.data ?? []) as unknown[]);

  const mensagens = [...anteriores, ...novas];
  const naJanela = new Set(mensagens.map((m) => m.id));
  const faltam = new Set<string>();
  for (const m of mensagens) if (m.quoted_message_id && !naJanela.has(m.quoted_message_id)) faltam.add(m.quoted_message_id);
  for (const r of reacoes) if (!naJanela.has(r.message_id)) faltam.add(r.message_id);

  const citadas: MsgCtx[] = [];
  const ids = [...faltam].filter((id) => UUID.test(id));
  for (let i = 0; i < ids.length; i += LOTE_IN) {
    const lote = ids.slice(i, i + LOTE_IN);
    const { data, error } = await db
      .from('messages')
      .select(COLUNAS_MSG)
      .eq('conversation_id', o.conversationId)
      .in('id', lote);
    if (error) throw new Error(`carregarJanela(citadas): ${error.message}`);
    citadas.push(...paraMsgCtx((data ?? []) as unknown[]));
  }

  return { mensagens, citadas, reacoes, novasTruncadas };
}

// ---- IO de produção da leitura ----

/** Reserva = reservarLeitura; baixar = storage 'attachments' (service role); gravar = mesclarMetadata. */
export function ioDeProducao(db: SupabaseClient): LeituraIO {
  return {
    async reservar(messageId) {
      const bruto = await reservarLeitura(db, messageId);
      if (bruto === null) return null;
      const l = parsearLeitura(bruto);
      if (!l) console.error('[conversa-contexto-db] reserva devolveu leitura inválida, não lê');
      return l;
    },

    async baixar(m) {
      if (!m.media_url) throw new Error('sem media_url');
      const caminho = caminhoDoAnexoNosso(m.media_url);
      if (caminho) {
        const { data, error } = await db.storage.from('attachments').download(caminho);
        if (error || !data) throw new Error('download do storage falhou');
        return new Uint8Array(await data.arrayBuffer());
      }
      // Sem caminho no bucket: só o host do próprio projeto (base pública ou interna), sem seguir redirecionamento.
      // A pública vira a interna: no Docker o servidor não alcança o endereço que o navegador usa.
      let alvo: URL;
      try {
        alvo = new URL(m.media_url);
      } catch {
        throw new Error('media_url inválida');
      }
      let interna: URL;
      let publica: URL;
      try {
        interna = new URL(baseInterna());
        publica = new URL(basePublica());
      } catch {
        throw new Error('host da mídia não permitido'); // sem configuração de URL não há "host do projeto"
      }
      if (alvo.origin === publica.origin) {
        alvo.protocol = interna.protocol;
        alvo.host = interna.host;
      } else if (alvo.host !== interna.host) {
        throw new Error('host da mídia não permitido');
      }
      const res = await fetch(alvo, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },

    async gravar(messageId, leitura) {
      await mesclarMetadata(db, messageId, { leitura });
    },
  };
}
