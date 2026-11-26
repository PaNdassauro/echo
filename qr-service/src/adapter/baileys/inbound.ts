/**
 * Baileys → modelo normalizado. Nenhum `proto` sai daqui.
 */
import {
    DisconnectReason,
    proto,
    type GroupMetadata,
    type GroupParticipant,
    type WAMessage,
    type WAMessageKey,
} from '@whiskeysockets/baileys';
import type {
    ContactCard,
    DisconnectCause,
    GroupActor,
    GroupInfo,
    GroupParticipant as NormGroupParticipant,
    GroupRole,
    InboundMessage,
    LocationContent,
    MediaKind,
    MediaRef,
    MessageContent,
    MessageKey,
    MessageStatus,
    ProtocolKind,
    QuotedRef,
    CtwaReferral,
} from '../types.js';
import {
    describeMessageShape,
    isViewOnceMessage,
    messageSecretOf,
    normalizeContent,
    extractCtwaReferral,
    findContextInfo,
    placeholderMediaKind,
    unwrapMessage,
} from '../proto/content.js';
import { STUB_TYPE } from '../proto/types.js';

export function toMillis(value: number | { toString(): string } | null | undefined): number {
    if (value === null || value === undefined) return Date.now();
    const seconds = typeof value === 'number' ? value : Number(value.toString());
    return seconds > 1e12 ? seconds : seconds * 1000;
}

export function normalizeKey(key: WAMessageKey): MessageKey {
    return {
        id: key.id ?? '',
        chatJid: key.remoteJid ?? '',
        fromMe: key.fromMe === true,
        participantJid: key.participant ?? undefined,
    };
}

export function toBaileysKey(key: MessageKey): WAMessageKey {
    return {
        id: key.id,
        remoteJid: key.chatJid,
        fromMe: key.fromMe,
        participant: key.participantJid,
    };
}

type KeyWithAlt = WAMessageKey & { remoteJidAlt?: string | null; participantAlt?: string | null; senderPn?: string | null };

function isViewOnceKey(msg: WAMessage): boolean {
    return (msg.key as WAMessageKey & { isViewOnce?: boolean }).isViewOnce === true;
}

export function normalizeMessage(msg: WAMessage): InboundMessage {
    const key = msg.key as KeyWithAlt;
    const chatJid = key.remoteJid ?? '';
    const isGroup = chatJid.endsWith('@g.us');
    const isBroadcast = chatJid.endsWith('@broadcast') || chatJid.endsWith('@newsletter');
    const senderJid = isGroup ? (key.participant ?? '') : (key.fromMe ? '' : chatJid);
    const alt = isGroup ? key.participantAlt : key.remoteJidAlt;
    const senderPn = key.senderPn ?? (alt && alt.endsWith('@s.whatsapp.net') ? alt : undefined)
        ?? (senderJid.endsWith('@s.whatsapp.net') ? senderJid : undefined);
    const senderLid = senderJid.endsWith('@lid') ? senderJid : (alt && alt.endsWith('@lid') ? alt : undefined);

    let content: MessageContent;
    const viewOnce = isViewOnceMessage(msg.message) || isViewOnceKey(msg);
    if (!msg.message) {
        const stubType = msg.messageStubType ?? null;
        content = isViewOnceKey(msg)
            ? { type: 'view_once_placeholder' }
            : {
                type: 'undecryptable',
                stub: stubType === null ? 'none' : stubType === STUB_TYPE.CIPHERTEXT ? 'ciphertext' : 'other',
                stubType: stubType !== null ? String(stubType) : undefined,
            };
    } else {
        content = normalizeContent(msg.message, chatJid);
        // View-once cujo corpo veio sem mídia baixável (só o envelope): placeholder com o tipo.
        if (viewOnce && content.type === 'unsupported') {
            content = { type: 'view_once_placeholder', mediaKind: placeholderMediaKind(msg.message) };
        }
    }

    const unwrapped = unwrapMessage(msg.message);
    const ctx = findContextInfo(unwrapped);
    let quoted: QuotedRef | undefined;
    if (ctx?.stanzaId) {
        quoted = {
            key: {
                id: ctx.stanzaId,
                chatJid: ctx.remoteJid ?? chatJid,
                fromMe: false,
                participantJid: ctx.participant ?? undefined,
            },
            content: ctx.quotedMessage ? normalizeContent(ctx.quotedMessage, chatJid) : undefined,
        };
    }

    return {
        key: normalizeKey(msg.key),
        timestamp: toMillis(msg.messageTimestamp),
        senderJid,
        senderPn: senderPn ?? undefined,
        senderLid,
        chatAltJid: key.remoteJidAlt ?? undefined,
        pushName: msg.pushName ?? undefined,
        businessName: msg.verifiedBizName ?? undefined,
        messageSecret: messageSecretOf(msg.message),
        shape: describeMessageShape(msg.message),
        isGroup,
        isBroadcast,
        content,
        quoted,
        mentionedJids: ctx?.mentionedJid ?? [],
        isForwarded: (ctx?.forwardingScore ?? 0) > 0 || ctx?.isForwarded === true,
        forwardingScore: ctx?.forwardingScore ?? 0,
        isEphemeral: !!msg.message?.ephemeralMessage || (ctx?.expiration ?? 0) > 0,
        isViewOnce: viewOnce,
        referral: extractCtwaReferral(ctx),
        raw: msg,
    };
}

export function normalizeStatus(status: proto.WebMessageInfo.Status | null | undefined): MessageStatus | null {
    const S = proto.WebMessageInfo.Status;
    switch (status) {
        case S.ERROR: return 'error';
        case S.PENDING: return 'pending';
        case S.SERVER_ACK: return 'sent';
        case S.DELIVERY_ACK: return 'delivered';
        case S.READ: return 'read';
        case S.PLAYED: return 'played';
        default: return null;
    }
}

export function normalizeDisconnect(statusCode: number | undefined, message: string | undefined): DisconnectCause {
    const text = (message ?? '').toLowerCase();
    switch (statusCode) {
        case DisconnectReason.loggedOut:
            return text.includes('conflict') || text.includes('replaced') ? 'conflict' : 'logged_out';
        case DisconnectReason.connectionReplaced: return 'connection_replaced';
        case DisconnectReason.restartRequired: return 'restart_required';
        case DisconnectReason.connectionLost:
        case DisconnectReason.connectionClosed: return 'connection_lost';
        case DisconnectReason.timedOut: return 'timed_out';
        case DisconnectReason.badSession: return 'bad_session';
        case DisconnectReason.forbidden: return 'forbidden';
        case DisconnectReason.multideviceMismatch: return 'multidevice_mismatch';
        case DisconnectReason.unavailableService: return 'unavailable_service';
        default: return 'unknown';
    }
}

function role(p: GroupParticipant): GroupRole {
    if (p.admin === 'superadmin' || p.isSuperAdmin) return 'superadmin';
    if (p.admin === 'admin' || p.isAdmin) return 'admin';
    return null;
}

export function normalizeParticipant(p: GroupParticipant): NormGroupParticipant {
    const phoneNumber = (p as GroupParticipant & { phoneNumber?: string }).phoneNumber;
    const username = (p as GroupParticipant & { username?: string }).username;
    return {
        jid: p.id,
        phoneJid: phoneNumber ?? (p.id.endsWith('@s.whatsapp.net') ? p.id : undefined),
        lid: p.lid ?? (p.id.endsWith('@lid') ? p.id : undefined),
        name: p.name ?? p.notify ?? username ?? undefined,
        role: role(p),
    };
}

export function normalizeActor(jid?: string | null, pn?: string | null, name?: string | null): GroupActor | undefined {
    if (!jid) return undefined;
    return { jid, phoneJid: pn ?? undefined, name: name ?? undefined };
}

export function normalizeGroup(meta: GroupMetadata): GroupInfo {
    return {
        author: normalizeActor(meta.author, meta.authorPn, meta.authorUsername),
        jid: meta.id,
        subject: meta.subject,
        subjectOwner: meta.subjectOwner,
        subjectTime: meta.subjectTime,
        description: meta.desc,
        ownerJid: meta.owner,
        creation: meta.creation,
        participants: (meta.participants ?? []).map(normalizeParticipant),
        size: meta.size,
        announce: meta.announce === true,
        restrict: meta.restrict === true,
        joinApprovalMode: meta.joinApprovalMode === true,
        memberAddMode: meta.memberAddMode === true ? 'all_member_add' : 'admin_add',
        ephemeralDuration: meta.ephemeralDuration,
        isCommunity: meta.isCommunity === true,
        isCommunityAnnounce: meta.isCommunityAnnounce === true,
        linkedParentJid: meta.linkedParent,
        inviteCode: meta.inviteCode,
        addressingMode: meta.addressingMode === 'pn' ? 'pn' : meta.addressingMode === 'lid' ? 'lid' : undefined,
    };
}
