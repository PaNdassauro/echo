/**
 * Boot após reiniciar o host: o qr pode subir antes do banco. A listagem das sessões da
 * zapo (que vem de phone_numbers) falha, e isso NÃO pode virar "nenhuma sessão": a
 * descoberta repete com backoff e depois restaura as linhas. Baileys (disco) não espera.
 * O restoreAllSessions roda de verdade, com um `this` falso (mesmo truque do
 * secret-edit.test.ts); o Supabase aponta para uma porta fechada, então a validação contra
 * phone_numbers falha e o restore segue (decisão 1: não falha fechado).
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { DISCOVERY_RETRY_DELAYS_MS, listStoredOnce, listStoredWithRetry } from '../src/lib/restoreDiscovery.js';
import { describeSupabaseError } from '../src/lib/supabaseError.js';
import type { StoredSessionLister } from '../src/lib/restoreDiscovery.js';

/** Lista que falha `failures` vezes e depois devolve `ids`. */
function flaky(name: string, failures: number, ids: string[]): StoredSessionLister & { calls: number } {
    const f = {
        name,
        calls: 0,
        async listStoredSessions(): Promise<string[]> {
            f.calls++;
            if (f.calls <= failures) throw new Error('fetch failed');
            return ids;
        },
    };
    return f;
}

const recordSleep = (waited: number[]) => async (ms: number): Promise<void> => { waited.push(ms); };

test('listStoredOnce: erro vira null (não lista vazia); lista vazia continua sendo []', async () => {
    assert.equal(await listStoredOnce(flaky('zapo', 1, ['a'])), null);
    assert.deepEqual(await listStoredOnce(flaky('zapo', 0, [])), []);
});

test('listStoredWithRetry: falha duas vezes, acerta na terceira, esperando antes de cada leitura', async () => {
    const f = flaky('zapo', 2, ['linha-1', 'linha-2']);
    const waited: number[] = [];
    assert.deepEqual(await listStoredWithRetry(f, [10, 20, 40], recordSleep(waited)), ['linha-1', 'linha-2']);
    assert.equal(f.calls, 3);
    assert.deepEqual(waited, [10, 20, 40]);
});

test('listStoredWithRetry: esgota as tentativas e devolve null (sem laço infinito)', async () => {
    const f = flaky('zapo', 99, []);
    const waited: number[] = [];
    assert.equal(await listStoredWithRetry(f, [1, 2, 3], recordSleep(waited)), null);
    assert.equal(f.calls, 3);
    assert.deepEqual(waited, [1, 2, 3]);
});

test('listStoredWithRetry: shouldStop depois da espera cancela sem ler nem logar desistência', async () => {
    const f = flaky('zapo', 0, ['a']);
    let parar = false;
    const sleep = async (): Promise<void> => { parar = true; };
    assert.equal(await listStoredWithRetry(f, [1, 2], sleep, () => parar), null);
    assert.equal(f.calls, 0);
});

test('backoff padrão cobre cerca de 3 minutos', () => {
    const total = DISCOVERY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    assert.ok(total >= 150_000 && total <= 200_000, `total=${total}`);
});

test('restoreAllSessions: baileys restaura já; zapo com banco fora restaura quando ele volta', async () => {
    process.env.SUPABASE_URL = 'http://127.0.0.1:1'; // porta fechada: toda consulta dá erro
    process.env.SUPABASE_SERVICE_KEY = 'service-key-de-teste';
    process.env.WEBHOOK_URL ??= 'https://example.com/functions/v1/whatsapp-webhook';
    process.env.RESTORE_STAGGER_MS = '1';
    const { SessionManager } = await import('../src/services/SessionManager.js');
    const proto = SessionManager.prototype as unknown as Record<string, (...a: unknown[]) => Promise<void>>;

    const baileys = flaky('baileys', 0, ['b1']);
    const zapo = flaky('zapo', 1, ['z1', 'z2']); // 1ª leitura (o boot) falha, a seguinte acerta
    const connected: string[] = [];
    const self: Record<string, unknown> = {
        providers: { all: () => [baileys, zapo] },
        sessions: new Map(),
        connectInFlight: new Map(),
        connect: async (id: string) => { connected.push(id); },
    };
    // Métodos privados reais (restore e nova tentativa); backoff padrão, 2 s na 1ª espera.
    self.restoreStoredSessions = proto.restoreStoredSessions.bind(self);
    self.retryDiscovery = proto.retryDiscovery.bind(self);

    await proto.restoreAllSessions.call(self);
    // O boot restaurou só o baileys; a zapo ficou pendente em segundo plano.
    assert.deepEqual(connected, ['b1']);
    for (let i = 0; i < 80 && connected.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual([...connected].sort(), ['b1', 'z1', 'z2']);
    assert.equal(zapo.calls, 2);
});

/** `this` falso com baileys (b1) e zapo (1ª leitura falha), para as duas provas abaixo. */
async function montarRestore(zapoIds: string[]) {
    process.env.SUPABASE_URL = 'http://127.0.0.1:1';
    process.env.SUPABASE_SERVICE_KEY = 'service-key-de-teste';
    process.env.WEBHOOK_URL ??= 'https://example.com/functions/v1/whatsapp-webhook';
    process.env.RESTORE_STAGGER_MS = '1';
    const { SessionManager } = await import('../src/services/SessionManager.js');
    const proto = SessionManager.prototype as unknown as Record<string, (...a: unknown[]) => Promise<void>>;
    const baileys = flaky('baileys', 0, ['b1']);
    const zapo = flaky('zapo', 1, zapoIds);
    const connected: string[] = [];
    const self: Record<string, unknown> = {
        providers: { all: () => [baileys, zapo] },
        sessions: new Map<string, unknown>(),
        connectInFlight: new Map<string, Promise<string>>(),
        disconnectAlertTimers: new Map(),
        shuttingDown: false,
        connect: async (id: string) => { connected.push(id); },
    };
    self.restoreStoredSessions = proto.restoreStoredSessions.bind(self);
    self.retryDiscovery = proto.retryDiscovery.bind(self);
    return { proto, self, zapo, connected };
}

test('nova tentativa: linha que ganhou sessão ou connect em andamento enquanto o banco estava fora não é reconectada', async () => {
    const { proto, self, zapo, connected } = await montarRestore(['z1', 'z2', 'z3']);
    await proto.restoreAllSessions.call(self);
    assert.deepEqual(connected, ['b1']);
    // Alguém conectou z1 à mão e z2 está conectando, antes da 2ª leitura (2 s de espera).
    (self.sessions as Map<string, unknown>).set('z1', {});
    (self.connectInFlight as Map<string, Promise<string>>).set('z2', Promise.resolve('x'));
    for (let i = 0; i < 80 && zapo.calls < 2; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(zapo.calls, 2);
    for (let i = 0; i < 30 && connected.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    // Só a z3, livre, foi restaurada: a guarda pula z1 e z2 sem bloquear tudo.
    assert.deepEqual(connected, ['b1', 'z3']);
});

test('shutdown no meio do backoff: a nova tentativa não lê nem conecta nada depois do shutdownAll', async () => {
    const { proto, self, zapo, connected } = await montarRestore(['z1', 'z2']);
    await proto.restoreAllSessions.call(self);
    assert.deepEqual(connected, ['b1']);
    await proto.shutdownAll.call(self); // sem sessões abertas: só liga a flag
    assert.equal(self.shuttingDown, true);
    await new Promise((r) => setTimeout(r, 2600)); // passa da 1ª espera (2 s)
    assert.equal(zapo.calls, 1, 'não leu de novo depois do shutdown');
    assert.deepEqual(connected, ['b1']);
});

test('shutdown durante o laço do restore: não conecta as linhas que faltam', async () => {
    const { proto, self, connected } = await montarRestore([]);
    const stored = new Map<string, unknown>([['a', {}], ['b', {}], ['c', {}]]);
    self.shuttingDown = true;
    await (self.restoreStoredSessions as (m: Map<string, unknown>) => Promise<void>)(stored);
    assert.deepEqual(connected, []);
    void proto;
});

test('describeSupabaseError: 502 sem corpo (message vazia) ainda diz o que veio', () => {
    assert.equal(describeSupabaseError({ message: '' }), 'sem mensagem (code=-, details=-, hint=-)');
    assert.equal(
        describeSupabaseError({ message: 'FetchError', code: '502', details: 'Bad Gateway', hint: null }),
        'FetchError (code=502, details=Bad Gateway, hint=-)',
    );
});

test('doConnect resolve o provider uma vez: store e factory são do mesmo provider', async () => {
    const fonte = readFileSync(new URL('../src/services/SessionManager.ts', import.meta.url), 'utf8');
    const inicio = fonte.indexOf('private async doConnect(');
    const fim = fonte.indexOf('\n    async ', inicio);
    assert.ok(inicio > 0 && fim > inicio);
    assert.equal(fonte.slice(inicio, fim).split('providerFor(').length - 1, 1, 'providerFor chamado mais de uma vez em doConnect');

    // Comportamento: a 1ª resolução é a que vale (um providerFor que muda de resposta não troca o factory).
    const { SessionManager } = await import('../src/services/SessionManager.js');
    const proto = SessionManager.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    let chamadas = 0;
    const parada = new Error('PAROU-DEPOIS-DO-STORE');
    const self = {
        providerFor: async () => {
            chamadas++;
            return { name: chamadas === 1 ? 'zapo' : 'baileys', createStore: () => ({ isPaired: async () => { throw parada; } }) };
        },
    };
    await assert.rejects(proto.doConnect.call(self, 'linha-1'), parada);
    assert.equal(chamadas, 1);
});
