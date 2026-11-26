/**
 * Nome exibível de um participante de grupo — implementação ÚNICA.
 *
 * Antes essa cadeia estava escrita em 6 lugares com 6 ordens e 6 rabos
 * diferentes (painel do grupo, menção, pílula de group_action, indicador de
 * digitando, chip de busca) e um sexto lugar — o cabeçalho da bolha — não tinha
 * cadeia nenhuma: renderia `sender_name` cru e, sem ele, NADA.
 */

import { formatParticipantPhone } from "@/lib/phone";

export type ParticipantNameOrigin = "alias" | "pushName" | "contact" | "phone";

export interface ParticipantNameSources {
  /** group_participant_aliases.alias — apelido manual, definido no painel. */
  alias?: string | null;
  /** pushName: messages.sender_name ou o nome que o qr-service resolveu. */
  pushName?: string | null;
  /** contact_name da conversa 1:1 existente (já sem nome que é só telefone). */
  contactName?: string | null;
}

export interface ResolvedParticipantName {
  /** Nunca vazio: cai no telefone formatado / "ID: 1234...5678". */
  name: string;
  origin: ParticipantNameOrigin;
}

/**
 * ORDEM ÚNICA DE PRIORIDADE — é a única linha a mexer para trocar a política.
 *   alias > pushName > contato 1:1 > telefone   (atual: conservadora, a camada
 *     de contato 1:1 só preenche o vazio e nenhum nome já exibido muda)
 *   alias > contato 1:1 > pushName > telefone   → ["alias","contactName","pushName"]
 */
const PRIORITY = ["alias", "pushName", "contactName"] as const satisfies readonly (keyof ParticipantNameSources)[];

const ORIGIN_BY_SOURCE: Record<keyof ParticipantNameSources, ParticipantNameOrigin> = {
  alias: "alias",
  pushName: "pushName",
  contactName: "contact",
};

/**
 * `origin` é a parte que carrega peso: dirige o indicador "veio de uma conversa
 * 1:1" no painel e transforma "caímos no telefone?" em valor, não em suposição.
 */
export function resolveParticipantName(
  sources: ParticipantNameSources,
  phone: string,
  isLid?: boolean,
): ResolvedParticipantName {
  for (const key of PRIORITY) {
    const value = sources[key]?.trim();
    if (value) return { name: value, origin: ORIGIN_BY_SOURCE[key] };
  }
  return { name: formatParticipantPhone(phone, isLid), origin: "phone" };
}

/** Sufixos de JID que o WhatsApp usa; o "bare" é o que serve de chave. */
export function bareJid(jid?: string | null): string | undefined {
  if (!jid) return undefined;
  const bare = jid.split("@")[0];
  return bare || undefined;
}

/**
 * Telefone de uma mensagem de grupo que pode ser usado para buscar contato —
 * ou undefined quando o valor gravado NÃO é telefone.
 *
 * O caminho de entrada do qr-service faz `senderPhone = altPhone ||
 * lidPhoneCache.get(lidId) || lidId`, então `sender_phone` às vezes É o LID cru.
 * Buscar contato com ele produziria vínculo falso.
 */
export function trustedSenderPhone(message: {
  sender_phone?: string | null;
  sender_jid?: string | null;
}): string | undefined {
  const phone = message.sender_phone?.trim();
  if (!phone || !/^\d+$/.test(phone)) return undefined;

  const jid = message.sender_jid;
  if (!jid) {
    // Linha legada (anterior à coluna sender_jid): só o comprimento distingue,
    // e LID tem ~15 dígitos. E.164 vai até 15, então o corte em 14 é conservador
    // — perde-se um número internacional longo, nunca se inventa um vínculo.
    return phone.length >= 10 && phone.length <= 14 ? phone : undefined;
  }

  if (jid.endsWith("@lid")) {
    // Telefone igual ao bare do @lid = o LID não foi resolvido.
    return phone === bareJid(jid) ? undefined : phone;
  }

  return phone;
}

/** Participante cru vindo do qr-service, na forma mínima que o merge consome. */
export interface DisplayMapParticipant {
  id: string;
  jid?: string | null;
  phone: string;
  /** Nome que o próprio qr-service resolveu (cache de LID / username). */
  name?: string | null;
  /** true = telefone NÃO resolvido (o valor em `phone` é o LID cru). */
  isLid?: boolean;
}

export interface ParticipantDisplay extends ResolvedParticipantName {
  /** Conversa 1:1 existente daquele participante, quando houver vínculo. */
  conversationId?: string;
  avatarUrl?: string | null;
  /** A conversa 1:1 está no MESMO número conectado que o grupo. */
  sameConnection?: boolean;
}

export interface BuildParticipantDisplayMapArgs {
  participants: DisplayMapParticipant[];
  /** Apelidos manuais, chaveados pelo bare do participant_jid. */
  aliases: Record<string, string>;
  /** pushNames vindos de messages.sender_name, chaveados por telefone/bare. */
  pushNames: Record<string, string>;
  /** Contatos 1:1 resolvidos, chaveados pelo telefone CONSULTADO. */
  contacts: Record<
    string,
    { conversationId: string; name?: string; avatarUrl: string | null; sameConnection: boolean }
  >;
}

/**
 * Monta o mapa de exibição a partir das quatro fontes.
 *
 * Cada identidade é gravada sob TODOS os seus apelidos de chave (telefone, bare
 * do jid, bare do id) — é isso que faz o lookup por `sender_phone`, por JID e
 * por dígitos de LID caírem todos na mesma entrada.
 *
 * Função pura, fora do React, para o ChatArea não crescer e o merge ser
 * testável sem montar componente.
 */
export function buildParticipantDisplayMap({
  participants,
  aliases,
  pushNames,
  contacts,
}: BuildParticipantDisplayMapArgs): Record<string, ParticipantDisplay> {
  const map: Record<string, ParticipantDisplay> = {};

  const write = (keys: (string | undefined)[], value: ParticipantDisplay) => {
    for (const key of keys) {
      if (key) map[key] = value;
    }
  };

  for (const p of participants) {
    const jidBare = bareJid(p.jid);
    const idBare = bareJid(p.id);
    const keys = [p.phone, jidBare, idBare];

    // O nome que o qr-service resolveu é FONTE DE pushName, nunca camada
    // separada — foi por tratá-lo como camada que um rebuild do lookup apagava
    // menções já renderizadas, voltando a número cru.
    const pushName =
      keys.map((k) => (k ? pushNames[k] : undefined)).find(Boolean) ?? p.name ?? undefined;
    const alias = keys.map((k) => (k ? aliases[k] : undefined)).find(Boolean);
    const contact = p.isLid ? undefined : contacts[p.phone];

    const resolved = resolveParticipantName(
      { alias, pushName, contactName: contact?.name },
      p.phone,
      p.isLid,
    );

    write(keys, {
      ...resolved,
      conversationId: contact?.conversationId,
      avatarUrl: contact?.avatarUrl,
      sameConnection: contact?.sameConnection,
    });
  }

  // Quem falou no grupo mas não está na lista de participantes (saiu do grupo,
  // ou a lista do qr-service não carregou) ainda precisa de nome resolvido.
  const covered = new Set(Object.keys(map));
  const orphanKeys = new Set(
    [...Object.keys(pushNames), ...Object.keys(aliases), ...Object.keys(contacts)].filter(
      (k) => !covered.has(k),
    ),
  );

  for (const key of orphanKeys) {
    const contact = contacts[key];
    map[key] = {
      ...resolveParticipantName(
        { alias: aliases[key], pushName: pushNames[key], contactName: contact?.name },
        key,
      ),
      conversationId: contact?.conversationId,
      avatarUrl: contact?.avatarUrl,
      sameConnection: contact?.sameConnection,
    };
  }

  return map;
}
