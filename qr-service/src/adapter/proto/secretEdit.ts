import { createDecipheriv, createHmac } from 'crypto';

/** Campos do `secretEncryptedMessage` que a decifragem usa (mesmo schema em toda lib). */
export interface SecretEncryptedEdit {
    targetMessageKey?: { id?: string | null } | null;
    encPayload?: Uint8Array | null;
    encIv?: Uint8Array | null;
}

const GCM_TAG_BYTES = 16;

/**
 * Abre uma edição cifrada com o segredo da mensagem original (secretEncType MESSAGE_EDIT).
 * Só o autor edita a própria mensagem, então remetente original = editor = `authorJid`:
 *   key0   = HMAC-SHA256(key = 0³², data = messageSecret)
 *   decKey = HMAC-SHA256(key = key0, data = origId ‖ author ‖ author ‖ 'Message Edit' ‖ 0x01)
 *   plain  = AES-256-GCM(decKey, encIv, AAD vazio), tag nos últimos 16 bytes
 * Devolve os bytes de um `proto.Message` (quem chama decodifica com o proto da sua lib),
 * ou null quando a tag não bate — identidade errada.
 */
export function decryptSecretEditPlaintext(enc: SecretEncryptedEdit | undefined, messageSecret: Buffer, authorJid: string): Buffer | null {
    const origMsgId = enc?.targetMessageKey?.id;
    if (!origMsgId || !enc?.encPayload || !enc.encIv) return null;
    const payload = Buffer.from(enc.encPayload);
    if (payload.length <= GCM_TAG_BYTES) return null;
    try {
        const sign = Buffer.concat([
            Buffer.from(origMsgId, 'utf8'),
            Buffer.from(authorJid, 'utf8'),
            Buffer.from(authorJid, 'utf8'),
            Buffer.from('Message Edit', 'utf8'),
            Buffer.from([1]),
        ]);
        const key0 = createHmac('sha256', Buffer.alloc(32)).update(messageSecret).digest();
        const decKey = createHmac('sha256', key0).update(sign).digest();
        const decipher = createDecipheriv('aes-256-gcm', decKey, Buffer.from(enc.encIv));
        decipher.setAuthTag(payload.subarray(payload.length - GCM_TAG_BYTES));
        return Buffer.concat([decipher.update(payload.subarray(0, payload.length - GCM_TAG_BYTES)), decipher.final()]);
    } catch {
        return null;
    }
}
