/**
 * Paridade Baileys × zapo (auditoria de paridade). Cada teste trava uma lacuna que
 * passou meses em silêncio porque o contrato de teste não exercitava o caminho: stub
 * que devolvia vazio, premissa falsa sobre a lib, capability anunciada sem caminho real.
 *
 * O cliente da zapo roda de verdade; só o WaClient é trocado por um falso que grava as
 * chamadas e dispara eventos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { decryptPollVote as baileysDecryptPollVote, proto } from '@whiskeysockets/baileys';
import { ZapoClientFactory } from '../src/adapter/zapo/index.js';
import { ZAPO_CAPABILITIES, toMediaDownloadError, zapoErrorStatus } from '../src/adapter/zapo/ZapoClient.js';
import { MediaDownloadError, ReachoutRejectedError, type WhatsAppClient } from '../src/adapter/WhatsAppClient.js';
import type { ClientEventMap, ClientEventName, MessageContent } from '../src/adapter/types.js';
import { decryptPollVotePayload, encryptPollVotePayload } from '../src/adapter/proto/pollVote.js';
import { normalizeContent } from '../src/adapter/proto/content.js';
import type { ProtoMessage } from '../src/adapter/proto/types.js';

// -- harness --------------------------------------------------------------------

type Call = { fn: string; args: unknown[] };

class FakeWa extends EventEmitter {
    calls: Call[] = [];
    sendImpl: (to: string, content: unknown, options?: unknown) => Promise<{ id: string }> = async () => ({ id: 'SENT1' });
    reuploadResult: { result: string; directPath?: string } = { result: 'success', directPath: '/v/t62/novo' };
    private rec(fn: string, ...args: unknown[]) { this.calls.push({ fn, args }); }
    message = {
        send: (to: string, content: unknown, options?: unknown) => { this.rec('send', to, content, options); return this.sendImpl(to, content, options); },
        sendReceipt: async (jid: string, ids: string[], opts: unknown) => { this.rec('sendReceipt', jid, ids, opts); },
        requestMediaReupload: async (req: unknown) => { this.rec('requestMediaReupload', req); return { messageId: 'x', resultCode: 0, ...this.reuploadResult }; },
    };
    group = {
        setSetting: async (jid: string, name: string, enabled: boolean) => { this.rec('setSetting', jid, name, enabled); },
    };
    getCredentials() { return null; }
    callsOf(fn: string) { return this.calls.filter((c) => c.fn === fn); }
}

function makeClient() {
    const factory = new ZapoClientFactory({ kind: 'memory' });
    const client = factory.create({ sessionId: `t-${randomBytes(4).toString('hex')}`, store: factory.createStore('t') });
    const wa = new FakeWa();
    const internal = client as unknown as { wa: unknown; bind(wa: unknown): void; identity: unknown };
    internal.wa = wa;
    internal.identity = { jid: '554100000001@s.whatsapp.net', lid: '99999@lid', phone: '554100000001' };
    internal.bind(wa);
    return { client, wa };
}

function collect<E extends ClientEventName>(client: WhatsAppClient, event: E): ClientEventMap[E][] {
    const out: ClientEventMap[E][] = [];
    client.on(event, ((payload: ClientEventMap[E]) => out.push(payload)) as never);
    return out;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function incoming(message: ProtoMessage, key: Partial<{ id: string; remoteJid: string; fromMe: boolean; participant: string; remoteJidAlt: string; participantAlt: string }> = {}) {
    return {
        key: { id: 'IN1', remoteJid: '5511999990002@s.whatsapp.net', fromMe: false, isGroup: false, ...key },
        message,
        timestampSeconds: 1_700_000_000,
        rawNode: { tag: 'message', attrs: { t: '1700000000' } },
    };
}

// -- enquete ----------------------------------------------------------------------

const POLL_ID = '3EB0POLL0000000001';
const CREATOR = '554100000001@s.whatsapp.net';
const VOTER = '5511999990002@s.whatsapp.net';

test('voto recebido: decifra de verdade (hashes das opções), não devolve [] fixo', () => {
    const { client } = makeClient();
    const secret = randomBytes(32);
    const plaintext = proto.Message.PollVoteMessage.encode({ selectedOptions: [createHash('sha256').update('Sim').digest()] }).finish();
    const vote = encryptPollVotePayload(plaintext, secret, { pollMsgId: POLL_ID, creatorJid: CREATOR, voterJid: VOTER });
    const hashes = client.decryptPollVote({ pollKey: { id: POLL_ID, chatJid: VOTER, fromMe: true }, handle: { vote } }, secret, CREATOR, VOTER);
    assert.deepEqual(hashes, [createHash('sha256').update('Sim').digest('hex')]);
});

test('voto recebido: combinação criador×votante errada LANÇA (o serviço tenta a próxima)', () => {
    const { client } = makeClient();
    const secret = randomBytes(32);
    const plaintext = proto.Message.PollVoteMessage.encode({ selectedOptions: [createHash('sha256').update('Sim').digest()] }).finish();
    const vote = encryptPollVotePayload(plaintext, secret, { pollMsgId: POLL_ID, creatorJid: CREATOR, voterJid: VOTER });
    const ref = { pollKey: { id: POLL_ID, chatJid: VOTER, fromMe: true }, handle: { vote } };
    assert.throws(() => client.decryptPollVote(ref, secret, CREATOR, '123456@lid'));
    assert.throws(() => client.decryptPollVote(ref, randomBytes(32), CREATOR, VOTER));
});

test('cripto do voto é a mesma do WhatsApp (o Baileys abre o que ciframos)', () => {
    const secret = randomBytes(32);
    const plaintext = proto.Message.PollVoteMessage.encode({ selectedOptions: [createHash('sha256').update('Talvez').digest()] }).finish();
    const enc = encryptPollVotePayload(plaintext, secret, { pollMsgId: POLL_ID, creatorJid: CREATOR, voterJid: VOTER });
    const opened = baileysDecryptPollVote(enc, { pollCreatorJid: CREATOR, pollMsgId: POLL_ID, pollEncKey: secret, voterJid: VOTER });
    assert.equal(Buffer.from(opened.selectedOptions![0]!).toString('hex'), createHash('sha256').update('Talvez').digest('hex'));
});

test('voto do painel: votante explícito, [] permitido (retirar) e participant = criador em grupo', async () => {
    const { client, wa } = makeClient();
    const secret = randomBytes(32);
    const group = '120363000000000001@g.us';
    await client.votePoll(group, { pollKey: { id: POLL_ID, chatJid: group, fromMe: false }, pollSecret: secret, voterJid: '99999@lid', creatorJid: '777@lid', selectedOptions: [] });
    const [call] = wa.callsOf('send');
    const upd = (call!.args[1] as { pollUpdateMessage: { pollCreationMessageKey: { participant?: string }; vote: { encPayload: Uint8Array; encIv: Uint8Array } } }).pollUpdateMessage;
    assert.equal(upd.pollCreationMessageKey.participant, '777@lid');
    // Decifra com o votante LID que pedimos — a lib usava sempre o nosso PN.
    const plain = decryptPollVotePayload(upd.vote, secret, { pollMsgId: POLL_ID, creatorJid: '777@lid', voterJid: '99999@lid' });
    assert.equal(proto.Message.PollVoteMessage.decode(plain).selectedOptions.length, 0);
});

test('message_addon de voto/edição não duplica o caminho cru', async () => {
    const { client, wa } = makeClient();
    const upserts = collect(client, 'messages.upsert');
    wa.emit('message_addon', { key: { id: 'A1', remoteJid: VOTER, fromMe: false }, targetMessageId: POLL_ID, rawNode: { attrs: {} }, raw: {}, decrypted: { kind: 'poll_vote', pollVote: {}, selectedOptionNames: null } });
    wa.emit('message_addon', { key: { id: 'A2', remoteJid: VOTER, fromMe: false }, targetMessageId: 'X', rawNode: { attrs: {} }, raw: {}, decrypted: { kind: 'message_edit', message: {} } });
    await tick();
    assert.equal(upserts.length, 0);
});

// -- eventos --------------------------------------------------------------------

test('protocolo não é processado em dobro (message + message_protocol)', async () => {
    const { client, wa } = makeClient();
    const upserts = collect(client, 'messages.upsert');
    const ev = incoming({ protocolMessage: { type: 0, key: { id: 'OLD', remoteJid: VOTER, fromMe: false } } });
    wa.emit('message', ev);
    wa.emit('message_protocol', { ...ev, protocolMessage: ev.message.protocolMessage });
    await tick();
    assert.equal(upserts.length, 1);
});

test('falha de decifragem vira stub ciphertext — mas só se nenhuma parte da stanza decifrou', async () => {
    const { client, wa } = makeClient();
    const upserts = collect(client, 'messages.upsert');
    const fail = (id: string) => wa.emit('debug_unhandled_stanza', { stanzaId: id, chatJid: VOTER, reason: 'message.decrypt_failed.pkmsg', rawNode: { attrs: { t: '1700000000' } } });
    fail('LOST1');
    fail('PARTIAL1');
    wa.emit('message', incoming({ conversation: 'oi' }, { id: 'PARTIAL1' }));
    await tick(3200);
    const contents = upserts.flatMap((u) => u.messages).map((m) => [m.key.id, m.content.type]);
    assert.deepEqual(contents, [['PARTIAL1', 'text'], ['LOST1', 'undecryptable']]);
    const lost = upserts.flatMap((u) => u.messages).find((m) => m.key.id === 'LOST1')!.content as Extract<MessageContent, { type: 'undecryptable' }>;
    assert.equal(lost.stub, 'ciphertext');
    assert.equal(lost.resendRequested, true);
});

test('troca de foto vira contacts.update (invalida avatar); request é ignorado', async () => {
    const { client, wa } = makeClient();
    const updates = collect(client, 'contacts.update');
    wa.emit('picture', { action: 'set', targetJid: VOTER, rawNode: { attrs: {} } });
    wa.emit('picture', { action: 'delete', targetJid: '555@lid', rawNode: { attrs: {} } });
    wa.emit('picture', { action: 'request', targetJid: VOTER, rawNode: { attrs: {} } });
    await tick();
    assert.deepEqual(updates.flat(), [{ jid: VOTER, avatar: 'changed' }, { jid: '555@lid', avatar: 'removed' }]);
});

test('par LID↔telefone da mensagem vira lid-mapping.update (uma vez)', async () => {
    const { client, wa } = makeClient();
    const maps = collect(client, 'lid-mapping.update');
    const ev = incoming({ conversation: 'oi' }, { remoteJid: '888@lid', remoteJidAlt: '5511999990003@s.whatsapp.net' });
    wa.emit('message', ev);
    wa.emit('message', { ...ev, key: { ...ev.key, id: 'IN2' } });
    await tick();
    assert.deepEqual(maps, [{ lid: '888@lid', pn: '5511999990003@s.whatsapp.net' }]);
});

test('autor de evento de grupo leva telefone e nome da notificação', async () => {
    const { client, wa } = makeClient();
    const updates = collect(client, 'group-participants.update');
    wa.emit('group', { action: 'add', groupJid: '1203@g.us', authorJid: '444@lid', participants: [{ jid: '555@lid' }], rawNode: { attrs: { participant_pn: '5511999990004@s.whatsapp.net', participant_username: 'Ana' } } });
    await tick();
    assert.deepEqual(updates[0]!.author, { jid: '444@lid', phoneJid: '5511999990004@s.whatsapp.net', name: 'Ana' });
});

test('troca do nome do grupo vira group-subject.update (antes era descartada)', async () => {
    const { client, wa } = makeClient();
    const updates = collect(client, 'group-subject.update');
    wa.emit('group', { action: 'subject', groupJid: '1203@g.us', authorJid: '444@lid', subject: ' Equipe Vendas - 2027 ', timestampSeconds: 1_794_000_000, details: { subjectOwnerPhoneJid: '5511999990004@s.whatsapp.net' }, rawNode: { attrs: {} } });
    wa.emit('group', { action: 'subject', groupJid: '1203@g.us', authorJid: '444@lid', subject: '  ', rawNode: { attrs: {} } });
    await tick();
    assert.deepEqual(updates, [{ groupJid: '1203@g.us', subject: 'Equipe Vendas - 2027', author: { jid: '444@lid', phoneJid: '5511999990004@s.whatsapp.net', name: undefined }, timestamp: 1_794_000_000 }]);
});

test('view-once sem corpo (message_unavailable) mantém isViewOnce', async () => {
    const { client, wa } = makeClient();
    const upserts = collect(client, 'messages.upsert');
    wa.emit('message_unavailable', { kind: 'view_once', key: { id: 'VO1', remoteJid: VOTER, fromMe: false }, rawNode: { attrs: {} } });
    await tick();
    assert.equal(upserts[0]!.messages[0]!.isViewOnce, true);
});

test('recibo usa a hora da stanza, não a de processamento', async () => {
    const { client, wa } = makeClient();
    const receipts = collect(client, 'message-receipt.update');
    wa.emit('receipt', { chatJid: '1203@g.us', participantJid: '555@lid', status: 'read', messageIds: ['M1'], rawNode: { attrs: { t: '1700000123' } } });
    await tick();
    assert.equal(receipts[0]![0]!.timestamp, 1_700_000_123_000);
});

// Recibo 1:1 → status da nossa mensagem chega depois da folga de 2 s para o eco.
const CONTACT = '5511999990001@s.whatsapp.net';

test('recibo 1:1 do contato vira status lido da nossa mensagem', async () => {
    const { client, wa } = makeClient();
    const updates = collect(client, 'messages.update');
    wa.emit('receipt', { chatJid: CONTACT, status: 'read', fromSelfDevice: false, messageIds: ['OUT1'], rawNode: { attrs: {} } });
    await tick(2100);
    assert.deepEqual(updates.flat(), [{ key: { id: 'OUT1', chatJid: CONTACT, fromMe: true }, type: 'status', status: 'read' }]);
});

test('recibo do nosso aparelho (from=nosso LID, recipient=contato) não vira status', async () => {
    const { client, wa } = makeClient();
    const updates = collect(client, 'messages.update');
    const receipts = collect(client, 'message-receipt.update');
    wa.emit('receipt', { chatJid: '99999:3@lid', recipientJid: CONTACT, status: 'read', fromSelfDevice: false, messageIds: ['IN1', 'IN2'], rawNode: { attrs: {} } });
    await tick(2100);
    assert.equal(updates.length, 0);
    assert.equal(receipts[0]![0]!.key.fromMe, false);
    assert.equal(receipts[0]![0]!.key.chatJid, CONTACT);
});

test('recibo do nosso jid sem recipient também não vira status', async () => {
    const { client, wa } = makeClient();
    const updates = collect(client, 'messages.update');
    wa.emit('receipt', { chatJid: '554100000001@s.whatsapp.net', status: 'read', fromSelfDevice: false, messageIds: ['X1'], rawNode: { attrs: {} } });
    await tick(2100);
    assert.equal(updates.length, 0);
});

test('read-self continua sem status', async () => {
    const { client, wa } = makeClient();
    const updates = collect(client, 'messages.update');
    wa.emit('receipt', { chatJid: CONTACT, status: 'read', fromSelfDevice: true, messageIds: ['IN3'], rawNode: { attrs: {} } });
    await tick(2100);
    assert.equal(updates.length, 0);
});

// -- envio / operações ------------------------------------------------------------

test('toda mensagem enviada leva e devolve o segredo (abre edição feita no aparelho)', async () => {
    const { client, wa } = makeClient();
    const sent = await client.send(VOTER, { type: 'text', text: 'oi' });
    assert.equal(sent.messageSecret?.length, 32);
    const options = wa.callsOf('send')[0]!.args[2] as { messageSecret?: Uint8Array };
    assert.deepEqual(Buffer.from(options.messageSecret!), sent.messageSecret);
    const reaction = await client.send(VOTER, { type: 'reaction', reaction: { targetKey: { id: 'X', chatJid: VOTER, fromMe: false }, emoji: '👍' } });
    assert.equal(reaction.messageSecret, undefined);
});

test('resposta leva o conteúdo citado (prévia no aparelho do contato)', async () => {
    const { client, wa } = makeClient();
    await client.send(VOTER, { type: 'text', text: 'resposta' }, { quoted: { key: { id: 'Q1', chatJid: VOTER, fromMe: false }, content: { type: 'text', text: 'pergunta' } } });
    const quote = (wa.callsOf('send')[0]!.args[2] as { quote: { key: { id: string }; message: { conversation: string } } }).quote;
    assert.equal(quote.key.id, 'Q1');
    assert.equal(quote.message.conversation, 'pergunta');
});

test('463 no envio: ReachoutRejectedError + messages.update error 463 (liga o bloqueio local)', async () => {
    const { client, wa } = makeClient();
    const updates = collect(client, 'messages.update');
    wa.sendImpl = async () => { throw new Error('negative publish ack: tag=ack id=ABC class=message error=463'); };
    await assert.rejects(client.send(VOTER, { type: 'text', text: 'oi' }, { messageId: 'MID' }), ReachoutRejectedError);
    assert.deepEqual(updates.flat(), [{ key: { id: 'MID', chatJid: VOTER, fromMe: true }, type: 'status', status: 'error', errorCode: '463' }]);
});

test('código de status sai do texto do erro da zapo (nack e IQ)', () => {
    assert.equal(zapoErrorStatus('negative publish ack: tag=ack id=1 error=463'), 463);
    assert.equal(zapoErrorStatus('group.addParticipants iq failed (403: forbidden)'), 403);
    assert.equal(zapoErrorStatus('picture iq failed (429: rate-overlimit)'), 429);
    assert.equal(zapoErrorStatus('socket closed'), undefined);
});

test('tique azul em grupo: um recibo por remetente', async () => {
    const { client, wa } = makeClient();
    const g = '1203@g.us';
    await client.markRead([
        { id: 'A', chatJid: g, fromMe: false, participantJid: '1@lid' },
        { id: 'B', chatJid: g, fromMe: false, participantJid: '2@lid' },
        { id: 'C', chatJid: g, fromMe: false, participantJid: '1@lid' },
    ]);
    const sent = wa.callsOf('sendReceipt').map((c) => [c.args[1], (c.args[2] as { participant?: string }).participant]);
    assert.deepEqual(sent, [[['A', 'C'], '1@lid'], [['B'], '2@lid']]);
});

test('"só admins enviam" usa a chave announcement da zapo', async () => {
    const { client, wa } = makeClient();
    await client.updateGroupSetting('1203@g.us', 'announcement');
    await client.updateGroupSetting('1203@g.us', 'unlocked');
    assert.deepEqual(wa.callsOf('setSetting').map((c) => [c.args[1], c.args[2]]), [['announcement', true], ['restrict', false]]);
});

test('mídia expirada: pede reupload e grava o directPath novo no handle', async () => {
    const { client, wa } = makeClient();
    const image = { mediaKey: new Uint8Array(32).fill(1), directPath: '/v/velho', url: 'https://mmg.whatsapp.net/velho' };
    const ref = { kind: 'image' as const, handle: { typeKey: 'imageMessage', message: { imageMessage: image } } };
    await client.requestMediaRetry({ id: 'M1', chatJid: VOTER, fromMe: false }, ref);
    assert.equal(wa.callsOf('requestMediaReupload').length, 1);
    assert.equal(image.directPath, '/v/t62/novo');
    assert.equal(image.url, undefined);
    wa.reuploadResult = { result: 'not_found' };
    await assert.rejects(client.requestMediaRetry({ id: 'M1', chatJid: VOTER, fromMe: false }, ref));
});

test('403 ao adicionar devolve o convite para mandar por DM', async () => {
    const { client } = makeClient();
    const internal = client as unknown as { requireClient(): unknown; wa: { group: Record<string, unknown> } };
    internal.wa.group.addParticipants = async () => [{
        jid: '5511999990005@s.whatsapp.net', status: 'error', code: 403,
        raw: { tag: 'participant', attrs: {}, content: [{ tag: 'add_request', attrs: { code: 'CONVITE123', expiration: '1700999999' } }] },
    }];
    const [r] = await client.updateGroupParticipants('1203@g.us', ['5511999990005@s.whatsapp.net'], 'add');
    assert.equal(r!.status, '403');
    assert.equal(r!.inviteCode, 'CONVITE123');
    assert.equal(r!.inviteExpiration, 1700999999);
});

// -- capabilities: anunciar só o que tem caminho real ---------------------------

test('zapo não anuncia history_fetch (as mensagens do chunk vão para o store none)', () => {
    assert.equal(ZAPO_CAPABILITIES.has('history_fetch'), false);
});

// -- normalizador compartilhado ---------------------------------------------------

test('associatedChildMessage (álbum) e questionReplyMessage são desembrulhados', () => {
    const album = normalizeContent({ associatedChildMessage: { message: { imageMessage: { mimetype: 'image/jpeg', caption: 'foto 2' } } } } as ProtoMessage, VOTER);
    assert.equal(album.type, 'media');
    assert.equal((album as Extract<MessageContent, { type: 'media' }>).media.kind, 'image');
    const reply = normalizeContent({ questionReplyMessage: { message: { conversation: 'resposta' } } } as ProtoMessage, VOTER);
    assert.deepEqual(reply, { type: 'text', text: 'resposta' });
});

test('cópia HD de mídia já entregue não vira segunda bolha', () => {
    const hd = normalizeContent({
        associatedChildMessage: { message: { imageMessage: { mimetype: 'image/jpeg' }, messageContextInfo: { messageAssociation: { associationType: 10 } } } },
    } as unknown as ProtoMessage, VOTER);
    assert.equal(hd.type, 'unsupported');
    assert.equal((hd as { skip?: string }).skip, 'deliberate');
});

test('reação/comentário cifrados não viram "[Mensagem não suportada]"', () => {
    for (const key of ['encReactionMessage', 'encCommentMessage']) {
        const c = normalizeContent({ [key]: { encPayload: new Uint8Array(4) } } as unknown as ProtoMessage, VOTER);
        assert.equal((c as { skip?: string }).skip, 'deliberate', key);
    }
});

test('download cortado no meio (Error: aborted, ECONNRESET) é rede e o serviço tenta de novo', () => {
    // Forma exata do node:https quando o CDN fecha a conexão no meio do corpo (áudio de grupo
    // perdido na hora porque caía em 'unknown' e não havia retry).
    const aborted = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    assert.equal(toMediaDownloadError(aborted).reason, 'network');
    assert.equal(toMediaDownloadError(new Error('aborted')).reason, 'network');
    const wrapped = Object.assign(new Error('read failed'), { cause: { code: 'ETIMEDOUT' } });
    assert.equal(toMediaDownloadError(wrapped).reason, 'network');
    // Os outros ramos seguem como estavam.
    assert.equal(toMediaDownloadError(new Error('download failed with status 403 for https://mmg')).reason, 'expired');
    assert.equal(toMediaDownloadError(new Error('media MAC mismatch')).reason, 'unknown');
    assert.equal(toMediaDownloadError(new Error('response exceeded max bytes')).reason, 'too_large');
    const own = new MediaDownloadError('x', 'not_found');
    assert.equal(toMediaDownloadError(own), own);
});
