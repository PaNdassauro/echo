import { createHash } from 'crypto';

/**
 * Evento "nome do grupo mudou" que vai ao Echo (`/qr-group-event`, action `subject`). A edge
 * atualiza `conversations.group_subject` com o `group_subject` do corpo ANTES de gravar a
 * mensagem de sistema, então o nome anda mesmo quando o evento é duplicata.
 *
 * O id junta grupo + nome + dia: a troca feita pelo próprio Echo é avisada na hora
 * (`updateGroupSubject`) e o aviso do WhatsApp pode chegar depois para a mesma sessão; os dois
 * caem no mesmo id e o segundo vira duplicata silenciosa na edge.
 */
export interface GroupSubjectEventInput {
    groupJid: string;
    subject: string;
    actorName?: string;
    actorPhone?: string;
    /** Unix segundos. */
    timestamp: number;
}

export function groupSubjectEvent(input: GroupSubjectEventInput): { eventId: string; content: string } | null {
    const subject = input.subject.trim();
    const bareGroup = input.groupJid.split('@')[0];
    if (!subject || !bareGroup || !input.groupJid.endsWith('@g.us')) return null;

    const hash = createHash('sha1').update(subject).digest('hex').slice(0, 12);
    const day = Math.floor(input.timestamp / 86_400);
    const actor = input.actorName?.trim() || input.actorPhone?.trim();
    const content = actor
        ? `${actor} mudou o nome do grupo para "${subject}"`
        : `O nome do grupo mudou para "${subject}"`;
    return { eventId: `grpevt_${bareGroup}_subject_${hash}_${day}`, content };
}
