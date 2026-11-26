import { getLookupVariations } from "@/lib/phone";

/**
 * A linha pode adicionar participante neste grupo?
 *
 * Adicionar em grupo sem permissão é o que o anti-abuso do WhatsApp pune com
 * `401 <conflict>`: a sessão cai e não volta sozinha. Por
 * isso o botão "Adicionar" do painel só aparece com certeza positiva de que a
 * linha é admin, ou membro de grupo em que os admins liberaram "todos
 * adicionam", e de que o grupo não está restrito. Sem certeza =
 * bloqueado.
 *
 * Par no serviço: `qr-service/src/lib/groupSelf.ts` (`checkCanAddParticipants`),
 * que recusa com 403 antes de falar com o WhatsApp. Mudou a regra lá, mudar aqui.
 *
 * Duas fontes, nesta ordem:
 * 1. `group.me`, que o qr-service devolve desde a 2.5.6 (acha a própria linha
 *    por JID, LID ou telefone das credenciais — cobre grupo endereçado por LID).
 * 2. Serviço antigo (sem `me`): a própria linha é procurada pelo telefone entre
 *    os participantes com telefone resolvido, com a tolerância ao 9º dígito de
 *    `getLookupVariations`. Participante `isLid` não resolvido não entra.
 */

export type GroupAddBlockReason = "not_admin" | "restricted" | "unknown";

export interface GroupAddPermission {
  allowed: boolean;
  /** null quando `allowed`. */
  reason: GroupAddBlockReason | null;
}

export interface GroupSelfSource {
  /** Desde o qr-service 2.5.6. `null` = o serviço não achou a linha na lista. */
  me?: { isAdmin: boolean } | null;
  participants: Array<{ phone: string; isAdmin: boolean; isLid?: boolean }>;
  /** true = "todos adicionam" (`all_member_add`); o serviço manda boolean. */
  memberAddMode?: boolean;
  suspended?: boolean;
  /** ISO; o serviço só manda quando a trava ainda vale, mas conferimos o relógio mesmo assim. */
  growthLockedUntil?: string;
}

const BLOCK_LABELS: Record<GroupAddBlockReason, string> = {
  not_admin: "Só admins adicionam participantes",
  restricted: "Grupo restrito pelo WhatsApp",
  unknown: "Não dá para confirmar se este número é admin",
};

/** Frase curta para o lugar do botão "Adicionar". */
export const groupAddBlockLabel = (reason: GroupAddBlockReason): string => BLOCK_LABELS[reason];

const block = (reason: GroupAddBlockReason): GroupAddPermission => ({ allowed: false, reason });
const ALLOWED: GroupAddPermission = { allowed: true, reason: null };

const isGrowthLocked = (until: string | undefined, now: number): boolean => {
  if (!until) return false;
  const ts = Date.parse(until);
  return Number.isFinite(ts) && ts > now;
};

/** Acha a própria linha pelo telefone (serviço sem `me`). */
export const findSelfByPhone = <P extends { phone: string; isLid?: boolean }>(
  participants: P[],
  linePhoneDigits: string
): P | undefined => {
  const digits = linePhoneDigits.replace(/\D/g, "");
  if (!digits) return undefined;
  const own = new Set(getLookupVariations(digits));
  return participants.find((p) => {
    if (p.isLid) return false;
    const theirs = p.phone.replace(/\D/g, "");
    return theirs !== "" && getLookupVariations(theirs).some((key) => own.has(key));
  });
};

export type GroupSelfRole = "admin" | "member" | "unknown";

/** Papel da própria linha no grupo: `group.me` (2.5.6+) e, sem ele, o telefone da linha. */
export function resolveGroupSelfRole(
  group: Pick<GroupSelfSource, "me" | "participants">,
  linePhoneDigits: string | null | undefined
): GroupSelfRole {
  if (group.me !== undefined) {
    if (group.me === null) return "unknown";
    return group.me.isAdmin ? "admin" : "member";
  }
  const self = findSelfByPhone(group.participants, linePhoneDigits ?? "");
  if (!self) return "unknown";
  return self.isAdmin ? "admin" : "member";
}

export function resolveGroupAddPermission(
  group: GroupSelfSource,
  linePhoneDigits: string | null | undefined,
  now: number = Date.now()
): GroupAddPermission {
  if (group.suspended || isGrowthLocked(group.growthLockedUntil, now)) return block("restricted");

  const role = resolveGroupSelfRole(group, linePhoneDigits);
  if (role === "unknown") return block("unknown");
  return role === "admin" || group.memberAddMode === true ? ALLOWED : block("not_admin");
}

export interface GroupManagePermissions {
  /** Interruptores de configuração e revogar o link: só admin. */
  manageSettings: boolean;
  /** Tornar admin, remover admin e remover do grupo: só admin. */
  manageMembers: boolean;
  /** Nome, descrição, foto e mensagens temporárias: admin, ou todos com `restrict` desligado. */
  editInfo: boolean;
  /** Copiar o link de convite: admin, ou membro em grupo "todos adicionam" (medido). */
  shareInvite: boolean;
}

/**
 * O que o painel do grupo oferece além de adicionar.
 *
 * Ao contrário do adicionar, a dúvida LIBERA: fora o add, o WhatsApp só devolve
 * erro para quem não pode (sem derrubar a sessão), então esconder um controle
 * por falta de certeza custaria mais que o toast de erro. Só esconde com certeza
 * positiva de que a linha é membro comum.
 */
export function resolveGroupManagePermissions(
  group: Pick<GroupSelfSource, "me" | "participants" | "memberAddMode"> & { restrict?: boolean },
  linePhoneDigits: string | null | undefined
): GroupManagePermissions {
  const role = resolveGroupSelfRole(group, linePhoneDigits);
  const admin = role !== "member";
  return {
    manageSettings: admin,
    manageMembers: admin,
    editInfo: admin || group.restrict !== true,
    shareInvite: admin || group.memberAddMode === true,
  };
}

export type GroupSendBlockReason = "not_admin";

export interface GroupSendPermission {
  allowed: boolean;
  /** null quando `allowed`. */
  reason: GroupSendBlockReason | null;
}

export interface GroupSendSource {
  /** true = só admins enviam ("announcement" no WhatsApp). */
  announce?: boolean;
  /** Desde o qr-service 2.5.6. `null` = o serviço não achou a linha. `undefined` = serviço antigo. */
  me?: { isAdmin: boolean } | null;
  participants: Array<{ phone: string; isAdmin: boolean; isLid?: boolean }>;
}

const SEND_ALLOWED: GroupSendPermission = { allowed: true, reason: null };

/**
 * A linha pode enviar mensagem neste grupo?
 *
 * Grupo em modo "só administradores enviam" (`announce`) com a linha como membro
 * comum: o WhatsApp aceita a stanza e a descarta em silêncio, e a mensagem fica
 * com 1 check para sempre. O painel fecha a caixa de
 * mensagem, como o WhatsApp oficial.
 *
 * Ao contrário de `resolveGroupAddPermission` (que bloqueia na dúvida, porque
 * adicionar sem ser admin derruba a sessão), aqui a dúvida LIBERA: o custo de um
 * falso bloqueio é travar o atendimento. Só bloqueia com certeza positiva de que
 * a linha não é admin.
 *
 * NÃO há par no qr-service: o serviço deixa passar e o WhatsApp descarta. Se um
 * dia o serviço passar a recusar o envio (API, CRM, automação), a regra mora lá
 * também e este comentário deve apontar para o par.
 *
 * Mesmas fontes de `resolveGroupAddPermission`: `group.me` (2.5.6+) e, sem ele,
 * o telefone da linha entre os participantes.
 */
export function resolveGroupSendPermission(
  group: GroupSendSource,
  linePhoneDigits?: string | null
): GroupSendPermission {
  if (!group.announce) return SEND_ALLOWED;
  return resolveGroupSelfRole(group, linePhoneDigits) === "member"
    ? { allowed: false, reason: "not_admin" }
    : SEND_ALLOWED;
}
