// Instagram Direct (API do Instagram com login do Instagram).
//
// Fase 1: só a conexão da conta e o registro cru dos avisos do
// Meta. Nada aqui cria conversa ou responde alguém.
//
// Formatos lidos na documentação oficial do Meta:
// - aviso de mensagem: { object: "instagram", entry: [{ id, time, messaging: [{
//   sender: { id }, recipient: { id }, timestamp, message | postback | referral
//   | read | reaction | message_edit }] }] }
// - assinatura: cabeçalho X-Hub-Signature-256 = "sha256=" + HMAC-SHA256 do
//   corpo cru com o segredo do app.

import { iguaisEmTempoConstante } from './segredo.ts';

export const IG_GRAPH_VERSION = Deno.env.get('INSTAGRAM_GRAPH_VERSION') ?? 'v25.0';
export const IG_GRAPH = `https://graph.instagram.com/${IG_GRAPH_VERSION}`;

// Campos de aviso que a conexão assina. Comentário fica de fora: exige
// aprovação própria do Meta e não faz parte do Direct.
export const IG_CAMPOS_ASSINADOS = [
  'messages',
  'messaging_postbacks',
  'messaging_referral',
  'messaging_seen',
  'message_reactions',
  'message_edit',
];

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(segredo: string, dado: string): Promise<string> {
  const chave = await crypto.subtle.importKey(
    'raw',
    enc.encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', chave, enc.encode(dado)));
}

/** sha256 em hexadecimal de um texto. */
export async function sha256Hex(dado: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(dado)));
}

/**
 * Lista de segredos aceitos (vírgula separa um segredo por app). O PRIMEIRO da
 * lista é o segredo do app do Instagram, par do INSTAGRAM_APP_ID: é ele que o
 * login do Instagram usa.
 */
export function segredosDoApp(valor = Deno.env.get('INSTAGRAM_APP_SECRET') ?? ''): string[] {
  return valor.split(',').map((s) => s.trim()).filter(Boolean);
}

/** A assinatura do Meta confere com algum dos segredos? */
export async function assinaturaConfere(
  corpoCru: string,
  cabecalho: string | null,
  segredos: string[],
): Promise<boolean> {
  if (!cabecalho || !cabecalho.startsWith('sha256=') || segredos.length === 0) return false;
  const recebido = cabecalho.slice('sha256='.length).trim().toLowerCase();
  for (const segredo of segredos) {
    if (iguaisEmTempoConstante(await hmacHex(segredo, corpoCru), recebido)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// "state" do login do Instagram: prova que o link de conexão saiu de nós e diz
// em qual linha a conta vai entrar. Formato: base64url(json) + "." + hmac.
// ---------------------------------------------------------------------------

export type EstadoDaConexao = {
  org: string;   // organizations.id
  linha: string; // phone_numbers.id (a linha QR/API com que a linha Instagram divide a caixa)
  exp: number;   // segundos desde 1970
  n: string;     // aleatório
  app?: boolean; // saiu da tela de Configurações: a volta é para o próprio Echo
};

/** Tipos de linha que podem dividir a caixa com o Direct (NULL = padrão antigo, API). Par de instagram_linha_pode_hospedar(). */
export function linhaPodeHospedar(tipo: string | null | undefined): boolean {
  return ['qr', 'business_api', 'business', 'official'].includes(tipo ?? 'business_api');
}

/** Link do login do Instagram (a página onde o admin da conta autoriza). */
export function linkDeAutorizacao(appId: string, redirectUri: string, state: string): string {
  return `https://www.instagram.com/oauth/authorize?${new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'instagram_business_basic,instagram_business_manage_messages',
    state,
  })}`;
}

// ---------------------------------------------------------------------------
// Renovação do token longo (vale 60 dias). O Meta só renova token com mais de
// 24 h e ainda válido; a rotina tenta quando faltam 10 dias, no máximo a cada 12 h.
// ---------------------------------------------------------------------------

export const RENOVAR_ANTES_MS = 10 * 24 * 60 * 60 * 1000;
export const INTERVALO_ENTRE_TENTATIVAS_MS = 12 * 60 * 60 * 1000;

export function precisaRenovar(
  conexao: { status: string; access_token: string; token_expires_at: string | null; token_refresh_tried_at: string | null },
  agoraMs = Date.now(),
): boolean {
  if (conexao.status !== 'connected' || !conexao.access_token || !conexao.token_expires_at) return false;
  const vence = new Date(conexao.token_expires_at).getTime();
  if (!Number.isFinite(vence) || vence - agoraMs > RENOVAR_ANTES_MS) return false;
  if (!conexao.token_refresh_tried_at) return true;
  return agoraMs - new Date(conexao.token_refresh_tried_at).getTime() >= INTERVALO_ENTRE_TENTATIVAS_MS;
}

function b64url(texto: string): string {
  let bin = '';
  for (const byte of enc.encode(texto)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deB64url(texto: string): string {
  const base = texto.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(base + '='.repeat((4 - (base.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export async function assinarEstado(estado: EstadoDaConexao, segredo: string): Promise<string> {
  const corpo = b64url(JSON.stringify(estado));
  return `${corpo}.${await hmacHex(segredo, corpo)}`;
}

// O link vale 30 minutos; validade além de 2 horas não saiu de nós.
const VALIDADE_MAXIMA_SEG = 2 * 60 * 60;
// Segredo curto demais não protege o link (mesmo mínimo da entrada do Echo).
export const SEGREDO_MINIMO = 32;

export async function lerEstado(
  texto: string | null,
  segredo: string,
  agoraSeg = Math.floor(Date.now() / 1000),
): Promise<EstadoDaConexao | null> {
  if (!texto || !segredo || segredo.length < SEGREDO_MINIMO || texto.length > 2048) return null;
  const partes = texto.split('.');
  if (partes.length !== 2) return null;
  const [corpo, assinatura] = partes;
  if (!iguaisEmTempoConstante(await hmacHex(segredo, corpo), assinatura.toLowerCase())) return null;
  let estado: EstadoDaConexao;
  try {
    estado = JSON.parse(deB64url(corpo));
  } catch {
    return null;
  }
  if (!estado || typeof estado.org !== 'string' || typeof estado.linha !== 'string') return null;
  if (typeof estado.exp !== 'number' || estado.exp < agoraSeg) return null;
  if (estado.exp > agoraSeg + VALIDADE_MAXIMA_SEG) return null;
  return estado;
}

// ---------------------------------------------------------------------------
// Classificação dos avisos (só para o registro da fase 1).
// ---------------------------------------------------------------------------

export type TipoDeAviso =
  | 'message'
  | 'echo'
  | 'deleted'
  | 'postback'
  | 'referral'
  | 'read'
  | 'reaction'
  | 'edit'
  | 'other';

export type AvisoDoInstagram = {
  tipo: TipoDeAviso;
  igAccountId: string | null;
  senderId: string | null;
  recipientId: string | null;
  mid: string | null;
  eventAt: string | null;
  payload: Record<string, unknown>;
  /** sha256 de { conta, evento }: a reentrega do Meta repete; eventos diferentes não. */
  hash: string;
};

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

function texto(v: unknown): string | null {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number') return String(v);
  return null;
}

function quando(ts: unknown): string | null {
  const n = typeof ts === 'number' ? ts : typeof ts === 'string' ? Number(ts) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  // O Meta manda milissegundos; valor pequeno demais é segundos.
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

function tipoDoEvento(ev: Obj): { tipo: TipoDeAviso; mid: string | null } {
  const message = obj(ev.message);
  if (message) {
    const mid = texto(message.mid);
    if (message.is_deleted === true) return { tipo: 'deleted', mid };
    if (message.is_echo === true) return { tipo: 'echo', mid };
    return { tipo: 'message', mid };
  }
  const postback = obj(ev.postback);
  if (postback) return { tipo: 'postback', mid: texto(postback.mid) };
  if (obj(ev.referral)) return { tipo: 'referral', mid: null };
  const read = obj(ev.read);
  if (read) return { tipo: 'read', mid: texto(read.mid) };
  const reaction = obj(ev.reaction);
  if (reaction) return { tipo: 'reaction', mid: texto(reaction.mid) };
  const edit = obj(ev.message_edit);
  if (edit) return { tipo: 'edit', mid: texto(edit.mid) };
  return { tipo: 'other', mid: null };
}

/**
 * Abre o corpo do aviso em um item por evento. Corpo em formato desconhecido
 * vira UM item 'other' com o corpo inteiro, para nada sumir calado.
 */
export function abrirAvisos(corpo: unknown): Promise<AvisoDoInstagram[]> {
  const raiz = obj(corpo);
  const entradas = Array.isArray(raiz?.entry) ? (raiz!.entry as unknown[]) : [];
  const saida: Omit<AvisoDoInstagram, 'hash'>[] = [];
  for (const e of entradas) {
    const entrada = obj(e);
    if (!entrada) continue;
    const conta = texto(entrada.id);
    const eventos = Array.isArray(entrada.messaging) ? (entrada.messaging as unknown[]) : [];
    for (const item of eventos) {
      const ev = obj(item);
      if (!ev) continue;
      const { tipo, mid } = tipoDoEvento(ev);
      saida.push({
        tipo,
        igAccountId: conta,
        senderId: texto(obj(ev.sender)?.id),
        recipientId: texto(obj(ev.recipient)?.id),
        mid,
        eventAt: quando(ev.timestamp),
        payload: ev,
      });
    }
    // `changes` (comentários, menções) não é assinado nesta fase: se chegar,
    // fica registrado inteiro. Entrada sem `messaging` nem `changes` (ex.:
    // `standby`) também fica, para nada sumir calado.
    const temChanges = Array.isArray(entrada.changes) && entrada.changes.length > 0;
    if (!eventos.length && !temChanges) {
      saida.push({
        tipo: 'other',
        igAccountId: conta,
        senderId: null,
        recipientId: null,
        mid: null,
        eventAt: quando(entrada.time),
        payload: entrada,
      });
    }
    if (temChanges) {
      saida.push({
        tipo: 'other',
        igAccountId: conta,
        senderId: null,
        recipientId: null,
        mid: null,
        eventAt: quando(entrada.time),
        payload: { changes: entrada.changes },
      });
    }
  }
  if (saida.length === 0) {
    saida.push({
      tipo: 'other',
      igAccountId: null,
      senderId: null,
      recipientId: null,
      mid: null,
      eventAt: null,
      payload: raiz ?? { valor: corpo as unknown },
    });
  }
  return Promise.all(saida.map(async (a) => ({
    ...a,
    hash: await sha256Hex(JSON.stringify({ conta: a.igAccountId, evento: a.payload })),
  })));
}
