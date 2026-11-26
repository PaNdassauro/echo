/**
 * Quem é a própria linha dentro de um grupo, e se ela pode adicionar participantes.
 *
 * Existe por causa do `<stream:error code="401"><conflict/>`: `groupParticipantsUpdate add`
 * feito por quem não é admin é o que o anti-abuso do WhatsApp pune derrubando a sessão —
 * e ela não volta sozinha. A exceção é o grupo
 * em que os admins liberaram "todos adicionam" (`memberAddMode = all_member_add`): ali o
 * WhatsApp aceita o add de membro comum, como no aparelho. A decisão
 * fica aqui, pura, para o SessionManager só aplicar e o teste cobrir os casos sem subir sessão.
 *
 * Par no front: `src/lib/groupSelfRole.ts`, na raiz deste repositório (lê o `me` que o serviço devolve e,
 * sem ele, acha a linha pelo telefone). Mudou a regra aqui, mudar lá.
 */
import { normalizeJidUser } from './jid.js';
import type { GroupInfo, GroupParticipant, GroupRole, OwnIdentity } from '../adapter/types.js';

export interface GroupAddBlock {
    /** `not_group_admin` cobre também "não achei a própria linha": sem certeza, não adiciona. */
    code: 'not_group_admin' | 'group_restricted';
    reason: 'not_admin' | 'self_not_found' | 'suspended' | 'growth_locked';
    /** Mensagem pronta para o usuário (o front mostra como veio). */
    error: string;
}

const keysOf = (...jids: Array<string | null | undefined>): string[] =>
    jids.map((jid) => normalizeJidUser(jid)).filter((key) => key !== '');

/**
 * Chaves pelas quais a própria sessão pode aparecer na lista de participantes: o JID de
 * telefone, o LID (grupo endereçado por LID) e o telefone cru das credenciais.
 */
export function ownIdentityKeys(me: OwnIdentity | null | undefined): string[] {
    if (!me) return [];
    const phoneJid = me.phone && /^\d+$/.test(me.phone) ? `${me.phone}@s.whatsapp.net` : undefined;
    return [...new Set(keysOf(me.jid, me.lid, phoneJid))];
}

export function findSelfParticipant(
    participants: readonly GroupParticipant[],
    me: OwnIdentity | null | undefined
): GroupParticipant | undefined {
    const own = new Set(ownIdentityKeys(me));
    if (own.size === 0) return undefined;
    return participants.find((p) => keysOf(p.jid, p.phoneJid, p.lid).some((key) => own.has(key)));
}

export const isGroupAdminRole = (role: GroupRole): boolean => role === 'admin' || role === 'superadmin';

/**
 * `null` = pode adicionar. Senão, por que não — já com o código HTTP implícito (403) e a
 * frase para o usuário. Admin sempre pode; membro comum só no grupo "todos adicionam".
 * A linha precisa estar na lista: sem certeza de quem ela é, não adiciona.
 */
export function checkCanAddParticipants(
    meta: Pick<GroupInfo, 'participants' | 'suspended' | 'growthLockedUntil'> & Partial<Pick<GroupInfo, 'memberAddMode'>>,
    me: OwnIdentity | null | undefined,
    now: number = Date.now()
): GroupAddBlock | null {
    if (meta.suspended) {
        return {
            code: 'group_restricted',
            reason: 'suspended',
            error: 'Grupo suspenso pelo WhatsApp: não dá para adicionar participantes.',
        };
    }
    if ((meta.growthLockedUntil ?? 0) > now) {
        return {
            code: 'group_restricted',
            reason: 'growth_locked',
            error: 'O WhatsApp travou a entrada de participantes neste grupo.',
        };
    }
    const self = findSelfParticipant(meta.participants, me);
    if (!self) {
        return {
            code: 'not_group_admin',
            reason: 'self_not_found',
            error: 'Não foi possível confirmar se este número é admin do grupo.',
        };
    }
    if (!isGroupAdminRole(self.role) && meta.memberAddMode !== 'all_member_add') {
        return {
            code: 'not_group_admin',
            reason: 'not_admin',
            error: 'Só admins adicionam participantes neste grupo, e este número não é admin.',
        };
    }
    return null;
}
