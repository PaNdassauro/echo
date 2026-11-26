/**
 * Troca do nome do grupo chega ao Echo (2.5.13). Antes, a troca feita pelo Echo e o aviso
 * `subject` do WhatsApp não saíam do serviço: o Echo só via o nome novo de carona numa
 * mensagem, depois de o cache de 1 h expirar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import NodeCache from 'node-cache';
import { groupSubjectEvent } from '../src/lib/groupSubject.js';

const GROUP = '120363000000000001@g.us';
const T = 1_794_000_000;

test('groupSubjectEvent: id por grupo + nome + dia, texto com o autor', () => {
    const evt = groupSubjectEvent({ groupJid: GROUP, subject: '  Equipe Vendas - 2027 ', actorName: 'Ana', timestamp: T });
    assert.ok(evt);
    assert.match(evt.eventId, /^grpevt_120363000000000001_subject_[0-9a-f]{12}_\d+$/);
    assert.equal(evt.content, 'Ana mudou o nome do grupo para "Equipe Vendas - 2027"');
});

test('groupSubjectEvent: troca do Echo e aviso do WhatsApp no mesmo dia dão o mesmo id', () => {
    const a = groupSubjectEvent({ groupJid: GROUP, subject: 'Vendas', actorName: 'Linha', timestamp: T });
    const b = groupSubjectEvent({ groupJid: GROUP, subject: 'Vendas', actorPhone: '5511999990001', timestamp: T + 5 });
    assert.equal(a?.eventId, b?.eventId);
    const outroNome = groupSubjectEvent({ groupJid: GROUP, subject: 'Vendas 2', timestamp: T });
    assert.notEqual(outroNome?.eventId, a?.eventId);
    const outroDia = groupSubjectEvent({ groupJid: GROUP, subject: 'Vendas', timestamp: T + 86_400 });
    assert.notEqual(outroDia?.eventId, a?.eventId);
});

test('groupSubjectEvent: sem autor, texto neutro; nome vazio ou JID que não é grupo → null', () => {
    assert.equal(groupSubjectEvent({ groupJid: GROUP, subject: 'X', timestamp: T })?.content, 'O nome do grupo mudou para "X"');
    assert.equal(groupSubjectEvent({ groupJid: GROUP, subject: '   ', timestamp: T }), null);
    assert.equal(groupSubjectEvent({ groupJid: '5511999990001@s.whatsapp.net', subject: 'X', timestamp: T }), null);
});

// --- Fiação no SessionManager ---------------------------------------------------------

async function loadSessionManager() {
    process.env.SUPABASE_URL ??= 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_KEY ??= 'test-key';
    process.env.WEBHOOK_URL ??= 'https://example.com/functions/v1/whatsapp-webhook';
    return (await import('../src/services/SessionManager.js')).SessionManager;
}

function fakeSelf(client?: Record<string, unknown>) {
    const jobs: Array<{ route: string; wamid: string; body: Record<string, unknown> }> = [];
    const self: Record<string, unknown> = {
        groupMetadataCache: new NodeCache(),
        groupMetaFullCache: new NodeCache(),
        lidPhoneCache: new NodeCache(),
        lidNameCache: new NodeCache(),
        cacheSet: (cache: NodeCache, key: string, value: unknown) => cache.set(key, value),
        outbox: { enqueue: async (job: { route: string; wamid: string; body: Record<string, unknown> }) => { jobs.push(job); } },
        sessions: new Map(client ? [['pn-1', { client, status: 'connected' }]] : []),
        clientOf: () => client,
    };
    return { self, jobs };
}

test('handleGroupSubjectUpdate: atualiza o cache do nome e manda o evento subject ao Echo', async () => {
    const SessionManager = await loadSessionManager();
    const { self, jobs } = fakeSelf();
    (self.groupMetadataCache as NodeCache).set(GROUP, { subject: 'Velho', participants: ['a@lid'] });
    (self.groupMetaFullCache as NodeCache).set(GROUP, { subject: 'Velho' });
    (self.lidPhoneCache as NodeCache).set('444', '5511999990004');
    self.handleGroupSubjectUpdate = (SessionManager.prototype as unknown as Record<string, unknown>).handleGroupSubjectUpdate;

    await (self.handleGroupSubjectUpdate as Function).call(self, 'pn-1', { groupJid: GROUP, subject: 'Novo', author: { jid: '444@lid', name: 'Ana' }, timestamp: T });

    assert.deepEqual((self.groupMetadataCache as NodeCache).get(GROUP), { subject: 'Novo', participants: ['a@lid'] });
    assert.equal((self.groupMetaFullCache as NodeCache).get(GROUP), undefined);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].route, 'qr-group-event');
    assert.equal(jobs[0].body.group_subject, 'Novo');
    assert.equal(jobs[0].body.action, 'subject');
    assert.equal(jobs[0].body.event_id, jobs[0].wamid);
    assert.deepEqual(jobs[0].body.actor, { jid: '444@lid', phone: '5511999990004', name: 'Ana' });
    assert.equal(jobs[0].body.content, 'Ana mudou o nome do grupo para "Novo"');
});

test('updateGroupSubject: depois do sucesso na lib, avisa o Echo com a própria linha como autor', async () => {
    const SessionManager = await loadSessionManager();
    const calls: Array<[string, string]> = [];
    const client = {
        updateGroupSubject: async (jid: string, subject: string) => { calls.push([jid, subject]); },
        me: () => ({ jid: '5511999990001:12@s.whatsapp.net', phone: '5511999990001', name: 'Acme' }),
    };
    const { self, jobs } = fakeSelf(client);
    self.handleGroupSubjectUpdate = (SessionManager.prototype as unknown as Record<string, unknown>).handleGroupSubjectUpdate;

    const result = await SessionManager.prototype.updateGroupSubject.call(self as never, 'pn-1', GROUP, 'Equipe Vendas - 2027');
    await new Promise((r) => setTimeout(r, 0));

    assert.deepEqual(result, { success: true });
    assert.deepEqual(calls, [[GROUP, 'Equipe Vendas - 2027']]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].body.group_subject, 'Equipe Vendas - 2027');
    assert.equal((jobs[0].body.actor as { phone: string }).phone, '5511999990001');
});

test('updateGroupSubject: lib falhou → nada vai ao Echo', async () => {
    const SessionManager = await loadSessionManager();
    const client = { updateGroupSubject: async () => { throw new Error('not-authorized'); }, me: () => null };
    const { self, jobs } = fakeSelf(client);
    self.handleGroupSubjectUpdate = (SessionManager.prototype as unknown as Record<string, unknown>).handleGroupSubjectUpdate;
    const result = await SessionManager.prototype.updateGroupSubject.call(self as never, 'pn-1', GROUP, 'X');
    assert.equal(result.success, false);
    assert.equal(jobs.length, 0);
});
