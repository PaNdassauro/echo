/**
 * Normalização do corpo proto (`Message`) para o modelo do contrato. Vale para
 * qualquer lib que exponha o proto do WhatsApp (Baileys, zapo, forks) — nada aqui
 * importa lib; o adapter só passa `msg.message` e a chave normalizada.
 */
import type {
    ContactCard,
    CtwaReferral,
    LocationContent,
    MediaKind,
    MediaRef,
    MessageContent,
    MessageKey,
    ProtocolKind,
} from '../types.js';
import {
    PROTOCOL_TYPE,
    SECRET_ENC_TYPE,
    protoNumber,
    type Maybe,
    type ProtoContextInfo,
    type ProtoKey,
    type ProtoMedia,
    type ProtoMessage,
} from './types.js';
import { extractUnsupportedFallback } from './messageFallback.js';
import { getContentType, unwrapMessage, wrapperOf } from './unwrap.js';
// Só o TIPO do proto (apagado na compilação): o schema do WhatsApp é o mesmo em toda lib.
import type { proto as WAProto } from '@whiskeysockets/baileys';

export { getContentType, unwrapMessage };

export function protoKeyToMessageKey(key: ProtoKey, chatJid: string): MessageKey {
    return {
        id: key.id ?? '',
        chatJid: key.remoteJid ?? chatJid,
        fromMe: key.fromMe === true,
        participantJid: key.participant ?? undefined,
    };
}

const VIEW_ONCE_WRAPPERS = new Set<string>(['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']);

/** Caminho de wrappers + chaves da folha: `viewOnceMessageV2.imageMessage+messageContextInfo`. */
export function describeMessageShape(message: Maybe<ProtoMessage>): string {
    if (!message) return 'none';
    const path: string[] = [];
    let current: Maybe<ProtoMessage> = message;
    for (let depth = 0; depth < 8 && current; depth++) {
        const w = wrapperOf(current);
        if (!w) break;
        path.push(w.name);
        current = w.inner;
    }
    const leaf = current ? Object.keys(current).join('+') : 'empty';
    return [...path, leaf].join('.');
}

function unwrapLeaf(message: Maybe<ProtoMessage>): Record<string, unknown> | null | undefined {
    return unwrapMessage(message) as Record<string, unknown> | undefined;
}

/** View-once por wrapper ou por flag na mídia (o WhatsApp alterna entre as duas formas). */
export function isViewOnceMessage(message: Maybe<ProtoMessage>): boolean {
    let current: Maybe<ProtoMessage> = message;
    for (let depth = 0; depth < 8 && current; depth++) {
        const w = wrapperOf(current);
        if (!w) break;
        if (VIEW_ONCE_WRAPPERS.has(w.name)) return true;
        current = w.inner;
    }
    const media = current as {
        imageMessage?: { viewOnce?: boolean | null };
        videoMessage?: { viewOnce?: boolean | null };
        ptvMessage?: { viewOnce?: boolean | null };
        audioMessage?: { viewOnce?: boolean | null };
    } | null | undefined;
    return media?.imageMessage?.viewOnce === true || media?.videoMessage?.viewOnce === true
        || media?.ptvMessage?.viewOnce === true || media?.audioMessage?.viewOnce === true;
}

/**
 * MessageAssociation.AssociationType que são SEGUNDA CÓPIA de uma mídia já entregue
 * (HD/HEVC mandados depois da versão comum, foto em movimento). O aparelho troca a mídia
 * da bolha original; criar bolha nova duplicaria a foto/vídeo no CRM.
 */
const DUPLICATE_MEDIA_ASSOCIATIONS = new Set<number>([5, 10, 12, 19]); // HD_VIDEO, HD_IMAGE, MOTION_PHOTO, HEVC_VIDEO

function associationTypeOf(message: Maybe<ProtoMessage>): number | undefined {
    let current: Maybe<ProtoMessage> = message;
    for (let depth = 0; depth < 8 && current; depth++) {
        const assoc = (current.messageContextInfo as { messageAssociation?: { associationType?: number | null } | null } | null | undefined)?.messageAssociation;
        if (assoc?.associationType !== undefined && assoc.associationType !== null) return assoc.associationType;
        const w = wrapperOf(current);
        if (!w) break;
        current = w.inner;
    }
    return undefined;
}

export function placeholderMediaKind(message: Maybe<ProtoMessage>): MediaKind | undefined {
    const keys = Object.keys(unwrapLeaf(message) ?? {});
    if (keys.includes('imageMessage')) return 'image';
    if (keys.includes('videoMessage') || keys.includes('ptvMessage')) return 'video';
    if (keys.includes('audioMessage')) return 'audio';
    if (keys.includes('documentMessage')) return 'document';
    if (keys.includes('stickerMessage')) return 'sticker';
    return undefined;
}

export function messageSecretOf(message: Maybe<ProtoMessage>): Buffer | undefined {
    const secret = unwrapMessage(message)?.messageContextInfo?.messageSecret
        ?? message?.messageContextInfo?.messageSecret;
    return secret?.length ? Buffer.from(secret) : undefined;
}

/** Texto de uma mensagem editada (corpo ou legenda). */
export function editedText(edited: Maybe<ProtoMessage>): string {
    if (!edited) return '';
    const inner = unwrapMessage(edited) ?? edited;
    return inner.conversation ?? inner.extendedTextMessage?.text ?? inner.imageMessage?.caption
        ?? inner.videoMessage?.caption ?? inner.documentMessage?.caption ?? '';
}

/**
 * Texto novo de uma edição já decifrada. O plaintext vem como `protocolMessage` (type
 * MESSAGE_EDIT) com o corpo em `editedMessage` — ler direto dava '' e a edição sumia.
 */
export function editedTextOf(decoded: Maybe<ProtoMessage>): string {
    return editedText(decoded?.protocolMessage?.editedMessage ?? decoded);
}




const MEDIA_TYPES: Record<string, MediaKind> = {
    imageMessage: 'image',
    videoMessage: 'video',
    ptvMessage: 'video',
    audioMessage: 'audio',
    documentMessage: 'document',
    documentWithCaptionMessage: 'document',
    stickerMessage: 'sticker',
};

type AnyMedia = ProtoMedia;
const toNumber = protoNumber;

function mediaRef(kind: MediaKind, typeKey: string, media: AnyMedia, raw: ProtoMessage): MediaRef {
    return {
        kind,
        // handle = a sub-mensagem inteira; downloadMedia() usa mediaKey/directPath/url dela.
        handle: { typeKey, message: raw },
        mimeType: media.mimetype ?? undefined,
        fileName: media.fileName ?? undefined,
        fileLength: toNumber(media.fileLength),
        sha256: media.fileSha256 ? Buffer.from(media.fileSha256).toString('hex') : undefined,
        width: media.width ?? undefined,
        height: media.height ?? undefined,
        seconds: media.seconds ?? undefined,
        isVoiceNote: media.ptt === true,
        isVideoNote: typeKey === 'ptvMessage',
        isAnimated: media.isAnimated === true,
        isGif: media.gifPlayback === true,
        caption: media.caption ?? undefined,
        thumbnail: media.jpegThumbnail?.length ? Buffer.from(media.jpegThumbnail)
            : media.pngThumbnail?.length ? Buffer.from(media.pngThumbnail) : undefined,
        pointer: {
            hasMediaKey: !!media.mediaKey?.length,
            hasDirectPath: !!media.directPath,
            hasUrl: !!media.url,
        },
    };
}

function location(loc: NonNullable<ProtoMessage['locationMessage']> | NonNullable<ProtoMessage['liveLocationMessage']>, isLive: boolean): LocationContent {
    const asLoc = loc as NonNullable<ProtoMessage['locationMessage']>;
    return {
        latitude: loc.degreesLatitude ?? 0,
        longitude: loc.degreesLongitude ?? 0,
        name: asLoc.name ?? undefined,
        address: asLoc.address ?? undefined,
        url: asLoc.url ?? undefined,
        isLive,
    };
}

function contacts(msg: ProtoMessage): ContactCard[] {
    if (msg.contactMessage) {
        return [{ displayName: msg.contactMessage.displayName ?? '', vcard: msg.contactMessage.vcard ?? '' }];
    }
    return (msg.contactsArrayMessage?.contacts ?? []).map((c) => ({
        displayName: c.displayName ?? '',
        vcard: c.vcard ?? '',
    }));
}

function protocolKind(type: Maybe<number>): ProtocolKind {
    const T = PROTOCOL_TYPE;
    switch (type) {
        case T.EPHEMERAL_SETTING: return 'ephemeral_setting';
        case T.HISTORY_SYNC_NOTIFICATION: return 'history_sync_notification';
        case T.APP_STATE_SYNC_KEY_SHARE:
        case T.APP_STATE_SYNC_KEY_REQUEST:
        case T.APP_STATE_FATAL_EXCEPTION_NOTIFICATION: return 'app_state_sync';
        case T.PEER_DATA_OPERATION_REQUEST_MESSAGE:
        case T.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE: return 'peer_data_request';
        default: return 'other';
    }
}

export function findContextInfo(message: Maybe<ProtoMessage>): ProtoContextInfo | undefined {
    if (!message) return undefined;
    for (const value of Object.values(message)) {
        const ctx = (value as { contextInfo?: ProtoContextInfo } | null | undefined)?.contextInfo;
        if (ctx) return ctx;
    }
    return undefined;
}

/** Proto → JSON puro: bytes em base64, Long em string, sem internals do protobufjs. */
function toPlainJson(value: unknown): unknown {
    if (value === null || value === undefined) return undefined;
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
    if (Array.isArray(value)) {
        const arr = value.map(toPlainJson).filter((v) => v !== undefined);
        return arr.length ? arr : undefined;
    }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        if (typeof obj.low === 'number' && typeof obj.high === 'number' && 'unsigned' in obj) {
            return obj.toString !== Object.prototype.toString ? String(value) : undefined;
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
            if (k.startsWith('_')) continue;
            const plain = toPlainJson(v);
            if (plain !== undefined) out[k] = plain;
        }
        return Object.keys(out).length ? out : undefined;
    }
    return value;
}

const CTWA_CONVERSION_KEYS = [
    'conversionSource',
    'conversionData',
    'conversionDelaySeconds',
    'entryPointConversionSource',
    'entryPointConversionApp',
    'entryPointConversionDelaySeconds',
    'entryPointConversionExternalSource',
    'entryPointConversionExternalMedium',
] as const;

/** Referral de anúncio (CTWA): só existe na PRIMEIRA mensagem do lead e não é recuperável depois. */
export function extractCtwaReferral(ctx: Maybe<ProtoContextInfo>): CtwaReferral | undefined {
    const ear = ctx?.externalAdReply;
    if (!ear) return undefined;
    const { thumbnail: _thumb, ...adReply } = ear;
    const externalAdReply = toPlainJson(adReply);
    const referral: Record<string, unknown> = {};
    if (externalAdReply !== undefined) referral.externalAdReply = externalAdReply;
    for (const key of CTWA_CONVERSION_KEYS) {
        const plain = toPlainJson((ctx as Record<string, unknown> | null | undefined)?.[key]);
        if (plain !== undefined) referral[key] = plain;
    }
    if (!Object.keys(referral).length) return undefined;
    return { ctwaClid: ear.ctwaClid ?? null, referral };
}

/** Conteúdo normalizado de um `proto.IMessage` já desembrulhado (ephemeral/viewOnce/edited). */
export function normalizeContent(raw: Maybe<ProtoMessage>, chatJid: string): MessageContent {
    const association = associationTypeOf(raw);
    if (association !== undefined && DUPLICATE_MEDIA_ASSOCIATIONS.has(association)) {
        return { type: 'unsupported', rawType: `association:${association}`, description: null, skip: 'deliberate' };
    }
    const msg = unwrapMessage(raw);
    if (!msg) return { type: 'unsupported', rawType: 'empty', description: null };
    const typeKey = getContentType(msg);
    // Sem chave de conteúdo o que sobrou é protocolo que o servidor pendura em
    // qualquer stanza (distribuição de chave de grupo + messageContextInfo, oferta de
    // chamada) ou envelope vazio. O aparelho não desenha nada; persistir isso virava
    // uma bolha "[Mensagem não suportada]" fantasma no CRM. Skip auditável
    // (msg_skip_protocol grava o shape, então tipo novo de verdade ainda aparece no log).
    if (!typeKey) return { type: 'unsupported', rawType: 'no_content', description: null, skip: 'protocol' };
    // Reação/comentário/RSVP cifrados com o segredo da mensagem pai: não são bolha. Quando a
    // lib consegue abrir (zapo: message_addon) a reação chega por lá; o envelope cru não
    // pode virar "[Mensagem não suportada]".
    if (typeKey === 'encReactionMessage' || typeKey === 'encCommentMessage' || typeKey === 'encEventResponseMessage') {
        return { type: 'unsupported', rawType: typeKey, description: null, skip: 'deliberate' };
    }

    if (msg.conversation !== undefined && msg.conversation !== null && typeKey === 'conversation') {
        return { type: 'text', text: msg.conversation };
    }
    if (typeKey === 'extendedTextMessage') {
        const ext = msg.extendedTextMessage;
        const hasPreview = !!(ext?.title || ext?.matchedText);
        return {
            type: 'text',
            text: ext?.text ?? '',
            linkPreview: hasPreview ? {
                url: ext?.matchedText ?? undefined,
                title: ext?.title ?? undefined,
                description: ext?.description ?? undefined,
                thumbnail: ext?.jpegThumbnail?.length ? Buffer.from(ext.jpegThumbnail) : undefined,
            } : undefined,
        };
    }
    if (typeKey === 'secretEncryptedMessage' && msg.secretEncryptedMessage) {
        const enc = msg.secretEncryptedMessage;
        const target = enc.targetMessageKey ? protoKeyToMessageKey(enc.targetMessageKey, chatJid) : { id: '', chatJid, fromMe: false };
        if (enc.secretEncType === SECRET_ENC_TYPE.MESSAGE_EDIT) {
            return { type: 'edit', edit: { targetKey: target, newText: '', encrypted: { handle: enc } } };
        }
        return { type: 'protocol', kind: 'other' };
    }
    const mediaKind = MEDIA_TYPES[typeKey];
    if (mediaKind) {
        const inner = typeKey === 'documentWithCaptionMessage'
            ? msg.documentWithCaptionMessage?.message?.documentMessage
            : (msg as Record<string, unknown>)[typeKey];
        return { type: 'media', media: mediaRef(mediaKind, typeKey, (inner ?? {}) as AnyMedia, msg) };
    }
    if (typeKey === 'locationMessage' && msg.locationMessage) {
        return { type: 'location', location: location(msg.locationMessage, false) };
    }
    if (typeKey === 'liveLocationMessage' && msg.liveLocationMessage) {
        return { type: 'location', location: location(msg.liveLocationMessage, true) };
    }
    if (typeKey === 'contactMessage' || typeKey === 'contactsArrayMessage') {
        return { type: 'contacts', contacts: contacts(msg) };
    }
    if (typeKey === 'pollCreationMessage' || typeKey === 'pollCreationMessageV2' || typeKey === 'pollCreationMessageV3' || typeKey === 'pollCreationMessageV5') {
        const poll = msg.pollCreationMessage ?? msg.pollCreationMessageV2 ?? msg.pollCreationMessageV3 ?? msg.pollCreationMessageV5;
        return {
            type: 'poll_create',
            poll: {
                name: poll?.name ?? '',
                options: (poll?.options ?? []).map((o) => o.optionName ?? ''),
                selectableCount: poll?.selectableOptionsCount ?? 0,
            },
        };
    }
    if (typeKey === 'pollUpdateMessage' && msg.pollUpdateMessage) {
        const pollKey = msg.pollUpdateMessage.pollCreationMessageKey;
        const key = pollKey ? protoKeyToMessageKey(pollKey, chatJid) : { id: '', chatJid, fromMe: false };
        return { type: 'poll_vote', vote: { pollKey: key, encrypted: { pollKey: key, handle: msg.pollUpdateMessage } } };
    }
    if (typeKey === 'reactionMessage' && msg.reactionMessage) {
        const target = msg.reactionMessage.key ? protoKeyToMessageKey(msg.reactionMessage.key, chatJid) : { id: '', chatJid, fromMe: false };
        return { type: 'reaction', reaction: { targetKey: target, emoji: msg.reactionMessage.text ?? '' } };
    }
    if (typeKey === 'protocolMessage' && msg.protocolMessage) {
        const p = msg.protocolMessage;
        const T = PROTOCOL_TYPE;
        const target = p.key ? protoKeyToMessageKey(p.key, chatJid) : { id: '', chatJid, fromMe: false };
        if (p.type === T.REVOKE) return { type: 'revoke', revoke: { targetKey: target } };
        if (p.type === T.MESSAGE_EDIT) return { type: 'edit', edit: { targetKey: target, newText: editedText(p.editedMessage) } };
        const kind = protocolKind(p.type);
        return {
            type: 'protocol',
            kind,
            ephemeralSeconds: kind === 'ephemeral_setting' ? Number(p.ephemeralExpiration ?? 0) : undefined,
        };
    }
    if (typeKey === 'groupInviteMessage' && msg.groupInviteMessage) {
        const g = msg.groupInviteMessage;
        return {
            type: 'group_invite',
            invite: {
                groupJid: g.groupJid ?? '',
                inviteCode: g.inviteCode ?? '',
                inviteExpiration: toNumber(g.inviteExpiration),
                groupName: g.groupName ?? undefined,
                caption: g.caption ?? undefined,
            },
        };
    }
    const fallback = extractUnsupportedFallback(msg as unknown as WAProto.IMessage);
    if (fallback.kind === 'skip') return { type: 'unsupported', rawType: typeKey, description: null, skip: fallback.reason };
    return { type: 'unsupported', rawType: typeKey, description: fallback.content, messageType: fallback.messageType, metadata: fallback.metadata };
}

