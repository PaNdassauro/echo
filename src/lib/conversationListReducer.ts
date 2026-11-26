/**
 * Reducers puros da lista de conversas do ESCOPO da tela.
 *
 * O estado é `Conversation[]` das linhas (phone_number_id) do escopo: uma só no
 * modo número, várias na caixa conjunta. Cada função devolve a MESMA referência
 * `prev` quando nada muda — é isso que permite ao React pular re-render da lista
 * virtualizada quando o realtime entrega um evento que não altera nada visível
 * (eco de patch local, assignee repetido). Ordem não é responsabilidade daqui: os
 * consumidores ordenam via memo.
 *
 * Duas garantias valem para todo reducer que escreve o estado:
 *  - nada fora do escopo ENTRA (um evento, fetch ou refetch de outra linha não
 *    contamina a lista). Quem faz o que já estava dentro SAIR é o `reconcileFetched`
 *    (varre o local contra o escopo) e, conversa a conversa, o evento ou refetch que a
 *    leva para fora (`applyConversationEvent`, `mergeRefreshedRow`); os reducers de
 *    co-responsável só mexem no que já está na lista, sem varrer o escopo;
 *  - um id aparece no máximo uma vez. O Virtuoso usa o id como key, e uma conversa
 *    que mudou de número (`instagram_configurar_conexao` move conversas) pode
 *    chegar pelos fetches de DUAS linhas.
 */

import type { Conversation } from "@/types/conversation";
import { type ConversationRow, previewFromRow, rowToConversation } from "./conversationRealtime";

export interface ReconcileOptions {
  /**
   * A linha que este fetch cobre por INTEIRO: ele só é autoridade sobre as conversas dela.
   * Só decide com `complete: true`. A revalidação incremental junta várias linhas numa
   * resposta que nunca tira nada, e por isso a omite.
   */
  numeroId?: string;
  /** As linhas da tela agora. Conversa local de fora dele sai do estado. */
  escopo: ReadonlySet<string>;
  /**
   * Marca d'água de quando o fetch começou — separa insert local de linha apagada.
   * É o `last_message_at` mais novo da página 1 (ou a hora do cliente, se a linha
   * veio vazia): mesma unidade de `Date.parse(last_message_at)`.
   */
  startedAt: number;
  /**
   * false = este fetch não traz a linha inteira (faltam páginas, ou é a revalidação
   * incremental, que só traz o que mudou): o que não veio pode existir.
   */
  complete: boolean;
  /**
   * Ids tocados (realtime/otimista) depois que o fetch começou. No EMPATE de
   * last_message_at a versão local deles vence: fechar/assumir/co-responsável
   * não mexem no timestamp, e sem isto o snapshot da página os reverteria.
   * Sem a marca, empate = versão do fetch (cache SWR velho deve perder).
   */
  touched?: ReadonlySet<string>;
  /**
   * Ids que o realtime TIROU da lista (DELETE, ou UPDATE que levou a conversa para um
   * número fora do escopo) depois que o fetch começou. O servidor pode ter lido a página
   * antes disso e ainda trazê-los: sem a marca o commit os ressuscitava, e o incremental
   * (que nunca remove) os deixava ali até o completo periódico. Só barra o que SÓ veio no
   * fetch — conversa que ainda está em memória é decidida pela versão local, como sempre.
   * Não dá para reaproveitar `touched`: ele marca também ids que nem estão em memória
   * (DELETE de co-responsável) e serve a outro fim, o desempate.
   */
  removidos?: ReadonlySet<string>;
}

export type ConversationEvent =
  | { type: "upsert"; row: ConversationRow }
  | { type: "delete"; id: string };

export interface ConversationEventContext {
  /** Linhas da tela agora; vazio = nenhuma selecionada. */
  numeros: ReadonlySet<string>;
  memberProfiles: ReadonlyMap<string, Conversation["profiles"]>;
}

export interface AssigneeEvent {
  type: "add" | "remove";
  conversationId: string;
  userId: string;
}

/** Mesmos ids, em qualquer ordem. */
const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

const sameOrder = (a: readonly Conversation[], b: readonly Conversation[]): boolean =>
  a.length === b.length && a.every((row, i) => row === b[i]);

const sameStrings = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((value, i) => value === b[i]));

/**
 * Igualdade rasa por chave; `undefined` e chave ausente contam como iguais
 * porque a Conversation vinda do select e a montada pelo realtime diferem só
 * nisso.
 */
const shallowEqual = (a: Conversation, b: Conversation): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Conversation)[]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
};

/**
 * Mesmo valor de um campo, do jeito que o reconcile compara. `profiles` vale pelo nome e
 * pelo e-mail (null e ausente são iguais); `co_assignee_ids` pelo conjunto, porque o embed
 * não tem ORDER BY. O resto é `===`: o que não bater cai na versão do fetch, como sempre.
 */
const mesmoCampo = (chave: string, a: unknown, b: unknown): boolean => {
  if (chave === "profiles") {
    const pa = a as Conversation["profiles"];
    const pb = b as Conversation["profiles"];
    if (!pa || !pb) return !pa && !pb;
    return (
      (pa.first_name ?? null) === (pb.first_name ?? null) &&
      (pa.last_name ?? null) === (pb.last_name ?? null) &&
      (pa.email ?? null) === (pb.email ?? null)
    );
  }
  if (chave === "co_assignee_ids" && Array.isArray(a) && Array.isArray(b)) return sameIds(a, b);
  return a === b;
};

/**
 * Mesmo conteúdo, campo a campo. Um fetch sem nada novo devolve objetos NOVOS com os mesmos
 * valores: sem isto o reconcile trocaria a referência de cada linha, e a lista inteira
 * (filtro, ordem, espelho no cache) seria refeita a cada poll. Chave ausente conta como
 * `undefined`.
 */
const mesmoConteudo = (a: Conversation, b: Conversation): boolean => {
  for (const chave of Object.keys(a) as Array<keyof Conversation>) {
    if (!mesmoCampo(chave, a[chave], b[chave])) return false;
  }
  for (const chave of Object.keys(b) as Array<keyof Conversation>) {
    if (!(chave in a) && b[chave] !== undefined) return false;
  }
  return true;
};

/**
 * Casa o estado local com o resultado de um fetch: o completo de UMA linha
 * (`opts.numeroId`) ou o incremental, que vem sem ela (`complete: false`).
 *
 * - Local fora do escopo: sai (troca de números, cache velho).
 * - Id presente nos dois, seja qual for a linha local: vence a versão com
 *   `last_message_at` mais novo (um patch local aplicado durante o fetch é mais
 *   novo que o snapshot); empate → fetched, que traz profiles/co_assignee_ids do
 *   embed, salvo se o id foi tocado durante o fetch. Casar por id (e não por
 *   linha) é o que impede a conversa movida de A para B de aparecer duas vezes.
 *   Com o mesmo conteúdo, fica a referência local (`mesmoConteudo`).
 * - Só local, de OUTRA linha do escopo: fica como está. O fetch dela é que decide.
 * - Só local, da linha do fetch: sobrevive se o fetch foi parcial OU se nasceu
 *   depois do início do fetch (insert por realtime). Caso contrário foi apagada
 *   no servidor.
 * - Só no fetch: entra no fim, salvo se o realtime a tirou da lista depois do início
 *   do fetch (`opts.removidos`).
 *
 * No fim cada id sai uma única vez, mesmo que `prev` já viesse com repetição.
 */
export function reconcileFetched(
  prev: Conversation[],
  fetched: Map<string, Conversation>,
  opts: ReconcileOptions,
): Conversation[] {
  const next: Conversation[] = [];
  const seen = new Set<string>();
  const emitted = new Set<string>();

  // Único caminho para `next`: garante escopo e unicidade de uma vez.
  const emit = (row: Conversation) => {
    const line = row.phone_number_id;
    if (!line || !opts.escopo.has(line) || emitted.has(row.id)) return;
    emitted.add(row.id);
    next.push(row);
  };

  for (const local of prev) {
    if (!local.phone_number_id || !opts.escopo.has(local.phone_number_id)) continue;

    const remote = fetched.get(local.id);
    if (remote) {
      seen.add(local.id);
      const localTs = Date.parse(local.last_message_at);
      const remoteTs = Date.parse(remote.last_message_at);
      const keepLocal = localTs > remoteTs || (localTs === remoteTs && opts.touched?.has(local.id) === true);
      const igual = keepLocal || mesmoConteudo(local, remote);
      emit(igual ? local : remote);
      continue;
    }

    if (local.phone_number_id !== opts.numeroId) {
      emit(local);
      continue;
    }
    if (!opts.complete || Date.parse(local.last_message_at) > opts.startedAt) emit(local);
  }

  for (const remote of fetched.values()) {
    if (!seen.has(remote.id) && !opts.removidos?.has(remote.id)) emit(remote);
  }

  return sameOrder(prev, next) ? prev : next;
}

const removeById = (prev: Conversation[], id: string): Conversation[] => {
  const next = prev.filter((row) => row.id !== id);
  return next.length === prev.length ? prev : next;
};

/** A linha entra na lista da tela? Sem número, ou com um número fora do escopo, não. */
export const linhaNoEscopo = (phoneNumberId: string | null, numeros: ReadonlySet<string>): boolean =>
  !!phoneNumberId && numeros.has(phoneNumberId);

/** Aplica um postgres_changes de `conversations`. */
export function applyConversationEvent(
  prev: Conversation[],
  ev: ConversationEvent,
  ctx: ConversationEventContext,
): Conversation[] {
  if (ev.type === "delete") return removeById(prev, ev.id);

  const { row } = ev;
  // Fora das linhas da tela (ou sem nenhuma): se já estava aqui, mudou de linha
  // (merge de números) e sai; senão não há nada a fazer.
  if (!linhaNoEscopo(row.phone_number_id, ctx.numeros)) return removeById(prev, row.id);

  const index = prev.findIndex((c) => c.id === row.id);
  if (index === -1) {
    const profiles = row.assigned_to ? (ctx.memberProfiles.get(row.assigned_to) ?? null) : null;
    return [rowToConversation(row, profiles, []), ...prev];
  }

  const existing = prev[index];
  const next: Conversation = {
    ...existing,
    id: row.id,
    contact_name: row.contact_name ?? "",
    contact_phone: row.contact_phone ?? "",
    last_message_at: row.last_message_at,
    status: row.status ?? "",
    phone_number_id: row.phone_number_id,
    sector_id: row.sector_id,
    assigned_to: row.assigned_to,
    is_group: row.is_group ?? false,
    contact_avatar_url: row.contact_avatar_url,
    // O embed de profiles não vem no realtime: só troca quando o dono mudou.
    profiles:
      row.assigned_to === existing.assigned_to
        ? existing.profiles
        : row.assigned_to
          ? (ctx.memberProfiles.get(row.assigned_to) ?? null)
          : null,
  };
  if (row.contact_avatar_updated_at !== undefined) {
    next.contact_avatar_updated_at = row.contact_avatar_updated_at;
  }
  // A marca de Disparos é o que move a conversa entre as abas: o gatilho a
  // limpa quando o contato responde e o UPDATE chega por aqui. Ausente = canal
  // assinado antes da migração; mantém o que a lista já tinha.
  if (row.disparo_desde !== undefined) next.disparo_desde = row.disparo_desde;
  if (row.disparo_rotulo !== undefined) next.disparo_rotulo = row.disparo_rotulo;
  if (row.disparo_status !== undefined) next.disparo_status = row.disparo_status;
  // Mesma ideia para Com a IA: o gatilho tira a marca quando a IA passa a conversa.
  if (row.ia_desde !== undefined) next.ia_desde = row.ia_desde;
  if (row.ia_origem !== undefined) next.ia_origem = row.ia_origem;
  if (row.ia_sem_resposta_desde !== undefined) next.ia_sem_resposta_desde = row.ia_sem_resposta_desde;
  // Array novo a cada evento: com o mesmo conteúdo, fica a referência antiga
  // para o eco não re-renderizar a linha.
  if (row.disparo_campanhas !== undefined && !sameStrings(existing.disparo_campanhas, row.disparo_campanhas)) {
    next.disparo_campanhas = row.disparo_campanhas;
  }
  // Row sem `last_message_direction` = canal assinado antes da migração das
  // colunas desnormalizadas: mantém a prévia que a lista já tinha.
  if (row.last_message_direction !== undefined) {
    Object.assign(next, previewFromRow(row));
  }

  if (shallowEqual(existing, next)) return prev;
  const out = prev.slice();
  out[index] = next;
  return out;
}

/** Patch de `co_assignee_ids` (semântica de Set) por evento de `conversation_assignees`. */
export function applyAssigneeEvent(prev: Conversation[], ev: AssigneeEvent): Conversation[] {
  const index = prev.findIndex((c) => c.id === ev.conversationId);
  if (index === -1) return prev;

  const existing = prev[index];
  const current = existing.co_assignee_ids ?? [];
  const has = current.includes(ev.userId);
  if (ev.type === "add" ? has : !has) return prev;

  const co_assignee_ids =
    ev.type === "add" ? [...current, ev.userId] : current.filter((id) => id !== ev.userId);
  const out = prev.slice();
  out[index] = { ...existing, co_assignee_ids };
  return out;
}

/**
 * Refaz `co_assignee_ids` das conversas do escopo a partir de um retrato dos
 * co-responsáveis (conversa → user ids), lido numa consulta só.
 *
 * Existe porque `conversation_assignees` não move `conversations.updated_at`: a
 * revalidação incremental, que busca por `updated_at`, nunca vê um co-responsável que
 * entrou ou saiu. O retrato cobre as duas pontas — conversa que ele não cita fica sem
 * co-responsável.
 *
 * `ignorar`: ids que o realtime tocou depois que a consulta saiu. O retrato é mais velho
 * que o patch deles e os desfaria. Conversa de fora do escopo nunca é mexida.
 */
export function applyAssigneeSnapshot(
  prev: Conversation[],
  snapshot: ReadonlyMap<string, readonly string[]>,
  opts: { escopo: ReadonlySet<string>; ignorar?: ReadonlySet<string> },
): Conversation[] {
  let changed = false;
  const next = prev.map((conv) => {
    if (!conv.phone_number_id || !opts.escopo.has(conv.phone_number_id) || opts.ignorar?.has(conv.id)) return conv;
    const fresh = snapshot.get(conv.id) ?? [];
    if (sameIds(fresh, conv.co_assignee_ids ?? [])) return conv;
    changed = true;
    return { ...conv, co_assignee_ids: [...fresh] };
  });
  return changed ? next : prev;
}

/**
 * Substitui uma conversa pela versão refetchada com embed (profiles,
 * co_assignee_ids). `null` = o select não devolveu nada: saiu do escopo da RLS
 * (ex.: mudou de setor isolado) e some da lista.
 */
export function mergeRefreshedRow(
  prev: Conversation[],
  id: string,
  row: Conversation | null,
  numeros: ReadonlySet<string>,
): Conversation[] {
  if (row === null || !row.phone_number_id || !numeros.has(row.phone_number_id)) return removeById(prev, id);

  const index = prev.findIndex((c) => c.id === id);
  if (index === -1) return [row, ...prev];
  const out = prev.slice();
  out[index] = row;
  return out;
}
