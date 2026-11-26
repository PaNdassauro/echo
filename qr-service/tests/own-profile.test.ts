/**
 * Diálogo "Perfil do WhatsApp" do Echo (2.5.14). Antes:
 * - o nome trocado pelo Echo voltava ao velho ao reabrir: a zapo grava o nome novo nas
 *   credenciais, mas a identidade da linha era montada só ao conectar;
 * - a foto nunca aparecia: a URL do CDN do WhatsApp é barrada pelo CSP do Echo.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ownPictureDataUrl } from '../src/lib/ownProfilePicture.js';
import { buildInfo } from '../src/lib/version.js';
import { ContractHarness, DEVICE_USER_JID } from './adapter-contract/harness.js';
import { zapoDriver } from './adapter-contract/drivers/zapo.js';

const h = new ContractHarness(zapoDriver);
before(async () => { await h.start(); }, { timeout: 60_000 });
after(async () => { await h.stop(); });

test('zapo: nome trocado com a linha aberta aparece em me() sem reconectar', async () => {
    assert.notEqual(h.client.me()?.name, 'Ana Teste');
    // O fake-server não tem chave de app-state, então a mutação que avisa os outros aparelhos
    // falha aqui. A zapo grava o nome nas credenciais ANTES de subir a mutação (mesmo caminho
    // da produção, onde a mutação passa), e é isso que o me() precisa enxergar.
    await h.client.updateOwnName('Ana Teste').catch(() => {});
    assert.equal(h.client.me()?.name, 'Ana Teste');
    assert.equal(h.client.me()?.jid, DEVICE_USER_JID);
});

test('foto própria vai como data URL (o Echo barra a URL do WhatsApp)', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const pedidas: string[] = [];
    const url = await ownPictureDataUrl('https://pps.whatsapp.net/v/foto.jpg', async (u) => { pedidas.push(u); return jpeg; });
    assert.equal(url, `data:image/jpeg;base64,${jpeg.toString('base64')}`);
    assert.deepEqual(pedidas, ['https://pps.whatsapp.net/v/foto.jpg']);
});

test('versão no /health: sem build-arg vale a do package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const antes = process.env.APP_VERSION;
    try {
        for (const semArg of [undefined, '', 'dev']) {
            if (semArg === undefined) delete process.env.APP_VERSION; else process.env.APP_VERSION = semArg;
            assert.equal(buildInfo().version, pkg.version);
        }
        process.env.APP_VERSION = '9.9.9-testeligacao';
        assert.equal(buildInfo().version, '9.9.9-testeligacao');
    } finally {
        if (antes === undefined) delete process.env.APP_VERSION; else process.env.APP_VERSION = antes;
    }
});

test('sem foto ou download falho: null, nunca a URL do WhatsApp', async () => {
    assert.equal(await ownPictureDataUrl(null, async () => Buffer.from('x')), null);
    assert.equal(await ownPictureDataUrl('https://pps.whatsapp.net/v/foto.jpg', async () => null), null);
    assert.equal(await ownPictureDataUrl('https://pps.whatsapp.net/v/foto.jpg', async () => Buffer.alloc(0)), null);
});
