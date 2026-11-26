/**
 * Forma ESTRUTURAL do protobuf do WhatsApp (`Message`, `ContextInfo`, chaves) que
 * as libs Node compartilham: Baileys, zapo e forks geram os mesmos tipos a partir
 * do mesmo .proto. Aqui só o subconjunto que o serviço lê, sem importar lib alguma —
 * um `proto.IMessage` de qualquer delas é atribuível a `ProtoMessage`.
 */

/** protobufjs entrega inteiros de 64 bits como Long; só precisamos do toString(). */
export interface ProtoLong { toString(): string }
export type ProtoNumber = number | ProtoLong | null | undefined;
export type Maybe<T> = T | null | undefined;

export interface ProtoKey {
    remoteJid?: Maybe<string>;
    fromMe?: Maybe<boolean>;
    id?: Maybe<string>;
    participant?: Maybe<string>;
}

export interface ProtoExternalAdReply {
    ctwaClid?: Maybe<string>;
    thumbnail?: Maybe<Uint8Array>;
    title?: Maybe<string>;
    body?: Maybe<string>;
    sourceUrl?: Maybe<string>;
    sourceId?: Maybe<string>;
    sourceType?: Maybe<string>;
    mediaUrl?: Maybe<string>;
    thumbnailUrl?: Maybe<string>;
}

export interface ProtoContextInfo {
    stanzaId?: Maybe<string>;
    participant?: Maybe<string>;
    remoteJid?: Maybe<string>;
    quotedMessage?: Maybe<ProtoMessage>;
    mentionedJid?: Maybe<string[]>;
    isForwarded?: Maybe<boolean>;
    forwardingScore?: Maybe<number>;
    expiration?: Maybe<number>;
    externalAdReply?: Maybe<ProtoExternalAdReply>;
    conversionSource?: Maybe<string>;
    conversionData?: Maybe<Uint8Array>;
    conversionDelaySeconds?: Maybe<number>;
    entryPointConversionSource?: Maybe<string>;
    entryPointConversionApp?: Maybe<string>;
    entryPointConversionDelaySeconds?: Maybe<number>;
    entryPointConversionExternalSource?: Maybe<string>;
    entryPointConversionExternalMedium?: Maybe<string>;
}

export interface ProtoMedia {
    url?: Maybe<string>;
    mimetype?: Maybe<string>;
    fileSha256?: Maybe<Uint8Array>;
    fileLength?: ProtoNumber;
    mediaKey?: Maybe<Uint8Array>;
    directPath?: Maybe<string>;
    fileName?: Maybe<string>;
    caption?: Maybe<string>;
    width?: Maybe<number>;
    height?: Maybe<number>;
    seconds?: Maybe<number>;
    ptt?: Maybe<boolean>;
    isAnimated?: Maybe<boolean>;
    gifPlayback?: Maybe<boolean>;
    jpegThumbnail?: Maybe<Uint8Array>;
    pngThumbnail?: Maybe<Uint8Array>; // só figurinha
    viewOnce?: Maybe<boolean>;
    contextInfo?: Maybe<ProtoContextInfo>;
}

export interface ProtoWrapper { message?: Maybe<ProtoMessage> }

export interface ProtoMessage {
    conversation?: Maybe<string>;
    extendedTextMessage?: Maybe<{
        text?: Maybe<string>;
        title?: Maybe<string>;
        matchedText?: Maybe<string>;
        description?: Maybe<string>;
        jpegThumbnail?: Maybe<Uint8Array>;
        contextInfo?: Maybe<ProtoContextInfo>;
    }>;
    imageMessage?: Maybe<ProtoMedia>;
    videoMessage?: Maybe<ProtoMedia>;
    ptvMessage?: Maybe<ProtoMedia>;
    audioMessage?: Maybe<ProtoMedia>;
    documentMessage?: Maybe<ProtoMedia>;
    stickerMessage?: Maybe<ProtoMedia>;
    documentWithCaptionMessage?: Maybe<ProtoWrapper>;
    locationMessage?: Maybe<{ degreesLatitude?: Maybe<number>; degreesLongitude?: Maybe<number>; name?: Maybe<string>; address?: Maybe<string>; url?: Maybe<string>; contextInfo?: Maybe<ProtoContextInfo> }>;
    liveLocationMessage?: Maybe<{ degreesLatitude?: Maybe<number>; degreesLongitude?: Maybe<number>; caption?: Maybe<string>; contextInfo?: Maybe<ProtoContextInfo> }>;
    contactMessage?: Maybe<{ displayName?: Maybe<string>; vcard?: Maybe<string>; contextInfo?: Maybe<ProtoContextInfo> }>;
    contactsArrayMessage?: Maybe<{ displayName?: Maybe<string>; contacts?: Maybe<Array<{ displayName?: Maybe<string>; vcard?: Maybe<string> }>>; contextInfo?: Maybe<ProtoContextInfo> }>;
    pollCreationMessage?: Maybe<ProtoPollCreation>;
    pollCreationMessageV2?: Maybe<ProtoPollCreation>;
    pollCreationMessageV3?: Maybe<ProtoPollCreation>;
    pollCreationMessageV5?: Maybe<ProtoPollCreation>;
    pollUpdateMessage?: Maybe<{ pollCreationMessageKey?: Maybe<ProtoKey>; vote?: Maybe<{ encPayload?: Maybe<Uint8Array>; encIv?: Maybe<Uint8Array> }>; senderTimestampMs?: ProtoNumber }>;
    reactionMessage?: Maybe<{ key?: Maybe<ProtoKey>; text?: Maybe<string>; senderTimestampMs?: ProtoNumber }>;
    protocolMessage?: Maybe<{ key?: Maybe<ProtoKey>; type?: Maybe<number>; editedMessage?: Maybe<ProtoMessage>; ephemeralExpiration?: Maybe<number>; timestampMs?: ProtoNumber }>;
    groupInviteMessage?: Maybe<{ groupJid?: Maybe<string>; inviteCode?: Maybe<string>; inviteExpiration?: ProtoNumber; groupName?: Maybe<string>; caption?: Maybe<string>; contextInfo?: Maybe<ProtoContextInfo> }>;
    secretEncryptedMessage?: Maybe<{ targetMessageKey?: Maybe<ProtoKey>; encPayload?: Maybe<Uint8Array>; encIv?: Maybe<Uint8Array>; secretEncType?: Maybe<number> }>;
    messageContextInfo?: Maybe<{ messageSecret?: Maybe<Uint8Array> }>;
    ephemeralMessage?: Maybe<ProtoWrapper>;
    viewOnceMessage?: Maybe<ProtoWrapper>;
    viewOnceMessageV2?: Maybe<ProtoWrapper>;
    viewOnceMessageV2Extension?: Maybe<ProtoWrapper>;
    editedMessage?: Maybe<ProtoWrapper>;
    deviceSentMessage?: Maybe<ProtoWrapper>;
    associatedChildMessage?: Maybe<ProtoWrapper>;
    groupStatusMessage?: Maybe<ProtoWrapper>;
    groupStatusMessageV2?: Maybe<ProtoWrapper>;
}

export interface ProtoPollCreation {
    name?: Maybe<string>;
    options?: Maybe<Array<{ optionName?: Maybe<string> }>>;
    selectableOptionsCount?: Maybe<number>;
}

/** Constantes do protocolo (iguais em qualquer lib; vêm do .proto do WhatsApp). */
export const PROTOCOL_TYPE = {
    REVOKE: 0,
    EPHEMERAL_SETTING: 3,
    HISTORY_SYNC_NOTIFICATION: 5,
    APP_STATE_SYNC_KEY_SHARE: 6,
    APP_STATE_SYNC_KEY_REQUEST: 7,
    APP_STATE_FATAL_EXCEPTION_NOTIFICATION: 10,
    MESSAGE_EDIT: 14,
    PEER_DATA_OPERATION_REQUEST_MESSAGE: 16,
    PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE: 17,
} as const;

export const HISTORY_SYNC_TYPE = { INITIAL_BOOTSTRAP: 0, INITIAL_STATUS_V3: 1, FULL: 2, RECENT: 3, PUSH_NAME: 4, NON_BLOCKING_DATA: 5, ON_DEMAND: 6 } as const;
export const STUB_TYPE = { REVOKE: 1, CIPHERTEXT: 2 } as const;
export const SECRET_ENC_TYPE = { MESSAGE_EDIT: 2 } as const;
/** WebMessageInfo.Status */
export const MESSAGE_STATUS = { ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 } as const;

export function protoNumber(value: ProtoNumber): number | undefined {
    if (value === null || value === undefined) return undefined;
    return typeof value === 'number' ? value : Number(value.toString());
}
