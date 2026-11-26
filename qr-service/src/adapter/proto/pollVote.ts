import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

/** Quem é quem no voto: a chave depende da enquete, do criador e de quem votou. */
export interface PollVoteParties {
    pollMsgId: string;
    creatorJid: string;
    voterJid: string;
}

const GCM_TAG_BYTES = 16;

/**
 * Chave do voto (mesma derivação do WhatsApp Web):
 *   key0   = HMAC-SHA256(key = 0³², data = pollSecret)
 *   encKey = HMAC-SHA256(key = key0, data = pollId ‖ creator ‖ voter ‖ 'Poll Vote' ‖ 0x01)
 * AAD = "pollId\0voter". Vale para as duas libs — o proto é o mesmo.
 */
function pollVoteKey(pollSecret: Buffer, p: PollVoteParties): { key: Buffer; aad: Buffer } {
    const sign = Buffer.concat([
        Buffer.from(p.pollMsgId, 'utf8'),
        Buffer.from(p.creatorJid, 'utf8'),
        Buffer.from(p.voterJid, 'utf8'),
        Buffer.from('Poll Vote', 'utf8'),
        Buffer.from([1]),
    ]);
    const key0 = createHmac('sha256', Buffer.alloc(32)).update(pollSecret).digest();
    return {
        key: createHmac('sha256', key0).update(sign).digest(),
        aad: Buffer.from(`${p.pollMsgId}\u0000${p.voterJid}`, 'utf8'),
    };
}

/** Cifra um `PollVoteMessage` já serializado. */
export function encryptPollVotePayload(plaintext: Uint8Array, pollSecret: Buffer, p: PollVoteParties): { encPayload: Buffer; encIv: Buffer } {
    const { key, aad } = pollVoteKey(pollSecret, p);
    const encIv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, encIv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { encPayload: Buffer.concat([body, cipher.getAuthTag()]), encIv };
}

/**
 * Abre o voto e devolve os bytes do `PollVoteMessage`. **Lança** quando a tag não
 * bate: o serviço usa a exceção para tentar a próxima combinação criador×votante
 * (LID vs PN) — devolver vazio aqui faria o primeiro palpite "funcionar" com voto em
 * branco, que o painel lê como "retirou o voto".
 */
export function decryptPollVotePayload(
    enc: { encPayload?: Uint8Array | null; encIv?: Uint8Array | null } | null | undefined,
    pollSecret: Buffer,
    p: PollVoteParties,
): Buffer {
    if (!enc?.encPayload || !enc.encIv) throw new Error('voto sem encPayload/encIv');
    const payload = Buffer.from(enc.encPayload);
    // Só a tag (16 bytes) é válido: voto vazio = retirar o voto, plaintext de 0 bytes.
    if (payload.length < GCM_TAG_BYTES) throw new Error('voto cifrado curto demais');
    const { key, aad } = pollVoteKey(pollSecret, p);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.encIv));
    decipher.setAAD(aad);
    decipher.setAuthTag(payload.subarray(payload.length - GCM_TAG_BYTES));
    return Buffer.concat([decipher.update(payload.subarray(0, payload.length - GCM_TAG_BYTES)), decipher.final()]);
}
