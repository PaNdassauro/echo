/**
 * A promessa central do adapter: trocar de lib SEM re-parear. Pareia no Baileys,
 * exporta as credenciais, importa na zapo e a zapo entra como o mesmo aparelho.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ZapoClientFactory } from '../../src/adapter/zapo/index.js';
import { ContractHarness, DEVICE_USER_JID, waitFor } from './harness.js';
import { baileysDriver } from './drivers/baileys.js';

const ALICE = '5511988887777@s.whatsapp.net';

describe('migração de credenciais baileys → zapo', () => {
    const h = new ContractHarness(baileysDriver);
    before(async () => { await h.start(); }, { timeout: 60_000 });
    after(async () => { await h.stop(); });

    it('zapo conecta como o mesmo aparelho e recebe mensagem', async () => {
        await h.client.close();
        const snapshot = await h.client.exportAuthSnapshot();

        const zapo = new ZapoClientFactory({ kind: 'memory' });
        const store = zapo.createStore('migrated');
        const client = zapo.create({ sessionId: 'migrated', store, transport: h.transport(), logLevel: 'silent' });
        const { losses } = await client.importAuthSnapshot(snapshot);
        assert.equal(await store.isPaired(), true);

        const nextPipeline = h.server.waitForNextAuthenticatedPipeline(20_000);
        const open = waitFor(client, 'connection.update', (u) => u.state === 'open', 30_000);
        await client.connect();
        h.pipeline = await nextPipeline;
        await open;
        assert.equal(client.me()?.jid, DEVICE_USER_JID);
        console.log(`perdas reportadas na conversão: ${losses.length ? losses.join('; ') : 'nenhuma'}`);

        const alice = await h.peer(ALICE);
        const upsert = waitFor(client, 'messages.upsert', (u) => u.messages.some((m) => m.key.chatJid === ALICE));
        await alice.sendConversation('oi zapo');
        const msg = (await upsert).messages.find((m) => m.key.chatJid === ALICE)!;
        assert.ok(msg.content.type === 'text' && msg.content.text === 'oi zapo');
        await client.close();
    }, { timeout: 90_000 });
});
