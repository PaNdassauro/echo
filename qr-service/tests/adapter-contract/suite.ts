/**
 * Suíte de contrato: os MESMOS cenários para qualquer provider.
 * Um adapter novo que passa aqui está apto a ir para piloto.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaDownloadError } from '../../src/adapter/WhatsAppClient.js';
import { ContractHarness, DEVICE_USER_JID, waitFor, type ContractDriver } from './harness.js';

const ALICE = '5511988887777@s.whatsapp.net';

export function runContractSuite(driver: ContractDriver): void {
    describe(`contrato WhatsAppClient — ${driver.name}`, () => {
        const h = new ContractHarness(driver);

        before(async () => { await h.start(); }, { timeout: 60_000 });
        after(async () => { await h.stop(); });

        it('pareou por QR e abriu a conexão com identidade própria', () => {
            assert.equal(h.client.isOpen(), true);
            assert.equal(h.client.isRegistered(), true);
            const me = h.client.me();
            assert.ok(me, 'me() vazio');
            assert.equal(me.jid, DEVICE_USER_JID);
            assert.ok(h.client.capabilities.has('qr'));
        });

        it('recebe texto 1:1 normalizado', async () => {
            const alice = await h.peer(ALICE);
            const upsert = waitFor(h.client, 'messages.upsert', (u) => u.messages.some((m) => m.key.chatJid === ALICE));
            await alice.sendConversation('olá do contrato');
            const { messages } = await upsert;
            const msg = messages.find((m) => m.key.chatJid === ALICE)!;
            assert.equal(msg.content.type, 'text');
            assert.equal(msg.content.type === 'text' && msg.content.text, 'olá do contrato');
            assert.equal(msg.key.fromMe, false);
            assert.equal(msg.isGroup, false);
            assert.equal(msg.senderJid, ALICE);
            assert.ok(msg.key.id.length > 0);
            assert.ok(msg.timestamp > 1_600_000_000_000);
        });

        it('envia texto e o peer decifra', async () => {
            const alice = await h.peer(ALICE);
            const expected = alice.expectMessage({ timeoutMs: 10_000 });
            const result = await h.client.send(ALICE, { type: 'text', text: 'resposta do contrato' });
            assert.equal(result.key.chatJid, ALICE);
            assert.equal(result.key.fromMe, true);
            const received = await expected;
            assert.equal(received.message.conversation ?? received.message.extendedTextMessage?.text, 'resposta do contrato');
        });

        it('recebe reação, edição e apagamento como conteúdos próprios', async () => {
            const alice = await h.peer(ALICE);
            const original = waitFor(h.client, 'messages.upsert', (u) => u.messages.some((m) => m.content.type === 'text' && m.content.text === 'alvo'));
            await alice.sendConversation('alvo');
            const target = (await original).messages.find((m) => m.content.type === 'text')!;

            const reaction = waitFor(h.client, 'messages.upsert', (u) => u.messages.some((m) => m.content.type === 'reaction'));
            await alice.sendReaction({ targetMessageId: target.key.id, emoji: '👍' });
            const r = (await reaction).messages.find((m) => m.content.type === 'reaction')!;
            assert.ok(r.content.type === 'reaction' && r.content.reaction.emoji === '👍' && r.content.reaction.targetKey.id === target.key.id);

            const edit = waitFor(h.client, 'messages.upsert', (u) => u.messages.some((m) => m.content.type === 'edit'));
            await alice.sendMessageEdit({ targetMessageId: target.key.id, newText: 'alvo editado' });
            const e = (await edit).messages.find((m) => m.content.type === 'edit')!;
            assert.ok(e.content.type === 'edit' && e.content.edit.newText === 'alvo editado');

            const revoke = waitFor(h.client, 'messages.upsert', (u) => u.messages.some((m) => m.content.type === 'revoke'));
            await alice.sendMessageRevoke({ targetMessageId: target.key.id });
            const v = (await revoke).messages.find((m) => m.content.type === 'revoke')!;
            assert.ok(v.content.type === 'revoke' && v.content.revoke.targetKey.id === target.key.id);
        });

        it('envia reação, edição e apagamento', async () => {
            const alice = await h.peer(ALICE);
            const textP = alice.expectMessage({ timeoutMs: 10_000 });
            const sent = await h.client.send(ALICE, { type: 'text', text: 'para editar' });
            await textP;

            const reactP = alice.expectMessage({ timeoutMs: 10_000 });
            await h.client.send(ALICE, { type: 'reaction', reaction: { targetKey: sent.key, emoji: '❤️' } });
            assert.equal((await reactP).message.reactionMessage?.text, '❤️');

            const editP = alice.expectMessage({ timeoutMs: 10_000 });
            await h.client.send(ALICE, { type: 'edit', edit: { targetKey: sent.key, newText: 'editado' } });
            const editMsg = (await editP).message;
            assert.ok(editMsg.protocolMessage?.editedMessage || editMsg.editedMessage, 'edição não chegou como protocolMessage');

            const revokeP = alice.expectMessage({ timeoutMs: 10_000 });
            await h.client.send(ALICE, { type: 'revoke', revoke: { targetKey: sent.key } });
            assert.equal((await revokeP).message.protocolMessage?.key?.id, sent.key.id);
        });

        // Limitação do fake-server 1.3.0: o USync devolve só <devices>, sem <lid>. O
        // Baileys rc14 é LID-first e, sem mapeamento, não busca a pré-chave do contato
        // ("No sessions" → "All encryptions failed"). No WhatsApp real o servidor devolve
        // o LID. Enquanto o fake não ganhar <lid>, o peer precisa falar primeiro.
        it.skip('envia texto a contato nunca visto (cold start)', async () => {
            const bob = await h.peer('5511977776666@s.whatsapp.net', 'Bob');
            const expected = bob.expectMessage({ timeoutMs: 10_000 });
            await h.client.send('5511977776666@s.whatsapp.net', { type: 'text', text: 'primeiro contato' });
            assert.equal((await expected).message.conversation, 'primeiro contato');
        });

        it('recebe mídia com referência baixável', async () => {
            const alice = await h.peer(ALICE);
            const upsert = waitFor(h.client, 'messages.upsert', (u) => u.messages.some((m) => m.content.type === 'media'));
            const blob = await h.publishMedia(Buffer.alloc(2048, 7), 'image');
            await alice.sendImageMessage({
                directPath: blob.path,
                mediaKey: blob.mediaKey,
                fileSha256: blob.fileSha256,
                fileEncSha256: blob.fileEncSha256,
                fileLength: blob.fileLength,
                mimetype: 'image/jpeg',
                caption: 'foto',
            });
            const msg = (await upsert).messages.find((m) => m.content.type === 'media')!;
            assert.ok(msg.content.type === 'media');
            assert.equal(msg.content.media.kind, 'image');
            assert.equal(msg.content.media.caption, 'foto');
            assert.equal(msg.content.media.mimeType, 'image/jpeg');
            const bytes = await h.client.downloadMedia(msg.content.media);
            assert.equal(bytes.length, 2048);
            assert.equal(bytes[0], 7);
        });

        it('baixa mídia em stream para arquivo, com teto de bytes', async () => {
            const alice = await h.peer(ALICE);
            const upsert = waitFor(h.client, 'messages.upsert', (u) => u.messages.some((m) => m.content.type === 'media'));
            const payload = randomBytes(300_000);
            const blob = await h.publishMedia(payload, 'document');
            await alice.sendDocumentMessage({
                directPath: blob.path,
                mediaKey: blob.mediaKey,
                fileSha256: blob.fileSha256,
                fileEncSha256: blob.fileEncSha256,
                fileLength: blob.fileLength,
                mimetype: 'video/quicktime',
                fileName: 'video.mov',
            });
            const msg = (await upsert).messages.find((m) => m.content.type === 'media')!;
            assert.ok(msg.content.type === 'media');
            const media = msg.content.media;
            const dir = await mkdtemp(join(tmpdir(), 'contract-media-'));
            try {
                const target = join(dir, 'ok');
                const written = await h.client.downloadMediaToFile(media, target);
                assert.equal(written, payload.length);
                assert.deepEqual(await readFile(target), payload);

                // Teto abaixo do tamanho, sem fileLength para o corte antecipado: corta no stream e não deixa parcial.
                const cut = join(dir, 'cut');
                await assert.rejects(
                    h.client.downloadMediaToFile({ ...media, fileLength: undefined }, cut, { maxBytes: 100_000 }),
                    (e: unknown) => e instanceof MediaDownloadError && e.reason === 'too_large',
                );
                assert.deepEqual(await readdir(dir), ['ok']);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });

        it('recebe mensagem de grupo com remetente', async () => {
            const alice = await h.peer(ALICE);
            const groupJid = '120363000000000001@g.us';
            await h.server.createFakeGroup({ groupJid, subject: 'Contrato', participants: [alice] });
            const upsert = waitFor(h.client, 'messages.upsert', (u) => u.messages.some((m) => m.key.chatJid === groupJid));
            await alice.sendGroupConversation(groupJid, 'oi grupo');
            const msg = (await upsert).messages.find((m) => m.key.chatJid === groupJid)!;
            assert.equal(msg.isGroup, true);
            assert.equal(msg.senderJid, ALICE);
            assert.ok(msg.content.type === 'text' && msg.content.text === 'oi grupo');
        });

        it('exporta e importa snapshot de credenciais sem re-parear', async (t) => {
            if (!h.client.capabilities.has('auth_snapshot')) {
                t.skip('provider não exporta snapshot (rollback usa o backup da migração)');
                return;
            }
            await h.client.close();
            const snapshot = await h.client.exportAuthSnapshot();
            assert.equal(snapshot.format, 'baileys-v1');
            assert.ok(snapshot.creds && Object.keys(snapshot.keys).length >= 0);

            const clone = h.newClient('contract-clone');
            const { losses } = await clone.importAuthSnapshot(snapshot);
            assert.deepEqual(losses, []);
            assert.equal(clone.isRegistered(), true);

            const nextPipeline = h.server.waitForNextAuthenticatedPipeline(15_000);
            const open = waitFor(clone, 'connection.update', (u) => u.state === 'open');
            await clone.connect();
            h.pipeline = await nextPipeline;
            await open;
            assert.equal(clone.me()?.jid, DEVICE_USER_JID);
            await clone.close();
            // volta o cliente principal para os cenários seguintes
            await h.reconnect();
        });

        it('fecha e reporta a causa da queda', async () => {
            const closed = waitFor(h.client, 'connection.update', (u) => u.state === 'close');
            await h.client.close();
            const u = await closed;
            assert.equal(u.state, 'close');
            assert.equal(u.cause, 'closed_by_us');
            assert.equal(h.client.isOpen(), false);
        });

        it('não registrou erro de handler durante a suíte', () => {
            const errors = h.drainErrors();
            assert.deepEqual(errors.map((e) => `${e.scope}: ${(e.error as Error)?.message ?? e.error}`), []);
        });
    });
}
