// Serializador de uma conversa de WhatsApp para texto de prompt de IA (copiloto).
//
// Módulo PURO: importa só `mascara.ts` e `iso-us.ts`. Todo texto que vem da
// conversa (conteúdo, nomes, legendas, transcrições, enquetes, contatos) entra
// no prompt como string JSON numa linha só, via `citar`: nenhuma fala consegue
// começar uma linha nova, forjar um prefixo `[#n …]` ou um título de bloco.
//
// `descreverMensagem` devolve o texto CRU da descrição (já mascarado, sem
// aspas); quem põe entre aspas é o `serializarConversa`, com `citar`.
import { mascarar } from './mascara.ts';
import { compararIso, isoUs } from './iso-us.ts';

export interface MsgCtx {
  id: string;
  conversation_id: string;
  created_at: string; /* isoUs */
  direction: 'inbound' | 'outbound';
  message_type: string | null;
  content: string | null;
  status: string | null;
  reaction: string | null;
  sender_name: string | null;
  sender_phone: string | null;
  sent_by: string | null;
  is_deleted: boolean;
  is_edited: boolean;
  quoted_message_id: string | null;
  media_url: string | null;
  media_filename: string | null;
  media_mime_type: string | null;
  media_size_bytes: number | null;
  metadata: Record<string, unknown> | null;
}
export interface ReacaoCtx {
  id: string;
  message_id: string;
  emoji: string;
  is_from_me: boolean;
  reactor_name: string | null;
  reacted_at: string; /* isoUs */
}
export interface Ponto {
  at: string; /* isoUs */
  id: string | null;
} // (created_at, id): ordem total sem empate
export interface ContextoEntrada {
  conversa: { id: string; contact_name: string; is_group: boolean };
  mensagens: MsgCtx[]; // ordem crescente: contexto anterior + novas
  citadas: MsgCtx[]; // citadas e alvos de reação fora da janela (para o trecho)
  reacoes: ReacaoCtx[]; // reações novas
  cursor: Ponto | null; // (created_at,id) > cursor = NOVA; null = todas novas
  agora: Date; // para marcar "há N dias" e a idade das linhas
  tetoChars?: number; // default 15000 (só o bloco CONVERSA)
}
export interface LinhaCtx {
  ref: string; // '#1', '#2'… em ordem cronológica, contando mensagens e reações
  tipo: 'mensagem' | 'reacao';
  message_id: string; // a mensagem (ou o alvo da reação)
  reaction_id: string | null;
  at: string; // isoUs
  /** Quem falou, do ponto de vista da equipe */
  direction: 'inbound' | 'outbound';
  quem: string; // 'cliente' | 'atendente' | 'equipe' | nome do participante (grupo, já escapado)
  nova: boolean;
  message_type: string | null;
  texto: string; // o texto da linha (sem o prefixo), já escapado (entre aspas)
  classe: string | null; // leitura.classe
  lacuna: boolean;
}
export interface ContextoSerializado {
  texto: string; // o bloco CONVERSA
  linhas: LinhaCtx[];
  refs: Record<string, LinhaCtx>; // '#12' → linha
  novas: number;
  lacunas: number;
  truncado: boolean;
  chars: number;
}

export const TETO_CHARS_PADRAO = 15000;
const LINHA_MAX = 3000; // teto de uma linha (a descrição inteira, antes de escapar)
const LEITURA_MAX_IMAGEM = 1200;
const LEITURA_MAX_ENCURTADA = 600;
const LEITURA_MAX_FALA = 6000;

// ---- Escape ----

// U+2028, U+2029 e U+0085 quebram linha em alguns leitores; escapados explicitamente.
const SEPARADORES_DE_LINHA = new RegExp('[' + String.fromCharCode(0x2028, 0x2029, 0x85) + ']', 'g');

/** Escapa um trecho variável: JSON.stringify (aspas, \n → \\n) e troca '[#' por '[ #'.
 *  Todo texto vindo da conversa passa por aqui. */
export function citar(s: string, max: number): string {
  const base = typeof s === 'string' ? s : String(s ?? '');
  const cortado = base.length > max ? `${base.slice(0, Math.max(0, max - 1))}…` : base;
  return JSON.stringify(cortado)
    .replace(SEPARADORES_DE_LINHA, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replaceAll('[#', '[ #');
}

/** Corta um pedaço cru (colapsa espaços) antes de compor a descrição. */
function corte(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t;
}

// ---- Metadata (jsonb externo: narrowing defensivo, sem `any`) ----

type Obj = Record<string, unknown>;
const ehObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface LeituraLida {
  classe: string | null;
  texto: string | null;
  lacuna: boolean;
  erro: string | null;
  tentativas: number;
  tipo: string | null;
}
function lerLeitura(meta: Obj | null): LeituraLida | null {
  const l = meta?.leitura;
  if (!ehObj(l)) return null;
  return {
    classe: str(l.classe),
    texto: typeof l.texto === 'string' ? l.texto : null,
    lacuna: l.lacuna === true,
    erro: str(l.erro),
    tentativas: num(l.tentativas) ?? 0,
    tipo: str(l.tipo),
  };
}

// ---- Quem falou, data ----

export function quemFalou(m: MsgCtx, isGroup: boolean): string {
  if (m.direction === 'inbound') {
    if (!isGroup) return 'cliente';
    return citar(m.sender_name || m.sender_phone || 'participante', 40);
  }
  return m.sent_by ? 'atendente' : 'equipe';
}

/** 'dd/MM HH:mm' em BRT (UTC−3 fixo). */
function dataBRT(at: string): string {
  const iso = isoUs(at);
  const ms = Date.parse(`${iso.slice(0, 19)}Z`) - 3 * 3_600_000;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// ---- Descrição por tipo ----

const NOME_MIDIA: Record<string, string> = {
  image: 'imagem',
  sticker: 'figurinha',
  audio: 'áudio',
  ptt: 'áudio',
  video: 'vídeo',
  document: 'documento',
};

const MOTIVO_ERRO: Record<string, string> = {
  grande_demais: 'arquivo grande demais',
  imagem_enviada: 'imagem enviada pela equipe',
  nao_suportado: 'tipo de arquivo não suportado',
  teto_gasto: 'leitura adiada',
  download: 'arquivo não baixou',
};

function motivoSemLeitura(m: MsgCtx, l: LeituraLida | null): string {
  if (!m.media_url) return 'arquivo indisponível';
  if (!l) return 'ainda não lida';
  if (l.erro) {
    if (MOTIVO_ERRO[l.erro]) return MOTIVO_ERRO[l.erro];
    return 'falha na leitura';
  }
  if (l.lacuna) return 'não será lida';
  return 'ainda não lida';
}

export interface OpcoesDescricao {
  /** Limite do texto de leitura (600 quando o teto aperta). */
  leituraMax?: number;
}

function descricaoMidia(m: MsgCtx, op: OpcoesDescricao): { texto: string; lacuna: boolean; classe: string | null } {
  const tipo = m.message_type ?? '';
  const nomeTipo = NOME_MIDIA[tipo] ?? 'arquivo';
  const content = (m.content ?? '').trim();
  // Legenda é conteúdo real; o marcador do webhook ("[Áudio]") não é.
  const legenda = content && !/^\[.*\]$/.test(content) ? `${corte(mascarar(content), 600)} ` : '';
  const l = lerLeitura(m.metadata);
  const classe = l?.classe ?? null;

  if (classe === 'documento') {
    return { texto: `${legenda}(documento pessoal recebido)`, lacuna: false, classe };
  }
  if (l && l.texto !== null && !l.lacuna) {
    if (l.texto.trim() === '') {
      return { texto: `${legenda}(${nomeTipo} lido: sem texto reconhecido)`, lacuna: false, classe };
    }
    const padrao = tipo === 'audio' || tipo === 'ptt' || tipo === 'video' ? LEITURA_MAX_FALA : LEITURA_MAX_IMAGEM;
    const limite = op.leituraMax !== undefined ? Math.min(op.leituraMax, padrao) : padrao;
    const t = corte(mascarar(l.texto), limite);
    const c = classe ?? 'outro';
    let corpo: string;
    switch (tipo) {
      case 'audio':
      case 'ptt':
        corpo = `(áudio transcrito: ${t})`;
        break;
      case 'video':
        corpo = `(vídeo, fala transcrita: ${t})`;
        break;
      case 'document':
        corpo = `(documento ${corte(m.media_filename, 80) || 'sem nome'} — CLASSE ${c}: ${t})`;
        break;
      case 'sticker':
        corpo = `(figurinha — CLASSE ${c}: ${t})`;
        break;
      default:
        corpo = `(imagem — CLASSE ${c}: ${t})`;
    }
    return { texto: `${legenda}${corpo}`, lacuna: false, classe };
  }
  return {
    texto: `${legenda}(${nomeTipo} sem leitura: ${motivoSemLeitura(m, l)} — o conteúdo existe e você não tem acesso)`,
    lacuna: true,
    classe,
  };
}

function nomesDeContato(m: MsgCtx): string {
  // Formato real gravado pelo webhook e pelo qr-service: campos singulares em
  // `metadata.contact` e a lista completa em `metadata.contact.contacts`. O formato
  // antigo com `metadata.contacts` no topo também é aceito, e o singular como último recurso.
  const meta = m.metadata;
  const contato = ehObj(meta?.contact) ? meta.contact : null;
  const listaTopo = Array.isArray(meta?.contacts) ? (meta.contacts as unknown[]) : null;
  const listaAninhada = Array.isArray(contato?.contacts) ? (contato.contacts as unknown[]) : null;
  const lista: unknown[] = listaTopo && listaTopo.length > 0
    ? listaTopo
    : listaAninhada && listaAninhada.length > 0
    ? listaAninhada
    : contato
    ? [contato]
    : [];
  const partes = lista.filter(ehObj).map((c) => {
    const nome = str(c.displayName) ?? str(c.name) ?? 'sem nome';
    const fones = Array.isArray(c.phones) ? (c.phones as unknown[]).filter((p): p is string => typeof p === 'string') : [];
    const fone = fones[0] ?? str(c.phone);
    return fone ? `${corte(nome, 60)} — ${corte(fone, 30)}` : corte(nome, 60);
  });
  return partes.join('; ');
}

function descricaoEnquete(m: MsgCtx): string {
  const p = ehObj(m.metadata?.poll) ? (m.metadata?.poll as Obj) : null;
  if (!p) return '(enquete)';
  const pergunta = corte(str(p.question) ?? m.content, 200);
  const opcoes = (Array.isArray(p.options) ? (p.options as unknown[]) : [])
    .map((o) => (typeof o === 'string' ? o : ehObj(o) ? str(o.name) ?? str(o.text) ?? '' : ''))
    .filter(Boolean)
    .map((o) => corte(o, 60));
  const votos = ehObj(p.votes) ? Object.values(p.votes).filter((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v))).length : 0;
  return `(enquete: ${pergunta} — opções: ${opcoes.join('; ')} — votos: ${votos})`;
}

/** Trecho curto de uma mensagem (para citação e reação). */
function trechoDe(m: MsgCtx, n: number): string {
  const c = (m.content ?? '').trim();
  if (c && !/^\[.*\]$/.test(c) && !m.is_deleted) return corte(mascarar(c), n);
  const d = descreverMensagem(m, undefined, null);
  return d ? corte(d.texto, n) : '';
}

/** null = pular. O texto devolvido é CRU (mascarado, sem aspas): o serializador escapa a linha inteira. */
export function descreverMensagem(
  m: MsgCtx,
  citada: MsgCtx | undefined,
  refDaCitada: string | null,
  op: OpcoesDescricao = {},
): { texto: string; lacuna: boolean; classe: string | null } | null {
  const tipo = m.message_type;
  if (tipo === 'group_action') return null;
  if (tipo === 'unsupported' && m.metadata === null) return null; // bolha fantasma de stanza de protocolo

  let corpo: { texto: string; lacuna: boolean; classe: string | null };

  if (m.is_deleted) {
    const antes = corte(mascarar(m.content ?? ''), 200);
    corpo = {
      texto: antes && !/^\[.*\]$/.test(antes) ? `(apagou esta mensagem; o texto era: ${antes})` : '(apagou esta mensagem)',
      lacuna: false,
      classe: null,
    };
  } else {
    switch (tipo) {
      case 'text':
      case 'template':
      case 'button_reply':
      case 'list_reply':
      case 'list':
      case 'flow':
      case 'nfm_reply':
      case null:
      case undefined: {
        const c = (m.content ?? '').trim();
        if (!c) return null;
        corpo = { texto: mascarar(c), lacuna: false, classe: null };
        break;
      }
      case 'image':
      case 'sticker':
      case 'audio':
      case 'ptt':
      case 'video':
      case 'document':
        corpo = descricaoMidia(m, op);
        break;
      case 'location': {
        const loc = ehObj(m.metadata?.location) ? (m.metadata?.location as Obj) : null;
        const partes = [str(loc?.name), str(loc?.address)].filter((x): x is string => x !== null).map((x) => corte(x, 120));
        const lat = num(loc?.lat);
        const lng = num(loc?.lng);
        const alvo = partes.length > 0 ? partes.join(', ') : lat !== null && lng !== null ? `${lat}, ${lng}` : 'sem endereço';
        corpo = { texto: `(localização${loc?.live === true ? ' ao vivo' : ''}: ${alvo})`, lacuna: false, classe: null };
        break;
      }
      case 'contact': {
        const nomes = nomesDeContato(m);
        corpo = { texto: `(contato compartilhado${nomes ? `: ${nomes}` : ''})`, lacuna: false, classe: null };
        break;
      }
      case 'poll':
        corpo = { texto: descricaoEnquete(m), lacuna: false, classe: null };
        break;
      case 'call': {
        const call = ehObj(m.metadata?.call) ? (m.metadata?.call as Obj) : null;
        const st = str(call?.status);
        corpo = { texto: `(ligação de voz/vídeo${st ? `: ${corte(st, 40)}` : ''})`, lacuna: false, classe: null };
        break;
      }
      case 'reaction':
        corpo = { texto: `(reagiu com ${corte(m.content, 16)})`, lacuna: false, classe: null };
        break;
      case 'deleted':
        corpo = { texto: '(mensagem apagada)', lacuna: false, classe: null };
        break;
      case 'unsupported': {
        const orig = str(m.metadata?.original_type);
        corpo = {
          texto: orig
            ? `(mensagem de um tipo que o Echo não mostra: ${corte(orig, 40)})`
            : '(mensagem de um tipo que o Echo não mostra)',
          lacuna: true,
          classe: null,
        };
        break;
      }
      default: {
        // Tipo fora do CHECK (não deveria existir): usa o texto, se houver.
        const c = (m.content ?? '').trim();
        if (!c) return null;
        corpo = { texto: mascarar(c), lacuna: false, classe: null };
      }
    }
    if (m.is_edited && !m.is_deleted) {
      const hist = Array.isArray(m.metadata?.edit_history) ? (m.metadata?.edit_history as unknown[]) : [];
      const ultimo = hist.length > 0 ? hist[hist.length - 1] : null;
      const antigo = ehObj(ultimo) ? str(ultimo.content) : null;
      if (antigo) corpo.texto += ` (editada; antes: ${corte(mascarar(antigo), 200)})`;
      else if (m.metadata?.edit_content_unavailable === true) corpo.texto += ' (editada; o texto novo não chegou)';
    }
  }

  if (m.quoted_message_id) {
    if (citada) {
      const t = trechoDe(citada, 80);
      corpo.texto = refDaCitada
        ? `(respondendo a ${refDaCitada}: ${t}) ${corpo.texto}`
        : `(respondendo a: ${t}) ${corpo.texto}`;
    }
  }
  return corpo;
}

// ---- Serialização ----

interface Item {
  linha: Omit<LinhaCtx, 'texto'> & { texto: string };
  // Para refazer o texto quando o teto aperta
  recompor: (leituraMax: number) => string;
}

function ehNova(at: string, id: string | null, c: Ponto | null): boolean {
  if (!c) return true;
  const cmp = compararIso(at, c.at);
  if (cmp > 0) return true;
  if (cmp < 0) return false;
  return c.id !== null && id !== null && id > c.id;
}

function formatarLinha(l: LinhaCtx): string {
  return `[${l.ref} ${dataBRT(l.at)} ${l.quem}] ${l.texto}`;
}

const CAB_ANTERIORES = 'JÁ ANALISADAS (contexto):';
const CAB_NOVAS = 'NOVAS (desde a última análise):';

export function serializarConversa(e: ContextoEntrada): ContextoSerializado {
  const teto = e.tetoChars ?? TETO_CHARS_PADRAO;
  const isGroup = e.conversa.is_group;

  const porId = new Map<string, MsgCtx>();
  for (const m of e.citadas) porId.set(m.id, m);
  for (const m of e.mensagens) porId.set(m.id, m); // a janela vale sobre a citada
  const noJanela = new Map<string, MsgCtx>(e.mensagens.map((m) => [m.id, m]));
  const idsComReacao = new Set(e.reacoes.map((r) => r.message_id));

  // Passo 1: quais mensagens viram linha, e em que ordem (mensagens e reações juntas).
  type Evento =
    | { k: 'm'; at: string; m: MsgCtx }
    | { k: 'r'; at: string; r: ReacaoCtx };
  const eventos: Evento[] = [
    ...e.mensagens.map((m): Evento => ({ k: 'm', at: isoUs(m.created_at), m })),
    ...e.reacoes.map((r): Evento => ({ k: 'r', at: isoUs(r.reacted_at), r })),
  ];
  eventos.sort((a, b) => {
    const c = a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
    if (c !== 0) return c;
    if (a.k !== b.k) return a.k === 'm' ? -1 : 1; // mensagem antes da reação no mesmo instante
    if (a.k === 'm' && b.k === 'm') return a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0;
    return 0;
  });

  const refDeMsg = new Map<string, string>();
  const emitidos: Evento[] = [];
  for (const ev of eventos) {
    if (ev.k === 'm' && descreverMensagem(ev.m, undefined, null) === null) continue;
    emitidos.push(ev);
    if (ev.k === 'm') refDeMsg.set(ev.m.id, `#${emitidos.length}`);
  }

  // Passo 2: texto de cada linha.
  const itens: Item[] = emitidos.map((ev, i) => {
    const ref = `#${i + 1}`;
    if (ev.k === 'm') {
      const m = ev.m;
      const citada = m.quoted_message_id ? porId.get(m.quoted_message_id) : undefined;
      const refCitada = m.quoted_message_id && noJanela.has(m.quoted_message_id)
        ? refDeMsg.get(m.quoted_message_id) ?? null
        : null;
      const montar = (leituraMax: number): { texto: string; lacuna: boolean; classe: string | null } => {
        const d = descreverMensagem(m, citada, refCitada, { leituraMax }) as { texto: string; lacuna: boolean; classe: string | null };
        let t = d.texto;
        if (m.reaction && !idsComReacao.has(m.id) && !m.is_deleted) {
          t += ` (reação atual nesta mensagem: ${corte(m.reaction, 16)})`;
        }
        return { ...d, texto: t };
      };
      const d0 = montar(LEITURA_MAX_IMAGEM);
      return {
        linha: {
          ref,
          tipo: 'mensagem',
          message_id: m.id,
          reaction_id: null,
          at: ev.at,
          direction: m.direction,
          quem: quemFalou(m, isGroup),
          nova: ehNova(ev.at, m.id, e.cursor),
          message_type: m.message_type,
          texto: citar(d0.texto, LINHA_MAX),
          classe: d0.classe,
          lacuna: d0.lacuna,
        },
        recompor: (max) => citar(montar(max).texto, LINHA_MAX),
      };
    }
    const r = ev.r;
    const alvoNaJanela = noJanela.get(r.message_id);
    const refAlvo = alvoNaJanela ? refDeMsg.get(r.message_id) ?? null : null;
    const alvo = alvoNaJanela ?? porId.get(r.message_id);
    const trecho = alvo ? trechoDe(alvo, 60) : '';
    const emoji = corte(r.emoji, 16);
    const destino = refAlvo ? `à mensagem ${refAlvo}` : alvo ? 'a uma mensagem anterior' : 'a uma mensagem antiga';
    const texto = `reagiu ${emoji} ${destino}${alvo ? ` (${trecho})` : ' (mensagem antiga)'}`;
    const quem = r.is_from_me
      ? 'atendente'
      : isGroup && r.reactor_name
      ? citar(r.reactor_name, 40)
      : 'cliente';
    return {
      linha: {
        ref,
        tipo: 'reacao',
        message_id: r.message_id,
        reaction_id: r.id,
        at: ev.at,
        direction: r.is_from_me ? 'outbound' : 'inbound',
        quem,
        nova: true,
        message_type: 'reaction',
        texto: citar(texto, LINHA_MAX),
        classe: null,
        lacuna: false,
      },
      recompor: () => citar(texto, LINHA_MAX),
    };
  });

  // Passo 3: teto do bloco CONVERSA.
  const montarConversa = (its: Item[]): string => {
    const ant = its.filter((x) => !x.linha.nova).map((x) => formatarLinha(x.linha));
    const nov = its.filter((x) => x.linha.nova).map((x) => formatarLinha(x.linha));
    const partes: string[] = [];
    if (ant.length > 0) partes.push(`${CAB_ANTERIORES}\n${ant.join('\n')}`);
    partes.push(`${CAB_NOVAS}${nov.length > 0 ? `\n${nov.join('\n')}` : '\n(nenhuma)'}`);
    return partes.join('\n');
  };

  let restantes = itens;
  let truncado = false;
  let conversa = montarConversa(restantes);
  // 1) mais antigas de JÁ ANALISADAS
  while (conversa.length > teto) {
    const i = restantes.findIndex((x) => !x.linha.nova);
    if (i < 0) break;
    restantes = restantes.filter((_, j) => j !== i);
    truncado = true;
    conversa = montarConversa(restantes);
  }
  // 2) encurta textos de leitura
  if (conversa.length > teto) {
    let mudou = false;
    for (const it of restantes) {
      const novo = it.recompor(LEITURA_MAX_ENCURTADA);
      if (novo !== it.linha.texto) {
        it.linha.texto = novo;
        mudou = true;
      }
    }
    if (mudou) truncado = true;
    conversa = montarConversa(restantes);
  }
  // 3) mais antigas das NOVAS (sempre sobra a mais recente)
  while (conversa.length > teto && restantes.length > 1) {
    restantes = restantes.slice(1);
    truncado = true;
    conversa = montarConversa(restantes);
  }

  const linhas = restantes.map((x) => x.linha);
  const refs: Record<string, LinhaCtx> = {};
  for (const l of linhas) refs[l.ref] = l;

  return {
    texto: `CONVERSA:\n${conversa}`,
    linhas,
    refs,
    novas: linhas.filter((l) => l.nova).length,
    lacunas: linhas.filter((l) => l.lacuna).length,
    truncado,
    chars: conversa.length,
  };
}
