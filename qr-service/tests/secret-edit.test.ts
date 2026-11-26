/**
 * Edição cifrada (secretEncryptedMessage MESSAGE_EDIT): os dois providers abrem o payload
 * e devolvem o texto novo. O payload é montado com os helpers do Baileys — derivação
 * independente da de src/adapter/proto/secretEdit.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { aesEncryptGCM, hmacSign, proto } from '@whiskeysockets/baileys';
import { decryptSecretEditPlaintext } from '../src/adapter/proto/secretEdit.js';
import { BaileysClient } from '../src/adapter/baileys/BaileysClient.js';
import { ZapoClient } from '../src/adapter/zapo/ZapoClient.js';

const ORIG_ID = '3EB0A1B2C3D4E5F60718';
const AUTHOR = '554199990000@s.whatsapp.net';

function encryptEdit(secret: Buffer, author: string, message: proto.IMessage) {
    const sign = Buffer.concat([
        Buffer.from(ORIG_ID), Buffer.from(author), Buffer.from(author), Buffer.from('Message Edit'), new Uint8Array([1]),
    ]);
    const key = hmacSign(sign, hmacSign(secret, new Uint8Array(32), 'sha256'), 'sha256');
    const encIv = randomBytes(12);
    const encPayload = aesEncryptGCM(proto.Message.encode(message).finish(), key, encIv, new Uint8Array(0));
    return { targetMessageKey: { id: ORIG_ID }, encPayload, encIv, secretEncType: 2 };
}

const protocolEdit = (editedMessage: proto.IMessage): proto.IMessage => ({
    protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, editedMessage },
});

// Os métodos não usam estado da instância; evita montar store/sessão.
const providers = [
    ['baileys', (h: unknown, s: Buffer, a: string) => BaileysClient.prototype.decryptSecretEdit.call({}, h, s, a)],
    ['zapo', (h: unknown, s: Buffer, a: string) => ZapoClient.prototype.decryptSecretEdit.call({}, h, s, a)],
] as const;

for (const [name, decrypt] of providers) {
    test(`${name}: texto dentro de protocolMessage.editedMessage`, () => {
        const secret = randomBytes(32);
        const handle = encryptEdit(secret, AUTHOR, protocolEdit({ conversation: 'texto novo' }));
        assert.equal(decrypt(handle, secret, AUTHOR), 'texto novo');
    });

    test(`${name}: legenda de mídia editada`, () => {
        const secret = randomBytes(32);
        const handle = encryptEdit(secret, AUTHOR, protocolEdit({ imageMessage: { caption: 'legenda nova' } }));
        assert.equal(decrypt(handle, secret, AUTHOR), 'legenda nova');
    });

    test(`${name}: identidade errada não decifra`, () => {
        const secret = randomBytes(32);
        const handle = encryptEdit(secret, AUTHOR, protocolEdit({ conversation: 'x' }));
        assert.equal(decrypt(handle, secret, '5541888887777@s.whatsapp.net'), null);
        assert.equal(decrypt(handle, randomBytes(32), AUTHOR), null);
    });
}

test('payload sem id/iv devolve null sem lançar', () => {
    assert.equal(decryptSecretEditPlaintext({ encPayload: Buffer.alloc(40) }, randomBytes(32), AUTHOR), null);
    assert.equal(decryptSecretEditPlaintext(undefined, randomBytes(32), AUTHOR), null);
});
