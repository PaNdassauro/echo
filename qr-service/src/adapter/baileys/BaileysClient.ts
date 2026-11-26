import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import makeWASocket, {
    DisconnectReason,
    WA_CERT_DETAILS,
    aesEncryptGCM,
    decryptPollVote,
    downloadContentFromMessage,
    generateMessageID,
    generateWAMessageFromContent,
    hmacSign,
    jidNormalizedUser,
    proto,
    useMultiFileAuthState,
    type BaileysEventMap,
    type DownloadableMessage,
    type GroupMetadata,
    type WAMessage,
    type WASocket,
} from '@whiskeysockets/baileys';
import type NodeCache from 'node-cache';
import type { Readable } from 'stream';
import type { ClientConfig, ClientListener, WhatsAppClient } from '../WhatsAppClient.js';
import { MediaDownloadError, ReachoutRejectedError, WhatsAppClientError } from '../WhatsAppClient.js';
import type {
    AuthSnapshot,
    Capability,
    ChatState,
    ClientEventMap,
    ClientEventName,
    GlobalPresence,
    GroupInfo,
    GroupInviteInfo,
    GroupJoinRequest,
    GroupParticipantResult,
    GroupSetting,
    InboundMessage,
    Jid,
    LidMapping,
    MediaRef,
    MessageContent,
    MessageKey,
    MessageReceipt,
    MessageUpdate,
    OutboundContent,
    OwnIdentity,
    PollVoteRef,
    PollVoteRequest,
    ProfileInfo,
    CallUpdate,
    MessageCapping,
    ReachoutTimelock,
    SendOptions,
    SendResult,
    WhatsAppLookup,
} from '../types.js';
import { FileSessionStore } from './FileSessionStore.js';
import { writeMediaStreamToFile } from '../mediaFile.js';
import { editedTextOf, normalizeContent } from '../proto/content.js';
import type { ProtoMessage } from '../proto/types.js';
import { decryptSecretEditPlaintext, type SecretEncryptedEdit } from '../proto/secretEdit.js';
import {
    normalizeActor,
    normalizeDisconnect,
    normalizeGroup,
    normalizeKey,
    normalizeMessage,
    normalizeParticipant,
    normalizeStatus,
    toBaileysKey,
    toMillis,
} from './inbound.js';
import { toBaileysContent, toBaileysOptions } from './outbound.js';
import { resolveWaVersion } from './waVersion.js';
import { extractUnsupportedFallback } from '../proto/messageFallback.js';

export const BAILEYS_LIBRARY_ID = 'baileys@7.0.0-rc14';

export const BAILEYS_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
    'qr', 'pairing_code', 'poll_create', 'poll_vote', 'reaction', 'edit', 'revoke', 'lid',
    'history_fetch', 'media_retry', 'placeholder_resend', 'view_once_placeholder',
    'group_join_requests', 'group_invite_info', 'reachout_timelock', 'message_capping', 'presence_subscribe',
    'chat_state', 'profile_picture', 'auth_snapshot',
]);

/** Timestamps da notificação de capping chegam como string (epoch em segundos ou ISO). */
function cappingTimestamp(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : undefined;
}

type BaileysCapInfo = {
    total_quota?: number; used_quota?: number; cycle_start_timestamp?: string; cycle_end_timestamp?: string;
    ote_status?: string; mv_status?: string; capping_status?: string;
};

function normalizeCapping(info: BaileysCapInfo | undefined): MessageCapping {
    return {
        status: info?.capping_status ?? 'NONE',
        totalQuota: info?.total_quota ?? undefined,
        usedQuota: info?.used_quota ?? undefined,
        cycleStart: cappingTimestamp(info?.cycle_start_timestamp),
        cycleEnd: cappingTimestamp(info?.cycle_end_timestamp),
        oteStatus: info?.ote_status ?? undefined,
        mvStatus: info?.mv_status ?? undefined,
        raw: info,
    };
}

/** Dependências específicas do Baileys que a factory compartilha entre sessões. */
export interface BaileysRuntime {
    /** Contador de retries de decrypt por mensagem, compartilhado como hoje no SessionManager. */
    msgRetryCounterCache?: NodeCache;
}

type MediaHandle = { typeKey: string; message: proto.IMessage };

function isMediaHandle(value: unknown): value is MediaHandle {
    return typeof value === 'object' && value !== null && 'typeKey' in value && 'message' in value;
}

/** Expirada (precisa de reupload pelo aparelho) × rede (tentar de novo) × outro. */
function classifyDownloadError(error: unknown): 'expired' | 'network' | 'not_found' | 'unknown' {
    const status = boomStatus(error);
    const err = error as { code?: string; name?: string; message?: string } | undefined;
    const code = String(err?.code ?? '');
    const message = String(err?.message ?? '').toLowerCase();
    if (status === 404 || status === 410 || status === 403) return 'expired';
    if (code.includes('ERR_OSSL') || message.includes('bad decrypt') || /\b(410|404|403)\b/.test(message)
        || message.includes('not found') || message.includes('forbidden') || message.includes('expired')) return 'expired';
    if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE|ENOTFOUND/.test(code) || err?.name === 'AggregateError'
        || message.includes('fetch failed') || message.includes('socket hang up') || message.includes('timeout')
        || message.includes('network') || /\b50[0-9]\b/.test(message) || (status !== undefined && status >= 500)) return 'network';
    return 'unknown';
}

function boomStatus(error: unknown): number | undefined {
    return error instanceof Boom ? error.output.statusCode : (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}

/**
 * Implementação do contrato sobre o Baileys. Um cliente = um socket = uma sessão.
 * Não reconecta sozinho: o serviço decide a partir de `connection.update`.
 */
export class BaileysClient implements WhatsAppClient {
    readonly libraryId = BAILEYS_LIBRARY_ID;
    readonly capabilities = BAILEYS_CAPABILITIES;
    readonly sessionId: string;

    private readonly emitter = new EventEmitter();
    private readonly store: FileSessionStore;
    private socket: WASocket | null = null;
    private open = false;
    private registered = false;
    private identity: OwnIdentity | null = null;
    private pairingRequested = false;
    private closing = false;
    /** Segredos de enquete que este cliente criou/recebeu (para decifrar votos). */
    private readonly pollSecrets = new Map<string, Buffer>();

    constructor(private readonly config: ClientConfig, private readonly runtime: BaileysRuntime = {}) {
        this.sessionId = config.sessionId;
        if (!(config.store instanceof FileSessionStore)) {
            throw new WhatsAppClientError('BaileysClient exige FileSessionStore', 'bad_store');
        }
        this.store = config.store;
        this.emitter.setMaxListeners(50);
    }

    // -- ciclo de vida -------------------------------------------------------

    async connect(): Promise<void> {
        if (this.socket) throw new WhatsAppClientError('Socket já existe; feche antes de reconectar', 'already_connected');
        await this.store.ensureDir();
        const { state, saveCreds } = await useMultiFileAuthState(this.store.dir);
        this.registered = !!state.creds.me?.id;

        const transport = this.config.transport;
        if (transport?.noiseRootCa) {
            // Só testes: confia na raiz do fake-server no lugar da pinada do WhatsApp.
            WA_CERT_DETAILS.PUBLIC_KEY = Buffer.from(transport.noiseRootCa.publicKey);
            WA_CERT_DETAILS.SERIAL = transport.noiseRootCa.serial;
        }
        const version = transport?.waVersion ?? await resolveWaVersion();

        const socket = makeWASocket({
            auth: state,
            version,
            // Só quando há override: a chave presente com undefined APAGA o default da lib.
            ...(transport?.socketUrl ? { waWebSocketUrl: transport.socketUrl } : {}),
            printQRInTerminal: false,
            logger: pino({ level: this.config.logLevel ?? 'warn' }),
            browser: this.config.pairing && !state.creds.registered
                ? ['Ubuntu', 'Chrome', '22.04.4']
                : ['Echo WPP', 'Chrome', '125.0.0.0'],
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            markOnlineOnConnect: false,
            retryRequestDelayMs: 250,
            msgRetryCounterCache: this.runtime.msgRetryCounterCache,
            cachedGroupMetadata: this.config.getCachedGroup
                ? async (jid) => {
                    const cached = await this.config.getCachedGroup!(jid);
                    return cached ? ((cached as GroupInfo & { raw?: GroupMetadata }).raw ?? undefined) : undefined;
                }
                : undefined,
            getMessage: async (key) => {
                const raw = key.id ? this.config.getSentMessage?.(key.id) : undefined;
                if (!raw) return undefined;
                // O serviço guarda o WAMessage inteiro (SendResult.raw); o Baileys quer o corpo.
                const asWa = raw as { message?: proto.IMessage | null; key?: unknown };
                return (asWa.key !== undefined ? asWa.message ?? undefined : (raw as proto.IMessage)) ?? undefined;
            },
            shouldSyncHistoryMessage: ({ syncType }) => {
                const kind = this.historyKind(syncType);
                return this.config.shouldAcceptHistory ? this.config.shouldAcceptHistory(kind) : kind === 'recent' || kind === 'on_demand';
            },
        });
        this.socket = socket;
        this.pairingRequested = false;
        this.closing = false;
        this.bind(socket, saveCreds);
    }

    async close(): Promise<void> {
        const socket = this.socket;
        if (!socket) return;
        // Os listeners ficam: o 'close' que o Baileys emite vira connection.update
        // com cause 'closed_by_us', e o serviço sabe que não é queda.
        this.closing = true;
        // end() destrói o event-buffer SEM flush: eventos já recebidos morreriam.
        try { socket.ev.flush(); } catch { /* buffer pode já estar destruído */ }
        const closed = new Promise<void>((resolve) => {
            const timer = setTimeout(finish, 5000);
            function finish(): void {
                clearTimeout(timer);
                resolve();
            }
            socket.ev.on('connection.update', (u) => { if (u.connection === 'close') finish(); });
        });
        socket.end(undefined);
        await closed;
        if (this.socket === socket) this.socket = null;
        this.open = false;
    }

    async logout(): Promise<void> {
        const socket = this.socket;
        if (socket) {
            try { await socket.logout(); } catch { /* servidor pode já ter derrubado */ }
        }
        await this.close();
        await this.store.wipe();
        this.registered = false;
        this.identity = null;
    }

    isRegistered(): boolean { return this.registered; }
    isOpen(): boolean { return this.open; }
    connectionState(): 'connecting' | 'open' | 'closed' {
        const ws = (this.socket as unknown as { ws?: { readyState?: number } } | null)?.ws;
        const state = ws?.readyState;
        if (state === 1 && this.open) return 'open';
        if (state === 0 || state === 1) return 'connecting';
        return 'closed';
    }
    me(): OwnIdentity | null { return this.identity; }

    async requestPairingCode(): Promise<string> {
        const socket = this.requireSocket();
        const phone = this.config.pairing?.phone;
        if (!phone) throw new WhatsAppClientError('Sessão não configurada para pairing code', 'no_pairing_phone');
        this.pairingRequested = true;
        const code = await socket.requestPairingCode(phone);
        this.emit('pairing_code', { code });
        return code;
    }

    on<E extends ClientEventName>(event: E, listener: ClientListener<E>): void {
        this.emitter.on(event, listener as (...args: unknown[]) => void);
    }

    off<E extends ClientEventName>(event: E, listener: ClientListener<E>): void {
        this.emitter.off(event, listener as (...args: unknown[]) => void);
    }

    removeAllListeners(): void {
        this.emitter.removeAllListeners();
    }

    // -- credenciais ---------------------------------------------------------

    async exportAuthSnapshot(): Promise<AuthSnapshot> {
        if (this.socket) throw new WhatsAppClientError('Feche o socket antes de exportar', 'socket_open');
        return this.store.exportSnapshot(this.libraryId);
    }

    async importAuthSnapshot(snapshot: AuthSnapshot): Promise<{ losses: string[] }> {
        if (this.socket) throw new WhatsAppClientError('Feche o socket antes de importar', 'socket_open');
        await this.store.importSnapshot(snapshot);
        this.registered = true;
        return { losses: [] };
    }

    // -- mensagens -----------------------------------------------------------

    async send(to: Jid, content: OutboundContent, opts?: SendOptions): Promise<SendResult> {
        const socket = this.requireSocket();
        if (content.type === 'edit' && content.edit.captionOf) {
            return this.sendCaptionEdit(to, content.edit.targetKey, content.edit.captionOf, content.edit.newText);
        }
        const baileysContent = toBaileysContent(content);
        if (opts?.mentionedJids?.length && 'text' in baileysContent) {
            (baileysContent as { mentions?: string[] }).mentions = opts.mentionedJids;
        }
        if (opts?.forwarded) {
            (baileysContent as { contextInfo?: proto.IContextInfo }).contextInfo = { isForwarded: true, forwardingScore: 1 };
        }
        let sent: WAMessage | undefined;
        try {
            const options = toBaileysOptions(opts);
            if (content.type === 'group_invite') {
                // Miniatura do grupo no card de convite (o Baileys busca via este hook).
                (options as { getProfilePicUrl?: (jid: string, type: 'preview' | 'image') => Promise<string | undefined> }).getProfilePicUrl =
                    async (jid, type) => { try { return await socket.profilePictureUrl(jid, type); } catch { return undefined; } };
            }
            sent = await socket.sendMessage(to, baileysContent, options);
        } catch (error) {
            throw this.translateError(error, to);
        }
        if (!sent) throw new WhatsAppClientError('sendMessage não devolveu a mensagem', 'send_no_result');
        const secret = sent.message?.messageContextInfo?.messageSecret;
        if (secret && sent.key.id) this.pollSecrets.set(sent.key.id, Buffer.from(secret));
        return {
            key: normalizeKey(sent.key),
            timestamp: toMillis(sent.messageTimestamp),
            messageSecret: secret ? Buffer.from(secret) : undefined,
            pollSecret: content.type === 'poll' && secret ? Buffer.from(secret) : undefined,
            raw: sent,
        };
    }

    /** Edição de legenda: o Baileys só edita texto via sendMessage; legenda vai como protocolMessage cru. */
    private async sendCaptionEdit(to: Jid, target: MessageKey, mediaKind: 'image' | 'video' | 'document', caption: string): Promise<SendResult> {
        const socket = this.requireSocket();
        const field = `${mediaKind}Message` as 'imageMessage' | 'videoMessage' | 'documentMessage';
        const editedMessage: proto.IMessage = { [field]: { caption } };
        const wamsg = generateWAMessageFromContent(
            to,
            {
                protocolMessage: {
                    key: toBaileysKey(target),
                    type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
                    editedMessage,
                    timestampMs: Date.now(),
                },
            },
            { userJid: this.identity?.jid ?? '' },
        );
        try {
            await socket.relayMessage(to, wamsg.message!, { messageId: wamsg.key.id! });
        } catch (error) {
            throw this.translateError(error, to);
        }
        return { key: normalizeKey(wamsg.key), timestamp: Date.now(), raw: wamsg };
    }

    async votePoll(relayJid: Jid, vote: PollVoteRequest): Promise<{ messageId: string }> {
        const socket = this.requireSocket();
        const plaintext = proto.Message.PollVoteMessage.encode({
            selectedOptions: vote.selectedOptions.map((name) => createHash('sha256').update(name).digest()),
        }).finish();
        const pollMsgId = vote.pollKey.id;
        // Derivação da chave do voto (mesma do WhatsApp Web): HKDF manual via HMAC.
        const sign = Buffer.concat([
            Buffer.from(pollMsgId),
            Buffer.from(vote.creatorJid),
            Buffer.from(vote.voterJid),
            Buffer.from('Poll Vote'),
            Buffer.from([1]),
        ]);
        const key0 = hmacSign(vote.pollSecret, Buffer.alloc(32), 'sha256');
        const encKey = hmacSign(sign, key0, 'sha256');
        const encIv = randomBytes(12);
        const aad = Buffer.from(`${pollMsgId}\u0000${vote.voterJid}`);
        const encPayload = aesEncryptGCM(plaintext, encKey, encIv, aad);
        // Round-trip local: se não decifra aqui, não decifraria no aparelho.
        const check = decryptPollVote({ encPayload, encIv }, {
            pollCreatorJid: vote.creatorJid,
            pollMsgId,
            pollEncKey: new Uint8Array(vote.pollSecret),
            voterJid: vote.voterJid,
        });
        if ((check.selectedOptions?.length ?? 0) !== vote.selectedOptions.length) {
            throw new WhatsAppClientError('selectedOptions divergentes no round-trip', 'poll_vote_selfcheck');
        }
        const isGroup = relayJid.endsWith('@g.us');
        const pollCreationMessageKey: proto.IMessageKey = {
            remoteJid: relayJid,
            id: pollMsgId,
            fromMe: vote.pollKey.fromMe,
            ...(isGroup ? { participant: vote.creatorJid } : {}),
        };
        const messageId = generateMessageID();
        try {
            await socket.relayMessage(
                relayJid,
                { pollUpdateMessage: { pollCreationMessageKey, vote: { encPayload, encIv }, senderTimestampMs: Date.now() } },
                { messageId, additionalNodes: [{ tag: 'meta', attrs: { polltype: 'vote' } }] },
            );
        } catch (error) {
            throw this.translateError(error, relayJid);
        }
        return { messageId };
    }

    async markRead(keys: MessageKey[]): Promise<void> {
        await this.requireSocket().readMessages(keys.map(toBaileysKey));
    }

    async downloadMedia(ref: MediaRef, opts?: { maxBytes?: number }): Promise<Buffer> {
        try {
            const stream = await this.openMediaStream(ref, opts);
            const chunks: Buffer[] = [];
            let total = 0;
            for await (const chunk of stream) {
                const buf = chunk as Buffer;
                total += buf.length;
                if (opts?.maxBytes && total > opts.maxBytes) {
                    stream.destroy();
                    throw new MediaDownloadError(`download passou de ${opts.maxBytes} bytes`, 'too_large');
                }
                chunks.push(buf);
            }
            return Buffer.concat(chunks);
        } catch (error) {
            if (error instanceof MediaDownloadError) throw error;
            throw new MediaDownloadError((error as Error)?.message ?? String(error), classifyDownloadError(error), error);
        }
    }

    async downloadMediaToFile(ref: MediaRef, filePath: string, opts?: { maxBytes?: number }): Promise<number> {
        try {
            return await writeMediaStreamToFile(await this.openMediaStream(ref, opts), filePath, opts?.maxBytes);
        } catch (error) {
            if (error instanceof MediaDownloadError) throw error;
            throw new MediaDownloadError((error as Error)?.message ?? String(error), classifyDownloadError(error), error);
        }
    }

    /** Valida o ponteiro e abre o stream decifrado do CDN. */
    private async openMediaStream(ref: MediaRef, opts?: { maxBytes?: number }): Promise<Readable> {
        if (!isMediaHandle(ref.handle)) throw new MediaDownloadError('handle inválido', 'unknown');
        const { typeKey, message } = ref.handle;
        const inner = typeKey === 'documentWithCaptionMessage'
            ? message.documentWithCaptionMessage?.message?.documentMessage
            : (message as Record<string, unknown>)[typeKey];
        const downloadable = inner as DownloadableMessage | undefined;
        if (!downloadable?.mediaKey) throw new MediaDownloadError('mensagem sem mediaKey', 'not_found');
        if (opts?.maxBytes && ref.fileLength && ref.fileLength > opts.maxBytes) {
            throw new MediaDownloadError(`mídia de ${ref.fileLength} bytes excede ${opts.maxBytes}`, 'too_large');
        }
        const baileysType = ref.kind === 'video' && ref.isVideoNote ? 'ptv' : ref.kind;
        return downloadContentFromMessage(downloadable, baileysType, {
            host: this.config.transport?.mediaHost,
        });
    }

    async requestMediaRetry(key: MessageKey, ref: MediaRef): Promise<void> {
        if (!isMediaHandle(ref.handle)) throw new MediaDownloadError('handle inválido', 'unknown');
        await this.requireSocket().updateMediaMessage({ key: toBaileysKey(key), message: ref.handle.message });
    }

    async requestPlaceholderResend(keys: MessageKey[]): Promise<Array<string | undefined>> {
        const socket = this.requireSocket();
        const ids: Array<string | undefined> = [];
        for (const key of keys) ids.push(await socket.requestPlaceholderResend(toBaileysKey(key)));
        return ids;
    }

    async fetchHistory(count: number, oldest: { key: MessageKey; timestamp: number }): Promise<string> {
        return this.requireSocket().fetchMessageHistory(count, toBaileysKey(oldest.key), Math.floor(oldest.timestamp / 1000));
    }

    decryptPollVote(vote: PollVoteRef, pollSecret: Buffer, pollCreatorJid: Jid, voterJid: Jid): string[] {
        const update = vote.handle as proto.Message.IPollUpdateMessage;
        const enc = update.vote;
        if (!enc?.encPayload || !enc.encIv) return [];
        const decrypted = decryptPollVote(
            { encPayload: enc.encPayload, encIv: enc.encIv },
            { pollCreatorJid, pollMsgId: vote.pollKey.id, pollEncKey: pollSecret, voterJid },
        );
        return (decrypted.selectedOptions ?? []).map((o) => Buffer.from(o).toString('hex'));
    }

    decryptSecretEdit(handle: unknown, messageSecret: Buffer, authorJid: Jid): string | null {
        const plaintext = decryptSecretEditPlaintext(handle as SecretEncryptedEdit | undefined, messageSecret, authorJid);
        if (!plaintext) return null;
        try {
            return editedTextOf(proto.Message.decode(plaintext) as ProtoMessage) || null;
        } catch {
            return null;
        }
    }

    describe(content: MessageContent): string {
        if (content.type === 'unsupported') return content.description ?? '[Mensagem não suportada]';
        if (content.type === 'text') return content.text;
        return `[${content.type}]`;
    }

    normalize(raw: unknown): InboundMessage | null {
        const msg = raw as WAMessage | undefined;
        if (!msg?.key) return null;
        return normalizeMessage(msg);
    }

    // -- contatos / presença -------------------------------------------------

    async lookup(phones: string[]): Promise<WhatsAppLookup[]> {
        const results = await this.call('onWhatsApp', (s) => s.onWhatsApp(...phones));
        return (results ?? []).map((r) => {
            const lid = (r as { lid?: string | number }).lid;
            return { jid: r.jid, exists: r.exists === true, lid: lid !== undefined ? String(lid) : undefined };
        });
    }

    async getProfile(jid: Jid): Promise<ProfileInfo> {
        const socket = this.requireSocket();
        const [status, pictureUrl] = await Promise.all([
            socket.fetchStatus(jid).catch(() => undefined),
            socket.profilePictureUrl(jid, 'image').catch(() => undefined),
        ]);
        const first = status?.[0]?.status as { status?: string } | undefined;
        return { jid, status: first?.status, pictureUrl: pictureUrl ?? null };
    }

    async getProfilePictureUrl(jid: Jid, size: 'preview' | 'image' = 'image'): Promise<string | null> {
        try {
            return (await this.call('profilePictureUrl', (s) => s.profilePictureUrl(jid, size))) ?? null;
        } catch (error) {
            if (boomStatus(error) === 404) return null;
            throw this.translateError(error, jid);
        }
    }

    async updateOwnName(name: string): Promise<void> { await this.call('updateProfileName', (s) => s.updateProfileName(name)); }
    async updateOwnPicture(image: Buffer): Promise<void> {
        const me = this.identity?.jid;
        if (!me) throw new WhatsAppClientError('sem identidade própria', 'not_paired');
        await this.call('updateProfilePicture', (s) => s.updateProfilePicture(me, image));
    }
    async setGlobalPresence(presence: GlobalPresence): Promise<void> { await this.call('sendPresenceUpdate', (s) => s.sendPresenceUpdate(presence)); }
    async sendChatState(to: Jid, state: ChatState): Promise<void> { await this.call('sendPresenceUpdate', (s) => s.sendPresenceUpdate(state, to)); }
    async subscribePresence(jid: Jid): Promise<void> { await this.call('presenceSubscribe', (s) => s.presenceSubscribe(jid)); }

    async lookupPnsForLids(lids: Jid[]): Promise<Map<Jid, Jid>> {
        const out = new Map<Jid, Jid>();
        if (!lids.length) return out;
        const pairs = await this.call('lidMapping.getPNsForLIDs', (s) => s.signalRepository.lidMapping.getPNsForLIDs(lids));
        for (const pair of pairs ?? []) {
            if (pair.lid && pair.pn) out.set(pair.lid, pair.pn);
        }
        return out;
    }

    async lidForPn(pn: Jid): Promise<Jid | null> {
        const mapped = await this.call('lidMapping.getLIDForPN', (s) => s.signalRepository.lidMapping.getLIDForPN(pn)).catch(() => null);
        return mapped ? jidNormalizedUser(mapped) : null;
    }

    async pnForLid(lid: Jid): Promise<Jid | null> {
        const mapped = await this.call('lidMapping.getPNForLID', (s) => s.signalRepository.lidMapping.getPNForLID(lid)).catch(() => null);
        return mapped ? jidNormalizedUser(mapped) : null;
    }

    async storeLidMappings(pairs: LidMapping[]): Promise<void> {
        if (!pairs.length) return;
        await this.call('lidMapping.storeLIDPNMappings', (s) => s.signalRepository.lidMapping.storeLIDPNMappings(pairs));
    }

    // -- ligação de voz: o Baileys não tem pilha de mídia; só sinalização de recusa.

    private noVoice(): never {
        throw new WhatsAppClientError('Ligação de voz não suportada pelo provider baileys', 'unsupported_by_provider', 501);
    }
    async startCall(): Promise<{ callId: string }> { return this.noVoice(); }
    async endCall(): Promise<void> { return this.noVoice(); }
    async acceptCall(): Promise<void> { return this.noVoice(); }
    setCallLiveAudio(): void { this.noVoice(); }
    feedCallAudio(): number { return this.noVoice(); }
    setCallMuted(): void { this.noVoice(); }
    getCall(): CallUpdate | null { return null; }
    listCalls(): CallUpdate[] { return []; }

    async fetchMessageCapping(): Promise<MessageCapping> {
        const info = await this.call('fetchNewChatMessageCap', (s) => s.fetchNewChatMessageCap());
        return normalizeCapping(info as BaileysCapInfo | undefined);
    }

    async fetchReachoutTimelock(): Promise<ReachoutTimelock> {
        const state = await this.call('fetchAccountReachoutTimelock', (s) => s.fetchAccountReachoutTimelock());
        return {
            isActive: state?.isActive === true,
            lockedUntil: state?.timeEnforcementEnds?.getTime(),
            enforcementType: state?.enforcementType ? String(state.enforcementType) : undefined,
            raw: state,
        };
    }

    // -- grupos --------------------------------------------------------------

    async createGroup(subject: string, participants: Jid[]): Promise<GroupInfo> {
        return normalizeGroup(await this.call('groupCreate', (s) => s.groupCreate(subject, participants)));
    }
    async getGroup(jid: Jid): Promise<GroupInfo> {
        const meta = await this.call('groupMetadata', (s) => s.groupMetadata(jid));
        return Object.assign(normalizeGroup(meta), { raw: meta });
    }
    async listGroups(): Promise<GroupInfo[]> {
        const all = await this.call('groupFetchAllParticipating', (s) => s.groupFetchAllParticipating());
        return Object.values(all).map(normalizeGroup);
    }
    async leaveGroup(jid: Jid): Promise<void> { await this.call('groupLeave', (s) => s.groupLeave(jid)); }

    async updateGroupParticipants(jid: Jid, participants: Jid[], action: 'add' | 'remove' | 'promote' | 'demote'): Promise<GroupParticipantResult[]> {
        const results = await this.call('groupParticipantsUpdate', (s) => s.groupParticipantsUpdate(jid, participants, action));
        return results.map((r) => {
            const content = r.content as { attrs?: Record<string, string>; content?: Array<{ tag?: string; attrs?: Record<string, string> }> } | undefined;
            const invite = content?.content?.find((n) => n.tag === 'add_request');
            const phone = content?.attrs?.phone_number;
            return {
                jid: r.jid ?? '',
                phoneJid: phone?.endsWith('@s.whatsapp.net') ? phone : undefined,
                status: String(r.status),
                inviteCode: invite?.attrs?.code,
                inviteExpiration: invite?.attrs?.expiration ? Number(invite.attrs.expiration) : undefined,
            };
        });
    }
    async updateGroupSubject(jid: Jid, subject: string): Promise<void> { await this.call('groupUpdateSubject', (s) => s.groupUpdateSubject(jid, subject)); }
    async updateGroupDescription(jid: Jid, description: string | null): Promise<void> {
        await this.call('groupUpdateDescription', (s) => s.groupUpdateDescription(jid, description ?? undefined));
    }
    async updateGroupPicture(jid: Jid, image: Buffer): Promise<void> { await this.call('updateProfilePicture', (s) => s.updateProfilePicture(jid, image)); }
    async updateGroupSetting(jid: Jid, setting: GroupSetting): Promise<void> { await this.call('groupSettingUpdate', (s) => s.groupSettingUpdate(jid, setting)); }
    async updateGroupEphemeral(jid: Jid, seconds: number): Promise<void> { await this.call('groupToggleEphemeral', (s) => s.groupToggleEphemeral(jid, seconds)); }
    async updateGroupMemberAddMode(jid: Jid, mode: 'admin_add' | 'all_member_add'): Promise<void> {
        await this.call('groupMemberAddMode', (s) => s.groupMemberAddMode(jid, mode));
    }
    async updateGroupJoinApprovalMode(jid: Jid, on: boolean): Promise<void> {
        await this.call('groupJoinApprovalMode', (s) => s.groupJoinApprovalMode(jid, on ? 'on' : 'off'));
    }
    async getGroupInviteCode(jid: Jid): Promise<string> {
        const code = await this.call('groupInviteCode', (s) => s.groupInviteCode(jid));
        if (!code) throw new WhatsAppClientError('grupo sem código de convite', 'no_invite_code');
        return code;
    }
    async revokeGroupInviteCode(jid: Jid): Promise<string> {
        const code = await this.call('groupRevokeInvite', (s) => s.groupRevokeInvite(jid));
        if (!code) throw new WhatsAppClientError('falha ao revogar convite', 'no_invite_code');
        return code;
    }
    async getGroupInviteInfo(code: string): Promise<GroupInviteInfo> {
        const meta = await this.call('groupGetInviteInfo', (s) => s.groupGetInviteInfo(code));
        return { jid: meta.id, subject: meta.subject, size: meta.size, description: meta.desc, ownerJid: meta.owner, creation: meta.creation };
    }
    async acceptGroupInvite(code: string): Promise<Jid> {
        const jid = await this.call('groupAcceptInvite', (s) => s.groupAcceptInvite(code));
        if (!jid) throw new WhatsAppClientError('convite não aceito', 'invite_rejected');
        return jid;
    }
    async listGroupJoinRequests(jid: Jid): Promise<GroupJoinRequest[]> {
        const list = await this.call('groupRequestParticipantsList', (s) => s.groupRequestParticipantsList(jid));
        return list.map((r) => ({
            jid: r.jid,
            phoneJid: r.phone_number ?? undefined,
            requestMethod: r.request_method,
            requestTime: r.request_time ? Number(r.request_time) : undefined,
        }));
    }
    async updateGroupJoinRequests(jid: Jid, participants: Jid[], action: 'approve' | 'reject'): Promise<GroupParticipantResult[]> {
        const results = await this.call('groupRequestParticipantsUpdate', (s) => s.groupRequestParticipantsUpdate(jid, participants, action));
        return results.map((r) => ({ jid: r.jid ?? '', status: String(r.status) }));
    }

    // -- internos ------------------------------------------------------------

    /** Executa uma chamada no socket traduzindo o erro da lib para o contrato. */
    private async call<T>(scope: string, fn: (socket: WASocket) => Promise<T>): Promise<T> {
        try {
            return await fn(this.requireSocket());
        } catch (error) {
            throw this.translateError(error, scope);
        }
    }

    private requireSocket(): WASocket {
        if (!this.socket) throw new WhatsAppClientError('Sessão sem socket', 'not_connected');
        return this.socket;
    }

    private emit<E extends ClientEventName>(event: E, payload: ClientEventMap[E]): void {
        this.emitter.emit(event, payload);
    }

    private historyKind(syncType: number | null | undefined): 'recent' | 'on_demand' | 'full' | 'other' {
        const T = proto.HistorySync.HistorySyncType;
        if (syncType === T.RECENT) return 'recent';
        if (syncType === T.ON_DEMAND) return 'on_demand';
        if (syncType === T.FULL || syncType === T.INITIAL_BOOTSTRAP) return 'full';
        return 'other';
    }

    private translateError(error: unknown, to: Jid): WhatsAppClientError {
        if (error instanceof WhatsAppClientError) return error;
        // IQ de grupo/perfil: o Baileys embrulha em Boom 500 e põe o código real em `data`.
        const data = (error as { data?: unknown } | undefined)?.data;
        const status = typeof data === 'number' ? data : boomStatus(error);
        const message = (error as Error)?.message ?? String(error);
        if (status === 463 || /reachout|timelock/i.test(message)) return new ReachoutRejectedError(to, undefined, error);
        return new WhatsAppClientError(message, status ? `wa_${status}` : 'unknown', status, error);
    }

    private bind(socket: WASocket, saveCreds: () => Promise<void>): void {
        const on = <T extends keyof BaileysEventMap>(event: T, handler: (arg: BaileysEventMap[T]) => void | Promise<void>) => {
            socket.ev.on(event, (arg) => {
                Promise.resolve()
                    .then(() => handler(arg))
                    .catch((error: unknown) => this.emit('error', { scope: event, error }));
            });
        };

        on('creds.update', async () => {
            await saveCreds();
            const me = socket.authState.creds.me;
            this.registered = !!me?.id;
            if (me?.id) {
                this.identity = {
                    jid: jidNormalizedUser(me.id),
                    lid: me.lid ? jidNormalizedUser(me.lid) : undefined,
                    phone: me.id.split('@')[0]?.split(':')[0],
                    name: me.name ?? undefined,
                };
            }
            this.emit('creds.update', { registered: this.registered, me: this.identity ?? undefined });
        });

        on('connection.update', async (update) => {
            if (update.qr) this.emit('qr', { qr: update.qr });
            if (update.connection === 'open') {
                this.open = true;
                const me = socket.authState.creds.me;
                if (me?.id) {
                    this.identity = {
                        jid: jidNormalizedUser(me.id),
                        lid: me.lid ? jidNormalizedUser(me.lid) : undefined,
                        phone: me.id.split('@')[0]?.split(':')[0],
                        name: me.name ?? undefined,
                    };
                    this.registered = true;
                }
            }
            if (update.connection === 'connecting' && this.config.pairing?.autoRequest && !this.registered && !this.pairingRequested) {
                // O código só pode ser pedido com o socket aberto no servidor; o Baileys
                // resolve isso internamente, mas o pedido tem que vir depois do 'connecting'.
                void this.requestPairingCode().catch((error: unknown) => this.emit('error', { scope: 'pairing_code', error }));
            }
            if (update.connection === 'close') {
                this.open = false;
                if (this.socket === socket) this.socket = null;
                const err = update.lastDisconnect?.error;
                const statusCode = boomStatus(err);
                const cause = this.closing ? 'closed_by_us' : normalizeDisconnect(statusCode, err?.message);
                this.closing = false;
                this.emit('connection.update', {
                    state: 'close',
                    cause,
                    statusCode,
                    errorMessage: err?.message,
                    receivedPendingNotifications: update.receivedPendingNotifications,
                });
                return;
            }
            if (update.connection !== undefined || update.receivedPendingNotifications !== undefined || update.isNewLogin !== undefined) {
                this.emit('connection.update', {
                    state: update.connection,
                    receivedPendingNotifications: update.receivedPendingNotifications,
                    isNewLogin: update.isNewLogin,
                });
            }
            if (update.receivedPendingNotifications) this.emit('offline.drained', { count: -1 });
        });

        on('messages.upsert', ({ messages, type }) => {
            for (const m of messages) {
                const secret = m.message?.messageContextInfo?.messageSecret;
                if (secret && m.key.id) this.pollSecrets.set(m.key.id, Buffer.from(secret));
            }
            this.emit('messages.upsert', { kind: type, messages: messages.map(normalizeMessage) });
        });

        on('messaging-history.set', ({ messages, isLatest, syncType, peerDataRequestSessionId }) => {
            this.emit('history.sync', {
                kind: this.historyKind(syncType),
                messages: messages.map(normalizeMessage),
                isLatest: isLatest === true,
                requestId: peerDataRequestSessionId ?? undefined,
            });
        });

        on('messages.update', (updates) => {
            const out: MessageUpdate[] = [];
            for (const { key, update } of updates) {
                const nk = normalizeKey(key);
                const status = normalizeStatus(update.status);
                if (status) {
                    const stubParams = (update as { messageStubParameters?: string[] }).messageStubParameters ?? [];
                    out.push({ key: nk, type: 'status', status, errorCode: status === 'error' ? (stubParams[0] ?? 'unknown') : undefined });
                }
                const edited = update.message?.editedMessage?.message?.protocolMessage?.editedMessage
                    ?? update.message?.protocolMessage?.editedMessage;
                if (edited) {
                    const content = normalizeContent(edited, nk.chatJid);
                    out.push({ key: nk, type: 'edit', newText: content.type === 'text' ? content.text : '' });
                }
                const revoked = (update as { revokeMessageTimestamp?: unknown }).revokeMessageTimestamp !== undefined
                    || update.messageStubType === proto.WebMessageInfo.StubType.REVOKE;
                if (revoked) {
                    out.push({ key: nk, type: 'revoke' });
                }
                const pollUpdates = (update as { pollUpdates?: proto.IPollUpdate[] }).pollUpdates;
                if (pollUpdates?.length) {
                    for (const pu of pollUpdates) {
                        out.push({
                            key: nk,
                            type: 'poll_update',
                            vote: { pollKey: nk, encrypted: { pollKey: nk, handle: pu } },
                        });
                    }
                }
                if (!status && !edited && !revoked && !pollUpdates?.length) {
                    out.push({ key: nk, type: 'other', raw: update });
                }
            }
            if (out.length) this.emit('messages.update', out);
        });

        on('message-receipt.update', (updates) => {
            const out: MessageReceipt[] = [];
            for (const { key, receipt } of updates) {
                const nk = normalizeKey(key);
                const userJid = receipt.userJid ?? '';
                if (receipt.playedTimestamp) out.push({ key: nk, userJid, type: 'played', timestamp: toMillis(receipt.playedTimestamp) });
                else if (receipt.readTimestamp) out.push({ key: nk, userJid, type: 'read', timestamp: toMillis(receipt.readTimestamp) });
                else if (receipt.receiptTimestamp) out.push({ key: nk, userJid, type: 'delivered', timestamp: toMillis(receipt.receiptTimestamp) });
                else out.push({ key: nk, userJid, type: 'other', timestamp: Date.now() });
            }
            if (out.length) this.emit('message-receipt.update', out);
        });

        on('contacts.update', (contacts) => {
            this.emit('contacts.update', contacts.filter((c) => !!c.id).map((c) => ({
                jid: c.id!,
                lid: c.lid ?? undefined,
                phoneJid: (c as { phoneNumber?: string }).phoneNumber ?? undefined,
                name: c.name ?? undefined,
                notify: c.notify ?? undefined,
                avatar: c.imgUrl === 'changed' ? 'changed' : c.imgUrl === null ? 'removed' : undefined,
            })));
        });

        on('lid-mapping.update', ({ lid, pn }) => this.emit('lid-mapping.update', { lid, pn }));
        on('message-capping.update', (info) => this.emit('message_capping', normalizeCapping(info as BaileysCapInfo)));
        on('groups.upsert', (metas) => this.emit('groups.upsert', metas.map(normalizeGroup)));
        on('group-participants.update', ({ id, author, authorPn, authorUsername, participants, action }) => {
            if (action === 'modify') return;
            this.emit('group-participants.update', {
                groupJid: id,
                action,
                participants: participants.map(normalizeParticipant),
                author: normalizeActor(author, authorPn, authorUsername),
            });
        });

        // groups.update também sai do groupFetchAllParticipating com o metadado inteiro de cada
        // grupo (traz `participants`); troca de nome de verdade é o stub, sem a lista.
        on('groups.update', (updates) => {
            for (const u of updates) {
                const subject = typeof u.subject === 'string' ? u.subject.trim() : '';
                if (!u.id || !subject || u.participants) continue;
                this.emit('group-subject.update', {
                    groupJid: u.id,
                    subject,
                    author: normalizeActor(u.author, u.authorPn, u.authorUsername),
                });
            }
        });

        on('presence.update', ({ id, presences }) => {
            for (const [participant, data] of Object.entries(presences)) {
                this.emit('presence.update', {
                    chatJid: id,
                    participantJid: participant,
                    state: data.lastKnownPresence,
                    lastSeen: data.lastSeen ? data.lastSeen * 1000 : undefined,
                });
            }
        });
    }

    /**
     * MIGRAÇÃO (fases 1–5): o SessionManager ainda pendura handlers e chama métodos
     * direto no socket. Some quando a allowlist do check:adapter chegar a zero.
     */
    rawSocket(): WASocket {
        return this.requireSocket();
    }


    /** Segredo de uma enquete que passou por este cliente (para `decryptPollVote`). */
    pollSecretFor(pollMessageId: string): Buffer | undefined {
        return this.pollSecrets.get(pollMessageId);
    }

    /** Descrição legível de um proto cru (uso interno do serviço durante a migração). */
    static describeRaw(message: proto.IMessage | null | undefined): string | null {
        const fallback = extractUnsupportedFallback(message);
        return fallback.kind === 'message' ? fallback.content : null;
    }
}
