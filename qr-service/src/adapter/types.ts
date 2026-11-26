/**
 * Modelo normalizado do adapter de WhatsApp.
 *
 * Regras do contrato:
 * - Nada aqui importa a biblioteca (Baileys ou outra). Nenhum tipo `proto.*`.
 * - Tudo é serializável em JSON, exceto `Buffer` em mídia. Isso permite que um
 *   implementador futuro seja um sidecar (ex.: whatsmeow em Go) falando HTTP/IPC.
 * - Campos opacos (`MediaRef.handle`, `PollVoteRef.handle`) pertencem ao adapter que
 *   os criou; o serviço só os devolve para o mesmo adapter, nunca os inspeciona.
 */

/** JID do WhatsApp: `5511999999999@s.whatsapp.net`, `123@lid`, `123-456@g.us`. */
export type Jid = string;

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

export type ConnectionState = 'connecting' | 'open' | 'close';

/** Causas de queda já traduzidas; o statusCode bruto viaja ao lado para diagnóstico. */
export type DisconnectCause =
    | 'logged_out'          // 401 — creds inválidas, precisa parear de novo
    | 'conflict'            // 401 conflict — outro cliente assumiu a sessão
    | 'connection_replaced' // 440
    | 'restart_required'    // 515 — reconectar com as mesmas creds
    | 'connection_lost'     // 408 / rede
    | 'timed_out'
    | 'bad_session'         // 500
    | 'forbidden'           // 403 — ban/bloqueio
    | 'multidevice_mismatch'
    | 'unavailable_service'
    /** Fechamento pedido pelo próprio serviço (`close()`). */
    | 'closed_by_us'
    | 'unknown';

export interface ConnectionUpdate {
    state?: ConnectionState;
    cause?: DisconnectCause;
    statusCode?: number;
    errorMessage?: string;
    /** Fim da drenagem da fila offline (mensagens pendentes já entregues). */
    receivedPendingNotifications?: boolean;
    isNewLogin?: boolean;
}

export interface QrUpdate {
    /** Conteúdo bruto do QR (o serviço rende a imagem). */
    qr: string;
}

export interface PairingCodeUpdate {
    code: string;
}

export interface OwnIdentity {
    jid: Jid;
    lid?: Jid;
    phone?: string;
    name?: string;
}

// ---------------------------------------------------------------------------
// Mensagens — inbound
// ---------------------------------------------------------------------------

export interface MessageKey {
    /** wamid do WhatsApp — sempre, em qualquer provider. */
    id: string;
    chatJid: Jid;
    fromMe: boolean;
    /** Em grupo: quem mandou. */
    participantJid?: Jid;
    /** Id interno do provider quando difere do wamid (ex.: SaaS HTTP). */
    providerId?: string;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/**
 * Referência opaca para download posterior. `handle` é privado do adapter que a
 * emitiu (no Baileys: o sub-message proto com mediaKey/directPath/url).
 */
export interface MediaRef {
    kind: MediaKind;
    handle: unknown;
    mimeType?: string;
    fileName?: string;
    fileLength?: number;
    sha256?: string;
    width?: number;
    height?: number;
    /** Áudio/vídeo: duração em segundos. */
    seconds?: number;
    /** Áudio gravado como voz (PTT). */
    isVoiceNote?: boolean;
    /** Vídeo gravado como "mensagem de vídeo" redonda (PTV). */
    isVideoNote?: boolean;
    isAnimated?: boolean;
    isGif?: boolean;
    caption?: string;
    /** Miniatura JPEG quando a lib entrega inline. */
    thumbnail?: Buffer;
    /** O que o ponteiro traz (para diagnóstico de falha de download em qr_message_log). */
    pointer?: { hasMediaKey: boolean; hasDirectPath: boolean; hasUrl: boolean };
}

export interface ContactCard {
    displayName: string;
    vcard: string;
}

export interface LocationContent {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
    url?: string;
    isLive?: boolean;
}

export interface PollCreateContent {
    name: string;
    options: string[];
    selectableCount: number;
}

/** Voto de enquete: chega cifrado; só o adapter que conhece a cripto abre. */
export interface PollVoteRef {
    pollKey: MessageKey;
    handle: unknown;
}

export interface PollVoteContent {
    pollKey: MessageKey;
    /** Preenchido pelo adapter quando conseguiu decifrar (segredo da enquete em cache). */
    selectedOptions?: string[];
    /** Quando não decifrado: o serviço pode pedir `client.decryptPollVote(ref, secret)`. */
    encrypted?: PollVoteRef;
}

export interface ReactionContent {
    targetKey: MessageKey;
    /** '' = reação removida. */
    emoji: string;
}

export interface EditContent {
    targetKey: MessageKey;
    /** Vazio quando a edição chegou cifrada (ver `encrypted`). */
    newText: string;
    /** Edição de LEGENDA de mídia (imagem/vídeo/documento) em vez do texto. */
    captionOf?: 'image' | 'video' | 'document';
    /** Edição cifrada com o segredo da mensagem original; abrir com `client.decryptSecretEdit`. */
    encrypted?: { handle: unknown };
}

export interface LinkPreview {
    url?: string;
    title?: string;
    description?: string;
    thumbnail?: Buffer;
}

export interface RevokeContent {
    targetKey: MessageKey;
}

export interface GroupInviteContent {
    groupJid: Jid;
    inviteCode: string;
    inviteExpiration?: number;
    groupName?: string;
    caption?: string;
}

export type ProtocolKind =
    | 'ephemeral_setting'
    | 'history_sync_notification'
    | 'app_state_sync'
    | 'peer_data_request'
    | 'message_secret'
    | 'other';

export type MessageContent =
    | { type: 'text'; text: string; linkPreview?: LinkPreview }
    | { type: 'media'; media: MediaRef }
    | { type: 'location'; location: LocationContent }
    | { type: 'contacts'; contacts: ContactCard[] }
    | { type: 'poll_create'; poll: PollCreateContent }
    | { type: 'poll_vote'; vote: PollVoteContent }
    | { type: 'reaction'; reaction: ReactionContent }
    | { type: 'edit'; edit: EditContent }
    | { type: 'revoke'; revoke: RevokeContent }
    | { type: 'group_invite'; invite: GroupInviteContent }
    /** View-once não entregue: só chega a stanza `unavailable`. */
    | { type: 'view_once_placeholder'; mediaKind?: MediaKind }
    /**
     * Chegou sem corpo. `stub` 'ciphertext'/'none' = perda real (pedir reenvio);
     * 'other' = stub informativo do WhatsApp (entrou no grupo, etc.).
     */
    | {
        type: 'undecryptable'; stub: 'none' | 'ciphertext' | 'other'; stubType?: string;
        /** A lib já pediu o reenvio ao aparelho sozinha (zapo). undefined = a lib não diz; o serviço decide. */
        resendRequested?: boolean;
    }
    | { type: 'protocol'; kind: ProtocolKind; ephemeralSeconds?: number }
    /**
     * Tipo conhecido pela lib mas sem mapeamento próprio. `skip` marca coisas que não
     * são mensagem de chat (álbum, sync, stanza só de protocolo); senão
     * `description`/`messageType`/`metadata` são o fallback legível que vai para o webhook.
     */
    | { type: 'unsupported'; rawType: string; description: string | null; skip?: 'album' | 'deliberate' | 'protocol'; messageType?: string; metadata?: Record<string, unknown> };

export interface QuotedRef {
    key: MessageKey;
    /** Resumo do conteúdo citado, quando a lib inclui. */
    content?: MessageContent;
}

/**
 * Referral de anúncio "click-to-WhatsApp". `referral` é o externalAdReply + campos de
 * conversão já em JSON puro (bytes em base64), como o webhook sempre recebeu.
 */
export interface CtwaReferral {
    ctwaClid: string | null;
    referral: Record<string, unknown>;
}

export interface InboundMessage {
    key: MessageKey;
    /** Unix ms. */
    timestamp: number;
    senderJid: Jid;
    /** Telefone (JID @s.whatsapp.net) do remetente quando a lib já resolveu o LID. */
    senderPn?: Jid;
    senderLid?: Jid;
    /** Forma alternativa do chat (PN quando o chat é LID e vice-versa). */
    chatAltJid?: Jid;
    pushName?: string;
    /** Nome verificado de conta business, quando a lib entrega. */
    businessName?: string;
    /** Segredo da mensagem (enquetes, edições cifradas). */
    messageSecret?: Buffer;
    /** Caminho de wrappers + folha do corpo cru, só para diagnóstico. */
    shape?: string;
    isGroup: boolean;
    /** Broadcast/status/newsletter. */
    isBroadcast: boolean;
    content: MessageContent;
    quoted?: QuotedRef;
    mentionedJids: Jid[];
    isForwarded: boolean;
    /** Contador de encaminhamentos (>= 5 = "encaminhada com frequência"). */
    forwardingScore: number;
    isEphemeral: boolean;
    isViewOnce: boolean;
    referral?: CtwaReferral;
    /** Corpo cru da lib, só para log/diagnóstico. Nunca decida lógica por ele. */
    raw?: unknown;
}

export type UpsertKind =
    /** Mensagem nova ao vivo. */
    | 'notify'
    /** Fila offline / eco de envio próprio. */
    | 'append';

export interface MessagesUpsert {
    kind: UpsertKind;
    messages: InboundMessage[];
}

export type HistorySyncKind = 'recent' | 'on_demand' | 'full' | 'other';

export interface HistorySync {
    kind: HistorySyncKind;
    messages: InboundMessage[];
    isLatest: boolean;
    /** Correlaciona com o pedido de `fetchMessageHistory`. */
    requestId?: string;
}

// ---------------------------------------------------------------------------
// Mensagens — updates, recibos, presença
// ---------------------------------------------------------------------------

export type MessageStatus = 'error' | 'pending' | 'sent' | 'delivered' | 'read' | 'played';

export type MessageUpdate =
    /** `errorCode` só em status 'error' (ex.: '463' contato frio recusado). */
    | { key: MessageKey; type: 'status'; status: MessageStatus; errorCode?: string }
    | { key: MessageKey; type: 'edit'; newText: string }
    | { key: MessageKey; type: 'revoke' }
    | { key: MessageKey; type: 'poll_update'; vote: PollVoteContent }
    /** Mídia que estava indisponível foi reenviada pelo aparelho. */
    | { key: MessageKey; type: 'media_retry'; media?: MediaRef; ok: boolean }
    | { key: MessageKey; type: 'other'; raw?: unknown };

export interface MessageReceipt {
    key: MessageKey;
    userJid: Jid;
    type: 'delivered' | 'read' | 'played' | 'retry' | 'other';
    timestamp: number;
}

export type PresenceState = 'available' | 'unavailable' | 'composing' | 'recording' | 'paused';

export interface PresenceUpdate {
    chatJid: Jid;
    participantJid: Jid;
    state?: PresenceState;
    lastSeen?: number;
}

export interface ContactUpdate {
    jid: Jid;
    lid?: Jid;
    /** Telefone (JID) quando a lib manda o par LID↔PN no evento. */
    phoneJid?: Jid;
    name?: string;
    notify?: string;
    /** 'changed' | 'removed' — a lib só sinaliza; a URL vem por `getProfilePictureUrl`. */
    avatar?: 'changed' | 'removed';
}

export interface LidMapping {
    lid: Jid;
    pn: Jid;
}

// ---------------------------------------------------------------------------
// Grupos
// ---------------------------------------------------------------------------

export type GroupRole = 'admin' | 'superadmin' | null;

export interface GroupParticipant {
    jid: Jid;
    /** Telefone quando a lib já entrega ao lado do LID. */
    phoneJid?: Jid;
    lid?: Jid;
    /** Nome/username quando a lib entrega nos metadados. */
    name?: string;
    role: GroupRole;
}

export interface GroupInfo {
    jid: Jid;
    subject: string;
    subjectOwner?: Jid;
    subjectTime?: number;
    description?: string;
    ownerJid?: Jid;
    creation?: number;
    participants: GroupParticipant[];
    size?: number;
    announce: boolean;      // só admins mandam
    restrict: boolean;      // só admins editam dados
    joinApprovalMode: boolean;
    memberAddMode: 'admin_add' | 'all_member_add';
    ephemeralDuration?: number;
    isCommunity: boolean;
    isCommunityAnnounce: boolean;
    linkedParentJid?: Jid;
    /** Quando a lib já devolve junto (ex.: após criar). */
    inviteCode?: string;
    /** Como o grupo endereça participantes (afeta o voto de enquete). */
    addressingMode?: 'pn' | 'lid';
    /** Em `groups.upsert`: quem nos adicionou. */
    author?: GroupActor;
    /** Grupo suspenso pelo WhatsApp (só a zapo entrega; undefined = a lib não informa). */
    suspended?: boolean;
    /** Estado do apelo contra a suspensão. */
    appealStatus?: 'approved' | 'in_review' | 'none' | 'rejected';
    /** Unix ms até quando o WhatsApp travou a entrada de novos membros. */
    growthLockedUntil?: number;
}

/** Voto de enquete a enviar. A cripto é da lib; o serviço só escolhe o endereçamento. */
export interface PollVoteRequest {
    pollKey: MessageKey;
    pollSecret: Buffer;
    /** JID nosso no modo de endereçamento escolhido (pn ou lid). */
    voterJid: Jid;
    /** JID do criador da enquete no mesmo modo. */
    creatorJid: Jid;
    selectedOptions: string[];
}

export type GroupParticipantAction = 'add' | 'remove' | 'promote' | 'demote';

export interface GroupActor {
    jid: Jid;
    phoneJid?: Jid;
    name?: string;
}

export interface GroupParticipantsUpdate {
    groupJid: Jid;
    action: GroupParticipantAction;
    participants: GroupParticipant[];
    author?: GroupActor;
}

/**
 * Nome do grupo trocou (aviso do WhatsApp a cada participante). Sem isso o Echo só via o nome
 * novo de carona na próxima mensagem, depois de o cache de metadados expirar.
 */
export interface GroupSubjectUpdate {
    groupJid: Jid;
    subject: string;
    author?: GroupActor;
    /** Unix segundos da troca, quando a lib informa. */
    timestamp?: number;
}

export interface GroupParticipantResult {
    jid: Jid;
    /** Telefone (JID @s.whatsapp.net) quando `jid` é LID e a lib devolve o par. */
    phoneJid?: Jid;
    /** Código da lib ('200' ok, '403' privacidade, '408' saiu recente, '409' já está...). */
    status: string;
    /** Para 403: link de convite que a lib devolve para mandar por DM. */
    inviteCode?: string;
    inviteExpiration?: number;
}

export type GroupSetting = 'announcement' | 'not_announcement' | 'locked' | 'unlocked';

export interface GroupInviteInfo {
    jid: Jid;
    subject: string;
    size?: number;
    description?: string;
    ownerJid?: Jid;
    creation?: number;
}

export interface GroupJoinRequest {
    jid: Jid;
    phoneJid?: Jid;
    requestMethod?: string;
    requestTime?: number;
}

// ---------------------------------------------------------------------------
// Mensagens — outbound
// ---------------------------------------------------------------------------

export interface OutboundMediaSource {
    /** Bytes ou URL para a lib baixar/subir. */
    data: Buffer | { url: string };
    mimeType: string;
    fileName?: string;
    caption?: string;
}

export type OutboundContent =
    | { type: 'text'; text: string; linkPreview?: boolean }
    | { type: 'image'; media: OutboundMediaSource; viewOnce?: boolean }
    | { type: 'video'; media: OutboundMediaSource; gifPlayback?: boolean; isVideoNote?: boolean; viewOnce?: boolean }
    | { type: 'audio'; media: OutboundMediaSource; isVoiceNote: boolean; seconds?: number; waveform?: Buffer; viewOnce?: boolean }
    | { type: 'document'; media: OutboundMediaSource }
    | { type: 'sticker'; media: OutboundMediaSource; isAnimated?: boolean }
    | { type: 'location'; location: LocationContent }
    | { type: 'contacts'; contacts: ContactCard[]; displayName?: string }
    | { type: 'poll'; poll: PollCreateContent }
    | { type: 'reaction'; reaction: ReactionContent }
    | { type: 'edit'; edit: EditContent }
    | { type: 'revoke'; revoke: RevokeContent }
    | { type: 'group_invite'; invite: GroupInviteContent };

export interface SendOptions {
    /** Resposta a outra mensagem. O adapter precisa do conteúdo citado para montar o preview. */
    quoted?: { key: MessageKey; content?: MessageContent; raw?: unknown };
    mentionedJids?: Jid[];
    /** Segundos; mensagens temporárias do chat. */
    ephemeralExpiration?: number;
    /** Forçar o id da mensagem (retry/update-in-place). */
    messageId?: string;
    /** Marca "Encaminhada" no aparelho do destinatário. */
    forwarded?: boolean;
}

export interface SendResult {
    key: MessageKey;
    timestamp: number;
    /** Segredo da mensagem enviada (enquete: decifra votos; texto: decifra edições cifradas). */
    messageSecret?: Buffer;
    /** Alias de `messageSecret` quando a mensagem é enquete. */
    pollSecret?: Buffer;
    /** Corpo enviado, para cache de retry-decrypt do próprio adapter. */
    raw?: unknown;
}

export interface WhatsAppLookup {
    jid: Jid;
    exists: boolean;
    lid?: Jid;
}

export interface ProfileInfo {
    jid: Jid;
    name?: string;
    status?: string;
    pictureUrl?: string | null;
}

export type ChatState = 'composing' | 'recording' | 'paused';
export type GlobalPresence = 'available' | 'unavailable';

/** Bloqueio de contato frio (código 463) informado pelo servidor. */
export interface ReachoutTimelock {
    isActive: boolean;
    /** Unix ms em que o bloqueio termina, quando ativo. */
    lockedUntil?: number;
    enforcementType?: string;
    raw?: unknown;
}

// ---------------------------------------------------------------------------
// Capabilities, credenciais e transporte
// ---------------------------------------------------------------------------

/**
 * O que um provider sabe fazer. Rotas consultam antes de chamar e respondem
 * 501 `unsupported_by_provider` em vez de quebrar; a UI esconde o botão.
 */
export type Capability =
    | 'qr'
    | 'pairing_code'
    | 'poll_create'
    | 'poll_vote'
    | 'reaction'
    | 'edit'
    | 'revoke'
    | 'lid'
    | 'history_fetch'
    | 'media_retry'
    | 'placeholder_resend'
    | 'view_once_placeholder'
    | 'group_join_requests'
    | 'group_invite_info'
    | 'reachout_timelock'
    | 'message_capping'
    | 'presence_subscribe'
    | 'chat_state'
    | 'profile_picture'
    | 'auth_snapshot'
    /** Ligação de voz (fazer, atender, encerrar, áudio ao vivo). */
    | 'voice_call';

/**
 * Credenciais + chaves Signal de uma sessão num formato neutro. É o shape
 * `{ creds, keys }` do `useMultiFileAuthState` do Baileys, que `wa-store-migrate`
 * já converte para outras libs. Permite trocar de lib SEM re-parear.
 */
export interface AuthSnapshot {
    format: 'baileys-v1';
    creds: Record<string, unknown>;
    keys: Record<string, Record<string, unknown>>;
    exportedAt: number;
    libraryId: string;
}

/**
 * Onde a lib guarda o estado da sessão. Cada provider escolhe a implementação
 * (arquivos, Postgres, ...); o serviço só passa a referência.
 */
export interface SessionStore {
    readonly kind: string;
    /** Identificador estável (path, schema, instanceId) para logs e `/health`. */
    readonly locator: string;
    /** Apaga tudo da sessão (logout definitivo / reset). */
    wipe(): Promise<void>;
    /** Existe estado persistido (pode ser só o esqueleto de um pareamento que não terminou). */
    exists(): Promise<boolean>;
    /** Credenciais completas de um pareamento concluído (tem identidade própria). */
    isPaired(): Promise<boolean>;
}

/** Overrides de rede: testes contra fake-server, proxy, etc. */
export interface TransportOverrides {
    socketUrl?: string;
    /** Raiz do cert Noise a confiar no lugar da pinada do WhatsApp. */
    noiseRootCa?: { publicKey: Uint8Array; serial: number };
    /** Agent HTTPS para upload/download de mídia (libs que aceitam agent). */
    mediaAgent?: unknown;
    /** Host (host:porta) de mídia no lugar de mmg.whatsapp.net (libs que aceitam host). */
    mediaHost?: string;
    waVersion?: [number, number, number];
}

/** Quota de envio informada pelo servidor (só algumas libs entregam). */
/**
 * Cota de conversas NOVAS por ciclo que o WhatsApp impõe à conta (message capping).
 * Chega por evento (notificação MEX) e por consulta (`fetchMessageCapping`).
 * `CAPPED` = o servidor recusa mensagem a quem nunca falou conosco.
 */
export interface MessageCapping {
    status: 'NONE' | 'FIRST_WARNING' | 'SECOND_WARNING' | 'CAPPED' | string;
    totalQuota?: number;
    usedQuota?: number;
    /** Unix ms. */
    cycleStart?: number;
    /** Unix ms. */
    cycleEnd?: number;
    oteStatus?: string;
    mvStatus?: string;
    raw?: unknown;
}

// ---------------------------------------------------------------------------
// Ligação de voz
// ---------------------------------------------------------------------------

export type CallState = 'initiating' | 'ringing' | 'incoming_ringing' | 'connecting' | 'active' | 'on_hold' | 'ended';

/** Estado de uma ligação (nossa ou do contato) no modelo normalizado. */
export interface CallUpdate {
    callId: string;
    peerJid: Jid;
    /** Telefone do contato quando a lib entrega ao lado do LID. */
    peerPn?: Jid;
    direction: 'outgoing' | 'incoming';
    isVideo: boolean;
    state: CallState;
    /** Motivo do fim ('user_ended', 'declined', 'timeout', 'busy', ...), só em 'ended'. */
    endReason?: string;
    startedAt: number;
    connectedAt?: number;
    endedAt?: number;
    durationSecs?: number;
    muted: boolean;
}

export interface StartCallOptions {
    /** Arquivo de áudio pré-gravado (qualquer formato que o ffmpeg leia) tocado ao conectar. */
    audioFile?: string;
    isVideo?: boolean;
}

/** PCM Float32 mono 16 kHz: o único formato que circula pelo contrato. */
export const CALL_AUDIO_SAMPLE_RATE = 16_000;

// ---------------------------------------------------------------------------
// Mapa de eventos
// ---------------------------------------------------------------------------

export interface ClientEventMap {
    'connection.update': ConnectionUpdate;
    'qr': QrUpdate;
    'pairing_code': PairingCodeUpdate;
    /** Creds mudaram e foram persistidas pelo adapter; o serviço só precisa saber. */
    'creds.update': { registered: boolean; me?: OwnIdentity };
    'messages.upsert': MessagesUpsert;
    'messages.update': MessageUpdate[];
    'message-receipt.update': MessageReceipt[];
    'history.sync': HistorySync;
    'contacts.update': ContactUpdate[];
    'lid-mapping.update': LidMapping;
    'groups.upsert': GroupInfo[];
    'group-participants.update': GroupParticipantsUpdate;
    'group-subject.update': GroupSubjectUpdate;
    'presence.update': PresenceUpdate;
    /**
     * Fila offline drenada após conectar. `count` = total que o servidor anunciou
     * (-1 quando a lib não conta); `remaining` = o que sobrou na fila do servidor;
     * `forced` = a drenagem foi cortada e o resto fica para a próxima conexão.
     */
    'offline.drained': { count: number; remaining?: number; forced?: boolean };
    'message_capping': MessageCapping;
    /** Ligação mudou de estado (inclui a chegada de uma ligação do contato). */
    'call.update': CallUpdate;
    /** Áudio do contato numa ligação ativa: PCM Float32 mono 16 kHz. */
    'call.audio': { callId: string; pcm: Float32Array };
    /** Erro lançado por uma stanza que a lib não soube processar (não derruba a sessão). */
    'error': { scope: string; error: unknown };
}

export type ClientEventName = keyof ClientEventMap;
