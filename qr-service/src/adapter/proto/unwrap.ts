import type { Maybe, ProtoMessage } from './types.js';

/**
 * Campos `FutureProofMessage` que só embrulham o corpo real (`{ message: ... }`). Lista
 * única: o normalizador, o shape de log e o view-once leem daqui. Faltar um wrapper faz
 * a mensagem inteira virar "[Mensagem não suportada]" — o associatedChildMessage (álbum,
 * HD) sumiu assim quando o normalizador deixou de ser o do Baileys.
 */
export const MESSAGE_WRAPPERS = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
    'editedMessage',
    'deviceSentMessage',
    'associatedChildMessage',
    'groupStatusMessage',
    'groupStatusMessageV2',
    'groupMentionedMessage',
    'botInvokeMessage',
    'botForwardedMessage',
    'lottieStickerMessage',
    'questionMessage',
    'questionReplyMessage',
    'pollCreationMessageV4',
] as const;

type Wrapped = Record<string, { message?: unknown } | null | undefined>;

/** Primeiro wrapper presente neste nível, com o corpo que ele embrulha. */
export function wrapperOf(message: Maybe<object>): { name: (typeof MESSAGE_WRAPPERS)[number]; inner: ProtoMessage } | undefined {
    if (!message) return undefined;
    const m = message as Wrapped;
    for (const name of MESSAGE_WRAPPERS) {
        const inner = m[name]?.message;
        if (inner) return { name, inner: inner as ProtoMessage };
    }
    return undefined;
}

/** Desembrulha todos os wrappers (equivale ao normalizeMessageContent das libs). */
export function unwrapMessage(message: Maybe<ProtoMessage>): ProtoMessage | undefined {
    let current: Maybe<ProtoMessage> = message;
    for (let depth = 0; depth < 8 && current; depth++) {
        const w = wrapperOf(current);
        if (!w) break;
        current = w.inner;
    }
    return current ?? undefined;
}

/**
 * Chaves que o servidor anexa ao lado do corpo e nunca SÃO o corpo: distribuição de
 * chave de grupo (as duas variantes) e o messageContextInfo (deviceList/secret).
 */
const NON_CONTENT_KEYS = new Set([
    'senderKeyDistributionMessage',
    'fastRatchetKeySenderKeyDistributionMessage',
    'messageContextInfo',
]);

/** Primeira chave de conteúdo (equivale ao getContentType das libs). */
export function getContentType(message: Maybe<object>): string | undefined {
    if (!message) return undefined;
    return Object.keys(message).find((k) =>
        (k === 'conversation' || k.includes('Message')) && !NON_CONTENT_KEYS.has(k));
}
