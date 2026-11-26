/**
 * Modelo normalizado → conteúdo do Baileys (`AnyMessageContent`).
 */
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from '@whiskeysockets/baileys';
import type { OutboundContent, OutboundMediaSource, SendOptions } from '../types.js';
import { toBaileysKey } from './inbound.js';

type MediaInput = Buffer | { url: string };

function media(src: OutboundMediaSource): MediaInput {
    return Buffer.isBuffer(src.data) ? src.data : { url: src.data.url };
}

export function toBaileysContent(content: OutboundContent): AnyMessageContent {
    switch (content.type) {
        case 'text':
            return { text: content.text, linkPreview: content.linkPreview === false ? null : undefined };
        case 'image':
            return { image: media(content.media), caption: content.media.caption, mimetype: content.media.mimeType, viewOnce: content.viewOnce };
        case 'video':
            return {
                video: media(content.media),
                caption: content.media.caption,
                mimetype: content.media.mimeType,
                gifPlayback: content.gifPlayback,
                ptv: content.isVideoNote,
                viewOnce: content.viewOnce,
            };
        case 'audio':
            return {
                audio: media(content.media),
                mimetype: content.media.mimeType,
                ptt: content.isVoiceNote,
                seconds: content.seconds,
                viewOnce: content.viewOnce,
            };
        case 'document':
            return {
                document: media(content.media),
                mimetype: content.media.mimeType,
                fileName: content.media.fileName ?? 'arquivo',
                caption: content.media.caption,
            };
        case 'sticker':
            return { sticker: media(content.media), mimetype: content.media.mimeType, isAnimated: content.isAnimated };
        case 'location':
            return {
                location: {
                    degreesLatitude: content.location.latitude,
                    degreesLongitude: content.location.longitude,
                    name: content.location.name,
                    address: content.location.address,
                    url: content.location.url,
                },
            };
        case 'contacts':
            return {
                contacts: {
                    displayName: content.displayName ?? content.contacts[0]?.displayName,
                    contacts: content.contacts.map((c) => ({ displayName: c.displayName, vcard: c.vcard })),
                },
            };
        case 'poll':
            return {
                poll: {
                    name: content.poll.name,
                    values: content.poll.options,
                    selectableCount: content.poll.selectableCount,
                },
            };
        case 'reaction':
            return { react: { text: content.reaction.emoji, key: toBaileysKey(content.reaction.targetKey) } };
        case 'edit':
            return { text: content.edit.newText, edit: toBaileysKey(content.edit.targetKey) };
        case 'revoke':
            return { delete: toBaileysKey(content.revoke.targetKey) };
        case 'group_invite':
            return {
                groupInvite: {
                    inviteCode: content.invite.inviteCode,
                    inviteExpiration: content.invite.inviteExpiration ?? Math.floor(Date.now() / 1000) + 3 * 24 * 3600,
                    jid: content.invite.groupJid,
                    subject: content.invite.groupName ?? '',
                    text: content.invite.caption ?? '',
                },
            };
    }
}

export function toBaileysOptions(opts: SendOptions | undefined): MiscMessageGenerationOptions {
    if (!opts) return {};
    const out: MiscMessageGenerationOptions = {};
    if (opts.quoted) {
        // O Baileys precisa de um WAMessage para montar o preview da citação. Sem o
        // cru, um texto basta (é o que o serviço sempre mandou).
        const raw = opts.quoted.raw as WAMessage | undefined;
        const text = opts.quoted.content?.type === 'text' ? opts.quoted.content.text : '';
        out.quoted = raw ?? { key: toBaileysKey(opts.quoted.key), message: { conversation: text } };
    }
    if (opts.ephemeralExpiration !== undefined) out.ephemeralExpiration = opts.ephemeralExpiration;
    if (opts.messageId) out.messageId = opts.messageId;
    return out;
}
