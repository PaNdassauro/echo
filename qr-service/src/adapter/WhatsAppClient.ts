/**
 * Contrato entre o serviço (SessionManager/rotas) e a biblioteca de WhatsApp.
 *
 * Um cliente = uma sessão (um número). O SessionManager continua dono de tudo que é
 * regra de negócio (webhooks, outbox, Supabase, LID no banco, limites de proteção,
 * avatar). O cliente só sabe conectar, receber e mandar coisas pelo WhatsApp.
 *
 * Implementações vivem em `src/adapter/<lib>/`. Só elas podem importar a lib —
 * `npm run check:adapter` garante isso.
 */
import type {
    AuthSnapshot,
    CallUpdate,
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
    MessageCapping,
    MessageContent,
    MessageKey,
    OutboundContent,
    OwnIdentity,
    PollVoteRef,
    PollVoteRequest,
    ProfileInfo,
    ReachoutTimelock,
    SendOptions,
    SendResult,
    SessionStore,
    StartCallOptions,
    TransportOverrides,
    WhatsAppLookup,
} from './types.js';

export type ClientListener<E extends ClientEventName> = (payload: ClientEventMap[E]) => void | Promise<void>;

export interface ClientConfig {
    /** Identidade da sessão no serviço (phone_numbers.id). */
    sessionId: string;
    /** Onde a lib persiste credenciais/chaves. Criado pela factory do provider. */
    store: SessionStore;
    /** Só testes/proxy. Produção não passa nada. */
    transport?: TransportOverrides;
    /** Pareamento por código em vez de QR. `autoRequest` pede o código sozinho ao conectar. */
    pairing?: { phone: string; autoRequest?: boolean };
    /**
     * Mensagens enviadas recentemente, para retry de decrypt e para citar (`quoted`).
     * O serviço já mantém esse cache; o adapter só consulta.
     */
    getSentMessage?: (id: string) => unknown | undefined;
    /** Cache de metadados de grupo para o adapter não refazer IQ a cada envio. */
    getCachedGroup?: (jid: Jid) => Promise<GroupInfo | undefined>;
    /** Aceitar ou não um chunk de histórico antes de baixá-lo. */
    shouldAcceptHistory?: (kind: 'recent' | 'on_demand' | 'full' | 'other') => boolean;
    logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
    /**
     * Habilita ligação de voz (capability 'voice_call') quando a lib tem plugin para isso.
     * Exige binário nativo (wrtc, glibc): só ligar em imagem preparada (Dockerfile.voip).
     */
    voice?: boolean | {
        /** Ligações simultâneas por linha (padrão do plugin: 1). Acima de 1 é experimento: o cliente oficial não faz isso. */
        maxConcurrentCalls?: number;
    };
}

export interface WhatsAppClient {
    readonly sessionId: string;
    /** Identidade da lib para logs/`/health` (ex.: 'baileys@7.0.0-rc14'). */
    readonly libraryId: string;
    readonly capabilities: ReadonlySet<Capability>;

    // -- ciclo de vida -------------------------------------------------------

    /** Abre a conexão. Resolve quando o socket existe; o estado vem por 'connection.update'. */
    connect(): Promise<void>;
    /** Fecha o socket sem invalidar as credenciais. */
    close(reason?: string): Promise<void>;
    /** Desloga no servidor (invalida as credenciais). */
    logout(): Promise<void>;
    /** Sessão já pareada em algum momento (tem identidade própria). */
    isRegistered(): boolean;
    /** Socket aberto agora. */
    isOpen(): boolean;
    /** Estado do transporte (advisory; 'connecting' inclui handshake/pareamento). */
    connectionState(): 'connecting' | 'open' | 'closed';
    me(): OwnIdentity | null;
    /** Gera o código de pareamento (só faz sentido com `config.pairing`). */
    requestPairingCode(): Promise<string>;

    on<E extends ClientEventName>(event: E, listener: ClientListener<E>): void;
    off<E extends ClientEventName>(event: E, listener: ClientListener<E>): void;
    /** Solta todos os handlers do serviço (troca de socket / destruição da sessão). */
    removeAllListeners(): void;

    // -- credenciais (troca de lib sem re-parear) ----------------------------

    /** Exporta creds + chaves Signal no formato neutro. Chamar com o socket fechado. */
    exportAuthSnapshot(): Promise<AuthSnapshot>;
    /** Importa um snapshot (convertido, se preciso) para o store deste provider. Antes de `connect()`. */
    importAuthSnapshot(snapshot: AuthSnapshot): Promise<{ losses: string[] }>;

    // -- providers fora do processo (HTTP + webhook) -------------------------

    /**
     * Só providers HTTP: recebe o corpo do webhook que o provider chamou em
     * `POST /provider/:name/webhook/:sessionId`, valida e emite os eventos.
     */
    ingestWebhook?(body: unknown, headers: Record<string, string | string[] | undefined>): Promise<void>;

    // -- mensagens -----------------------------------------------------------

    send(to: Jid, content: OutboundContent, opts?: SendOptions): Promise<SendResult>;
    markRead(keys: MessageKey[]): Promise<void>;
    /** Baixa a mídia referenciada. Lança `MediaDownloadError` com o motivo. */
    downloadMedia(ref: MediaRef, opts?: { maxBytes?: number }): Promise<Buffer>;
    /**
     * Baixa a mídia em stream direto para `filePath`, sem guardar o arquivo inteiro
     * na memória. Devolve os bytes escritos. Lança `MediaDownloadError`, e nesse
     * caso não deixa arquivo parcial.
     */
    downloadMediaToFile(ref: MediaRef, filePath: string, opts?: { maxBytes?: number }): Promise<number>;
    /** Pede ao aparelho que reenvie a mídia expirada; resultado chega em 'messages.update' (media_retry). */
    requestMediaRetry(key: MessageKey, ref: MediaRef): Promise<void>;
    /** Pede reenvio de mensagens que chegaram como stub indecifrável; devolve o id do pedido por chave (se a lib der). */
    requestPlaceholderResend(keys: MessageKey[]): Promise<Array<string | undefined>>;
    /** Vota numa enquete (cifra + envia). Devolve o id da mensagem de voto. */
    votePoll(relayJid: Jid, vote: PollVoteRequest): Promise<{ messageId: string }>;
    /** Puxa histórico para trás a partir de uma âncora. Resultado chega em 'history.sync' (on_demand). */
    fetchHistory(count: number, oldest: { key: MessageKey; timestamp: number }): Promise<string>;
    /** Abre voto de enquete com o segredo da enquete original. Devolve os hashes (hex) das opções. */
    decryptPollVote(vote: PollVoteRef, pollSecret: Buffer, pollCreatorJid: Jid, voterJid: Jid): string[];
    /** Abre uma edição cifrada (`EditContent.encrypted`) com o segredo da original e o JID do autor. null = identidade errada. */
    decryptSecretEdit(handle: unknown, messageSecret: Buffer, authorJid: Jid): string | null;
    /** Descrição legível de um conteúdo (para fallback/log). */
    describe(content: MessageContent): string;
    /** Reidrata uma mensagem crua (do cache do serviço) no modelo normalizado. */
    normalize(raw: unknown): InboundMessage | null;

    // -- ligação de voz (capability 'voice_call') -----------------------------

    /** Liga para `to`. Resolve com o id assim que a oferta sai; o progresso vem em 'call.update'. */
    startCall(to: Jid, opts?: StartCallOptions): Promise<{ callId: string }>;
    /** Encerra (ou recusa, se ainda tocando) a ligação. */
    endCall(callId: string, reason?: 'user_ended' | 'declined' | 'busy'): Promise<void>;
    /** Atende uma ligação do contato. */
    acceptCall(callId: string): Promise<void>;
    /** Liga/desliga o modo de áudio ao vivo (PCM empurrado por `feedCallAudio`) em vez do arquivo. */
    setCallLiveAudio(callId: string, enabled: boolean): void;
    /** Empurra PCM Float32 mono 16 kHz. Devolve quantos ms ainda estão na fila de envio. */
    feedCallAudio(callId: string, pcm: Float32Array): number;
    setCallMuted(callId: string, muted: boolean): void;
    getCall(callId: string): CallUpdate | null;
    listCalls(): CallUpdate[];

    // -- contatos / presença -------------------------------------------------

    lookup(phones: string[]): Promise<WhatsAppLookup[]>;
    getProfile(jid: Jid): Promise<ProfileInfo>;
    getProfilePictureUrl(jid: Jid, size?: 'preview' | 'image'): Promise<string | null>;
    updateOwnName(name: string): Promise<void>;
    updateOwnPicture(image: Buffer): Promise<void>;
    setGlobalPresence(presence: GlobalPresence): Promise<void>;
    sendChatState(to: Jid, state: ChatState): Promise<void>;
    subscribePresence(jid: Jid): Promise<void>;
    /** Consulta o bloqueio de contato frio (463). */
    fetchReachoutTimelock(): Promise<ReachoutTimelock>;
    /** Consulta a cota de conversas novas da conta (capability 'message_capping'); o evento 'message_capping' traz mudanças. */
    fetchMessageCapping(): Promise<MessageCapping>;
    /** LID → telefone (JID) no store local da lib, sem ir ao servidor. */
    lookupPnsForLids(lids: Jid[]): Promise<Map<Jid, Jid>>;
    /** Guarda pares LID↔telefone aprendidos (metadados de grupo, etc.). */
    storeLidMappings(pairs: LidMapping[]): Promise<void>;
    lidForPn(pn: Jid): Promise<Jid | null>;
    pnForLid(lid: Jid): Promise<Jid | null>;

    // -- grupos --------------------------------------------------------------

    createGroup(subject: string, participants: Jid[]): Promise<GroupInfo>;
    getGroup(jid: Jid): Promise<GroupInfo>;
    listGroups(): Promise<GroupInfo[]>;
    leaveGroup(jid: Jid): Promise<void>;
    updateGroupParticipants(jid: Jid, participants: Jid[], action: 'add' | 'remove' | 'promote' | 'demote'): Promise<GroupParticipantResult[]>;
    updateGroupSubject(jid: Jid, subject: string): Promise<void>;
    updateGroupDescription(jid: Jid, description: string | null): Promise<void>;
    updateGroupPicture(jid: Jid, image: Buffer): Promise<void>;
    updateGroupSetting(jid: Jid, setting: GroupSetting): Promise<void>;
    updateGroupEphemeral(jid: Jid, seconds: number): Promise<void>;
    updateGroupMemberAddMode(jid: Jid, mode: 'admin_add' | 'all_member_add'): Promise<void>;
    updateGroupJoinApprovalMode(jid: Jid, on: boolean): Promise<void>;
    getGroupInviteCode(jid: Jid): Promise<string>;
    revokeGroupInviteCode(jid: Jid): Promise<string>;
    getGroupInviteInfo(code: string): Promise<GroupInviteInfo>;
    acceptGroupInvite(code: string): Promise<Jid>;
    listGroupJoinRequests(jid: Jid): Promise<GroupJoinRequest[]>;
    updateGroupJoinRequests(jid: Jid, participants: Jid[], action: 'approve' | 'reject'): Promise<GroupParticipantResult[]>;
}

/** Cria clientes; o SessionManager recebe uma factory, não uma lib. */
export interface WhatsAppClientFactory {
    /** Nome curto do provider = valor de `phone_numbers.qr_provider`. */
    readonly name: string;
    readonly libraryId: string;
    readonly capabilities: ReadonlySet<Capability>;
    /** Store da sessão neste provider (arquivos, Postgres, instância remota...). */
    createStore(sessionId: string): SessionStore;
    /** Sessões com estado persistido neste provider (para o restore no boot). */
    listStoredSessions(): Promise<string[]>;
    create(config: ClientConfig): WhatsAppClient;
    /** Versão do protocolo/web client que a lib vai anunciar (para `/health`). */
    describeRuntime(): Promise<{ libraryId: string; waVersion?: string }>;
}

// -- erros do contrato -------------------------------------------------------

export class WhatsAppClientError extends Error {
    constructor(message: string, readonly code: string, readonly statusCode?: number, readonly cause?: unknown) {
        super(message);
        this.name = 'WhatsAppClientError';
    }
}

export class MediaDownloadError extends WhatsAppClientError {
    constructor(message: string, readonly reason: 'not_found' | 'too_large' | 'expired' | 'network' | 'unknown', cause?: unknown) {
        super(message, `media_${reason}`, undefined, cause);
        this.name = 'MediaDownloadError';
    }
}

/** Contato frio barrado pelo servidor (463). */
export class ReachoutRejectedError extends WhatsAppClientError {
    constructor(readonly to: Jid, readonly timelock?: ReachoutTimelock, cause?: unknown) {
        super(`Contato frio recusado: ${to}`, 'reachout_rejected', 463, cause);
        this.name = 'ReachoutRejectedError';
    }
}
