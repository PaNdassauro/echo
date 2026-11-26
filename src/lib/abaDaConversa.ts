/**
 * Em que abas da lista uma conversa aparece. Ponto único da regra: o contador
 * de cada aba e o filtro da aba ativa leem daqui, então os dois não divergem.
 *
 * Precedência (a primeira que casa leva a conversa sozinha):
 *   encerrada → com a IA → disparos → abas normais.
 * Encerrada continua só em Encerrados mesmo com `disparo_desde` ou `ia_desde` preenchido.
 * Quem entra e sai de Disparos e de Com a IA é o banco; o front só lê a marca,
 * com uma exceção: a rede de segurança de Com a IA (ver comAIa).
 */

import type { Conversation } from "@/types/conversation";

export type AbaDaLista = "all" | "waiting" | "mine" | "shared" | "ia" | "disparos" | "closed";

export type FilaDaConversa = "closed" | "ia" | "disparos" | "normal";

/** A pessoa escreveu e a IA não respondeu neste tempo: a conversa volta para o time. */
export const IA_SEM_RESPOSTA_MS = 10 * 60 * 1000;

export interface ContextoDaAba {
  userId: string;
  /** Busca com texto: a aba Todos também mostra quem está em Disparos e Com a IA. */
  buscando?: boolean;
  /** Relógio da rede de segurança de Com a IA (ms). Sem ele, agora. */
  agora?: number;
}

type ConversaDaFila = Pick<Conversation, "status" | "disparo_desde" | "ia_desde" | "ia_sem_resposta_desde">;

type ConversaDaAba = ConversaDaFila & Pick<Conversation, "assigned_to" | "co_assignee_ids">;

/**
 * A IA está atendendo e dando conta. Rede de segurança (a lista do atendente
 * mostra só o que precisa de ação): a pessoa escreveu e a IA não respondeu
 * em 10 minutos (ia_sem_resposta_desde, mantido pelo banco; disparo e automação
 * não contam como resposta), a IA parou (pausa, falha, fora do horário) e a
 * conversa volta para Aguardando. Sem data legível, volta também: melhor ver a
 * mais que perder.
 */
export function comAIa(conv: ConversaDaFila, agora: number = Date.now()): boolean {
  if (!conv.ia_desde) return false;
  if (!conv.ia_sem_resposta_desde) return true;
  const desde = Date.parse(conv.ia_sem_resposta_desde);
  return !Number.isNaN(desde) && agora - desde < IA_SEM_RESPOSTA_MS;
}

/** Conversa ainda em Com a IA cuja rede de 10 minutos está correndo: a lista precisa do relógio. */
export function iaContandoRede(conv: ConversaDaFila, agora: number = Date.now()): boolean {
  return !!conv.ia_sem_resposta_desde && comAIa(conv, agora);
}

export function filaDaConversa(conv: ConversaDaFila, agora?: number): FilaDaConversa {
  if (conv.status === "closed") return "closed";
  if (comAIa(conv, agora)) return "ia";
  if (conv.disparo_desde) return "disparos";
  return "normal";
}

/** As abas normais se sobrepõem (Todos + Aguardando, Todos + Meus…); as outras são exclusivas. */
export function abasDaConversa(conv: ConversaDaAba, ctx: ContextoDaAba): AbaDaLista[] {
  const fila = filaDaConversa(conv, ctx.agora);
  if (fila === "closed") return ["closed"];
  if (fila === "ia") return ctx.buscando ? ["ia", "all"] : ["ia"];
  if (fila === "disparos") return ctx.buscando ? ["disparos", "all"] : ["disparos"];

  const abas: AbaDaLista[] = ["all"];
  if (conv.assigned_to === null) abas.push("waiting");
  if (conv.assigned_to === ctx.userId) abas.push("mine");
  else if (conv.co_assignee_ids?.includes(ctx.userId)) abas.push("shared");
  return abas;
}

export function estaNaAba(conv: ConversaDaAba, aba: string, ctx: ContextoDaAba): boolean {
  return abasDaConversa(conv, ctx).includes(aba as AbaDaLista);
}
