/**
 * zapo → modelo normalizado. O corpo (`event.message`) é o proto do WhatsApp e passa
 * pelo normalizador compartilhado; aqui ficam chave, remetente, grupos e quedas.
 */
import type {
    WaConnectionEvent,
    WaGroupMetadata,
    WaGroupParticipant,
    WaIncomingMessageEvent,
    WaIncomingMessageKey,
} from 'zapo-js';
import type { DisconnectCause, GroupInfo, GroupParticipant, GroupRole, InboundMessage, MessageContent, MessageKey } from '../types.js';
import {
    describeMessageShape,
    extractCtwaReferral,
    findContextInfo,
    isViewOnceMessage,
    messageSecretOf,
    normalizeContent,
    placeholderMediaKind,
    unwrapMessage,
} from '../proto/content.js';
import type { ProtoMessage } from '../proto/types.js';

export function keyOf(key: WaIncomingMessageKey | { remoteJid: string; id: string; fromMe: boolean; participant?: string }): MessageKey {
    return { id: key.id, chatJid: key.remoteJid, fromMe: key.fromMe, participantJid: key.participant ?? undefined };
}

export function normalizeZapoMessage(event: WaIncomingMessageEvent, overrideContent?: MessageContent): InboundMessage {
    const key = event.key;
    const chatJid = key.remoteJid;
    const isGroup = key.isGroup || chatJid.endsWith('@g.us');
    const isBroadcast = key.isBroadcast || key.isNewsletter || chatJid.endsWith('@broadcast');
    const senderJid = isGroup ? (key.participant ?? '') : (key.fromMe ? '' : chatJid);
    const alt = isGroup ? key.participantAlt : key.remoteJidAlt;
    const senderPn = alt?.endsWith('@s.whatsapp.net') ? alt : (senderJid.endsWith('@s.whatsapp.net') ? senderJid : undefined);
    const senderLid = senderJid.endsWith('@lid') ? senderJid : (alt?.endsWith('@lid') ? alt : undefined);
    const message = event.message as ProtoMessage | undefined;
    // message_unavailable(view_once) chega sem corpo: o view-once vem do tipo do evento
    // (o Baileys lia key.isViewOnce). Sem isso a bolha perdia metadata.view_once.
    const viewOnce = isViewOnceMessage(message) || overrideContent?.type === 'view_once_placeholder';

    let content: MessageContent;
    if (overrideContent) {
        content = overrideContent;
    } else if (!message) {
        content = { type: 'undecryptable', stub: 'none' };
    } else {
        content = normalizeContent(message, chatJid);
        if (viewOnce && content.type === 'unsupported') {
            content = { type: 'view_once_placeholder', mediaKind: placeholderMediaKind(message) };
        }
    }
    const ctx = findContextInfo(unwrapMessage(message));
    return {
        key: keyOf(key),
        timestamp: event.timestampSeconds ? event.timestampSeconds * 1000 : Date.now(),
        senderJid,
        senderPn,
        senderLid,
        chatAltJid: key.remoteJidAlt ?? undefined,
        pushName: event.pushName ?? undefined,
        messageSecret: messageSecretOf(message),
        shape: describeMessageShape(message),
        isGroup,
        isBroadcast,
        content,
        quoted: ctx?.stanzaId ? {
            key: { id: ctx.stanzaId, chatJid: ctx.remoteJid ?? chatJid, fromMe: false, participantJid: ctx.participant ?? undefined },
            content: ctx.quotedMessage ? normalizeContent(ctx.quotedMessage, chatJid) : undefined,
        } : undefined,
        mentionedJids: ctx?.mentionedJid ?? [],
        isForwarded: (ctx?.forwardingScore ?? 0) > 0 || ctx?.isForwarded === true,
        forwardingScore: ctx?.forwardingScore ?? 0,
        isEphemeral: !!message?.ephemeralMessage || (ctx?.expiration ?? 0) > 0 || (event.expirationSeconds ?? 0) > 0,
        isViewOnce: viewOnce,
        referral: extractCtwaReferral(ctx),
        raw: event,
    };
}

function role(p: WaGroupParticipant): GroupRole {
    if (p.isSuperAdmin) return 'superadmin';
    if (p.isAdmin) return 'admin';
    return null;
}

export function normalizeZapoParticipant(p: WaGroupParticipant): GroupParticipant {
    return {
        jid: p.jid,
        phoneJid: p.phoneNumber ?? (p.jid.endsWith('@s.whatsapp.net') ? p.jid : undefined),
        lid: p.lid ?? (p.jid.endsWith('@lid') ? p.jid : undefined),
        name: p.displayName ?? p.username ?? undefined,
        role: role(p),
    };
}

export function normalizeZapoGroup(meta: WaGroupMetadata & { participants?: readonly WaGroupParticipant[]; memberAddMode?: string; inviteCode?: string; isCommunity?: boolean; isCommunityAnnounce?: boolean }): GroupInfo {
    return {
        jid: meta.jid,
        subject: meta.subject,
        subjectOwner: meta.subjectOwner,
        subjectTime: meta.subjectTime,
        description: meta.desc,
        ownerJid: meta.owner,
        creation: meta.creation,
        participants: (meta.participants ?? []).map(normalizeZapoParticipant),
        size: meta.size,
        announce: meta.announce,
        restrict: meta.restrict,
        joinApprovalMode: meta.membershipApprovalEnabled,
        memberAddMode: meta.memberAddMode === 'all_member_add' ? 'all_member_add' : 'admin_add',
        ephemeralDuration: meta.ephemeral,
        isCommunity: meta.isParentGroup,
        isCommunityAnnounce: meta.defaultSubgroup,
        linkedParentJid: meta.linkedParentJid,
        inviteCode: meta.inviteCode,
        addressingMode: meta.addressingMode,
        suspended: meta.suspended === true ? true : undefined,
        appealStatus: meta.appealStatus,
        // O servidor manda epoch em segundos; 0/ausente = sem trava.
        growthLockedUntil: meta.growthLockedExpiration ? meta.growthLockedExpiration * 1000 : undefined,
    };
}

/** Motivo de queda da zapo → causa do contrato (+ código numérico legado para os logs). */
export function normalizeZapoDisconnect(event: Extract<WaConnectionEvent, { status: 'close' }>): { cause: DisconnectCause; statusCode?: number } {
    const r = String(event.reason);
    if (r === 'client_disconnected') return { cause: 'closed_by_us' };
    if (r === 'stream_error_replaced') return { cause: 'connection_replaced', statusCode: 440 };
    if (r === 'stream_error_device_removed' || r === 'stream_error_force_logout' || r === 'failure_not_authorized' || event.isLogout) {
        return { cause: 'logged_out', statusCode: 401 };
    }
    if (r === 'failure_banned' || r === 'failure_locked') return { cause: 'forbidden', statusCode: 403 };
    if (r === 'stream_error_force_login' || r === 'failure_client_too_old' || r === 'failure_bad_user_agent') return { cause: 'restart_required', statusCode: 515 };
    if (r === 'failure_service_unavailable') return { cause: 'unavailable_service', statusCode: 503 };
    if (r === 'comms_stopped' || r === 'stream_error_ack' || r === 'stream_error_other' || r === 'stream_error_xml_not_well_formed') {
        return { cause: 'connection_lost', statusCode: 408 };
    }
    if (r === 'primary_identity_key_change') return { cause: 'bad_session', statusCode: 500 };
    return { cause: 'unknown' };
}
