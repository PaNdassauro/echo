/**
 * Guarda "só admin adiciona participante" (2.5.6). Adicionar sem ser admin é o que o
 * WhatsApp pune com 401 <conflict> derrubando a sessão. A decisão é pura
 * (src/lib/groupSelf.ts); aqui também se confere que o SessionManager recusa ANTES de
 * chamar a lib, com um `this` falso (mesmo truque do secret-edit.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCanAddParticipants, findSelfParticipant, ownIdentityKeys } from '../src/lib/groupSelf.js';
import type { GroupParticipant, OwnIdentity } from '../src/adapter/types.js';

const ME: OwnIdentity = { jid: '5511999990001:12@s.whatsapp.net', lid: '123456789@lid', phone: '5511999990001' };
const OTHER_ADMIN = '5511888880000@s.whatsapp.net';

const p = (jid: string, role: GroupParticipant['role'] = null, extra: Partial<GroupParticipant> = {}): GroupParticipant =>
    ({ jid, role, ...extra });
const group = (
    participants: GroupParticipant[],
    extra: { suspended?: boolean; growthLockedUntil?: number; subject?: string; memberAddMode?: 'admin_add' | 'all_member_add' } = {}
) =>
    ({ subject: 'Grupo X', participants, ...extra });

test('ownIdentityKeys: JID sem device, LID e telefone cru das credenciais', () => {
    assert.deepEqual(ownIdentityKeys(ME), ['5511999990001@s.whatsapp.net', '123456789@lid']);
    assert.deepEqual(ownIdentityKeys({ jid: '5511999990001@s.whatsapp.net' }), ['5511999990001@s.whatsapp.net']);
    assert.deepEqual(ownIdentityKeys(null), []);
});

test('findSelfParticipant: pelo JID de telefone (grupo endereçado por PN)', () => {
    const me = p('5511999990001@s.whatsapp.net', 'admin');
    assert.equal(findSelfParticipant([p(OTHER_ADMIN, 'superadmin'), me], ME), me);
});

test('findSelfParticipant: pelo LID quando o grupo é endereçado por LID', () => {
    const me = p('123456789@lid', null, { lid: '123456789@lid' });
    assert.equal(findSelfParticipant([p('999@lid'), me], ME), me);
});

test('findSelfParticipant: pelo phoneJid que a lib entrega ao lado de outro LID', () => {
    const me = p('777@lid', 'admin', { phoneJid: '5511999990001@s.whatsapp.net' });
    assert.equal(findSelfParticipant([me], { jid: '5511999990001@s.whatsapp.net' }), me);
});

test('findSelfParticipant: sem identidade (sessão sem creds) ou fora da lista → undefined', () => {
    assert.equal(findSelfParticipant([p('5511999990001@s.whatsapp.net', 'admin')], null), undefined);
    assert.equal(findSelfParticipant([p(OTHER_ADMIN, 'admin')], ME), undefined);
});

test('checkCanAddParticipants: admin e superadmin podem', () => {
    assert.equal(checkCanAddParticipants(group([p('5511999990001@s.whatsapp.net', 'admin')]), ME), null);
    assert.equal(checkCanAddParticipants(group([p('5511999990001@s.whatsapp.net', 'superadmin')]), ME), null);
});

test('checkCanAddParticipants: membro comum é recusado (not_group_admin / not_admin)', () => {
    const block = checkCanAddParticipants(group([p(OTHER_ADMIN, 'admin'), p('5511999990001@s.whatsapp.net')]), ME);
    assert.equal(block?.code, 'not_group_admin');
    assert.equal(block?.reason, 'not_admin');
    assert.match(block?.error ?? '', /não é admin/);
});

test('checkCanAddParticipants: membro comum pode no grupo "todos adicionam"', () => {
    const members = [p(OTHER_ADMIN, 'admin'), p('5511999990001@s.whatsapp.net')];
    assert.equal(checkCanAddParticipants(group(members, { memberAddMode: 'all_member_add' }), ME), null);
    assert.equal(checkCanAddParticipants(group(members, { memberAddMode: 'admin_add' }), ME)?.reason, 'not_admin');
});

test('checkCanAddParticipants: "todos adicionam" não libera linha fora da lista nem grupo restrito', () => {
    const now = 1_700_000_000_000;
    assert.equal(
        checkCanAddParticipants(group([p(OTHER_ADMIN, 'admin')], { memberAddMode: 'all_member_add' }), ME)?.reason,
        'self_not_found'
    );
    const member = [p('5511999990001@s.whatsapp.net')];
    assert.equal(
        checkCanAddParticipants(group(member, { memberAddMode: 'all_member_add', suspended: true }), ME, now)?.reason,
        'suspended'
    );
});

test('checkCanAddParticipants: linha fora da lista é recusada — sem certeza não adiciona', () => {
    const block = checkCanAddParticipants(group([p(OTHER_ADMIN, 'admin')]), ME);
    assert.equal(block?.code, 'not_group_admin');
    assert.equal(block?.reason, 'self_not_found');
});

test('checkCanAddParticipants: grupo suspenso ou com trava de crescimento recusa mesmo admin', () => {
    const admin = [p('5511999990001@s.whatsapp.net', 'superadmin')];
    const now = 1_760_000_000_000;
    assert.equal(checkCanAddParticipants(group(admin, { suspended: true }), ME, now)?.reason, 'suspended');
    assert.equal(checkCanAddParticipants(group(admin, { growthLockedUntil: now + 60_000 }), ME, now)?.reason, 'growth_locked');
    assert.equal(checkCanAddParticipants(group(admin, { growthLockedUntil: now + 60_000 }), ME, now)?.code, 'group_restricted');
    // Trava vencida não bloqueia.
    assert.equal(checkCanAddParticipants(group(admin, { growthLockedUntil: now - 60_000 }), ME, now), null);
});

// --- Fiação no SessionManager: recusa antes de falar com a lib -----------------------

async function loadSessionManager() {
    // O módulo exige as envs do Supabase na importação (sai com exit 1 sem elas);
    // o cliente não conecta em nada só por ser criado.
    process.env.SUPABASE_URL ??= 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_KEY ??= 'test-key';
    return (await import('../src/services/SessionManager.js')).SessionManager;
}

interface FakeOptions {
    /** Como o WhatsApp conhece cada número (lookup). Ausente = conhece do jeito que veio. */
    known?: Record<string, string>;
    /** Números que o lookup diz que não estão no WhatsApp. */
    missing?: string[];
    /** O lookup falha (rede, timeout). */
    lookupFails?: boolean;
    /** Código que o WhatsApp devolve por pessoa no add. */
    addStatus?: string;
}

function fakeSession(
    participants: GroupParticipant[],
    memberAddMode?: 'admin_add' | 'all_member_add',
    options: FakeOptions = {}
) {
    const calls: string[] = [];
    const lookups: string[][] = [];
    const logs: Array<[string, string, string, Record<string, unknown>]> = [];
    const client = {
        me: () => ME,
        getGroup: async () => group(participants, { memberAddMode }),
        lookup: async (phones: string[]) => {
            lookups.push(phones);
            if (options.lookupFails) throw new Error('usync timeout');
            return phones.map((d) => ({
                jid: options.known?.[d] ?? `${d}@s.whatsapp.net`,
                exists: !(options.missing ?? []).includes(d),
            }));
        },
        updateGroupParticipants: async (_jid: string, jids: string[]) => {
            calls.push(...jids);
            return jids.map((jid) => ({ jid, status: options.addStatus ?? '200' }));
        },
    };
    const session = { phoneNumberId: 'pn-1', client, status: 'connected' };
    const cache = new Map<string, string>();
    /** Prazo pedido a cada gravação no cache (undefined = o padrão do cache, 6 h). */
    const ttls = new Map<string, number | undefined>();
    const self: Record<string, unknown> = {
        sessions: new Map([['pn-1', session]]),
        clientOf: () => client,
        debugLog: async (...args: [string, string, string, Record<string, unknown>]) => { logs.push(args); },
        outboundJidCache: cache,
        cacheSet: (c: Map<string, string>, key: string, value: string, ttl?: number) => {
            c.set(key, value);
            ttls.set(key, ttl);
        },
    };
    return { self, calls, lookups, logs, cache, ttls };
}

/** Liga no falso as peças reais do SessionManager que o add usa: o lookup do envio e a tradução do erro lançado. */
function wire(SessionManager: Awaited<ReturnType<typeof loadSessionManager>>, self: Record<string, unknown>) {
    const proto = SessionManager.prototype as unknown as Record<string, unknown>;
    self.resolveOutboundJid = proto.resolveOutboundJid;
    self.getBaileysThrownMessage = proto.getBaileysThrownMessage;
    return self;
}

test('SessionManager.addGroupParticipants: linha sem admin → 403 lógico, lib NÃO é chamada', async () => {
    const SessionManager = await loadSessionManager();
    const { self, calls, logs } = fakeSession([p(OTHER_ADMIN, 'superadmin'), p('5511999990001@s.whatsapp.net')]);
    const result = await SessionManager.prototype.addGroupParticipants.call(self, 'pn-1', '120363@g.us', ['5511777770000']);
    assert.equal(result.success, false);
    assert.equal(result.code, 'not_group_admin');
    assert.deepEqual(calls, []);
    assert.equal(logs[0]?.[1], 'group_add_blocked');
    assert.equal(logs[0]?.[3].reason, 'not_admin');
});

test('SessionManager.addGroupParticipants: linha admin → segue para a lib', async () => {
    const SessionManager = await loadSessionManager();
    const { self, calls } = fakeSession([p(OTHER_ADMIN, 'superadmin'), p('5511999990001@s.whatsapp.net', 'admin')]);
    const result = await SessionManager.prototype.addGroupParticipants.call(wire(SessionManager, self), 'pn-1', '120363@g.us', ['5511777770000']);
    assert.equal(result.success, true);
    assert.deepEqual(calls, ['5511777770000@s.whatsapp.net']);
});

test('SessionManager.addGroupParticipants: membro comum em grupo "todos adicionam" → segue para a lib', async () => {
    const SessionManager = await loadSessionManager();
    const { self, calls } = fakeSession([p(OTHER_ADMIN, 'superadmin'), p('5511999990001@s.whatsapp.net')], 'all_member_add');
    const result = await SessionManager.prototype.addGroupParticipants.call(wire(SessionManager, self), 'pn-1', '120363@g.us', ['5511777770000']);
    assert.equal(result.success, true);
    assert.deepEqual(calls, ['5511777770000@s.whatsapp.net']);
});

// Números fictícios. O caso que originou isto: o cadastro tem o celular com o
// 9º dígito e o WhatsApp conhece a conta sem ele (conta antiga, DDD 11).
const COM_9 = '5511999990006';
const NO_WHATSAPP = '551199990006@s.whatsapp.net';
const FORA_DO_WHATSAPP = '5511999990007';
const ADMIN_GROUP = () => [p(OTHER_ADMIN, 'superadmin'), p('5511999990001@s.whatsapp.net', 'admin')];

test('SessionManager.addGroupParticipants: número com o 9 vai no JID que o WhatsApp conhece', async () => {
    const SessionManager = await loadSessionManager();
    const { self, calls, lookups } = fakeSession(ADMIN_GROUP(), undefined, { known: { [COM_9]: NO_WHATSAPP } });
    const result = await SessionManager.prototype.addGroupParticipants.call(wire(SessionManager, self), 'pn-1', '120363@g.us', [COM_9]);
    assert.equal(result.success, true);
    assert.deepEqual(lookups, [[COM_9]]);
    assert.deepEqual(calls, [NO_WHATSAPP]);
});

test('SessionManager.addGroupParticipants: segundo add do mesmo número usa o cache, sem lookup novo', async () => {
    const SessionManager = await loadSessionManager();
    const { self, lookups, calls } = fakeSession(ADMIN_GROUP(), undefined, { known: { [COM_9]: NO_WHATSAPP } });
    const wired = wire(SessionManager, self);
    await SessionManager.prototype.addGroupParticipants.call(wired, 'pn-1', '120363@g.us', [COM_9]);
    await SessionManager.prototype.addGroupParticipants.call(wired, 'pn-1', '120363@g.us', [COM_9]);
    assert.equal(lookups.length, 1);
    assert.deepEqual(calls, [NO_WHATSAPP, NO_WHATSAPP]);
});

test('SessionManager.addGroupParticipants: recusa 451 chega à tela como frase, não "Erro 451"', async () => {
    const SessionManager = await loadSessionManager();
    const { self } = fakeSession(ADMIN_GROUP(), undefined, { addStatus: '451' });
    const result = await SessionManager.prototype.addGroupParticipants.call(wire(SessionManager, self), 'pn-1', '120363@g.us', [COM_9]);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /não reconheceu este número/);
    assert.doesNotMatch(result.error ?? '', /Erro 451/);
});

test('SessionManager.addGroupParticipants: JID pronto (LID) não passa pelo lookup', async () => {
    const SessionManager = await loadSessionManager();
    const { self, calls, lookups } = fakeSession(ADMIN_GROUP());
    await SessionManager.prototype.addGroupParticipants.call(wire(SessionManager, self), 'pn-1', '120363@g.us', ['99887766@lid']);
    assert.deepEqual(lookups, []);
    assert.deepEqual(calls, ['99887766@lid']);
});

test('SessionManager.addGroupParticipants: lookup diz "não está no WhatsApp" → vai cru, como antes, e a palavra final é do WhatsApp', async () => {
    const SessionManager = await loadSessionManager();
    const { self, calls, cache, ttls } = fakeSession(ADMIN_GROUP(), undefined, { missing: [FORA_DO_WHATSAPP], addStatus: '451' });
    const result = await SessionManager.prototype.addGroupParticipants.call(wire(SessionManager, self), 'pn-1', '120363@g.us', [FORA_DO_WHATSAPP]);
    assert.deepEqual(calls, [`${FORA_DO_WHATSAPP}@s.whatsapp.net`]);
    assert.equal(cache.get(`pn-1:${FORA_DO_WHATSAPP}`), `${FORA_DO_WHATSAPP}@s.whatsapp.net`);
    assert.equal(ttls.get(`pn-1:${FORA_DO_WHATSAPP}`), 600);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /não reconheceu este número/);
});

test('SessionManager.addGroupParticipants: lookup que falha → vai cru e não guarda nada', async () => {
    const SessionManager = await loadSessionManager();
    const { self, calls, cache } = fakeSession(ADMIN_GROUP(), undefined, { lookupFails: true });
    const result = await SessionManager.prototype.addGroupParticipants.call(wire(SessionManager, self), 'pn-1', '120363@g.us', [COM_9]);
    assert.equal(result.success, true);
    assert.deepEqual(calls, [`${COM_9}@s.whatsapp.net`]);
    assert.equal(cache.size, 0);
});

test('SessionManager.addGroupParticipants: número achado fica no cache pelo prazo padrão (6 h)', async () => {
    const SessionManager = await loadSessionManager();
    const { self, ttls } = fakeSession(ADMIN_GROUP(), undefined, { known: { [COM_9]: NO_WHATSAPP } });
    await SessionManager.prototype.addGroupParticipants.call(wire(SessionManager, self), 'pn-1', '120363@g.us', [COM_9]);
    assert.ok(ttls.has(`pn-1:${COM_9}`));
    assert.equal(ttls.get(`pn-1:${COM_9}`), undefined);
});

test('SessionManager.addGroupParticipants: privacidade (403 com convite) usa o número corrigido', async () => {
    const SessionManager = await loadSessionManager();
    const { self } = fakeSession(ADMIN_GROUP(), undefined, { known: { [COM_9]: NO_WHATSAPP } });
    const client = (self.clientOf as () => Record<string, unknown>)();
    client.updateGroupParticipants = async (_jid: string, jids: string[]) =>
        jids.map((jid) => ({ jid, status: '403', inviteCode: 'ABC123', inviteExpiration: 1795000000 }));
    const result = await SessionManager.prototype.addGroupParticipants.call(wire(SessionManager, self), 'pn-1', '120363@g.us', [COM_9]);
    assert.equal(result.success, true);
    assert.deepEqual(result.inviteRequired, [
        { phone: NO_WHATSAPP.replace('@s.whatsapp.net', ''), jid: NO_WHATSAPP, code: 'ABC123', expiration: 1795000000 },
    ]);
});

test('SessionManager.createGroup: quem entra na criação vai no JID do WhatsApp; quem não está segue cru, como antes', async () => {
    const SessionManager = await loadSessionManager();
    const { self, lookups } = fakeSession([], undefined, { known: { [COM_9]: NO_WHATSAPP }, missing: [FORA_DO_WHATSAPP] });
    const created: string[][] = [];
    const client = (self.clientOf as () => Record<string, unknown>)();
    client.createGroup = async (_name: string, jids: string[]) => {
        created.push(jids);
        return { jid: '120363999@g.us' };
    };
    const result = await SessionManager.prototype.createGroup.call(
        wire(SessionManager, self), 'pn-1', 'Grupo teste', [COM_9, FORA_DO_WHATSAPP, '554199990001@s.whatsapp.net']
    );
    assert.equal(result.success, true);
    assert.deepEqual(lookups, [[COM_9], [FORA_DO_WHATSAPP]]);
    assert.deepEqual(created, [[NO_WHATSAPP, `${FORA_DO_WHATSAPP}@s.whatsapp.net`, '554199990001@s.whatsapp.net']]);
});
