// Aviso único, passo 3: um aviso ao CRM por mensagem.
//
// Cada linha nossa que está num grupo grava a sua cópia da mensagem, e no 1 a 1 o contato pode ter duas conversas na
// mesma linha (com e sem o 9º dígito). A primeira cópia gravada reserva o aviso em `aviso_de_mensagem` (chave única
// por organização) e as outras não avisam. Se a cópia da linha que FALOU chega depois da de quem só ouviu, vai só um
// complemento `message.author` (quem digitou e por onde), com chave própria. A reserva acontece na gravação
// (/qr-message e emitMessageSent), antes de qualquer chamada ao CRM.
// A entrega só conta com o ok do CRM; sem ok, o cron aviso-de-mensagem-repetir (edge aviso-repetir) repete até
// MAX_REPETICOES vezes e, na 6ª tentativa e na última, deixa webhook_dead em qr_message_log, que vira e-mail e push
// para a equipe.
// Só linha QR: a linha oficial grava uma cópia só da mensagem, então não há o que deduplicar.
// O receptor do webhook usa `aviso_id` como chave para descartar o aviso repetido.

import { logWriteFailure } from './failure-log.ts';
import { fetchExterno, UrlExternaBloqueadaError } from './url-guard.ts';

/** Prefixo do `ultimo_erro` quando a guarda SSRF recusou a URL do webhook da organização. */
export const ERRO_URL_BLOQUEADA = 'url_bloqueada:';

export const MAX_REPETICOES = 10;
/** Minutos até cada repetição: a 1ª um minuto depois da entrega que falhou, a 10ª umas 5 horas depois. */
const ESPERA_MIN = [1, 2, 4, 8, 15, 30, 60, 60, 60, 60];
/** A 6ª tentativa sem ok (uns 30 minutos de CRM recusando) já avisa a equipe, sem esperar as 5 horas do fim. */
export const ALERTA_NA_TENTATIVA = 6;
/** Prazo da 1ª entrega. Passado, o cron trata o aviso como queda no meio e repete pelo corpo guardado. */
export const PRAZO_PRIMEIRA_ENTREGA_MS = 5 * 60_000;
const ENTREGA_TIMEOUT_MS = 8_000;
const LOTE = 30;
const EM_PARALELO = 5;

/** O que a gravação conta ao aviso. Vai em `payload.aviso_unico` para o sendOrganizationWebhook. */
export interface AvisoUnicoEntrada {
  /** aviso_id: 'grupo:<jid>:<código>' | 'conversa:<linha>:<contato sem o 9>:<código>' (+ ':autor'/':linha'). */
  chave: string;
  /** A cópia é da linha que falou: envio pelo Echo ou fromMe do aparelho. */
  saida: boolean;
  /** A cópia sabe quem digitou ou por onde (painel, API, automação, agendamento, disparo). */
  tem_autor: boolean;
  /** Só no complemento: a chave do aviso que ele completa. */
  original?: string;
  /** A reserva já feita na gravação (emitMessageSent reserva antes de o envio responder). */
  reserva?: Reserva;
}

export interface DonoDaReserva {
  evento: string;
  tem_autor: boolean;
  message_id: string;
}

export type Reserva =
  | { tipo: 'reservado'; id: string }
  | { tipo: 'copia'; dono: DonoDaReserva }
  | { tipo: 'sem_reserva' };

const soDigitos = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/** O contato só em dígitos e sem o 9º dígito do celular brasileiro: as duas conversas do contato dão a mesma chave. */
export function contatoSemNono(valor: unknown): string {
  const d = soDigitos(valor);
  return /^55\d{2}9\d{8}$/.test(d) ? d.slice(0, 4) + d.slice(5) : d;
}

/** A chave do aviso da mensagem, ou null quando não há código do WhatsApp de verdade (o aviso sai como sempre saiu). */
export function chaveDoAviso(args: {
  grupo: boolean;
  groupJid?: string | null;
  linhaId?: string | null;
  contato?: string | null;
  codigo?: string | null;
}): string | null {
  const codigo = String(args.codigo ?? '').trim();
  // 'qr_…' é o marcador que o Echo grava quando o serviço não devolveu código; 'grpevt_…' é aviso de sistema do grupo.
  if (!codigo || codigo.startsWith('qr_') || codigo.startsWith('grpevt_')) return null;
  if (args.grupo) {
    const jid = String(args.groupJid ?? '').trim();
    return jid.endsWith('@g.us') ? `grupo:${jid}:${codigo}` : null;
  }
  const linha = String(args.linhaId ?? '').trim();
  const contato = contatoSemNono(args.contato);
  return linha && contato ? `conversa:${linha}:${contato}:${codigo}` : null;
}

/** A chave do complemento: um com quem digitou e um só com a linha, para o mais completo nunca ficar de fora. */
export function chaveDoComplemento(chave: string, temAutor: boolean): string {
  return `${chave}:${temAutor ? 'autor' : 'linha'}`;
}

/**
 * A cópia que chegou depois da reserva complementa o aviso? Só a cópia da linha que falou, e só quando o aviso que
 * saiu foi o de quem ouviu (o CRM não recebeu nada da linha que falou) ou não sabia quem digitou e esta sabe.
 */
export function precisaComplemento(
  copia: Pick<AvisoUnicoEntrada, 'saida' | 'tem_autor'>,
  dono: Pick<DonoDaReserva, 'evento' | 'tem_autor'>,
): boolean {
  if (!copia.saida) return false;
  return dono.evento !== 'message.sent' || (copia.tem_autor && !dono.tem_autor);
}

/** De quem é e qual é a mensagem de uma chave: o grupo ou o contato, e o código do WhatsApp. */
export function partesDaChave(chave: string): { conversa: string; codigo: string | null } {
  const p = chave.split(':');
  if (p[p.length - 1] === 'autor' || p[p.length - 1] === 'linha') p.pop();
  if (p[0] === 'grupo' && p.length === 3) return { conversa: p[1], codigo: p[2] };
  if (p[0] === 'conversa' && p.length === 4) return { conversa: p[2], codigo: p[3] };
  return { conversa: 'unknown', codigo: null };
}

/** Minutos até a repetição de número `repeticao` (1 a MAX_REPETICOES). */
export function esperaDaRepeticao(repeticao: number): number {
  return ESPERA_MIN[Math.min(Math.max(repeticao, 1), ESPERA_MIN.length) - 1];
}

/**
 * Reserva o aviso. Nunca lança: com o banco fora, devolve 'sem_reserva' e o aviso sai mesmo assim (o CRM descarta o
 * repetido pelo aviso_id). 'copia' traz quem ganhou, para decidir o complemento.
 */
export async function reservarAviso(
  supabase: any,
  args: { organizationId: string; chave: string; messageId: string; evento: string; temAutor: boolean },
): Promise<Reserva> {
  try {
    const { data, error } = await supabase
      .from('aviso_de_mensagem')
      .upsert(
        {
          organization_id: args.organizationId,
          chave: args.chave,
          message_id: args.messageId,
          evento: args.evento,
          tem_autor: args.temAutor,
          estado: 'enviando',
          proxima_em: new Date(Date.now() + PRAZO_PRIMEIRA_ENTREGA_MS).toISOString(),
        },
        { onConflict: 'organization_id,chave', ignoreDuplicates: true },
      )
      .select('id');
    if (error) throw error;
    if (data && data.length > 0) return { tipo: 'reservado', id: String(data[0].id) };

    const { data: dono, error: erroDono } = await supabase
      .from('aviso_de_mensagem')
      .select('evento, tem_autor, message_id')
      .eq('organization_id', args.organizationId)
      .eq('chave', args.chave)
      .maybeSingle();
    if (erroDono || !dono) throw erroDono ?? new Error('reserva não encontrada depois do conflito');
    return { tipo: 'copia', dono: dono as DonoDaReserva };
  } catch (error) {
    console.error('[aviso-unico] reserva falhou; o aviso sai sem reserva:', error);
    return { tipo: 'sem_reserva' };
  }
}

/** Guarda o aviso montado antes da 1ª entrega: se a função cair no meio, o cron repete por ele. Nunca lança. */
export async function guardarCorpo(supabase: any, reservaId: string, corpo: unknown): Promise<void> {
  try {
    const falou = (corpo as { falou?: unknown } | null)?.falou ?? null;
    const { error } = await supabase.from('aviso_de_mensagem').update({ corpo, falou }).eq('id', reservaId);
    if (error) console.error('[aviso-unico] corpo do aviso não foi guardado:', error);
  } catch (error) {
    console.error('[aviso-unico] corpo do aviso não foi guardado:', error);
  }
}

/** O que muda na reserva depois de uma tentativa. Puro: a regra das repetições mora aqui. */
export function resultadoDaTentativa(
  tentativas: number,
  ok: boolean,
  erro: string | null,
  agora: Date,
  bloqueada = false,
): Record<string, unknown> {
  if (ok) {
    return { estado: 'entregue', tentativas, entregue_em: agora.toISOString(), proxima_em: null, corpo: null, ultimo_erro: null };
  }
  // URL recusada pela guarda SSRF: repetir não muda nada (só o admin corrigindo a URL ou a allowlist), então encerra.
  if (bloqueada) {
    return { estado: 'falhou', tentativas, proxima_em: null, ultimo_erro: erro };
  }
  // tentativas = a 1ª entrega + as repetições já feitas
  if (tentativas > MAX_REPETICOES) {
    return { estado: 'falhou', tentativas, proxima_em: null, ultimo_erro: erro };
  }
  const espera = esperaDaRepeticao(tentativas) * 60_000;
  return { estado: 'repetir', tentativas, proxima_em: new Date(agora.getTime() + espera).toISOString(), ultimo_erro: erro };
}

/** Grava o resultado de uma tentativa. Nunca lança: sem gravar, o prazo vence e o cron repete (o CRM descarta o repetido). */
export async function registrarEntrega(
  supabase: any,
  reservaId: string,
  tentativas: number,
  ok: boolean,
  erro: string | null,
  bloqueada = false,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('aviso_de_mensagem')
      .update(resultadoDaTentativa(tentativas, ok, erro, new Date(), bloqueada))
      .eq('id', reservaId);
    if (error) console.error('[aviso-unico] resultado da entrega não foi gravado:', error);
  } catch (error) {
    console.error('[aviso-unico] resultado da entrega não foi gravado:', error);
  }
}

interface AvisoNaFila {
  id: string;
  organization_id: string;
  chave: string;
  message_id: string;
  tentativas: number;
  corpo: Record<string, unknown> | null;
}

/**
 * Repete os avisos vencidos (edge aviso-repetir, chamada pelo cron a cada minuto). A hora do aviso (ts/ts_iso) é a da
 * repetição: é por ela que o CRM sabe que a mensagem é nova; a hora da mensagem segue em message_created_at.
 */
export async function repetirAvisos(
  supabase: any,
  // A URL é da organização: passa pela guarda SSRF em cada salto (fetchExterno), como na 1ª entrega.
  enviar: (url: string, init: RequestInit) => Promise<Response> = (u, i) => fetchExterno(u, i),
): Promise<{ lote: number; entregues: number; repetir: number; falharam: number }> {
  const { data, error } = await supabase.rpc('aviso_de_mensagem_pegar_lote', { p_limite: LOTE });
  if (error) throw new Error(`lote de avisos: ${error.message ?? error}`);
  const lote = (data ?? []) as AvisoNaFila[];
  const enderecos = new Map<string, Promise<string | null>>();
  const enderecoDa = (org: string) => {
    if (!enderecos.has(org)) {
      enderecos.set(org, (async () => {
        const { data: cfg, error: erroCfg } = await supabase
          .from('organization_webhooks')
          .select('url, is_active')
          .eq('organization_id', org)
          .maybeSingle();
        if (erroCfg) throw new Error(`webhook da organização: ${erroCfg.message ?? erroCfg}`);
        return cfg?.is_active && cfg?.url ? String(cfg.url) : null;
      })());
    }
    return enderecos.get(org)!;
  };

  const placar = { lote: lote.length, entregues: 0, repetir: 0, falharam: 0 };
  const tentar = async (a: AvisoNaFila) => {
    const tentativas = (a.tentativas ?? 0) + 1;
    let url: string | null;
    try {
      url = await enderecoDa(a.organization_id);
    } catch (e) {
      // Sem saber o endereço, não conta tentativa: o prazo de 10 minutos do lote vence e o cron tenta de novo.
      console.error('[aviso-repetir]', e);
      return;
    }
    if (!url) {
      // O webhook foi desligado: ninguém espera o aviso. Sem alerta.
      await supabase.from('aviso_de_mensagem')
        .update({ estado: 'falhou', proxima_em: null, ultimo_erro: 'webhook da organização desligado' }).eq('id', a.id);
      placar.falharam++;
      return;
    }
    let ok = false;
    let erro: string | null = null;
    let bloqueada = false;
    if (!a.corpo) {
      erro = 'aviso sem corpo guardado (a função caiu antes de montar o aviso)';
    } else {
      try {
        const corpo = { ...a.corpo, ts: Date.now(), ts_iso: new Date().toISOString() };
        const resp = await enviar(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(corpo),
          signal: AbortSignal.timeout(ENTREGA_TIMEOUT_MS),
        });
        ok = resp.ok;
        if (!ok) erro = `HTTP ${resp.status}`;
      } catch (e) {
        if (e instanceof UrlExternaBloqueadaError) {
          bloqueada = true;
          erro = `${ERRO_URL_BLOQUEADA}${e.reason}`;
          console.warn(`[aviso-repetir] URL do webhook bloqueada pela guarda (${e.reason})`);
        } else {
          erro = String((e as Error)?.message ?? e);
        }
      }
    }
    const final = !ok && (!a.corpo || bloqueada || tentativas > MAX_REPETICOES);
    const { error: erroGravar } = await supabase
      .from('aviso_de_mensagem')
      .update(final
        ? { estado: 'falhou', tentativas, proxima_em: null, ultimo_erro: erro }
        : resultadoDaTentativa(tentativas, ok, erro, new Date()))
      .eq('id', a.id);
    if (erroGravar) console.error('[aviso-repetir] resultado não gravado:', erroGravar);
    if (ok) {
      placar.entregues++;
      return;
    }
    if (final) placar.falharam++;
    else placar.repetir++;
    if (final || tentativas === ALERTA_NA_TENTATIVA) {
      // webhook_dead fora das rotas derivadas conta como falha dura no check_message_failure_alerts: e-mail e push.
      const partes = partesDaChave(a.chave);
      await logWriteFailure(supabase, {
        toJid: partes.conversa,
        wamid: partes.codigo,
        action: 'webhook_dead',
        error: final
          ? `Aviso ao CRM não entregue depois de ${tentativas} tentativa(s): ${erro ?? 'sem resposta'} (aviso ${a.chave})`
          : `Aviso ao CRM ainda sem ok depois de ${tentativas} tentativas: ${erro ?? 'sem resposta'}; o Echo segue repetindo até ${MAX_REPETICOES + 1} (aviso ${a.chave})`,
        route: 'aviso-webhook',
        payload: { aviso_id: a.chave, message_id: a.message_id, organization_id: a.organization_id },
      });
    }
  };

  for (let i = 0; i < lote.length; i += EM_PARALELO) {
    await Promise.all(lote.slice(i, i + EM_PARALELO).map(tentar));
  }
  return placar;
}
