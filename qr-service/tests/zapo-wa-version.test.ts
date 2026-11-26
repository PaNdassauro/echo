/**
 * Versão do WhatsApp Web anunciada pela zapo (2.5.15). Quando o WhatsApp passa a
 * recusar a versão fixa da lib (`failure_client_too_old`), todas as linhas da zapo caem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaVersionResolver } from '../src/adapter/zapo/waVersion.js';

test('resolve: busca uma vez, guarda por 1 h e busca de novo depois', async () => {
    let calls = 0; let t = 0;
    const r = createWaVersionResolver(async () => ({ version: `2.3000.105495395${++calls}` }), () => t);
    assert.equal(await r.resolve(), '2.3000.1054953951');
    t = 59 * 60 * 1000;
    assert.equal(await r.resolve(), '2.3000.1054953951');
    t = 61 * 60 * 1000;
    assert.equal(await r.resolve(), '2.3000.1054953952');
    assert.equal(calls, 2);
});

test('resolve: N sessões reconectando juntas fazem uma busca só', async () => {
    let calls = 0;
    const r = createWaVersionResolver(async () => { calls++; await new Promise((ok) => setTimeout(ok, 5)); return { version: '2.3000.1054953954' }; });
    const all = await Promise.all([r.resolve(), r.resolve(), r.resolve()]);
    assert.deepEqual(all, ['2.3000.1054953954', '2.3000.1054953954', '2.3000.1054953954']);
    assert.equal(calls, 1);
});

test('resolve: busca que falha ou vem torta devolve undefined (lib usa a embutida) e não vira cache', async () => {
    const respostas: Array<() => Promise<{ version: string }>> = [
        async () => { throw new Error('rede'); },
        async () => ({ version: 'lixo' }),
        async () => ({ version: '2.3000.1054953954' }),
    ];
    const r = createWaVersionResolver(() => respostas.shift()!());
    assert.equal(await r.resolve(), undefined);
    assert.equal(await r.resolve(), undefined);
    assert.equal(await r.resolve(), '2.3000.1054953954');
});

test('resolve: falha depois de um acerto mantém a versão anterior com cooldown de 60 s', async () => {
    let t = 0; let calls = 0; let falha = false;
    const r = createWaVersionResolver(async () => {
        calls++;
        if (falha) throw new Error('rede');
        return { version: `2.3000.105495395${calls}` };
    }, () => t);
    assert.equal(await r.resolve(), '2.3000.1054953951');
    falha = true;
    t = 61 * 60 * 1000;
    assert.equal(await r.resolve(), '2.3000.1054953951');
    assert.equal(calls, 2);
    // Dentro do cooldown de 60 s não repete a busca
    t += 30 * 1000;
    assert.equal(await r.resolve(), '2.3000.1054953951');
    assert.equal(calls, 2);
    // Passou o cooldown e voltou a responder: atualiza o cache
    falha = false;
    t += 31 * 1000;
    assert.equal(await r.resolve(), '2.3000.1054953953');
    assert.equal(calls, 3);
});

test('invalidate: versão recusada pelo servidor força busca nova na próxima conexão', async () => {
    let calls = 0;
    const r = createWaVersionResolver(async () => ({ version: `2.3000.105495395${++calls}` }));
    assert.equal(await r.resolve(), '2.3000.1054953951');
    r.invalidate();
    assert.equal(await r.resolve(), '2.3000.1054953952');
});
