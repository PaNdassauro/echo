import { bareJid } from "@/lib/participantDisplayName";
import { formatParticipantPhone } from "@/lib/phone";

export interface PollData {
  question: string;
  options: string[];
  /** 0 = múltiplas respostas; 1 = escolha única. */
  selectable_count: number;
  /** voter_jid → opções escolhidas ([] = voto retirado). */
  votes: Record<string, string[]>;
  /** voter_jid → nome (pushName; 'Você' para votos do painel/aparelho). */
  voter_names?: Record<string, string>;
}

export interface PollParticipantRef {
  /** Id sem sufixo (LID ou telefone): casa com o `bareJid` da chave do voto. */
  key: string;
  name: string;
  isSelf?: boolean;
}

export interface PollVoterRef {
  key: string;
  name: string;
}

export interface PollOptionResult {
  option: string;
  count: number;
  pct: number;
  voters: PollVoterRef[];
}

export interface PollSummary {
  totalVoters: number;
  /** Participantes do grupo sem a própria linha; null sem a lista carregada. */
  participantsTotal: number | null;
  /** Na ordem original de `poll.options`. */
  options: PollOptionResult[];
  /** Opção líder (maior contagem > 0; empate = a primeira na ordem original). */
  leader: string | null;
  /** null = lista de participantes indisponível. */
  nonVoters: PollParticipantRef[] | null;
}

/**
 * Nome de quem votou: lookup do grupo (apelido/contato) → nome congelado no
 * voto (inclui "Você") → telefone formatado, ou LID abreviado.
 */
export function pollVoterName(
  jid: string,
  poll: PollData,
  lookup?: Record<string, string>,
): string {
  const bare = bareJid(jid) ?? jid;
  const fromLookup = lookup?.[bare];
  if (fromLookup) return fromLookup;
  const frozen = poll.voter_names?.[jid];
  if (frozen) return frozen;
  return formatParticipantPhone(bare, jid.endsWith("@lid"));
}

export function summarizePoll(
  poll: PollData,
  participants: PollParticipantRef[] | undefined,
  lookup?: Record<string, string>,
): PollSummary {
  const voteEntries = Object.entries(poll.votes).filter(([, selected]) => selected.length > 0);
  const totalVoters = voteEntries.length;

  const options = poll.options.map<PollOptionResult>((option) => {
    const voters = voteEntries
      .filter(([, selected]) => selected.includes(option))
      .map(([jid]) => ({ key: bareJid(jid) ?? jid, name: pollVoterName(jid, poll, lookup) }));
    const count = voters.length;
    return {
      option,
      count,
      pct: totalVoters > 0 ? Math.round((count / totalVoters) * 100) : 0,
      voters,
    };
  });

  let leader: PollOptionResult | null = null;
  for (const result of options) {
    if (result.count > 0 && (!leader || result.count > leader.count)) leader = result;
  }

  let nonVoters: PollParticipantRef[] | null = null;
  let participantsTotal: number | null = null;
  if (participants) {
    const others = participants.filter((p) => !p.isSelf);
    const voted = new Set(voteEntries.map(([jid]) => bareJid(jid) ?? jid));
    nonVoters = others.filter((p) => !voted.has(p.key));
    participantsTotal = others.length;
  }

  return { totalVoters, participantsTotal, options, leader: leader?.option ?? null, nonVoters };
}
