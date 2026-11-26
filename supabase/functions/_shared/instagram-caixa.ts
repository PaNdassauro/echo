// Instagram Direct: o aviso do Meta vira conversa no Echo.
//
// Roda depois que o instagram-webhook grava o aviso cru. Quem decide se vira
// conversa é instagram_connections.inbox_mode:
//   'off'  nada (só o registro cru);
//   'on'   todo Direct, na linha da conexão.
//
// Não chama webhook da organização, automação nem resposta automática: o Direct
// não é telefone. O resultado de cada aviso fica em instagram_webhook_events.process_note.
import { IG_GRAPH } from './instagram.ts';
import { urlPublicaDoAnexo } from './url-publica.ts';

// deno-lint-ignore no-explicit-any
type Db = any;
type Obj = Record<string, unknown>;

export type EventoGravado = {
  id: number;
  ig_account_id: string | null;
  sender_id: string | null;
  recipient_id: string | null;
  event_type: string;
  mid: string | null;
  event_at: string | null;
  payload: Obj;
};

type Conexao = {
  id: string;
  organization_id: string;
  phone_number_id: string;
  ig_user_id: string;
  access_token: string;
  inbox_mode: 'off' | 'on';
};

export type ConversaDoDirect = {
  id: string;
  channel: string;
  instagram_account_id: string | null;
  instagram_user_id: string | null;
  contact_name: string | null;
};

export const COLUNAS_DA_CONVERSA = 'id, channel, instagram_account_id, instagram_user_id, contact_name';

type Conversa = ConversaDoDirect;

// Mídia acima disso fica só com o endereço do Meta (o download estouraria a
// função; o endereço do Meta vence em alguns dias).
const LIMITE_DA_MIDIA_BYTES = 25 * 1024 * 1024;

const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const texto = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** De quem é a conversa: no eco (mensagem nossa) é o destinatário; no resto, o remetente. */
export function pessoaDoEvento(ev: Pick<EventoGravado, 'event_type' | 'sender_id' | 'recipient_id'>): string | null {
  return ev.event_type === 'echo' ? ev.recipient_id : ev.sender_id;
}

/** Linha onde a conversa aparece, ou o motivo de não virar conversa. */
export function destinoDaConversa(
  conexao: Pick<Conexao, 'inbox_mode' | 'phone_number_id'>,
): { linha: string } | { nota: string } {
  return conexao.inbox_mode === 'on' ? { linha: conexao.phone_number_id } : { nota: 'caixa desligada' };
}

type Anexo = { tipo: string; url: string | null; titulo: string | null };

function anexosDa(mensagem: Obj): Anexo[] {
  const lista = Array.isArray(mensagem.attachments) ? mensagem.attachments : [];
  return lista.map((a) => {
    const o = obj(a) ?? {};
    const p = obj(o.payload) ?? {};
    return { tipo: texto(o.type) ?? 'desconhecido', url: texto(p.url), titulo: texto(p.title) };
  });
}

/** Tipo e texto da bolha para um anexo do Direct. */
export function bolhaDoAnexo(anexo: Anexo): { tipo: string; conteudo: string; baixar: boolean } {
  switch (anexo.tipo) {
    case 'image':
      return { tipo: 'image', conteudo: '[Imagem]', baixar: true };
    case 'animated_image':
      return { tipo: 'image', conteudo: '[GIF]', baixar: true };
    case 'video':
      return { tipo: 'video', conteudo: '[Vídeo]', baixar: true };
    case 'audio':
      return { tipo: 'audio', conteudo: '[Áudio]', baixar: true };
    case 'file':
      return { tipo: 'document', conteudo: anexo.titulo ?? '[Arquivo]', baixar: true };
    case 'like_heart':
      return { tipo: 'text', conteudo: '❤️', baixar: false };
    case 'story_mention':
      return { tipo: 'text', conteudo: `Mencionou a gente num story${anexo.url ? `: ${anexo.url}` : ''}`, baixar: false };
    case 'share':
    case 'ig_post':
    case 'ig_reel':
    case 'reel':
      return { tipo: 'text', conteudo: `Compartilhou um post${anexo.url ? `: ${anexo.url}` : ''}`, baixar: false };
    default:
      return {
        tipo: 'unsupported',
        conteudo: `[Direct: ${anexo.tipo}]${anexo.url ? ` ${anexo.url}` : ''}`,
        baixar: false,
      };
  }
}

async function baixarMidia(db: Db, url: string, tipo: string): Promise<
  { url: string; mime: string; nome: string; bytes: number } | null
> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const declarado = Number(res.headers.get('content-length') ?? '0');
    if (declarado > LIMITE_DA_MIDIA_BYTES) return null;
    const dados = new Uint8Array(await res.arrayBuffer());
    if (dados.length > LIMITE_DA_MIDIA_BYTES) return null;
    const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
    const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
    const nome = `instagram_${tipo}_${crypto.randomUUID()}.${ext}`;
    const caminho = `media/${nome}`;
    const { error } = await db.storage.from('attachments').upload(caminho, dados, { contentType: mime, upsert: false });
    if (error) {
      console.error('[instagram-caixa] upload da mídia falhou', error.message);
      return null;
    }
    return { url: urlPublicaDoAnexo(caminho), mime, nome, bytes: dados.length };
  } catch (e) {
    console.error('[instagram-caixa] download da mídia falhou', e instanceof Error ? e.name : 'erro');
    return null;
  }
}

async function perfilDaPessoa(conexao: Conexao, pessoa: string): Promise<
  { nome: string | null; usuario: string | null; foto: string | null }
> {
  try {
    const res = await fetch(`${IG_GRAPH}/${pessoa}?${new URLSearchParams({ fields: 'name,username,profile_pic' })}`, {
      headers: { Authorization: `Bearer ${conexao.access_token}` },
    });
    const corpo = (await res.json().catch(() => ({}))) as Obj;
    if (!res.ok) {
      console.warn('[instagram-caixa] perfil não lido', res.status, JSON.stringify(obj(corpo.error)?.code ?? null));
      return { nome: null, usuario: null, foto: null };
    }
    return { nome: texto(corpo.name), usuario: texto(corpo.username), foto: texto(corpo.profile_pic) };
  } catch {
    return { nome: null, usuario: null, foto: null };
  }
}

// A pessoa do Direct mora numa conversa só por linha: a do Direct (sem
// telefone) ou, depois de juntada, a do WhatsApp do contato.
async function acharConversa(db: Db, conexao: Conexao, linha: string, pessoa: string): Promise<Conversa | null> {
  const { data, error } = await db
    .from('conversations')
    .select(COLUNAS_DA_CONVERSA)
    .eq('phone_number_id', linha)
    .eq('instagram_account_id', conexao.ig_user_id)
    .eq('instagram_user_id', pessoa)
    .maybeSingle();
  if (error) throw new Error(`leitura da conversa: ${error.code}`);
  return data;
}

async function garantirConversa(db: Db, conexao: Conexao, linha: string, pessoa: string): Promise<Conversa> {
  const existente = await acharConversa(db, conexao, linha, pessoa);
  if (existente) return existente;

  const perfil = await perfilDaPessoa(conexao, pessoa);
  const agora = new Date().toISOString();
  // A foto do Meta vence em dias: guarda uma cópia.
  const foto = perfil.foto ? (await baixarMidia(db, perfil.foto, 'perfil'))?.url ?? perfil.foto : null;
  const { data, error } = await db
    .from('conversations')
    .insert({
      channel: 'instagram',
      instagram_account_id: conexao.ig_user_id,
      instagram_user_id: pessoa,
      instagram_username: perfil.usuario,
      contact_phone: `ig:${pessoa}`,
      contact_name: perfil.nome ?? (perfil.usuario ? `@${perfil.usuario}` : 'Instagram'),
      contact_avatar_url: foto,
      contact_avatar_updated_at: foto ? agora : null,
      whatsapp_id: `ig_${conexao.ig_user_id}`,
      phone_number_id: linha,
      is_group: false,
      status: 'active',
      source: 'organic',
    })
    .select(COLUNAS_DA_CONVERSA)
    .single();
  if (!error) return data;
  if (error.code === '23505') {
    // Dois avisos da mesma pessoa nova ao mesmo tempo: a outra requisição criou.
    const corrida = await acharConversa(db, conexao, linha, pessoa);
    if (corrida) return corrida;
  }
  throw new Error(`criação da conversa: ${error.code}`);
}

type MensagemGravada = {
  id: string;
  whatsapp_message_id: string | null;
  content: string | null;
  message_type: string | null;
  metadata: Obj | null;
  created_at: string;
};

async function gravarMensagem(
  db: Db,
  conexao: Conexao,
  conversa: Conversa,
  ev: EventoGravado,
): Promise<{ nota: string; linhas: MensagemGravada[] }> {
  const mensagem = obj(ev.payload.message) ?? {};
  const mid = texto(mensagem.mid) ?? ev.mid;
  if (!mid) return { nota: 'mensagem sem mid', linhas: [] };
  const deNos = ev.event_type === 'echo';
  const replyTo = obj(mensagem.reply_to);
  const story = obj(replyTo?.story);
  const botao = texto(obj(mensagem.quick_reply)?.payload);
  const metadataBase: Obj = {
    canal: 'instagram',
    ...(ev.event_at ? { sent_at: ev.event_at } : {}),
    ...(deNos ? { origem: 'instagram' } : {}),
    ...(story ? { instagram_story_resposta: texto(story.url) } : {}),
    ...(botao ? { instagram_quick_reply: botao } : {}),
  };

  let citada: string | null = null;
  const midCitado = texto(replyTo?.mid);
  if (midCitado) {
    const { data } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversa.id)
      .eq('whatsapp_message_id', midCitado)
      .maybeSingle();
    citada = data?.id ?? null;
  }

  const linhas: Obj[] = [];
  const corpoTexto = texto(mensagem.text);
  const anexos = anexosDa(mensagem);
  if (corpoTexto || anexos.length === 0) {
    linhas.push({
      whatsapp_message_id: mid,
      message_type: corpoTexto ? 'text' : 'unsupported',
      content: story
        ? `Respondeu ao seu story: ${corpoTexto ?? ''}`.trim()
        : corpoTexto ?? '[Mensagem do Direct sem texto]',
      metadata: metadataBase,
    });
  }
  for (const [i, anexo] of anexos.entries()) {
    const bolha = bolhaDoAnexo(anexo);
    const midDoAnexo = linhas.length === 0 && i === 0 ? mid : `${mid}#${i + 1}`;
    const linha: Obj = {
      whatsapp_message_id: midDoAnexo,
      message_type: bolha.tipo,
      content: bolha.conteudo,
      metadata: { ...metadataBase, instagram_anexo: anexo.tipo },
    };
    if (bolha.baixar && anexo.url) {
      const guardada = await baixarMidia(db, anexo.url, bolha.tipo);
      linha.media_url = guardada?.url ?? anexo.url;
      linha.media_mime_type = guardada?.mime ?? null;
      linha.media_filename = guardada?.nome ?? null;
      linha.media_size_bytes = guardada?.bytes ?? null;
    }
    linhas.push(linha);
  }

  const agora = new Date().toISOString();
  const { data: gravadas, error } = await db.from('messages').upsert(
    linhas.map((l, i) => ({
      conversation_id: conversa.id,
      direction: deNos ? 'outbound' : 'inbound',
      status: 'sent',
      quoted_message_id: i === 0 ? citada : null,
      created_at: agora,
      ...l,
    })),
    // Reentrega do Meta e o eco do que o próprio Echo mandou caem na mesma
    // chave: não duplicam.
    { onConflict: 'whatsapp_message_id,conversation_id', ignoreDuplicates: true },
  ).select('id, whatsapp_message_id, content, message_type, metadata, created_at');
  if (error) throw new Error(`gravação da mensagem: ${error.code}`);
  return { nota: deNos ? 'eco gravado' : 'mensagem gravada', linhas: (gravadas ?? []) as MensagemGravada[] };
}

/** Botão de abertura do Direct (ice breaker) ou botão de mensagem: vira bolha com o título. */
async function gravarPostback(db: Db, conversa: Conversa, ev: EventoGravado): Promise<{ nota: string; linhas: MensagemGravada[] }> {
  const postback = obj(ev.payload.postback) ?? {};
  const titulo = texto(postback.title) ?? '[Botão do Direct]';
  const carga = texto(postback.payload);
  const mid = texto(postback.mid) ?? `postback:${ev.id}`;
  const { data, error } = await db.from('messages').upsert(
    {
      conversation_id: conversa.id,
      direction: 'inbound',
      status: 'sent',
      whatsapp_message_id: mid,
      message_type: 'button_reply',
      content: titulo,
      created_at: new Date().toISOString(),
      metadata: {
        canal: 'instagram',
        ...(ev.event_at ? { sent_at: ev.event_at } : {}),
        ...(carga ? { instagram_postback: carga } : {}),
      },
    },
    { onConflict: 'whatsapp_message_id,conversation_id', ignoreDuplicates: true },
  ).select('id, whatsapp_message_id, content, message_type, metadata, created_at');
  if (error) throw new Error(`gravação do botão: ${error.code}`);
  return { nota: 'botão gravado', linhas: (data ?? []) as MensagemGravada[] };
}

async function aplicarLeitura(db: Db, conversa: Conversa, ev: EventoGravado): Promise<string> {
  const lida = obj(ev.payload.read);
  const midLido = texto(lida?.mid);
  let ate = new Date().toISOString();
  if (midLido) {
    const { data } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversa.id)
      .eq('whatsapp_message_id', midLido)
      .maybeSingle();
    if (data?.created_at) ate = data.created_at;
  }
  const { error } = await db
    .from('messages')
    .update({ status: 'read' })
    .eq('conversation_id', conversa.id)
    .eq('direction', 'outbound')
    // Card juntado: a leitura do Instagram só vale para o que saiu pelo Direct.
    .eq('metadata->>canal', 'instagram')
    .in('status', ['sent', 'delivered'])
    .lte('created_at', ate);
  if (error) throw new Error(`leitura: ${error.code}`);
  return 'lida aplicada';
}

/**
 * Reação do Direct: escalar `messages.reaction` (fallback) + linha em `message_reactions` (reactor_jid `ig:<IGSID>`,
 * is_from_me=false), como o ramo da Cloud API. O front só notifica reação pelo INSERT em message_reactions: sem a linha,
 * a reação do Direct não toca som nem toast. Falha no fan-out não derruba o escalar (que já foi gravado).
 */
export async function aplicarReacao(db: Db, conversa: Conversa, ev: EventoGravado): Promise<string> {
  const reacao = obj(ev.payload.reaction);
  const alvo = texto(reacao?.mid);
  if (!alvo) return 'reação sem alvo';
  const valor = reacao?.action === 'unreact' ? null : texto(reacao?.emoji) ?? texto(reacao?.reaction);
  const { data, error } = await db
    .from('messages')
    .update({ reaction: valor })
    .eq('conversation_id', conversa.id)
    .eq('metadata->>canal', 'instagram')
    .eq('whatsapp_message_id', alvo)
    .select('id');
  if (error) throw new Error(`reação: ${error.code}`);
  const pessoa = pessoaDoEvento(ev);
  if (pessoa) {
    const reactorJid = `ig:${pessoa}`;
    for (const { id } of (data ?? []) as Array<{ id: string }>) {
      try {
        const { error: delError } = await db
          .from('message_reactions')
          .delete()
          .eq('message_id', id)
          .eq('is_from_me', false)
          .eq('reactor_jid', reactorJid);
        if (delError) {
          console.error('[instagram] reação: remover linha anterior falhou:', delError.code);
          continue;
        }
        if (valor) {
          const { error: insError } = await db
            .from('message_reactions')
            .insert({ message_id: id, reactor_jid: reactorJid, reactor_name: null, is_from_me: false, emoji: valor });
          if (insError) console.error('[instagram] reação: inserir linha falhou:', insError.code);
        }
      } catch (e) {
        console.error('[instagram] reação: fan-out falhou:', e instanceof Error ? e.name : 'erro');
      }
    }
  }
  return 'reação aplicada';
}

async function aplicarEdicao(db: Db, conversa: Conversa, ev: EventoGravado): Promise<string> {
  const edicao = obj(ev.payload.message_edit);
  const alvo = texto(edicao?.mid);
  const novo = texto(edicao?.text);
  if (!alvo || !novo) return 'edição sem texto';
  const { error } = await db
    .from('messages')
    .update({ content: novo, is_edited: true, edited_at: new Date().toISOString() })
    .eq('conversation_id', conversa.id)
    .eq('metadata->>canal', 'instagram')
    .eq('whatsapp_message_id', alvo);
  if (error) throw new Error(`edição: ${error.code}`);
  return 'edição aplicada';
}

async function aplicarApagada(db: Db, conversa: Conversa, ev: EventoGravado): Promise<string> {
  if (!ev.mid) return 'apagada sem mid';
  const { error } = await db
    .from('messages')
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq('conversation_id', conversa.id)
    .eq('metadata->>canal', 'instagram')
    .like('whatsapp_message_id', `${ev.mid}%`);
  if (error) throw new Error(`apagada: ${error.code}`);
  return 'apagada aplicada';
}

function avisarEquipe(conversa: Conversa, previa: string): void {
  const url = Deno.env.get('SUPABASE_URL');
  const chave = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !chave) return;
  // Mesmo aviso do WhatsApp (whatsapp-webhook): vai para quem cuida da conversa.
  fetch(`${url}/functions/v1/send-web-push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: conversa.id,
      title: `Direct de ${conversa.contact_name || 'Instagram'}`,
      body: previa.substring(0, 120) || '📎 Mídia',
    }),
  }).catch((e) => console.error('[instagram-caixa] aviso à equipe falhou', e instanceof Error ? e.name : 'erro'));
}

async function processarUm(db: Db, conexao: Conexao, ev: EventoGravado): Promise<string> {
  const pessoa = pessoaDoEvento(ev);
  if (!pessoa || pessoa === conexao.ig_user_id) return 'sem pessoa';
  const destino = destinoDaConversa(conexao);
  if ('nota' in destino) return destino.nota;

  if (ev.event_type === 'message' || ev.event_type === 'echo' || ev.event_type === 'postback') {
    const conversa = await garantirConversa(db, conexao, destino.linha, pessoa);
    const { nota, linhas } = ev.event_type === 'postback'
      ? await gravarPostback(db, conversa, ev)
      : await gravarMensagem(db, conexao, conversa, ev);
    if (ev.event_type === 'echo' || !linhas.length) return nota;
    const mensagem = obj(ev.payload.message) ?? {};
    avisarEquipe(conversa, texto(mensagem.text) ?? linhas[0].content ?? '');
    return nota;
  }
  const conversa = await acharConversa(db, conexao, destino.linha, pessoa);
  if (!conversa) return 'sem conversa';
  switch (ev.event_type) {
    case 'read':
      return await aplicarLeitura(db, conversa, ev);
    case 'reaction':
      return await aplicarReacao(db, conversa, ev);
    case 'edit':
      return await aplicarEdicao(db, conversa, ev);
    case 'deleted':
      return await aplicarApagada(db, conversa, ev);
    default:
      return `sem tratamento: ${ev.event_type}`;
  }
}

/** Leva os avisos recém-gravados para a caixa do Echo. Nunca lança: o aviso cru já está salvo. */
export async function levarParaACaixa(db: Db, eventos: EventoGravado[]): Promise<void> {
  const conexoes = new Map<string, Conexao | null>();
  for (const ev of eventos) {
    let nota: string;
    try {
      const conta = ev.ig_account_id;
      if (!conta) {
        nota = 'sem conta';
      } else {
        if (!conexoes.has(conta)) {
          const { data, error } = await db
            .from('instagram_connections')
            .select('id, organization_id, phone_number_id, ig_user_id, access_token, inbox_mode')
            .eq('ig_user_id', conta)
            .eq('status', 'connected')
            .maybeSingle();
          if (error) throw new Error(`conexão: ${error.code}`);
          conexoes.set(conta, data);
        }
        const conexao = conexoes.get(conta);
        nota = conexao ? await processarUm(db, conexao, ev) : 'conta sem conexão';
      }
    } catch (e) {
      nota = `erro: ${e instanceof Error ? e.message : 'desconhecido'}`.slice(0, 200);
      console.error('[instagram-caixa]', ev.id, nota);
    }
    await db
      .from('instagram_webhook_events')
      .update({ processed_at: new Date().toISOString(), process_note: nota })
      .eq('id', ev.id);
  }
}
