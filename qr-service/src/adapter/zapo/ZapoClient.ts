import './polyfill.js';
import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import {
    ConsoleLogger,
    WaClient,
    proto as zproto,
    type WaAuthCredentials,
    type WaClientOptions,
    type WaConnectionEvent,
    type WaGroupEvent,
    type WaIncomingAddonEvent,
    type WaIncomingChatstateEvent,
    type WaIncomingMessageEvent,
    type WaIncomingPresenceEvent,
    type WaIncomingReceiptEvent,
    type WaIncomingUnavailableMessageEvent,
    type WaMessageKey,
    type WaOfflineResumeEvent,
    type WaPictureEvent,
    type WaClientEventMap,
    type WaSendMessageContent,
    type WaSendMessageOptions,
} from 'zapo-js';
import type { CallInfo, EndCallReason, voipPlugin as VoipPluginFactory } from '@zapo-js/voip';
import type { ClientConfig, ClientListener, WhatsAppClient } from '../WhatsAppClient.js';
import { MediaDownloadError, ReachoutRejectedError, WhatsAppClientError } from '../WhatsAppClient.js';
import type {
    AuthSnapshot,
    Capability,
    ChatState,
    ClientEventMap,
    ClientEventName,
    GlobalPresence,
    GroupActor,
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
    OutboundContent,
    OwnIdentity,
    PollVoteRef,
    PollVoteRequest,
    ProfileInfo,
    CallUpdate,
    MessageCapping,
    ReachoutTimelock,
    SendOptions,
    StartCallOptions,
    SendResult,
    WhatsAppLookup,
} from '../types.js';
import { editedTextOf } from '../proto/content.js';
import { decryptSecretEditPlaintext, type SecretEncryptedEdit } from '../proto/secretEdit.js';
import { decryptPollVotePayload, encryptPollVotePayload } from '../proto/pollVote.js';
import { PROTOCOL_TYPE, type ProtoMessage } from '../proto/types.js';
import { ZapoSessionStore } from './ZapoSessionStore.js';
import { writeMediaStreamToFile } from '../mediaFile.js';
import { zapoWaVersion } from './waVersion.js';
import { keyOf, normalizeZapoDisconnect, normalizeZapoGroup, normalizeZapoMessage, normalizeZapoParticipant } from './inbound.js';

export const ZAPO_LIBRARY_ID = 'zapo-js@1.12.0';

type WaParticipantActionResult = Awaited<ReturnType<WaClient['group']['addParticipants']>>[number];

export const ZAPO_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
    'qr', 'pairing_code', 'poll_create', 'poll_vote', 'reaction', 'edit', 'revoke', 'lid',
    'media_retry', 'view_once_placeholder', 'group_join_requests', 'group_invite_info',
    'reachout_timelock', 'message_capping', 'presence_subscribe', 'chat_state', 'profile_picture',
    // Sem 'history_fetch': o pedido sai, mas a zapo entrega as mensagens do chunk só ao
    // messages store (que é 'none') — o history_sync_chunk traz apenas contagens.
]);

type MediaHandle = { typeKey?: string; message: ProtoMessage };
function isMediaHandle(v: unknown): v is MediaHandle {
    return typeof v === 'object' && v !== null && 'message' in v;
}

type MediaNode = { mediaKey?: Uint8Array | null; directPath?: string | null; url?: string | null };
/** Sub-mensagem de mídia do handle (a que tem mediaKey/directPath/url). */
function mediaNodeOf(handle: MediaHandle): MediaNode | undefined {
    const msg = handle.message as Record<string, unknown>;
    if (handle.typeKey === 'documentWithCaptionMessage') {
        return (msg.documentWithCaptionMessage as { message?: { documentMessage?: MediaNode } } | undefined)?.message?.documentMessage;
    }
    return handle.typeKey ? msg[handle.typeKey] as MediaNode | undefined : undefined;
}

// -- ligação de voz -----------------------------------------------------------
// O plugin puxa `@roamhq/wrtc` (binário glibc): só é importado quando a linha pede
// voz (`ClientConfig.voice`), e uma falha de import vira "sem voz", não crash.
type VoipModule = typeof import('@zapo-js/voip');
type VoipCoordinator = ReturnType<ReturnType<typeof VoipPluginFactory>['setup']>;
let voipModule: Promise<VoipModule | null> | null = null;
function loadVoip(): Promise<VoipModule | null> {
    voipModule ??= import('@zapo-js/voip').catch((error: unknown) => {
        console.warn('[zapo] plugin de voz indisponível:', (error as Error)?.message ?? error);
        return null;
    });
    return voipModule;
}

function normalizeCall(call: CallInfo): CallUpdate {
    const pn = call.callerPn ? (call.callerPn.includes('@') ? call.callerPn : `${call.callerPn.replace(/\D/g, '')}@s.whatsapp.net`) : undefined;
    return {
        callId: call.callId,
        peerJid: call.peerJid,
        peerPn: pn,
        direction: call.direction === 'incoming' ? 'incoming' : 'outgoing',
        isVideo: call.mediaType === 'video',
        state: call.stateData.state as CallUpdate['state'],
        endReason: call.stateData.endReason ? String(call.stateData.endReason) : undefined,
        startedAt: call.createdAt.getTime(),
        connectedAt: call.stateData.connectedAt?.getTime() ?? call.stateData.acceptedAt?.getTime(),
        endedAt: call.stateData.endedAt?.getTime(),
        durationSecs: call.stateData.durationSecs,
        muted: call.stateData.audioMuted,
    };
}

/**
 * A zapo não põe o código do servidor em campo nenhum do erro, só no texto:
 * nack de envio = "negative publish ack: tag=ack … error=463" e IQ = "… iq failed (403: forbidden)".
 */
export function zapoErrorStatus(message: string | undefined): number | undefined {
    if (!message) return undefined;
    const m = /\berror=(\d{3})\b/.exec(message) ?? /\bcode=(\d{3})\b/.exec(message) ?? /iq failed \((\d{3}):/.exec(message);
    return m ? Number(m[1]) : undefined;
}

/** O servidor manda epoch em segundos; a zapo repassa como veio. Normaliza para ms. */
function epochMs(value: number | null | undefined): number | undefined {
    if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
    return value < 1e12 ? value * 1000 : value;
}

function bytes(data: Buffer | { url: string }): Uint8Array | string {
    return Buffer.isBuffer(data) ? new Uint8Array(data) : data.url;
}

/**
 * Implementação do contrato sobre a zapo-js. Mesmo proto do WhatsApp, API própria:
 * eventos tipados por assunto e coordenadores (`client.message`, `client.group`...).
 */
export class ZapoClient implements WhatsAppClient {
    readonly libraryId = ZAPO_LIBRARY_ID;
    readonly capabilities: ReadonlySet<Capability>;
    readonly sessionId: string;
    /** Mesma referência de `capabilities`: 'voice_call' cai se o plugin não carregar. */
    private readonly caps: Set<Capability>;
    private voip: VoipCoordinator | null = null;

    private readonly emitter = new EventEmitter();
    private readonly store: ZapoSessionStore;
    private wa: WaClient | null = null;
    private open = false;
    private connecting = false;
    private closing = false;
    private identity: OwnIdentity | null = null;
    private registered = false;
    private readonly lidPairsSeen = new Set<string>();
    /** Ids que decifraram (pelo menos uma parte) — anula o aviso de falha da mesma stanza. */
    private readonly decryptedIds = new Set<string>();
    private readonly pendingUndecrypted = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly config: ClientConfig) {
        this.sessionId = config.sessionId;
        if (!(config.store instanceof ZapoSessionStore)) {
            throw new WhatsAppClientError('ZapoClient exige ZapoSessionStore', 'bad_store');
        }
        this.store = config.store;
        this.caps = new Set<Capability>(config.voice ? [...ZAPO_CAPABILITIES, 'voice_call'] : [...ZAPO_CAPABILITIES]);
        this.capabilities = this.caps;
        this.emitter.setMaxListeners(50);
    }

    // -- ciclo de vida -------------------------------------------------------

    async connect(): Promise<void> {
        if (this.wa) throw new WhatsAppClientError('Cliente já conectado; feche antes', 'already_connected');
        const transport = this.config.transport;
        const creds = await this.store.store.session(this.sessionId).auth.load();
        this.registered = !!creds?.meJid;
        this.identity = creds ? this.identityFrom(creds) : null;

        // Servidor falso (testes) não confere versão: só busca a atual contra o WhatsApp de verdade.
        const version = transport?.waVersion?.join('.') ?? (transport?.socketUrl ? undefined : await zapoWaVersion.resolve());
        const options: WaClientOptions = {
            ...(version ? { version } : {}),
            store: this.store.store,
            sessionId: this.sessionId,
            markOnlineOnConnect: false,
            deviceBrowser: 'chrome',
            chatSocketUrls: transport?.socketUrl ? [transport.socketUrl] : undefined,
            testHooks: transport?.noiseRootCa ? { noiseRootCa: transport.noiseRootCa } : undefined,
            proxy: transport?.mediaAgent
                ? {
                    mediaUpload: transport.mediaAgent as NonNullable<WaClientOptions['proxy']>['mediaUpload'],
                    mediaDownload: transport.mediaAgent as NonNullable<WaClientOptions['proxy']>['mediaDownload'],
                }
                : undefined,
            logoutStoreClear: { auth: true, signal: true, preKey: true, session: true, identity: true, senderKey: true, appState: true },
        };
        const level = this.config.logLevel === 'silent' ? 'error' : (this.config.logLevel ?? 'warn');
        const voipMod = this.config.voice ? await loadVoip() : null;
        const maxConcurrentCalls = typeof this.config.voice === 'object' ? this.config.voice.maxConcurrentCalls : undefined;
        const plugins = voipMod ? [voipMod.voipPlugin({ logLevel: 'warn', maxConcurrentCalls })] : [];
        const wa = new WaClient({ ...options, plugins }, new ConsoleLogger(level as 'error' | 'warn' | 'info' | 'debug')) as WaClient;
        this.voip = voipMod ? (wa as unknown as { voip: VoipCoordinator }).voip : null;
        // A capability nasce da configuração, mas quem manda é o plugin: VOIP_ENABLED=1
        // numa imagem sem glibc (o `@roamhq/wrtc` não carrega no alpine) anunciaria voz
        // numa linha que não liga — o front mostraria o botão e toda ligação falharia.
        if (this.config.voice && !voipMod) this.caps.delete('voice_call');
        this.wa = wa;
        this.closing = false;
        this.connecting = true;
        this.bind(wa);
        this.emit('connection.update', { state: 'connecting' });
        // connect() da zapo só resolve depois do pareamento; o contrato resolve quando o
        // socket existe e reporta o estado por eventos.
        void wa.connect().catch((error: unknown) => {
            this.connecting = false;
            this.emit('error', { scope: 'connect', error });
            if (this.wa === wa && !this.open) {
                this.emit('connection.update', { state: 'close', cause: 'connection_lost', errorMessage: (error as Error)?.message });
                this.wa = null; this.voip = null;
            }
        });
        if (this.config.pairing?.autoRequest && !this.registered) {
            void this.requestPairingCode().catch((error: unknown) => this.emit('error', { scope: 'pairing_code', error }));
        }
    }

    async close(): Promise<void> {
        const wa = this.wa;
        if (!wa) return;
        this.closing = true;
        try {
            await wa.disconnect();
        } catch { /* já fechado */ }
        if (this.wa === wa) { this.wa = null; this.voip = null; }
        this.open = false;
        this.connecting = false;
        for (const t of this.pendingUndecrypted.values()) clearTimeout(t);
        this.pendingUndecrypted.clear();
    }

    // -- ligação de voz -------------------------------------------------------

    private requireVoip(): VoipCoordinator {
        if (this.voip) return this.voip;
        throw new WhatsAppClientError(
            this.config.voice
                ? 'Plugin de voz não carregou nesta imagem (binário nativo do wrtc ausente?)'
                : 'Ligação de voz não habilitada para esta linha',
            'unsupported_by_provider', 501,
        );
    }

    async startCall(to: Jid, opts?: StartCallOptions): Promise<{ callId: string }> {
        const voip = this.requireVoip();
        try {
            const callId = await voip.startCall({ peerJid: to, isVideo: opts?.isVideo, audioFile: opts?.audioFile });
            return { callId };
        } catch (error) {
            throw this.translateError(error, to);
        }
    }

    async endCall(callId: string, reason: 'user_ended' | 'declined' | 'busy' = 'user_ended'): Promise<void> {
        const voip = this.requireVoip();
        const call = voip.getCall(callId);
        if (!call || call.isEnded) return;
        const why = reason as unknown as EndCallReason;
        if (call.direction === 'incoming' && call.isRinging) await voip.rejectCall(callId, why);
        else await voip.endCall(callId, why);
    }

    async acceptCall(callId: string): Promise<void> { await this.requireVoip().acceptCall(callId); }
    setCallLiveAudio(callId: string, enabled: boolean): void { this.requireVoip().setExternalAudioMode(callId, enabled); }
    feedCallAudio(callId: string, pcm: Float32Array): number { return this.requireVoip().feedLiveAudio(callId, pcm); }
    setCallMuted(callId: string, muted: boolean): void { this.requireVoip().setMute(callId, muted); }
    getCall(callId: string): CallUpdate | null {
        const call = this.voip?.getCall(callId);
        return call ? normalizeCall(call) : null;
    }
    listCalls(): CallUpdate[] { return (this.voip?.getCalls() ?? []).map(normalizeCall); }

    async logout(): Promise<void> {
        const wa = this.wa;
        if (wa) {
            try { await wa.logout(); } catch { /* servidor pode já ter derrubado */ }
        }
        await this.close();
        await this.store.wipe();
        this.registered = false;
        this.identity = null;
    }

    isRegistered(): boolean { return this.registered; }
    isOpen(): boolean { return this.open; }
    connectionState(): 'connecting' | 'open' | 'closed' {
        if (this.open) return 'open';
        return this.wa && this.connecting ? 'connecting' : 'closed';
    }
    // O nome muda com a linha aberta (Perfil do WhatsApp no Echo ou troca no aparelho): a zapo
    // grava em `meDisplayName` na hora, mas a identidade é montada só ao abrir a conexão.
    // Sem reler, o Echo mostrava o nome velho até a próxima reconexão.
    me(): OwnIdentity | null {
        const creds = this.wa?.getCredentials();
        if (this.identity && creds) {
            const name = creds.meDisplayName ?? creds.pushName ?? undefined;
            if (name !== undefined && name !== this.identity.name) this.identity = { ...this.identity, name };
        }
        return this.identity;
    }

    async requestPairingCode(): Promise<string> {
        const wa = this.requireClient();
        const phone = this.config.pairing?.phone;
        if (!phone) throw new WhatsAppClientError('Sessão não configurada para pairing code', 'no_pairing_phone');
        const code = await wa.auth.requestPairingCode(phone);
        this.emit('pairing_code', { code });
        return code;
    }

    on<E extends ClientEventName>(event: E, listener: ClientListener<E>): void {
        this.emitter.on(event, listener as (...args: unknown[]) => void);
    }
    off<E extends ClientEventName>(event: E, listener: ClientListener<E>): void {
        this.emitter.off(event, listener as (...args: unknown[]) => void);
    }
    removeAllListeners(): void { this.emitter.removeAllListeners(); }

    // -- credenciais ---------------------------------------------------------

    async exportAuthSnapshot(): Promise<AuthSnapshot> {
        // O WaStore não tem iterador em massa; o rollback usa o backup gravado na migração.
        throw new WhatsAppClientError('zapo não exporta snapshot; use o backup da migração', 'snapshot_unsupported');
    }

    async importAuthSnapshot(snapshot: AuthSnapshot): Promise<{ losses: string[] }> {
        if (this.wa) throw new WhatsAppClientError('Feche o cliente antes de importar', 'socket_open');
        const result = await this.store.importSnapshot(snapshot);
        this.registered = true;
        return result;
    }

    // -- mensagens -----------------------------------------------------------

    async send(to: Jid, content: OutboundContent, opts?: SendOptions): Promise<SendResult> {
        const wa = this.requireClient();
        const options: WaSendMessageOptions = {
            id: opts?.messageId,
            quote: opts?.quoted ? this.quoteOf(opts.quoted) : undefined,
            mentions: opts?.mentionedJids,
            forward: opts?.forwarded ? true : undefined,
            expirationSeconds: opts?.ephemeralExpiration,
        };
        let payload: WaSendMessageContent;
        // Segredo em TODA mensagem (a zapo gera um se não passarmos, mas não devolve): é ele
        // que abre a edição que alguém fizer depois no aparelho. Reação/revoke/edição não
        // são mensagens editáveis — sem segredo.
        const messageSecret: Buffer | undefined = content.type === 'reaction' || content.type === 'revoke' || content.type === 'edit'
            ? undefined
            : randomBytes(32);
        let viewOnce = false;
        switch (content.type) {
            case 'text':
                payload = { type: 'text', text: content.text, linkPreview: content.linkPreview !== false };
                break;
            case 'image':
                payload = { type: 'image', media: bytes(content.media.data), mimetype: content.media.mimeType, caption: content.media.caption };
                viewOnce = content.viewOnce === true;
                break;
            case 'video':
                payload = content.isVideoNote
                    ? { type: 'ptv', media: bytes(content.media.data), mimetype: content.media.mimeType }
                    : { type: 'video', media: bytes(content.media.data), mimetype: content.media.mimeType, caption: content.media.caption, gifPlayback: content.gifPlayback };
                viewOnce = content.viewOnce === true;
                break;
            case 'audio':
                payload = { type: 'audio', media: bytes(content.media.data), mimetype: content.media.mimeType, ptt: content.isVoiceNote, seconds: content.seconds, waveform: content.waveform ? new Uint8Array(content.waveform) : undefined };
                viewOnce = content.viewOnce === true;
                break;
            case 'document':
                payload = { type: 'document', media: bytes(content.media.data), mimetype: content.media.mimeType, fileName: content.media.fileName ?? 'arquivo', caption: content.media.caption };
                break;
            case 'sticker':
                payload = { type: 'sticker', media: bytes(content.media.data), mimetype: content.media.mimeType, isAnimated: content.isAnimated };
                break;
            case 'poll':
                payload = { type: 'poll', name: content.poll.name, options: content.poll.options, selectableCount: content.poll.selectableCount };
                break;
            case 'reaction':
                payload = { type: 'reaction', emoji: content.reaction.emoji, target: this.toWaKey(content.reaction.targetKey) };
                break;
            case 'revoke':
                payload = { type: 'revoke', target: this.toWaKey(content.revoke.targetKey) };
                break;
            case 'edit':
                if (content.edit.captionOf) {
                    const field = `${content.edit.captionOf}Message` as 'imageMessage' | 'videoMessage' | 'documentMessage';
                    payload = {
                        protocolMessage: {
                            key: this.toWaKey(content.edit.targetKey),
                            type: PROTOCOL_TYPE.MESSAGE_EDIT,
                            editedMessage: { [field]: { caption: content.edit.newText } },
                            timestampMs: Date.now(),
                        },
                    } as unknown as WaSendMessageContent;
                } else {
                    payload = { type: 'text', text: content.edit.newText, linkPreview: false };
                    (options as { editKey?: unknown }).editKey = { id: content.edit.targetKey.id, participant: content.edit.targetKey.participantJid };
                }
                break;
            case 'location':
                payload = {
                    locationMessage: {
                        degreesLatitude: content.location.latitude,
                        degreesLongitude: content.location.longitude,
                        name: content.location.name,
                        address: content.location.address,
                        url: content.location.url,
                    },
                } as unknown as WaSendMessageContent;
                break;
            case 'contacts':
                payload = (content.contacts.length === 1
                    ? { contactMessage: { displayName: content.contacts[0]!.displayName, vcard: content.contacts[0]!.vcard } }
                    : { contactsArrayMessage: { displayName: content.displayName ?? content.contacts[0]?.displayName ?? '', contacts: content.contacts.map((c) => ({ displayName: c.displayName, vcard: c.vcard })) } }
                ) as unknown as WaSendMessageContent;
                break;
            case 'group_invite':
                payload = {
                    groupInviteMessage: {
                        groupJid: content.invite.groupJid,
                        inviteCode: content.invite.inviteCode,
                        inviteExpiration: content.invite.inviteExpiration ?? Math.floor(Date.now() / 1000) + 3 * 24 * 3600,
                        groupName: content.invite.groupName ?? '',
                        caption: content.invite.caption ?? '',
                    },
                } as unknown as WaSendMessageContent;
                break;
        }
        const finalOptions: WaSendMessageOptions = { ...options, viewOnce: viewOnce || undefined, messageSecret: messageSecret ? new Uint8Array(messageSecret) : undefined };
        try {
            const result = await wa.message.send(to, payload, finalOptions);
            return {
                key: { id: result.id, chatJid: to, fromMe: true, participantJid: to.endsWith('@g.us') ? this.identity?.jid : undefined },
                timestamp: Date.now(),
                messageSecret,
                pollSecret: content.type === 'poll' ? messageSecret : undefined,
            };
        } catch (error) {
            throw this.rejectSend(error, to, opts?.messageId);
        }
    }

    /**
     * No Baileys o 463 chega como ack de erro (messages.update) e é isso que liga o bloqueio
     * local de contato frio no serviço. A zapo lança no send(): traduz para o mesmo evento,
     * senão cada reenvio ia ao servidor e alongava a punição.
     */
    private rejectSend(error: unknown, to: Jid, messageId?: string): WhatsAppClientError {
        const translated = this.translateError(error, to);
        if (translated instanceof ReachoutRejectedError) {
            this.emit('messages.update', [{ key: { id: messageId ?? '', chatJid: to, fromMe: true }, type: 'status', status: 'error', errorCode: '463' }]);
        }
        return translated;
    }

    async markRead(keys: MessageKey[]): Promise<void> {
        const wa = this.requireClient();
        // Um recibo por (chat, remetente): em grupo o `participant` do recibo tem que ser o
        // autor de CADA mensagem — agrupar só por chat mandava o do primeiro para todas, e o
        // tique azul não chegava para os outros remetentes do lote.
        const groups = new Map<string, { chatJid: Jid; participant?: Jid; ids: string[] }>();
        for (const k of keys) {
            const id = `${k.chatJid}|${k.participantJid ?? ''}`;
            const g = groups.get(id) ?? { chatJid: k.chatJid, participant: k.participantJid, ids: [] };
            g.ids.push(k.id);
            groups.set(id, g);
        }
        for (const g of groups.values()) {
            await wa.message.sendReceipt(g.chatJid, g.ids, { type: 'read', participant: g.participant } as never);
        }
    }

    async downloadMedia(ref: MediaRef, opts?: { maxBytes?: number }): Promise<Buffer> {
        const message = this.downloadableMessage(ref, opts);
        try {
            const data = await this.requireClient().message.downloadBytes(message, { maxBytes: opts?.maxBytes });
            if (opts?.maxBytes && data.length > opts.maxBytes) throw new MediaDownloadError(`download passou de ${opts.maxBytes} bytes`, 'too_large');
            return Buffer.from(data);
        } catch (error) {
            throw toMediaDownloadError(error);
        }
    }

    async downloadMediaToFile(ref: MediaRef, filePath: string, opts?: { maxBytes?: number }): Promise<number> {
        const message = this.downloadableMessage(ref, opts);
        try {
            const stream = await this.requireClient().message.download(message, { maxBytes: opts?.maxBytes });
            return await writeMediaStreamToFile(stream, filePath, opts?.maxBytes);
        } catch (error) {
            throw toMediaDownloadError(error);
        }
    }

    private downloadableMessage(ref: MediaRef, opts?: { maxBytes?: number }): zproto.IMessage {
        if (!isMediaHandle(ref.handle)) throw new MediaDownloadError('handle inválido', 'unknown');
        if (opts?.maxBytes && ref.fileLength && ref.fileLength > opts.maxBytes) {
            throw new MediaDownloadError(`mídia de ${ref.fileLength} bytes excede ${opts.maxBytes}`, 'too_large');
        }
        return ref.handle.message as unknown as zproto.IMessage;
    }

    /**
     * Pede ao aparelho que reenvie a mídia expirada e grava o directPath novo NO handle —
     * é o mesmo handle que o serviço passa de volta ao downloadMedia na próxima tentativa
     * (o Baileys faz igual via updateMediaMessage). A url antiga sai: o download tenta a
     * url antes do directPath, e ela é justamente a que expirou.
     */
    async requestMediaRetry(key: MessageKey, ref: MediaRef): Promise<void> {
        if (!isMediaHandle(ref.handle)) throw new MediaDownloadError('handle inválido', 'unknown');
        const media = mediaNodeOf(ref.handle);
        if (!media?.mediaKey?.length) throw new MediaDownloadError('mensagem sem mediaKey', 'not_found');
        const result = await this.call('requestMediaReupload', () => this.requireClient().message.requestMediaReupload({
            messageId: key.id,
            chatJid: key.chatJid,
            mediaKey: new Uint8Array(media.mediaKey!),
            fromMe: key.fromMe,
            participant: key.participantJid,
        }));
        if (result.result !== 'success' || !result.directPath) {
            throw new MediaDownloadError(`reupload ${result.result}`, result.result === 'not_found' ? 'not_found' : 'unknown');
        }
        media.directPath = result.directPath;
        media.url = undefined;
    }

    async requestPlaceholderResend(): Promise<Array<string | undefined>> {
        // A zapo já pede o reenvio sozinha (message_unavailable.resendRequested).
        return [];
    }

    async fetchHistory(count: number, oldest: { key: MessageKey; timestamp: number }): Promise<string> {
        const { messageId } = await this.requireClient().message.requestHistorySync({
            chatJid: oldest.key.chatJid,
            oldestMsgId: oldest.key.id,
            oldestMsgFromMe: oldest.key.fromMe,
            oldestMsgTimestampMs: oldest.timestamp,
            count,
        });
        return messageId;
    }

    decryptPollVote(vote: PollVoteRef, pollSecret: Buffer, pollCreatorJid: Jid, voterJid: Jid): string[] {
        // O handle é o pollUpdateMessage cru do evento `message`. O message_addon da zapo não
        // serve: ela só tem o segredo da enquete por 30 min em memória e nunca resolve os
        // nomes (lê o messages store, que é 'none'). Chave errada LANÇA — o serviço tenta a
        // próxima combinação LID/PN; devolver [] gravava voto em branco.
        const update = vote.handle as { vote?: { encPayload?: Uint8Array | null; encIv?: Uint8Array | null } | null } | undefined;
        const plaintext = decryptPollVotePayload(update?.vote, pollSecret, { pollMsgId: vote.pollKey.id, creatorJid: pollCreatorJid, voterJid });
        const decoded = zproto.Message.PollVoteMessage.decode(plaintext);
        return (decoded.selectedOptions ?? []).map((o) => Buffer.from(o).toString('hex'));
    }

    decryptSecretEdit(handle: unknown, messageSecret: Buffer, authorJid: Jid): string | null {
        // O message_addon da zapo só abre edição quando ELA tem o segredo da original — com
        // messages:'none' ela só guarda segredo de enquete/evento, então a edição de texto
        // chega crua em `message` e quem decifra é o serviço, com o msgSecretCache dele.
        const plaintext = decryptSecretEditPlaintext(handle as SecretEncryptedEdit | undefined, messageSecret, authorJid);
        if (!plaintext) return null;
        try {
            return editedTextOf(zproto.Message.decode(plaintext) as ProtoMessage) || null;
        } catch {
            return null;
        }
    }

    async votePoll(relayJid: Jid, vote: PollVoteRequest): Promise<{ messageId: string }> {
        const wa = this.requireClient();
        // Monta o pollUpdateMessage aqui em vez do `type: 'poll-vote'` da zapo, que usa
        // sempre o nosso PN como votante (o serviço tenta LID e PN), recusa [] (retirar o
        // voto) e exige participant em grupo. A zapo põe o meta polltype=vote sozinha.
        const pollMsgId = vote.pollKey.id;
        const plaintext = zproto.Message.PollVoteMessage.encode({
            selectedOptions: vote.selectedOptions.map((name) => createHash('sha256').update(name).digest()),
        }).finish();
        const parties = { pollMsgId, creatorJid: vote.creatorJid, voterJid: vote.voterJid };
        const { encPayload, encIv } = encryptPollVotePayload(plaintext, vote.pollSecret, parties);
        decryptPollVotePayload({ encPayload, encIv }, vote.pollSecret, parties); // round-trip: lança se divergir
        const isGroup = relayJid.endsWith('@g.us');
        const payload = {
            pollUpdateMessage: {
                pollCreationMessageKey: {
                    remoteJid: relayJid,
                    id: pollMsgId,
                    fromMe: vote.pollKey.fromMe,
                    ...(isGroup ? { participant: vote.pollKey.participantJid ?? vote.creatorJid } : {}),
                },
                vote: { encPayload: new Uint8Array(encPayload), encIv: new Uint8Array(encIv) },
                senderTimestampMs: Date.now(),
            },
        } as unknown as WaSendMessageContent;
        try {
            const result = await wa.message.send(relayJid, payload);
            return { messageId: result.id };
        } catch (error) {
            throw this.rejectSend(error, relayJid);
        }
    }

    describe(content: MessageContent): string {
        if (content.type === 'unsupported') return content.description ?? '[Mensagem não suportada]';
        if (content.type === 'text') return content.text;
        return `[${content.type}]`;
    }

    normalize(raw: unknown): InboundMessage | null {
        const event = raw as WaIncomingMessageEvent | undefined;
        if (!event?.key) return null;
        return normalizeZapoMessage(event);
    }

    // -- contatos / presença -------------------------------------------------

    async lookup(phones: string[]): Promise<WhatsAppLookup[]> {
        const wa = this.requireClient();
        const digits = phones.map((p) => p.replace(/\D/g, ''));
        const results = await this.call('getLidsByPhoneNumbers', () => wa.profile.getLidsByPhoneNumbers(digits));
        return digits.map((d) => {
            const jid = `${d}@s.whatsapp.net`;
            const r = results.find((x) => x.phoneJid === jid || x.queriedJid === jid || x.queriedJid === d);
            return { jid: r?.phoneJid ?? jid, exists: r?.exists === true, lid: r?.lidJid ?? undefined };
        });
    }

    async getProfile(jid: Jid): Promise<ProfileInfo> {
        const pictureUrl = await this.getProfilePictureUrl(jid, 'image').catch(() => null);
        return { jid, pictureUrl };
    }

    async getProfilePictureUrl(jid: Jid, size: 'preview' | 'image' = 'image'): Promise<string | null> {
        try {
            const pic = await this.requireClient().profile.getProfilePicture(jid, size);
            return pic?.url ?? null;
        } catch (error) {
            const status = this.statusOf(error);
            if (status === 404 || /not.?found|item-not-found/i.test(String((error as Error)?.message))) return null;
            throw this.translateError(error, jid);
        }
    }

    async updateOwnName(name: string): Promise<void> { await this.call('setPushName', () => this.requireClient().profile.setPushName(name)); }
    async updateOwnPicture(image: Buffer): Promise<void> { await this.call('setProfilePicture', () => this.requireClient().profile.setProfilePicture(new Uint8Array(image))); }
    async setGlobalPresence(presence: GlobalPresence): Promise<void> { await this.call('presence.send', () => this.requireClient().presence.send(presence)); }
    async sendChatState(to: Jid, state: ChatState): Promise<void> {
        const options = state === 'recording'
            ? { state: 'composing', media: 'audio' }
            : { state: state === 'paused' ? 'paused' : 'composing' };
        await this.call('sendChatstate', () => this.requireClient().presence.sendChatstate(to, options as never));
    }
    async subscribePresence(jid: Jid): Promise<void> { await this.call('presence.subscribe', () => this.requireClient().presence.subscribe(jid)); }

    async fetchMessageCapping(): Promise<MessageCapping> {
        const info = await this.call('getNewChatMessageCapping', () => this.requireClient().message.getNewChatMessageCapping());
        return {
            status: info.cappingStatus ?? 'NONE',
            totalQuota: info.totalQuota ?? undefined,
            usedQuota: info.usedQuota ?? undefined,
            cycleStart: epochMs(info.cycleStartAt),
            cycleEnd: epochMs(info.cycleEndAt),
            oteStatus: info.oteStatus ?? undefined,
            mvStatus: info.mvStatus ?? undefined,
            raw: info,
        };
    }

    async fetchReachoutTimelock(): Promise<ReachoutTimelock> {
        const t = await this.call('getReachoutTimelock', () => this.requireClient().message.getReachoutTimelock());
        return { isActive: t.isActive, lockedUntil: epochMs(t.enforcementEndsAt), enforcementType: t.enforcementType ?? undefined, raw: t };
    }

    /**
     * A zapo não tem consulta LID→telefone ao servidor. O que ela guarda é o par
     * `userJid`/`altUserJid` no cache de device-list (preenchido quando enviamos
     * ou resolvemos o destinatário). É local e sem tráfego: melhor esforço.
     */
    private async altJidFromStore(jid: Jid): Promise<Jid | null> {
        try {
            const snapshot = await this.store.store.session(this.sessionId).deviceList.findByAnyUserJid(jid);
            if (!snapshot) return null;
            const user = jid.split('@')[0]?.split(':')[0];
            const same = (a: string | undefined) => a?.split('@')[0]?.split(':')[0] === user;
            if (same(snapshot.userJid) && snapshot.altUserJid) return snapshot.altUserJid;
            if (same(snapshot.altUserJid)) return snapshot.userJid;
            return null;
        } catch {
            return null;
        }
    }

    async lookupPnsForLids(lids: Jid[]): Promise<Map<Jid, Jid>> {
        const out = new Map<Jid, Jid>();
        for (const lid of lids) {
            const alt = await this.altJidFromStore(lid.endsWith('@lid') ? lid : `${lid}@lid`);
            if (alt?.endsWith('@s.whatsapp.net')) out.set(lid, alt);
        }
        return out;
    }
    // A zapo não tem onde gravar par avulso: o dela é o cache de device-list (5 min, memória).
    // Quem persiste o mapa é o serviço (lidPhoneCache + banco), alimentado por lid-mapping.update.
    async storeLidMappings(_pairs: LidMapping[]): Promise<void> { /* sem store de LID na zapo */ }
    async lidForPn(pn: Jid): Promise<Jid | null> {
        const local = await this.altJidFromStore(pn);
        if (local?.endsWith('@lid')) return local;
        const [r] = await this.lookup([pn.split('@')[0] ?? pn]).catch(() => []);
        return r?.lid ?? null;
    }
    async pnForLid(lid: Jid): Promise<Jid | null> {
        const alt = await this.altJidFromStore(lid);
        return alt?.endsWith('@s.whatsapp.net') ? alt : null;
    }

    // -- grupos --------------------------------------------------------------

    async createGroup(subject: string, participants: Jid[]): Promise<GroupInfo> {
        return normalizeZapoGroup(await this.call('createGroup', () => this.requireClient().group.createGroup(subject, participants)));
    }
    async getGroup(jid: Jid): Promise<GroupInfo> {
        return normalizeZapoGroup(await this.call('queryGroupMetadata', () => this.requireClient().group.queryGroupMetadata(jid)));
    }
    async listGroups(): Promise<GroupInfo[]> {
        const all = await this.call('queryAllGroups', () => this.requireClient().group.queryAllGroups());
        return all.map(normalizeZapoGroup);
    }
    async leaveGroup(jid: Jid): Promise<void> { await this.call('leaveGroup', () => this.requireClient().group.leaveGroup([jid])); }

    async updateGroupParticipants(jid: Jid, participants: Jid[], action: 'add' | 'remove' | 'promote' | 'demote'): Promise<GroupParticipantResult[]> {
        const g = this.requireClient().group;
        const fn = action === 'add' ? g.addParticipants : action === 'remove' ? g.removeParticipants : action === 'promote' ? g.promoteParticipants : g.demoteParticipants;
        const results = await this.call(`${action}Participants`, () => fn.call(g, jid, participants));
        return results.map((r: WaParticipantActionResult) => this.participantResult(r));
    }
    async updateGroupSubject(jid: Jid, subject: string): Promise<void> { await this.call('setSubject', () => this.requireClient().group.setSubject(jid, subject)); }
    async updateGroupDescription(jid: Jid, description: string | null): Promise<void> { await this.call('setDescription', () => this.requireClient().group.setDescription(jid, description)); }
    async updateGroupPicture(jid: Jid, image: Buffer): Promise<void> { await this.call('setProfilePicture', () => this.requireClient().profile.setProfilePicture(new Uint8Array(image), jid)); }
    async updateGroupSetting(jid: Jid, setting: GroupSetting): Promise<void> {
        // Chaves da zapo: 'announcement' (só admins enviam) e 'restrict' (só admins editam).
        const [name, enabled]: ['announcement' | 'restrict', boolean] = setting === 'announcement' ? ['announcement', true]
            : setting === 'not_announcement' ? ['announcement', false]
            : setting === 'locked' ? ['restrict', true] : ['restrict', false];
        await this.call('setSetting', () => this.requireClient().group.setSetting(jid, name, enabled));
    }
    async updateGroupEphemeral(jid: Jid, seconds: number): Promise<void> { await this.call('setEphemeralDuration', () => this.requireClient().group.setEphemeralDuration(jid, seconds)); }
    async updateGroupMemberAddMode(jid: Jid, mode: 'admin_add' | 'all_member_add'): Promise<void> { await this.call('setMemberAddMode', () => this.requireClient().group.setMemberAddMode(jid, mode)); }
    async updateGroupJoinApprovalMode(jid: Jid, on: boolean): Promise<void> {
        await this.call('setSetting', () => this.requireClient().group.setSetting(jid, 'membership_approval_mode' as never, on));
    }
    async getGroupInviteCode(jid: Jid): Promise<string> { return this.call('queryInviteCode', () => this.requireClient().group.queryInviteCode(jid)); }
    async revokeGroupInviteCode(jid: Jid): Promise<string> { return (await this.call('revokeInvite', () => this.requireClient().group.revokeInvite(jid))).code; }
    async getGroupInviteInfo(code: string): Promise<GroupInviteInfo> {
        // A prévia do convite da zapo não traz o dono do grupo (só subjectOwner, quem mudou o nome).
        const info = await this.call('queryGroupInviteInfo', () => this.requireClient().group.queryGroupInviteInfo(code));
        return { jid: info.jid, subject: info.subject, size: info.size, description: info.desc, ownerJid: undefined, creation: info.creation };
    }
    async acceptGroupInvite(code: string): Promise<Jid> {
        return (await this.call('joinGroupViaInvite', () => this.requireClient().group.joinGroupViaInvite(code))).jid;
    }
    async listGroupJoinRequests(jid: Jid): Promise<GroupJoinRequest[]> {
        const list = await this.call('queryMembershipApprovalRequests', () => this.requireClient().group.queryMembershipApprovalRequests(jid));
        return list.map((r) => ({ jid: r.jid, phoneJid: r.requestorPhone ?? undefined, requestMethod: r.requestMethod, requestTime: r.requestTime }));
    }
    async updateGroupJoinRequests(jid: Jid, participants: Jid[], action: 'approve' | 'reject'): Promise<GroupParticipantResult[]> {
        const g = this.requireClient().group;
        await this.call(`${action}MembershipRequests`, () => action === 'approve' ? g.approveMembershipRequests(jid, participants) : g.rejectMembershipRequests(jid, participants));
        return participants.map((p) => ({ jid: p, status: '200' }));
    }

    // -- internos ------------------------------------------------------------

    private participantResult(r: WaParticipantActionResult): GroupParticipantResult {
        // 403 (privacidade) traz <add_request code expiration> no nó do participante: é o
        // convite que o serviço manda por DM. Sem ler o raw o 403 virava falha seca.
        const children = Array.isArray(r.raw?.content) ? r.raw.content as Array<{ tag?: string; attrs?: Record<string, string> }> : [];
        const invite = children.find((n) => n.tag === 'add_request');
        return {
            jid: r.jid,
            phoneJid: r.phoneNumber?.endsWith('@s.whatsapp.net') ? r.phoneNumber : (r.phoneNumber ? `${r.phoneNumber.replace(/\D/g, '')}@s.whatsapp.net` : undefined),
            status: r.status === 'ok' ? '200' : String(r.code || 500),
            inviteCode: invite?.attrs?.code,
            inviteExpiration: invite?.attrs?.expiration ? Number(invite.attrs.expiration) : undefined,
        };
    }

    /**
     * A zapo só monta a prévia da citação (contextInfo.quotedMessage) a partir do `message`
     * do quote — só a chave saía como resposta sem o balão citado no aparelho do contato.
     * Com o evento cru da zapo usa ele; senão, o texto citado (o que o Baileys também faz).
     */
    private quoteOf(quoted: NonNullable<SendOptions['quoted']>): WaSendMessageOptions['quote'] {
        const raw = quoted.raw as WaIncomingMessageEvent | undefined;
        if (raw?.key && raw.message) return raw;
        const text = quoted.content?.type === 'text' ? quoted.content.text : '';
        return { key: this.toWaKey(quoted.key), message: { conversation: text } } as unknown as WaSendMessageOptions['quote'];
    }

    /**
     * Autor de evento de grupo. Em grupo LID o `participant` é o LID; o telefone e o nome
     * vêm como `participant_pn`/`participant_username` na mesma notificação (o Baileys lia
     * daí). Sem eles o aviso saía "‹dígitos do LID› adicionou Fulano".
     */
    private groupActor(event: WaGroupEvent): GroupActor | undefined {
        if (!event.authorJid) return undefined;
        const attrs = (event.rawNode?.attrs ?? {}) as Record<string, string | undefined>;
        const pn = attrs.participant_pn;
        return {
            jid: event.authorJid,
            phoneJid: pn ? (pn.includes('@') ? pn : `${pn.replace(/\D/g, '')}@s.whatsapp.net`) : (event.authorJid.endsWith('@s.whatsapp.net') ? event.authorJid : undefined),
            name: attrs.participant_username || undefined,
        };
    }

    /**
     * Par LID↔telefone de quem mandou a mensagem. A zapo não emite mapa de LID e o dela é
     * um cache de 5 min em memória; o serviço sabe guardar o par (lid-mapping.update) e usa
     * para recibo/presença de grupo de quem nunca mandou mensagem naquela sessão.
     */
    private emitLidPair(msg: InboundMessage): void {
        const lid = msg.senderLid;
        const pn = msg.senderPn;
        if (!lid || !pn) return;
        const marker = `${lid}|${pn}`;
        if (this.lidPairsSeen.has(marker)) return;
        if (this.lidPairsSeen.size >= 5000) this.lidPairsSeen.clear();
        this.lidPairsSeen.add(marker);
        this.emit('lid-mapping.update', { lid, pn });
    }

    private markDecrypted(id: string | undefined): void {
        if (!id) return;
        if (this.decryptedIds.size >= 5000) this.decryptedIds.clear();
        this.decryptedIds.add(id);
        const pending = this.pendingUndecrypted.get(id);
        if (pending) { clearTimeout(pending); this.pendingUndecrypted.delete(id); }
    }

    private toWaKey(key: MessageKey): WaMessageKey {
        return { remoteJid: key.chatJid, id: key.id, fromMe: key.fromMe, participant: key.participantJid };
    }

    private identityFrom(creds: WaAuthCredentials): OwnIdentity | null {
        if (!creds.meJid) return null;
        const jid = creds.meJid.replace(/:\d+@/, '@');
        return { jid, lid: creds.meLid?.replace(/:\d+@/, '@'), phone: jid.split('@')[0], name: creds.meDisplayName ?? creds.pushName ?? undefined };
    }

    private requireClient(): WaClient {
        if (!this.wa) throw new WhatsAppClientError('Sessão sem cliente', 'not_connected');
        return this.wa;
    }

    private emit<E extends ClientEventName>(event: E, payload: ClientEventMap[E]): void {
        this.emitter.emit(event, payload);
    }

    private statusOf(error: unknown): number | undefined {
        const e = error as { code?: unknown; status?: unknown; statusCode?: unknown } | undefined;
        for (const v of [e?.statusCode, e?.status, e?.code]) {
            const n = typeof v === 'number' ? v : Number(v);
            if (Number.isFinite(n) && n >= 100 && n < 600) return n;
        }
        return zapoErrorStatus((error as Error)?.message);
    }

    private translateError(error: unknown, to: Jid): WhatsAppClientError {
        if (error instanceof WhatsAppClientError) return error;
        const status = this.statusOf(error);
        const message = (error as Error)?.message ?? String(error);
        if (status === 463 || /reachout|timelock/i.test(message)) return new ReachoutRejectedError(to, undefined, error);
        return new WhatsAppClientError(message, status ? `wa_${status}` : 'unknown', status, error);
    }

    private async call<T>(scope: string, fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (error) {
            throw this.translateError(error, scope);
        }
    }

    private bind(wa: WaClient): void {
        const safe = <T>(name: string, fn: (arg: T) => void | Promise<void>) => (arg: T) => {
            Promise.resolve().then(() => fn(arg)).catch((error: unknown) => this.emit('error', { scope: name, error }));
        };

        wa.on('auth_qr', safe<{ qr: string }>('auth_qr', ({ qr }) => this.emit('qr', { qr })));
        wa.on('auth_pairing_code', safe<{ code: string }>('auth_pairing_code', ({ code }) => this.emit('pairing_code', { code })));
        wa.on('auth_paired', safe<{ credentials: WaAuthCredentials }>('auth_paired', ({ credentials }) => {
            this.registered = true;
            this.identity = this.identityFrom(credentials);
            this.emit('creds.update', { registered: true, me: this.identity ?? undefined });
        }));

        wa.on('connection', safe<WaConnectionEvent>('connection', (event) => {
            if (event.status === 'open') {
                this.open = true;
                this.connecting = false;
                const creds = wa.getCredentials();
                if (creds) { this.identity = this.identityFrom(creds); this.registered = !!creds.meJid; }
                this.emit('connection.update', { state: 'open', isNewLogin: event.isNewLogin });
                return;
            }
            this.open = false;
            this.connecting = false;
            if (this.wa === wa) this.wa = null;
            const mapped = this.closing ? { cause: 'closed_by_us' as const, statusCode: undefined } : normalizeZapoDisconnect(event);
            // Versão recusada: a próxima conexão busca de novo em vez de repetir a do cache.
            if (String(event.reason) === 'failure_client_too_old') zapoWaVersion.invalidate();
            this.closing = false;
            this.emit('connection.update', {
                state: 'close',
                cause: mapped.cause,
                statusCode: mapped.statusCode,
                errorMessage: `${event.reason}${event.code ? ` (${event.code})` : ''}`,
            });
        }));

        const upsert = (event: WaIncomingMessageEvent, content?: MessageContent) => {
            const msg = normalizeZapoMessage(event, content);
            this.emitLidPair(msg);
            this.emit('messages.upsert', { kind: event.offline ? 'append' : 'notify', messages: [msg] });
        };
        // Só `message`: a zapo emite `message` para TODA stanza e, se for protocolo, emite de
        // novo `message_protocol` com o mesmo evento — escutar os dois processava revoke,
        // edição e aviso de temporária em dobro.
        wa.on('message', safe<WaIncomingMessageEvent>('message', (event) => {
            this.markDecrypted(event.key.id);
            upsert(event);
        }));
        // Falha de decifragem: a zapo não emite `message`, só este evento de debug (e manda o
        // retry receipt sozinha). Sem ele a perda era invisível — o alerta de mensagem perdida
        // (msg_drop_undecrypted) só existia no Baileys. Uma stanza pode ter mais de um <enc> e
        // falhar num só; espera um pouco e só reporta se nenhuma parte decifrou.
        wa.on('debug_unhandled_stanza', safe<{ rawNode?: { attrs?: Record<string, string | undefined> }; stanzaId?: string; chatJid?: string; offline?: boolean; reason?: string }>('debug_unhandled_stanza', (event) => {
            if (!event.reason?.startsWith('message.decrypt_failed') || !event.stanzaId || !event.chatJid) return;
            const id = event.stanzaId;
            if (this.decryptedIds.has(id) || this.pendingUndecrypted.has(id)) return;
            const attrs = event.rawNode?.attrs ?? {};
            const timer = setTimeout(() => {
                this.pendingUndecrypted.delete(id);
                if (this.wa !== wa || this.decryptedIds.has(id)) return;
                const base = {
                    key: { id, remoteJid: event.chatJid!, fromMe: false, participant: attrs.participant, isGroup: event.chatJid!.endsWith('@g.us') },
                    timestampSeconds: attrs.t ? Number(attrs.t) : undefined,
                    pushName: attrs.notify,
                    rawNode: event.rawNode,
                    offline: event.offline,
                } as unknown as WaIncomingMessageEvent;
                upsert(base, { type: 'undecryptable', stub: 'ciphertext', stubType: event.reason, resendRequested: true });
            }, 3000);
            this.pendingUndecrypted.set(id, timer);
        }));
        wa.on('message_addon', safe<WaIncomingAddonEvent>('message_addon', (event) => {
            const targetKey: MessageKey = { id: event.targetMessageId, chatJid: event.key.remoteJid, fromMe: false };
            // O evento de addon não traz hora nem nome: vêm da stanza (t/notify), senão a reação
            // saía com a hora de processamento e sem o nome de quem reagiu.
            const attrs = (event.rawNode?.attrs ?? {}) as Record<string, string | undefined>;
            const base = { ...event, message: event.raw, timestampSeconds: attrs.t ? Number(attrs.t) : undefined, pushName: attrs.notify } as WaIncomingMessageEvent;
            const d = event.decrypted;
            if (d.kind === 'reaction') {
                upsert(base, { type: 'reaction', reaction: { targetKey: d.reaction.key ? keyOf({ remoteJid: d.reaction.key.remoteJid ?? event.key.remoteJid, id: d.reaction.key.id ?? event.targetMessageId, fromMe: d.reaction.key.fromMe === true, participant: d.reaction.key.participant ?? undefined }) : targetKey, emoji: d.reaction.text ?? '' } });
            } else if (d.kind === 'poll_vote' || d.kind === 'message_edit') {
                // Já tratados pelo `message` cru da mesma stanza: o serviço decifra com o segredo
                // dele (banco/msgSecretCache), que sobrevive mais que o cache de 30 min da zapo.
                return;
            } else {
                upsert(base, { type: 'unsupported', rawType: `addon:${d.kind}`, description: null, skip: 'deliberate' });
            }
        }));
        wa.on('message_unavailable', safe<WaIncomingUnavailableMessageEvent>('message_unavailable', (event) => {
            const base = { key: event.key, timestampSeconds: event.timestampSeconds, pushName: event.pushName, rawNode: event.rawNode, offline: event.offline } as WaIncomingMessageEvent;
            upsert(base, event.kind === 'view_once'
                ? { type: 'view_once_placeholder' }
                : { type: 'undecryptable', stub: event.kind === 'other' ? 'ciphertext' : 'other', stubType: event.kind, resendRequested: event.resendRequested === true });
        }));

        wa.on('receipt', safe<WaIncomingReceiptEvent>('receipt', (event) => {
            const fromJid = event.chatJid ?? '';
            const userJid = event.participantJid ?? fromJid;
            const type = event.status === 'read' ? 'read' : event.status === 'played' ? 'played' : event.status === 'delivered' ? 'delivered' : 'other';
            const isGroup = fromJid.endsWith('@g.us');
            // Recibo que vem do NOSSO aparelho (o celular leu a mensagem que o contato mandou) chega
            // com from=<nosso jid/LID> e recipient=<contato>: não é recibo da nossa mensagem. Mesma
            // regra do Baileys (messages-recv.js, handleReceipt: isNodeFromMe / fromMe = !recipient).
            // Sem isso uma linha virava ~1.500 "lido" por dia de mensagem inbound (edge 404 ou status
            // errado + message.status no webhook da org).
            const bare = (jid: string | undefined) => jid?.replace(/:\d+@/, '@');
            const own = [this.identity?.jid, this.identity?.lid].filter(Boolean);
            const isNodeFromMe = own.includes(bare(userJid));
            const fromMe = !event.recipientJid;
            const chatJid = isNodeFromMe && !isGroup && event.recipientJid ? event.recipientJid : fromJid;
            // Hora do recibo = `t` da stanza. Recibo que volta da fila offline marcaria "lido às"
            // a hora da reconexão.
            const t = Number((event.rawNode?.attrs as Record<string, string | undefined> | undefined)?.t);
            const timestamp = Number.isFinite(t) && t > 0 ? t * 1000 : Date.now();
            const receipts: MessageReceipt[] = event.messageIds.map((id) => ({
                key: { id, chatJid, fromMe, participantJid: isGroup ? this.identity?.jid : undefined },
                userJid,
                type,
                timestamp,
            }));
            if (receipts.length) this.emit('message-receipt.update', receipts);
            // Em 1:1 o Baileys entrega o status da NOSSA mensagem por messages.update; a zapo
            // só manda o recibo. Traduz para o serviço enxergar entregue/lido/tocado.
            if (!isGroup && fromMe && !isNodeFromMe && !event.fromSelfDevice && (type === 'delivered' || type === 'read' || type === 'played')) {
                // Mensagem mandada pelo próprio celular: o eco e o recibo chegam quase juntos e o
                // recibo ganhava a corrida (edge 404 = "mensagem desconhecida", descartado). Dá
                // uma folga para o eco entrar primeiro.
                const status = type as 'delivered' | 'read' | 'played';
                const updates = event.messageIds.map((id) => ({ key: { id, chatJid, fromMe: true }, type: 'status' as const, status }));
                setTimeout(() => { if (this.wa === wa) this.emit('messages.update', updates); }, 2000);
            }
        }));

        wa.on('group', safe<WaGroupEvent>('group', async (event) => {
            const groupJid = event.groupJid ?? event.chatJid;
            if (!groupJid) return;
            if (event.action === 'add' || event.action === 'remove' || event.action === 'promote' || event.action === 'demote') {
                this.emit('group-participants.update', {
                    groupJid,
                    action: event.action,
                    participants: (event.participants ?? []).filter((p) => !!p.jid).map((p) => ({
                        jid: p.jid!,
                        phoneJid: p.phoneJid ?? (p.jid!.endsWith('@s.whatsapp.net') ? p.jid : undefined),
                        lid: p.lidJid,
                        name: p.displayName ?? p.username,
                        role: p.role === 'superadmin' ? 'superadmin' : p.role === 'admin' ? 'admin' : null,
                    })),
                    author: this.groupActor(event),
                });
                return;
            }
            if (event.action === 'subject') {
                const subject = event.subject?.trim();
                if (!subject) return;
                const author = this.groupActor(event);
                const ownerPn = typeof event.details?.subjectOwnerPhoneJid === 'string' ? event.details.subjectOwnerPhoneJid : undefined;
                this.emit('group-subject.update', {
                    groupJid,
                    subject,
                    author: author && !author.phoneJid && ownerPn ? { ...author, phoneJid: ownerPn } : author,
                    timestamp: event.timestampSeconds,
                });
                return;
            }
            if (event.action === 'create') {
                const meta = await wa.group.queryGroupMetadata(groupJid).catch(() => null);
                const info = meta ? normalizeZapoGroup(meta) : { jid: groupJid, subject: event.subject ?? '', participants: [], announce: false, restrict: false, joinApprovalMode: false, memberAddMode: 'admin_add' as const, isCommunity: false, isCommunityAnnounce: false };
                this.emit('groups.upsert', [{ ...info, author: this.groupActor(event) }]);
            }
        }));

        wa.on('presence', safe<WaIncomingPresenceEvent>('presence', (event) => {
            const chatJid = event.chatJid ?? '';
            this.emit('presence.update', {
                chatJid,
                participantJid: chatJid,
                state: event.type === 'available' ? 'available' : 'unavailable',
                lastSeen: typeof event.lastSeen === 'number' ? event.lastSeen * 1000 : undefined,
            });
        }));
        wa.on('chatstate', safe<WaIncomingChatstateEvent>('chatstate', (event) => {
            const chatJid = event.chatJid ?? '';
            const state = event.state === 'paused' ? 'paused' : event.media === 'audio' ? 'recording' : 'composing';
            this.emit('presence.update', { chatJid, participantJid: event.participantJid ?? chatJid, state });
        }));

        // Troca de foto de contato/grupo. O Baileys entregava isso em contacts.update e é o que
        // invalida o avatar no serviço; sem isso a foto nova nunca aparecia nas linhas zapo.
        // 'request' é pedido de foto, não troca.
        wa.on('picture', safe<WaPictureEvent>('picture', (event) => {
            if (!event.targetJid || event.action === 'request') return;
            this.emit('contacts.update', [{ jid: event.targetJid, avatar: event.action === 'delete' ? 'removed' : 'changed' }]);
        }));

        wa.on('offline_resume', safe<WaOfflineResumeEvent>('offline_resume', (event) => {
            if (event.status === 'complete') {
                this.emit('connection.update', { receivedPendingNotifications: true });
                const forced = (event as { forced?: boolean }).forced === true;
                this.emit('offline.drained', { count: event.totalStanzas, remaining: event.remainingStanzas, forced });
            }
        }));
        wa.on('mex_notification', safe<Parameters<WaClientEventMap['mex_notification']>[0]>('mex_notification', (raw) => {
            const event = raw as unknown as {
                kind: string; cappingStatus?: string | null; totalQuota?: number | null; usedQuota?: number | null;
                cycleStartTimestamp?: number | null; cycleEndTimestamp?: number | null; oteStatus?: string | null; mvStatus?: string | null;
            };
            if (event.kind === 'message_capping' && event.cappingStatus) {
                this.emit('message_capping', {
                    status: event.cappingStatus,
                    totalQuota: event.totalQuota ?? undefined,
                    usedQuota: event.usedQuota ?? undefined,
                    cycleStart: epochMs(event.cycleStartTimestamp),
                    cycleEnd: epochMs(event.cycleEndTimestamp),
                    oteStatus: event.oteStatus ?? undefined,
                    mvStatus: event.mvStatus ?? undefined,
                    raw: event,
                });
            }
        }));
        if (this.voip) {
            // Eventos do plugin não estão no mapa tipado da WaClient: entram pela sobrecarga por string.
            const onAny = wa.on.bind(wa) as (event: string, listener: (...args: unknown[]) => void) => unknown;
            const onCall = (name: string) => safe<CallInfo>(name, (call) => this.emit('call.update', normalizeCall(call)));
            onAny('voip_call_incoming', onCall('voip_call_incoming') as (...args: unknown[]) => void);
            onAny('voip_call_state', onCall('voip_call_state') as (...args: unknown[]) => void);
            onAny('voip_call_ended', onCall('voip_call_ended') as (...args: unknown[]) => void);
            onAny('voip_call_inbound_audio', safe<{ call: CallInfo; pcm: Float32Array }>('voip_call_inbound_audio', ({ call, pcm }) => {
                this.emit('call.audio', { callId: call.callId, pcm });
            }) as (...args: unknown[]) => void);
            onAny('voip_call_error', safe<unknown>('voip_call_error', (error) => this.emit('error', { scope: 'voip', error })) as (...args: unknown[]) => void);
        }
        wa.on('stream_failure', safe<unknown>('stream_failure', (event) => this.emit('error', { scope: 'stream_failure', error: event })));
        wa.on('stanza_error', safe<unknown>('stanza_error', (event) => this.emit('error', { scope: 'stanza_error', error: event })));
    }

}

/**
 * Expirada (precisa de reupload pelo aparelho) × rede (tentar de novo) × outro.
 * Exportada para teste. O download da zapo usa node:https: o CDN cortando a conexão no meio
 * do corpo vira `Error: aborted` com code ECONNRESET, que só se reconhece pelo code. Sem
 * isso a falha caía em 'unknown' e o serviço desistia na 1ª tentativa (áudio perdido em
 * poucos ms). Mesmo critério de code do classifyDownloadError do Baileys.
 */
export function toMediaDownloadError(error: unknown): MediaDownloadError {
    if (error instanceof MediaDownloadError) return error;
    const err = error as { message?: unknown; code?: unknown; cause?: { code?: unknown } } | null | undefined;
    const message = String(err?.message ?? error);
    const code = String(err?.code ?? err?.cause?.code ?? '');
    if (/exceeded max bytes/i.test(message)) return new MediaDownloadError(message, 'too_large', error);
    const reason = /404|410|403|expired|not found|forbidden|bad decrypt/i.test(message) ? 'expired'
        : /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE|ENOTFOUND/.test(code)
            || /ECONN|ETIMEDOUT|timeout|network|fetch failed|socket hang up|^aborted$/i.test(message) ? 'network' : 'unknown';
    return new MediaDownloadError(message, reason, error);
}
