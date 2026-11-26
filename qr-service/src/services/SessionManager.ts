// Polyfill must be imported before Baileys
import { mediaDimsMeta } from './mediaDims.js';
import '../polyfills.js';

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import QRCode from 'qrcode';
import { supabase } from '../lib/supabase.js';
import { postJson } from '../lib/httpClient.js';
import { WebhookOutbox } from '../lib/webhookOutbox.js';
import { MediaTempStore, type MediaTempFile } from '../lib/mediaTemp.js';
import { uploadFileResumable } from '../lib/resumableUpload.js';
import { baseInterna, paraUrlInterna, urlPublicaDoAnexo } from '../lib/publicUrl.js';
import { transcodeToOpus } from '../lib/audio.js';
import { audioMeta } from '../lib/audioWaveform.js';
import {
    MediaDownloadError,
    ProviderRegistry,
    WhatsAppClientError,
    type ClientEventMap,
    type ClientEventName,
    type GroupInfo,
    type GroupParticipantsUpdate,
    type GroupSubjectUpdate,
    type InboundMessage,
    type MediaRef,
    type MessageCapping,
    type MessageContent,
    type OutboundContent,
    type PollVoteContent,
    type ReachoutTimelock,
    type AuthSnapshot,
    type CallUpdate,
    type SendOptions,
    type SessionStore,
    type WhatsAppClient,
    type WhatsAppClientFactory,
} from '../adapter/index.js';
import { BaileysClientFactory } from '../adapter/baileys/index.js';
import { latestSnapshotBackup, saveSnapshotBackup } from '../lib/authSnapshotFile.js';
import { ZapoClientFactory } from '../adapter/zapo/index.js';
import { normalizeJidUser } from '../lib/jid.js';
import { groupSubjectEvent } from '../lib/groupSubject.js';
import { ownPictureDataUrl } from '../lib/ownProfilePicture.js';
import { checkCanAddParticipants, findSelfParticipant, isGroupAdminRole, type GroupAddBlock } from '../lib/groupSelf.js';
import { groupAddRefusalMessage, joinGroupAddRefusals, toParticipantJids } from '../lib/groupAdd.js';
import { listStoredOnce, listStoredWithRetry } from '../lib/restoreDiscovery.js';
import { describeSupabaseError } from '../lib/supabaseError.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import NodeCache from 'node-cache';


// Abaixo disso, a fila offline nativa do WhatsApp (messages.upsert type='append')
// já cobre o gap sozinha — rodar o refetch ativo seria trabalho à toa por conversa.
const AUTO_RECOVERY_GAP_THRESHOLD_MS = 5 * 60 * 1000;
// Só conversas com atividade recente entram na varredura automática: fetchMessageHistory
// é uma chamada por conversa, sequencial (guarda SYNC_ALREADY_RUNNING é por sessão), então
// varrer conversas mortas travaria a sessão por minutos numa reconexão com muito histórico.
const AUTO_RECOVERY_ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_RECOVERY_MAX_CONVERSATIONS = 200;

// Map a message's content key to the Baileys MediaType used for downloads.
/** Forma mínima do envio cru que os logs de diagnóstico ainda leem (id/status/timestamp). */
type RawSentMessage = {
    key?: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null };
    status?: unknown;
    messageTimestamp?: unknown;
    message?: unknown;
};

interface PollVoteAddressing {
    mode: 'lid' | 'pn';
    relayJid: string;
    voterJid: string;
    creatorJid: string;
}

// Extract the downloadable payload + media type from a message, or null if not media.
type SharedContact = { displayName: string; vcard: string; phones: string[] };
// Campos de topo espelham o primeiro contato: consumidores antigos (e as rows
// gravadas antes do suporte a múltiplos) só conhecem esse formato singular.
type ContactMetadata = SharedContact & { contacts?: SharedContact[] };

function parseSharedContact(
    displayName: string | null | undefined,
    vcard: string | null | undefined
): SharedContact {
    const safeVcard = vcard || '';
    // Extract phone numbers from vCard (TEL lines)
    const phones = safeVcard.match(/TEL[^:]*:([^\n\r]+)/gi)?.map(
        (tel: string) => tel.replace(/TEL[^:]*:/i, '').trim()
    ) || [];
    return { displayName: displayName || 'Sem nome', vcard: safeVcard, phones };
}

// Sinais de conversão que ficam no nível do contextInfo, ao lado do externalAdReply.
/** Prévia da mensagem citada, como o webhook sempre recebeu. */
function quotedLabel(content: MessageContent): string {
    if (content.type === 'text') return content.text || '[Mídia]';
    if (content.type === 'media') return content.media.caption || '[Mídia]';
    return '[Mídia]';
}

function errInfo(e: unknown): { code: string; name: string; message: string } {
    const err = e as { code?: unknown; name?: unknown; message?: unknown; cause?: { code?: unknown; name?: unknown } } | null;
    const code = String(err?.code ?? err?.cause?.code ?? '').toUpperCase();
    const name = String(err?.name ?? err?.cause?.name ?? '');
    const message = String(err?.message ?? e ?? '');
    return { code, name, message };
}

// Transient network failures worth retrying (Baileys uses native fetch → "fetch failed").
function isTransientDownloadError(e: unknown): boolean {
    const { code, name, message } = errInfo(e);
    const m = message.toLowerCase();
    if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE|ENOTFOUND/.test(code)) return true;
    if (name === 'AggregateError') return true;
    return (
        m.includes('fetch failed') ||
        m.includes('socket hang up') ||
        m.includes('timeout') ||
        m.includes('network') ||
        m.includes('econnreset') ||
        m.includes('etimedout') ||
        /\b50[0-9]\b/.test(m)
    );
}

// Media whose CDN URL/key expired — fixable by forcing a reupload before retrying.
function isMediaExpiredError(e: unknown): boolean {
    const { code, message } = errInfo(e);
    const m = message.toLowerCase();
    return (
        code.includes('ERR_OSSL') ||
        m.includes('bad decrypt') ||
        m.includes('410') ||
        m.includes('404') ||
        // A Boom do Baileys traz o número, não a palavra: um 403 do CDN caía como
        // não-transiente e abortava na 1ª tentativa sem pedir reupload ao aparelho.
        m.includes('403') ||
        m.includes('not found') ||
        m.includes('forbidden') ||
        m.includes('expired')
    );
}

/** Teto absoluto de mídia recebida. Acima disso a mensagem chega sem o arquivo (`media_too_large`). */
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES) || 50 * 1024 * 1024;
/**
 * Mídia acima disto (ou sem tamanho declarado) não passa pela memória: vai em
 * stream para um arquivo temporário e sobe ao Storage por upload resumível. Abaixo,
 * o caminho em memória de sempre (figurinha, foto, áudio).
 */
const MEDIA_STREAM_THRESHOLD_BYTES = Number(process.env.MEDIA_STREAM_THRESHOLD_BYTES) || 16 * 1024 * 1024;
/** Espaço que os arquivos temporários de mídia sempre deixam livre no disco (as creds moram nele). */
const MEDIA_DISK_RESERVE_BYTES = Number(process.env.MEDIA_DISK_RESERVE_BYTES) || 2 * 1024 * 1024 * 1024;
const mediaTemp = new MediaTempStore({
    dir: path.join(os.tmpdir(), 'qr-media'),
    reserveFreeBytes: MEDIA_DISK_RESERVE_BYTES,
    ttlMs: 2 * 60 * 60 * 1000,
});

// ---- Proteção contra restrição de número (erro 463, churn de pareamento) ----
/** Lê um inteiro de env aceitando 0 como valor válido (0 = desligado). */
const envNumber = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// Espaçamento entre envios da MESMA sessão: sequencial, aleatório entre min e max.
// DESLIGADO por padrão (0): o atendimento em tempo real não pode esperar. Para ligar, defina SEND_MAX_GAP_MS > 0 em ms (ex.: 1000/3000; o mínimo é SEND_MIN_GAP_MS).
const SEND_MIN_GAP_MS = envNumber('SEND_MIN_GAP_MS', 0);
const SEND_MAX_GAP_MS = Math.max(SEND_MIN_GAP_MS, envNumber('SEND_MAX_GAP_MS', 0));
const SEND_SPACING_ENABLED = SEND_MAX_GAP_MS > 0;
// Fila cheia (só com espaçamento ligado): quem esperaria mais que isto é recusado
// na hora em vez de estourar o timeout HTTP no meio do caminho.
const SEND_MAX_QUEUE_WAIT_MS = envNumber('SEND_MAX_QUEUE_WAIT_MS', 60_000);
// Contatos NOVOS (sem nenhuma mensagem recebida) distintos por hora, por sessão.
// 0 desliga. Volume a desconhecidos é a causa de restrição com mais relatos (#2800).
const NEW_CONTACT_HOURLY_CAP = envNumber('NEW_CONTACT_HOURLY_CAP', 20);
/** Ligação de voz (plugin da zapo + binário nativo). Só em imagem preparada (Dockerfile.voip). */
const VOIP_ENABLED = process.env.VOIP_ENABLED === '1';
/** Ligações simultâneas por linha. 1 = comportamento do cliente oficial; >1 só em teste. */
const VOIP_MAX_CONCURRENT_CALLS = Math.max(1, envNumber('VOIP_MAX_CONCURRENT_CALLS', 1));
// Pareamentos (QR/código) por número por hora, e cooldown de reconexão manual
// depois de um 401/403 em sessão registrada — repetir o pareamento é o que vira 428/ban.
const QR_HOURLY_CAP = Number(process.env.QR_HOURLY_CAP) || 5;
// 0 desliga o cooldown (envNumber, não `||`: 0 é falsy e caía no default de 30 min).
const CONNECT_COOLDOWN_AFTER_FATAL_MS = envNumber('CONNECT_COOLDOWN_AFTER_FATAL_MS', 30 * 60 * 1000);
// Intervalo entre reconexões no boot: sem ele um redeploy abre todas as sessões
// em rajada, no mesmo segundo, do mesmo IP.
const RESTORE_STAGGER_MS = Number(process.env.RESTORE_STAGGER_MS) || 3000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Razão do skip → action do qr_message_log (o único rastro do que não virou mensagem). */
const SKIP_ACTION = {
    album: 'msg_skip_album',
    deliberate: 'msg_skip_deliberate',
    protocol: 'msg_skip_protocol',
} as const satisfies Record<NonNullable<Extract<MessageContent, { type: 'unsupported' }>['skip']>, string>;

/** connect() recusado pela proteção de pareamento; a rota devolve 429 com a mensagem. */
export class ConnectRefusedError extends Error {
    readonly code = 'connect_refused';
    constructor(message: string) {
        super(message);
        this.name = 'ConnectRefusedError';
    }
}

/**
 * JIDs cujas mensagens o CRM não rastreia individualmente. Um revoke vindo daqui
 * referencia mensagem que nunca existiu em `messages`, então o POST só rende um
 * 404 na edge. NÃO usar no caminho de ingestão: mensagem de canal É salva; o que
 * não vale a pena é o webhook de apagamento dela.
 */
function isUntrackedRevokeOrigin(jid: string): boolean {
    return jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}

/**
 * Desfecho do download, preenchido para o caller registrar evidência. Sem isto o
 * caller só via `null` e o motivo real ficava em console.error — inacessível em
 * produção (um PDF de contato perdido sem sequer saber se foi 403,
 * chave ausente ou decifragem).
 */
interface MediaDownloadInfo {
    tooLarge?: boolean;
    /** tooLarge porque o disco não tinha folga para o arquivo temporário, não pelo tamanho. */
    diskFull?: boolean;
    declaredBytes?: number;
    /** Download tentado e esgotado (todas as tentativas + fallback). */
    failed?: boolean;
    lastError?: string;
    lastErrorCode?: string;
    attempts?: number;
    elapsedMs?: number;
    /** Forma do ponteiro cifrado — distingue "sem chave" de "CDN recusou". */
    hasMediaKey?: boolean;
    hasDirectPath?: boolean;
    hasUrl?: boolean;
}

/** Status HTTP/IQ de um erro da lib ou do contrato, para os ramos 401/403/404/429. */
function errorStatus(error: unknown): number | undefined {
    if (error instanceof WhatsAppClientError) return error.statusCode;
    return (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}

async function retryMediaDownload<T>(
    inbound: InboundMessage,
    client: WhatsAppClient | null | undefined,
    maxRetries: number,
    initialDelayMs: number,
    info: MediaDownloadInfo | undefined,
    attemptDownload: (client: WhatsAppClient, ref: MediaRef) => Promise<T>,
): Promise<T | null> {
    if (!client) return null;
    const ref: MediaRef | null = inbound.content.type === 'media' ? inbound.content.media : null;
    let lastError: unknown = null;
    const startedAt = Date.now();
    let attemptsMade = 0;
    const declared = ref?.fileLength ?? 0;
    if (info) {
        if (declared > 0) info.declaredBytes = declared;
        info.hasMediaKey = ref?.pointer?.hasMediaKey ?? false;
        info.hasDirectPath = ref?.pointer?.hasDirectPath ?? false;
        info.hasUrl = ref?.pointer?.hasUrl ?? false;
    }
    if (!ref) {
        if (info) { info.failed = true; info.lastError = 'mensagem sem mídia baixável'; }
        return null;
    }
    if (declared > MAX_MEDIA_BYTES) {
        console.warn(`[MediaDownload] Mídia declarada com ${declared} bytes (> ${MAX_MEDIA_BYTES}) — pulando download`);
        if (info) {
            info.tooLarge = true;
            info.declaredBytes = declared;
        }
        return null;
    }
    const key = inbound.key;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        attemptsMade = attempt;
        try {
            return await attemptDownload(client, ref);
        } catch (e: unknown) {
            lastError = e;
            const { message: errMsg } = errInfo(e);
            console.warn(`[MediaDownload] Attempt ${attempt}/${maxRetries} failed: ${errMsg}`);
            if (e instanceof MediaDownloadError && e.reason === 'too_large') {
                if (info) { info.tooLarge = true; }
                return null;
            }
            const transient = e instanceof MediaDownloadError ? e.reason === 'network' : isTransientDownloadError(e);
            const expired = e instanceof MediaDownloadError ? e.reason === 'expired' : isMediaExpiredError(e);
            if (expired) {
                // Mídia expirada no CDN: pede ao aparelho que reenvie e tenta de novo.
                try {
                    await client.requestMediaRetry(key, ref);
                } catch (reuploadError: unknown) {
                    console.warn('[MediaDownload] requestMediaRetry falhou:', errInfo(reuploadError).message);
                }
            }
            if (!transient && !expired) {
                break;
            }
            if (attempt < maxRetries) {
                const delay = initialDelayMs * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    const last = errInfo(lastError);
    console.error(`[MediaDownload] All attempts failed. Last error:`, last.message);
    if (info) {
        info.failed = true;
        info.lastError = last.message.slice(0, 500);
        info.lastErrorCode = last.code || last.name || undefined;
        info.attempts = attemptsMade;
        info.elapsedMs = Date.now() - startedAt;
    }
    return null;
}

/** Mídia pequena: inteira na memória. */
function downloadWithRetry(
    inbound: InboundMessage,
    client: WhatsAppClient | null | undefined,
    maxRetries: number = 4,
    initialDelayMs: number = 1000,
    info?: MediaDownloadInfo,
): Promise<Buffer | null> {
    const maxBytes = Math.min(MAX_MEDIA_BYTES, MEDIA_STREAM_THRESHOLD_BYTES);
    return retryMediaDownload(inbound, client, maxRetries, initialDelayMs, info, async (c, ref) => {
        const buffer = await c.downloadMedia(ref, { maxBytes });
        if (!buffer?.length) throw new Error('download retornou buffer vazio');
        return buffer;
    });
}

/** Mídia baixada para o disco, à espera do upload resumível. `release()` apaga o arquivo. */
interface InboundMediaFile {
    path: string;
    size: number;
    release: () => Promise<void>;
}

type InboundMedia = { buffer: Buffer } | { file: InboundMediaFile };

/** Vai para o disco o que é grande ou não declara tamanho. Figurinha fica na memória (o cache usa o buffer). */
function mediaGoesToDisk(ref: MediaRef): boolean {
    if (ref.kind === 'sticker') return false;
    const declared = ref.fileLength ?? 0;
    return declared === 0 || declared > MEDIA_STREAM_THRESHOLD_BYTES;
}

/**
 * Baixa a mídia de uma mensagem pelo caminho certo para o tamanho dela: memória
 * até `MEDIA_STREAM_THRESHOLD_BYTES`, disco + upload resumível acima (até
 * `MAX_MEDIA_BYTES`). Disco sem folga conta como `tooLarge`: a mensagem segue
 * sem o arquivo, com a marcação de sempre.
 */
async function downloadInboundMedia(
    inbound: InboundMessage,
    client: WhatsAppClient | null | undefined,
    maxRetries: number,
    initialDelayMs: number,
    info?: MediaDownloadInfo,
): Promise<InboundMedia | null> {
    const ref: MediaRef | null = inbound.content.type === 'media' ? inbound.content.media : null;
    if (!ref || !mediaGoesToDisk(ref) || (ref.fileLength ?? 0) > MAX_MEDIA_BYTES) {
        const buffer = await downloadWithRetry(inbound, client, maxRetries, initialDelayMs, info);
        return buffer ? { buffer } : null;
    }
    if (!client) return null;

    let temp: MediaTempFile;
    try {
        temp = await mediaTemp.reserve(ref.fileLength || MAX_MEDIA_BYTES, inbound.key.id ?? 'media');
    } catch (error) {
        console.warn(`[MediaDownload] ${errInfo(error).message} — mídia de ${inbound.key.id} fica sem arquivo`);
        if (info) {
            info.tooLarge = true;
            info.diskFull = true;
            info.declaredBytes = ref.fileLength || undefined;
        }
        return null;
    }
    const size = await retryMediaDownload(inbound, client, maxRetries, initialDelayMs, info, async (c, r) => {
        const written = await c.downloadMediaToFile(r, temp.path, { maxBytes: MAX_MEDIA_BYTES });
        if (!written) throw new Error('download retornou arquivo vazio');
        return written;
    });
    if (!size) {
        await temp.release();
        return null;
    }
    return { file: { path: temp.path, size, release: temp.release } };
}



interface ReachoutLock {
    hits: number;
    lockedUntil: number;
    lastJid: string;
    lastAt: number;
    /** 'server' = prazo informado pelo WhatsApp (fetchAccountReachoutTimelock);
     *  'fallback' = escalonado local quando o servidor não informa. */
    source: 'server' | 'fallback';
    enforcementType?: string;
}

interface Session {
    /** Adapter da lib. Nulo só entre a criação do objeto e o `connect()`. */
    client: WhatsAppClient | null;
    /** Nome do provider que criou o cliente (para /health; o cache por linha expira). */
    providerName?: string;
    qrCode: string | null;
    status: 'disconnected' | 'connecting' | 'connected' | 'qr_ready' | 'qr_expired' | 'needs_reconnect';
    phoneNumberId: string;
    listeners: Set<(event: string, data: unknown) => void>;
    reconnectAttempts: number;
    presenceInterval?: NodeJS.Timeout;
    reconnectTimer?: ReturnType<typeof setTimeout>;
    lastDisconnectedAt?: number; // Unix timestamp (ms) when session disconnected - used for offline sync
    lastActivityAt?: number; // Unix timestamp (ms) of last received event - used by watchdog
    /** Quantas mensagens da fila offline chegaram nesta conexão. É o que de fato
     *  recupera o gap de uma queda: o WhatsApp reentrega o pendente como
     *  messages.upsert type='append'. Contado só durante a drenagem. */
    offlineRecovered?: number;
    /** Refetch on-demand em andamento (fetchMessageHistory). O cutoff vem do
     *  pedido, não da janela de desconexão: um pedido explícito de histórico quer
     *  justamente mensagens antigas, que o cutoff do gap descartaria. */
    onDemandSync?: { cutoffMs: number; received: number };
    /** true entre o 'open' e o connection.update com receivedPendingNotifications,
     *  janela em que o 'append' significa fila offline (fora dela, 'append' também
     *  cobre mensagem que nós mesmos enviamos). */
    offlineDrainPending?: boolean;
    pairingCode: string | null; // last generated 8-char pairing code (in-memory only)
    usePairingCode?: boolean; // connect via pairing code instead of QR
    pairingPhone?: string; // digits-only E.164 (no '+') to pair against
    pairingCodeRequested?: boolean; // requestPairingCode() must run once per socket
    pairingRenewals?: number; // fresh-creds renewals consumed (NOT reset on code gen)
    /** Cache de phone_numbers.keep_device_notifications. Decide se a presença
     *  global é 'unavailable' (celular notifica) ou 'available' (presença
     *  completa do contato). Ver resolvePresenceState(). */
    keepDeviceNotifications?: boolean;
    /** to -> JID resolvido. O chatstate de "digitando" refresca a cada ~8s e
     *  resolveJid() faz onWhatsApp() (ida-e-volta na rede) — sem cache, digitar
     *  viraria uma consulta por refresh. Só o caminho de presença usa. */
    presenceJidCache?: Map<string, string>;
    /** LID (só o user, sem device) -> telefone. Semeado no presence-subscribe,
     *  onde ainda temos o telefone em mãos; o presence.update depois chega só
     *  com o @lid e não teria como voltar ao número sozinho. */
    presenceLidPhone?: Map<string, string>;
    /** true enquanto autoRecoverConversations varre as conversas após uma queda
     *  longa. Evita disparar duas varreduras em paralelo se a sessão cair e
     *  reconectar de novo no meio de uma. */
    autoRecoveryRunning?: boolean;
    /** true depois do primeiro QR deste socket. Um QR por pedido: o segundo ref
     *  (o primeiro expirou sem leitura) encerra o socket em vez de renovar o QR —
     *  cada QR gerado é um pareamento pendente a mais na conta do anti-abuso. */
    qrEmitted?: boolean;
    /** Restrição de abordagem (ack 463 "reach-out time-locked"). Enquanto
     *  lockedUntil não passar, envio a contato SEM conversa prévia é recusado
     *  localmente: cada tentativa que chega ao servidor soma no time-lock. */
    reachoutLock?: ReachoutLock;
    /** Última cota de conversas novas informada pelo WhatsApp (evento MEX ou sonda ao conectar).
     *  CAPPED barra contato frio localmente até o fim do ciclo. */
    messageCapping?: MessageCapping & { at: number; source: 'event' | 'probe' };
    /** Telefones (só dígitos) que já nos escreveram nesta vida do processo —
     *  liberados do bloqueio 463 sem consultar o banco. */
    warmJids?: Set<string>;
    /** Próximo instante em que um envio desta sessão pode sair (espaçamento). */
    nextSendAt?: number;
    /** Contatos novos abordados na última hora: dígitos -> timestamp. */
    newContactWindow?: Map<string, number>;
}

export interface AutoRecoverySummary {
    scanned: number;
    recovered: number;
    skippedNoAnchor: number;
    skippedNoJid: number;
    failed: number;
}

/**
 * Resultado de uma tentativa de foto. `no_photo` e `forbidden` são RESULTADOS, não
 * erros: quem não tem foto (ou não deixa ver) precisa ser lembrado, senão vira
 * consulta repetida para sempre.
 */
type AvatarOutcome = 'ok' | 'no_photo' | 'forbidden' | 'transient' | 'no_conversation';

/** Um pedido de foto na fila. O socket NÃO entra aqui: ele é resolvido na hora de
 *  drenar, senão um item enfileirado antes de uma queda usaria um socket morto. */
interface AvatarJob {
    phoneNumberId: string;
    /** JID consultado no WhatsApp (`…@s.whatsapp.net`, `…@lid` ou `…@g.us`). */
    jid: string;
    /** Telefone (dígitos) já resolvido pelo caminho da mensagem. É por ele que a
     *  conversa é achada, não pelo JID: o chat 1:1 hoje chega como `@lid`, e os
     *  dígitos do LID nunca casam com o `contact_phone`. */
    contactPhone?: string;
    isGroup: boolean;
    /** Grupo vale `image`: o painel mostra o avatar a 64px e o `preview` (~96px, ~2KB)
     *  fica mole. Contato segue em `preview` — são milhares. */
    quality: 'preview' | 'image';
    /** 0 = tráfego vivo, 1 = backfill. Vivo sempre passa na frente. */
    priority: 0 | 1;
    /** Quantas vezes a conversa não foi encontrada. A linha é criada pela edge
     *  function DEPOIS que a mensagem chega aqui — na primeira mensagem de um
     *  contato novo o vínculo sempre erra na primeira tentativa. */
    resolveMisses: number;
    /** Epoch em ms antes do qual o job não pode rodar (re-tentativa adiada). */
    notBefore: number;
    /** Marca os jobs de um backfill para poder cancelar e contabilizar. */
    backfillId?: string;
}

export interface AvatarBackfillState {
    jobId: string;
    phoneNumberId: string;
    state: 'running' | 'done' | 'cancelled';
    scope: 'all' | 'groups' | 'individual';
    activeDays: number;
    limit: number;
    startedAt: string;
    finishedAt: string | null;
    /** Conversas visitadas na varredura (nem toda visita vira job). */
    scanned: number;
    enqueued: number;
    ok: number;
    noPhoto: number;
    forbidden: number;
    transient: number;
    noConversation: number;
    /** Quantas vezes o disjuntor de 429 disparou durante este backfill. */
    breakerTrips: number;
}

export interface ConnectOptions {
    usePairingCode?: boolean;
    phoneNumber?: string; // digits-only E.164, required when usePairingCode
}

// Optional group settings applied right after creation — field names mirror getGroupMetadata output
export interface GroupCreateSettings {
    announce?: boolean; // true = only admins can send messages
    restrict?: boolean; // true = only admins can edit group info
    memberAddMode?: 'admin_add' | 'all_member_add';
    joinApprovalMode?: 'on' | 'off';
    ephemeralDuration?: number; // 0 | 86400 | 604800 | 7776000
}

type PhoneUpdateResult =
    | { ok: true }
    | {
        ok: false;
        reason: 'blocked' | 'merge';
        existingPhoneNumberId: string;
        existingDisplayName: string;
    };

export class SessionManager {
    private sessions: Map<string, Session> = new Map();
    /** Single-flight de connect() por número: mata a janela de socket duplo (F62). */
    private connectInFlight: Map<string, Promise<string>> = new Map();
    /** Ligada no 1º passo do shutdownAll: restore (laço e nova tentativa) não abre sessão depois disso. */
    private shuttingDown = false;
    private sessionsDir = path.join(process.cwd(), 'sessions');
    private readonly providers: ProviderRegistry;
    /**
     * Eventos de ligação para a ponte de áudio (WebSocket em routes/call.ts):
     * 'update' (phoneNumberId, CallUpdate) e 'audio' (phoneNumberId, callId, Float32Array).
     */
    readonly callEvents = new EventEmitter();
    /** Marcadores (callId:estado) já vistos, para deduplicar os eventos do plugin de voz. */
    private readonly callStateSeen = new NodeCache({ stdTTL: 600, checkperiod: 120, maxKeys: 5000 });
    /** phone_numbers.qr_provider por linha (5 min); sem coluna/erro cai no default. */
    private providerByLine: NodeCache;
    /**
     * Motivo da última falha de uploadToStorage, para o debugLog do chamador.
     * Válido só no await imediatamente seguinte ao upload (é sequencial dentro
     * de forwardToWebhook); não é estado de longo prazo.
     */
    private lastUploadError: string | null = null;
    private pendingListeners: Map<string, Set<(event: string, data: unknown) => void>> = new Map();
    // LID to Phone Number mapping (shared across all sessions) - 24h TTL to prevent memory leak
    private lidPhoneCache: NodeCache;
    // LID to Name mapping (from pushName in messages) - 24h TTL
    private lidNameCache: NodeCache;
    // Group metadata cache: groupJid -> { subject, participants } - 1h TTL
    private groupMetadataCache: NodeCache;
    /** GroupMetadata completo para o cachedGroupMetadata do socket (enumeração de
     *  participantes/dispositivos no envio em grupo). */
    private groupMetaFullCache: NodeCache;
    /** phoneNumberId:dígitos -> JID de saída (resultado do onWhatsApp). */
    private outboundJidCache: NodeCache;
    /** phoneNumberId:dígitos -> true quando o contato NÃO tem mensagem recebida
     *  (evita reconsultar o banco a cada envio para o mesmo contato frio). */
    private coldContactCache: NodeCache;
    /** Pedidos explícitos de pareamento por número (timestamps da última hora). */
    private pairingRequests = new Map<string, number[]>();
    /** Último 401/403 de sessão REGISTRADA por número — arma o cooldown do connect(). */
    private fatalCloseAt = new Map<string, { at: number; statusCode: number }>();
    // Message cache for retries (Baileys requirement for stability)
    // Message store for getMessage callback
    private msgCache: NodeCache;
    /**
     * Wamids que já saíram para o webhook (entrada), por `${phoneNumberId}:${wamid}`.
     *
     * O stub CIPHERTEXT do mesmo wamid costuma chegar DEPOIS do texto e render
     * vários drops em segundos. Não é perda, é eco do retry do Baileys — sem
     * esse marcador ele vira alerta.
     *
     * Não dá para reusar msgCache: aquele é o store do getMessage e só recebe
     * mensagem ENVIADA por nós.
     */
    private forwardedWamids: NodeCache;
    /** Wamid já contabilizado como não decifrado na janela, mesma chave composta. */
    private undecryptedSeen: NodeCache;
    // messageContextInfo.messageSecret por wamid. É o que permite decifrar a edição em 1:1
    // (secretEncryptedMessage), cujo texto novo vem cifrado com o segredo da mensagem alvo.
    private msgSecretCache: NodeCache;
    // Avatar timestamp cache - stores when avatar was last updated (avoids DB queries)
    private avatarTimestampCache: NodeCache;
    /**
     * Resultado da última tentativa POR JID (não por telefone: o JID é o único
     * identificador que o cron de merge não reescreve). Substitui o antigo
     * avatarFetchThrottle, que era um terceiro portão sobreposto.
     *
     * Sem isto, contato sem foto visível repetia uma consulta de até 10s ao WhatsApp
     * a cada 60s, para sempre, ocupando os 2 workers e convidando 429 — era o que
     * sufocava quem TEM foto.
     */
    private avatarAttemptCache: NodeCache;
    private readonly AVATAR_REFRESH_DAYS = 7; // Refresh avatar after 7 days
    /** url NULL + carimbo recente = "conferido, não tem foto". Ver AvatarOutcome. */
    private readonly AVATAR_NEGATIVE_REFRESH_DAYS = 2;
    private readonly AVATAR_TTL_S: Record<AvatarOutcome, number> = {
        ok: 604800,           // 7d
        no_photo: 43200,      // 12h
        forbidden: 86400,     // 24h — privacidade
        transient: 1800,      // 30min
        no_conversation: 3600 // 1h, só após esgotar as re-tentativas de vínculo
    };
    /**
     * Disjuntor global de 429. Um 429 não diz nada sobre O CONTATO — diz que a LINHA
     * pediu demais. Essa conta já levou um 401/loggedOut por tráfego em rajada, então
     * a pausa é global e cresce a cada reincidência.
     */
    private avatarPausedUntil = 0;
    private avatarConsecutive429 = 0;
    private readonly AVATAR_PAUSE_BASE_MS = 300_000; // 5min
    private readonly AVATAR_PAUSE_MAX_MS = 3_600_000; // 1h
    /**
     * URL guardada da foto do grupo (a do Storage, não a da CDN do WhatsApp).
     *
     * Substitui o `groupPictureCache`, que guardava a URL viva do `pps.whatsapp.net`
     * — expirável, jogada fora a cada 10 min e disputada com um timer de 2,5s que
     * fazia o painel abrir com o ícone e só mostrar a foto na SEGUNDA abertura. E era
     * chaveado só pelo JID: duas sessões no mesmo processo se atropelavam.
     */
    private groupAvatarUrlCache: NodeCache;
    // Disconnect alert timers
    private disconnectAlertTimers: Map<string, NodeJS.Timeout> = new Map();
    // Avatar fetch: fila com 2 workers. Antes era um portão que DESCARTAVA o pedido
    // quando os 2 slots estavam ocupados — e o throttle de 60s já tinha sido consumido
    // na decisão, então o JID descartado ficava trancado o minuto inteiro do mesmo jeito.
    private avatarConcurrent = 0;
    private readonly MAX_AVATAR_CONCURRENT = 2;
    private avatarQueue: Map<string, AvatarJob> = new Map();
    private avatarInFlight: Set<string> = new Set();
    private avatarQueueDropped = 0;
    private avatarLastDropLogAt = 0;
    private avatarLastStartAt = 0;
    private avatarPumpTimer?: NodeJS.Timeout;
    /** Quando o timer agendado vai disparar (epoch ms). Ver scheduleAvatarPump. */
    private avatarPumpAt = 0;
    /** Teto da fila. A rajada ruim não é o volume diário
     *  e sim a resposta em massa a um disparo: algumas centenas de JIDs
     *  distintos em minutos. 500 absorve isso; acima disso o serviço já está minutos
     *  atrasado e a próxima mensagem do contato reenfileira de qualquer jeito. */
    private readonly MAX_AVATAR_QUEUE = 500;
    /** Espaçamento mínimo entre PARTIDAS (global, não por contato). */
    private readonly AVATAR_GAP_LIVE_MS = 300;
    private readonly AVATAR_GAP_BACKFILL_MS = 2000;
    /** Backfill em andamento por número. Estado só em memória — ver runAvatarBackfill. */
    private avatarBackfills: Map<string, AvatarBackfillState> = new Map();
    // Watchdog reconnection cooldown (prevents reconnection loops) - 30min TTL
    private lastWatchdogReconnect: NodeCache;
    private readonly WATCHDOG_COOLDOWN_MS = 600000; // 10 minutes
    // Entrega ao webhook com retry + spill em disco ("recebeu = vai persistir").
    // Substitui o antigo par pendingWebhooks/MAX_PENDING_WEBHOOKS, cujo
    // backpressure DESCARTAVA mensagem recebida — agora fila cheia vira arquivo
    // em sessions/_outbox/ e o sweeper reentrega. Ver webhookOutbox.ts.
    private outbox = new WebhookOutbox({
        getWebhookUrl: () => process.env.WEBHOOK_URL,
        sessionsDir: this.sessionsDir,
        concurrency: 8,
        memCap: Number(process.env.MAX_PENDING_WEBHOOKS) || 500,
        debugLog: (phoneNumberId, action, toJid, payload, messageId) =>
            void this.debugLog(phoneNumberId, action, toJid, payload, messageId),
    });
    // Dedup do chatstate recebido: um contato digitando gera muitos presence.update.
    // Guarda o último estado transmitido por (phone, chat, participante).
    private presenceThrottle: NodeCache;
    // Refresh mínimo entre dois broadcasts do MESMO estado — só para o TTL do
    // cliente não expirar enquanto o contato continua digitando.
    private readonly PRESENCE_REFRESH_MS = 5000;

    constructor() {
        this.providers = new ProviderRegistry('baileys').register(new BaileysClientFactory(this.sessionsDir));
        this.providerByLine = new NodeCache({ stdTTL: 300, checkperiod: 60, maxKeys: 5000 });
        // Ensure sessions directory exists
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
        // Initialize caches with TTL to prevent memory leaks
        this.msgCache = new NodeCache({ stdTTL: 3600, checkperiod: 600, maxKeys: 5000 }); // 1h TTL, max 5k msgs
        // 1h de TTL: o stub atrasado chega em segundos, então sobra folga. Só um
        // booleano por wamid, daí o teto alto.
        this.forwardedWamids = new NodeCache({ stdTTL: 3600, checkperiod: 600, maxKeys: 20000 });
        // 5 min = a janela do detector de alerta. Expirar é inofensivo: no pior
        // caso a mesma mensagem conta de novo numa janela seguinte, que é
        // exatamente o comportamento desejado se ela continuar sem decifrar.
        this.undecryptedSeen = new NodeCache({ stdTTL: 300, checkperiod: 120, maxKeys: 5000 });
        // 2h de TTL: a janela de edição do WhatsApp é 15 min, então sobra folga. Perder o cache
        // num restart só afeta edição feita dentro dessa janela — degrada para "editada" sem texto.
        this.msgSecretCache = new NodeCache({ stdTTL: 7200, checkperiod: 900, maxKeys: 20000 });
        this.avatarTimestampCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 }); // 24h TTL
        this.lidPhoneCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600, maxKeys: 5000 }); // 24h TTL for LID mappings
        this.lidNameCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600, maxKeys: 5000 }); // 24h TTL for LID names
        this.groupMetadataCache = new NodeCache({ stdTTL: 3600, checkperiod: 600, maxKeys: 500 }); // 1h TTL for group metadata
        // 5 min: participante entra/sai com frequência; invalidado nos eventos de grupo.
        this.groupMetaFullCache = new NodeCache({ stdTTL: 300, checkperiod: 60, maxKeys: 500, useClones: false });
        // 6h: JID de um telefone não muda; o que muda (LID) o Baileys resolve por baixo.
        this.outboundJidCache = new NodeCache({ stdTTL: 6 * 3600, checkperiod: 600, maxKeys: 20000 });
        // 5 min: o contato pode responder a qualquer momento e virar "quente".
        this.coldContactCache = new NodeCache({ stdTTL: 300, checkperiod: 60, maxKeys: 5000 });
        // 60s de TTL: só precisa viver o suficiente pra detectar repetição de estado
        // dentro de uma rajada de digitação. Expirar é inofensivo (rebroadcast).
        // checkperiod < stdTTL de propósito: chave expirada só deixa de contar pro
        // maxKeys depois da varredura, então varrer devagar aproxima o teto sem
        // necessidade.
        this.presenceThrottle = new NodeCache({ stdTTL: 60, checkperiod: 30, maxKeys: 2000 });
        this.groupAvatarUrlCache = new NodeCache({ stdTTL: 600, checkperiod: 120, maxKeys: 500 }); // 10min
        // TTL por entrada (AVATAR_TTL_S), não no cache: cada desfecho tem uma validade.
        this.avatarAttemptCache = new NodeCache({ stdTTL: 86400, checkperiod: 600, maxKeys: 20000 });
        this.lastWatchdogReconnect = new NodeCache({ stdTTL: 1800, checkperiod: 300 }); // 30min TTL for watchdog

        // Start Connection Watchdog (every 15 minutes to avoid reconnection loops)
        setInterval(() => this.checkConnections(), 900 * 1000);
    }

    /**
     * Único caminho de escrita nos NodeCache do serviço.
     *
     * O node-cache não tem eviction: ao bater `maxKeys`, TODO `.set()` passa a lançar
     * ECACHEFULL até a varredura de TTL (checkperiod) liberar espaço. Como vários desses
     * `.set()` ficam no meio do handler de `messages.upsert`, a exceção abortava a mensagem
     * ANTES do insert — mensagens recebidas de grupos eram perdidas em silêncio quando os
     * caches de LID enchiam. Cache é otimização:
     * encher nunca pode custar a mensagem.
     *
     * Ao encher, poda as chaves mais antigas (ordem de inserção) e tenta uma vez — sem isso
     * o cache ficaria inútil até a varredura, que pode levar até `checkperiod` (1h nos
     * maiores). Falhar de novo é aceitável: perde-se só a entrada de cache.
     */
    private cacheSet<T>(cache: NodeCache, key: string, value: T, ttlSeconds?: number): boolean {
        const write = () =>
            ttlSeconds === undefined ? cache.set(key, value) : cache.set(key, value, ttlSeconds);
        try {
            return write();
        } catch {
            try {
                const keys = cache.keys();
                cache.del(keys.slice(0, Math.max(1, Math.ceil(keys.length / 4))));
                console.warn(
                    `[SessionManager] cache cheio (${keys.length} chaves) — podou 25% para gravar ${key}`
                );
                return write();
            } catch {
                return false;
            }
        }
    }

    // ============================================
    // MESSAGE DELIVERY LOGGING
    // ============================================

    /**
     * Get the WebSocket readyState for a session's socket.
     * Returns -1 if socket/ws is not available.
     */
    /** Citação no formato do contrato (em grupo o participante atribui a citação). */
    private quotedOptions(
        validJid: string, to: string,
        quotedMessageId?: string, quotedContent?: string, quotedFromMe?: boolean, quotedParticipant?: string,
    ): SendOptions {
        if (!quotedMessageId) return {};
        return {
            quoted: {
                key: {
                    chatJid: validJid,
                    id: quotedMessageId,
                    fromMe: quotedFromMe ?? false,
                    participantJid: to.includes('@g.us') && quotedParticipant ? quotedParticipant : undefined,
                },
                content: { type: 'text', text: quotedContent || '' },
            },
        };
    }

    /** Cliente da lib da sessão (fase 1+). Lança se a sessão ainda não conectou. */
    private clientOf(session: Session): WhatsAppClient {
        if (!session.client) throw new WhatsAppClientError('Sessão sem cliente', 'not_connected');
        return session.client;
    }

    /**
     * Provider da linha (`phone_numbers.qr_provider`). Antes da migração da coluna, ou
     * com nome desconhecido, cai no default do registry — nunca derruba o connect.
     */
    private async providerFor(phoneNumberId: string): Promise<WhatsAppClientFactory> {
        const cached = this.providerByLine.get<string>(phoneNumberId);
        if (cached) return this.providers.for(cached);
        let name = this.providers.defaultProvider;
        let readOk = false;
        try {
            const { data, error } = await supabase
                .from('phone_numbers')
                .select('qr_provider')
                .eq('id', phoneNumberId)
                .maybeSingle();
            if (error) {
                console.warn(`[Provider] leitura de qr_provider falhou para ${phoneNumberId}: ${error.message} — usando '${name}'`);
            } else {
                readOk = true;
                const raw = (data as { qr_provider?: string | null } | null)?.qr_provider;
                if (raw && this.providers.has(raw)) name = raw;
                else if (raw) console.warn(`[Provider] '${raw}' não registrado para ${phoneNumberId} — usando '${name}'`);
            }
        } catch (err) {
            console.warn(`[Provider] erro lendo qr_provider de ${phoneNumberId}:`, err instanceof Error ? err.message : err);
        }
        // Leitura que falhou não vira cache: o padrão valeria por 5 min mesmo com o banco de volta.
        if (readOk) this.cacheSet(this.providerByLine, phoneNumberId, name);
        return this.providers.for(name);
    }

    private async storeFor(phoneNumberId: string): Promise<SessionStore> {
        return (await this.providerFor(phoneNumberId)).createStore(phoneNumberId);
    }

    /**
     * Registra providers que dependem de configuração externa. A zapo precisa de um
     * Postgres próprio (`ZAPO_PG_URL`); sem ele fica de fora e o `/health` mostra só o
     * Baileys. Chamar antes de restoreAllSessions().
     */
    async initProviders(): Promise<void> {
        const pgUrl = process.env.ZAPO_PG_URL;
        if (!pgUrl) {
            console.log('[Provider] zapo desabilitada (defina ZAPO_PG_URL para registrar)');
            return;
        }
        try {
            const factory = await ZapoClientFactory.postgres(pgUrl, process.env.ZAPO_PG_TABLE_PREFIX || 'wa_zapo_', async () => {
                // Erro NÃO vira lista vazia: lista vazia faz o restore achar que não há linha zapo.
                const { data, error } = await supabase.from('phone_numbers').select('id').eq('qr_provider', 'zapo');
                if (error) throw new Error(`leitura de phone_numbers (zapo) falhou: ${describeSupabaseError(error)}`);
                return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
            });
            this.providers.register(factory);
            console.log('[Provider] zapo registrada (Postgres)');
        } catch (err) {
            console.error('[Provider] falha ao registrar zapo:', err instanceof Error ? err.message : err);
        }
    }

    /** Diretório das sessões em disco (credenciais do Baileys e `_outbox/`). */
    getSessionsDir(): string {
        return this.sessionsDir;
    }

    /** Provider e lib de cada sessão viva (para /health e /ops). */
    getSessionProviders(): Record<string, { provider: string; libraryId: string }> {
        const out: Record<string, { provider: string; libraryId: string }> = {};
        this.sessions.forEach((session, id) => {
            if (!session.client) return;
            out[id] = { provider: session.providerName ?? this.providerByLine.get<string>(id) ?? this.providers.defaultProvider, libraryId: session.client.libraryId };
        });
        return out;
    }

    getRegisteredProviders(): string[] {
        return this.providers.names();
    }

    /**
     * Troca a lib que atende a linha SEM re-parear: fecha a sessão (sem logout),
     * exporta as credenciais do provider atual, guarda backup, importa no novo,
     * grava `qr_provider` e reconecta. Rollback = chamar de novo com o antigo.
     */
    async migrateProvider(phoneNumberId: string, to: string): Promise<{
        from: string; to: string; losses: string[]; backup: string; status: string;
    }> {
        if (!this.providers.has(to)) {
            throw new Error(`Provider desconhecido: '${to}' (registrados: ${this.providers.names().join(', ')})`);
        }
        this.providerByLine.del(phoneNumberId);
        const current = await this.providerFor(phoneNumberId);
        const target = this.providers.for(to);
        if (current.name === target.name) {
            return { from: current.name, to, losses: [], backup: '', status: 'already_on_provider' };
        }
        // Fecha sem logout: as credenciais continuam válidas e vão para o outro provider.
        const session = this.sessions.get(phoneNumberId);
        if (session) {
            if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = undefined; }
            if (session.presenceInterval) { clearInterval(session.presenceInterval); session.presenceInterval = undefined; }
            this.clearDisconnectAlertTimer(phoneNumberId);
            if (session.client) {
                session.client.removeAllListeners();
                await session.client.close().catch(() => { /* já fechado */ });
            }
            session.status = 'disconnected';
            this.sessions.delete(phoneNumberId);
        }
        let snapshot: AuthSnapshot;
        let backup: string;
        if (current.capabilities.has('auth_snapshot')) {
            const exporter = current.create({ sessionId: phoneNumberId, store: current.createStore(phoneNumberId), logLevel: 'silent' });
            snapshot = await exporter.exportAuthSnapshot();
            backup = await saveSnapshotBackup(this.sessionsDir, phoneNumberId, snapshot);
        } else {
            // Provider sem export (zapo): volta pelo último backup gravado quando a linha
            // entrou nele. Sem backup, não há como trocar sem re-parear.
            const latest = await latestSnapshotBackup(this.sessionsDir, phoneNumberId);
            if (!latest) throw new Error(`'${current.name}' não exporta credenciais e não há backup em sessions/_snapshots/${phoneNumberId}`);
            snapshot = latest.snapshot;
            backup = latest.file;
        }
        const importer = target.create({ sessionId: phoneNumberId, store: target.createStore(phoneNumberId), logLevel: 'silent' });
        const { losses } = await importer.importAuthSnapshot(snapshot);
        const { error } = await supabase
            .from('phone_numbers')
            .update({ qr_provider: to })
            .eq('id', phoneNumberId);
        if (error) {
            throw new Error(`Credenciais importadas em '${to}' mas phone_numbers.qr_provider não atualizou: ${error.message}`);
        }
        this.providerByLine.del(phoneNumberId);
        void this.debugLog(phoneNumberId, 'provider_migrated', 'system', { from: current.name, to, losses: losses.length, backup });
        const status = await this.connect(phoneNumberId, false);
        return { from: current.name, to, losses, backup, status };
    }

    private getSocketReadyState(session: Session): number {
        // Compat com os logs antigos (readyState do ws): 0 conectando, 1 aberto, 3 fechado.
        const state = session.client?.connectionState();
        return state === 'open' ? 1 : state === 'connecting' ? 0 : state === 'closed' ? 3 : -1;
    }

    // ============================================
    // CONTACT AVATAR MANAGEMENT
    // ============================================

    private avatarKey(phoneNumberId: string, jid: string): string {
        return `${phoneNumberId}:${jid}`;
    }

    /** Grava o desfecho da tentativa com a validade que aquele desfecho merece. */
    private rememberAvatarAttempt(phoneNumberId: string, jid: string, outcome: AvatarOutcome): void {
        this.cacheSet(
            this.avatarAttemptCache,
            this.avatarKey(phoneNumberId, jid),
            { outcome, at: Date.now() },
            this.AVATAR_TTL_S[outcome]
        );
    }

    /**
     * Enfileira a busca da foto. Ponto ÚNICO de entrada — ninguém chama
     * fetchAndStoreProfilePicture direto no caminho de evento.
     *
     * Os curto-circuitos aqui são todos em memória (zero I/O); a consulta ao banco e
     * ao WhatsApp só acontece ao drenar. Antes, o `shouldFetchAvatar` consumia um
     * throttle de 60s ANTES do portão de concorrência, então um pedido descartado
     * trancava o JID o minuto inteiro sem nada ter sido tentado.
     */
    private enqueueAvatarFetch(
        phoneNumberId: string,
        jid: string,
        opts: {
            quality?: 'preview' | 'image';
            priority?: 0 | 1;
            force?: boolean;
            notBefore?: number;
            resolveMisses?: number;
            backfillId?: string;
            contactPhone?: string;
        } = {}
    ): void {
        if (!jid || !jid.includes('@')) return;
        const key = this.avatarKey(phoneNumberId, jid);
        const isGroup = jid.endsWith('@g.us');

        if (!opts.force && this.avatarAttemptCache.get(key) !== undefined) return;
        // Dedupe: a rajada de 10 mensagens do mesmo grupo vira UM job.
        if (this.avatarQueue.has(key) || this.avatarInFlight.has(key)) return;

        if (this.avatarQueue.size >= this.MAX_AVATAR_QUEUE) {
            // Rejeita o NOVO, não o mais antigo: descartar a cabeça da fila faria os
            // mesmos JIDs passarem fome a cada rajada. Perder uma foto é inofensivo de
            // um jeito que perder uma mensagem não é — nada de spill em disco aqui.
            this.avatarQueueDropped++;
            const now = Date.now();
            if (now - this.avatarLastDropLogAt > 60_000) {
                this.avatarLastDropLogAt = now;
                void this.debugLog(phoneNumberId, 'avatar_queue_dropped', jid, {
                    dropped_total: this.avatarQueueDropped,
                    limit: this.MAX_AVATAR_QUEUE,
                });
            }
            return;
        }

        this.avatarQueue.set(key, {
            phoneNumberId,
            jid,
            isGroup,
            quality: opts.quality ?? (isGroup ? 'image' : 'preview'),
            priority: opts.priority ?? 0,
            resolveMisses: opts.resolveMisses ?? 0,
            notBefore: opts.notBefore ?? 0,
            backfillId: opts.backfillId,
            contactPhone: opts.contactPhone,
        });

        this.scheduleAvatarPump(0);
    }

    /**
     * Reenfileira de DENTRO do job (conversa ainda não existe, 429, vínculo perdido).
     * A chave fica em `avatarInFlight` até o `finally` do pump, e o `enqueueAvatarFetch`
     * recusa chave em voo: sem tirá-la daqui antes, toda re-tentativa era descartada em
     * silêncio, sem desfecho no cache e sem linha no log.
     */
    private requeueAvatarJob(job: AvatarJob, patch: { notBefore: number; resolveMisses?: number }): void {
        this.avatarInFlight.delete(this.avatarKey(job.phoneNumberId, job.jid));
        this.enqueueAvatarFetch(job.phoneNumberId, job.jid, {
            quality: job.quality,
            priority: job.priority,
            force: true,
            notBefore: patch.notBefore,
            resolveMisses: patch.resolveMisses ?? job.resolveMisses,
            backfillId: job.backfillId,
            contactPhone: job.contactPhone,
        });
    }

    /**
     * Drena a fila respeitando concorrência, `notBefore`, o espaçamento mínimo entre
     * partidas e o disjuntor de 429. Vivo (priority 0) sempre passa na frente do
     * backfill — é por isso que existe UMA fila e não duas.
     */
    private pumpAvatarQueue(): void {
        const now = Date.now();
        if (this.avatarQueue.size === 0) return;

        if (now < this.avatarPausedUntil) {
            this.scheduleAvatarPump(this.avatarPausedUntil - now);
            return;
        }
        if (this.avatarConcurrent >= this.MAX_AVATAR_CONCURRENT) return; // o finally reagenda

        // Melhor candidato: prioridade, depois quem está pronto há mais tempo.
        let bestKey: string | undefined;
        let best: AvatarJob | undefined;
        let earliestNotBefore = Infinity;
        for (const [key, job] of this.avatarQueue) {
            if (job.notBefore > now) {
                earliestNotBefore = Math.min(earliestNotBefore, job.notBefore);
                continue;
            }
            if (!best || job.priority < best.priority) {
                bestKey = key;
                best = job;
                if (job.priority === 0) break; // vivo e pronto: não há melhor
            }
        }

        if (!best || !bestKey) {
            if (earliestNotBefore !== Infinity) this.scheduleAvatarPump(earliestNotBefore - now);
            return;
        }

        // Espaçamento entre PARTIDAS: 300ms no vivo, 2s no backfill.
        const gap = best.priority === 1 ? this.AVATAR_GAP_BACKFILL_MS : this.AVATAR_GAP_LIVE_MS;
        const since = now - this.avatarLastStartAt;
        if (since < gap) {
            this.scheduleAvatarPump(gap - since);
            return;
        }

        this.avatarQueue.delete(bestKey);
        const client = this.sessions.get(best.phoneNumberId)?.client;
        if (!client) {
            // Sessão caiu entre enfileirar e drenar: nada a fazer, e NÃO grava
            // desfecho (não foi o contato que falhou).
            this.scheduleAvatarPump(0);
            return;
        }

        this.avatarInFlight.add(bestKey);
        this.avatarLastStartAt = Date.now();
        this.avatarConcurrent++;
        const job = best;
        void this.processAvatarJob(job, client)
            .catch(err => console.error('[ProfilePic] Async error:', err))
            .finally(() => {
                this.avatarConcurrent--;
                this.avatarInFlight.delete(bestKey!);
                this.scheduleAvatarPump(0);
            });

        this.scheduleAvatarPump(0);
    }

    /**
     * Agenda o próximo ciclo, mantendo sempre o prazo MAIS CURTO.
     *
     * Ignorar o pedido quando já existe timer parecia inofensivo e não era: um job
     * adiado para +300s agendava o ciclo lá na frente, e o `finally` de um worker que
     * liberou vaga (ou um job vivo recém-enfileirado) tinha o seu pedido de "acorda
     * agora" descartado — a fila ficava parada com worker livre até o timer distante
     * disparar.
     */
    private scheduleAvatarPump(delayMs: number): void {
        const delay = Math.max(0, Math.min(delayMs, 60_000));
        const at = Date.now() + delay;
        if (this.avatarPumpTimer) {
            if (this.avatarPumpAt <= at) return; // o que já está agendado acorda antes
            clearTimeout(this.avatarPumpTimer);
        }
        this.avatarPumpAt = at;
        // Limpa o handle ANTES de rodar: `pumpAvatarQueue` não pode ver o timer que
        // acabou de disparar, ou o agendamento seguinte se acharia redundante.
        this.avatarPumpTimer = setTimeout(() => {
            this.avatarPumpTimer = undefined;
            this.avatarPumpAt = 0;
            this.pumpAvatarQueue();
        }, delay);
        this.avatarPumpTimer.unref?.();
    }

    /** Aciona o disjuntor global de 429 e devolve até quando a pausa vai. */
    private tripAvatarBreaker(phoneNumberId: string, jid: string): number {
        this.avatarConsecutive429++;
        const backfill = this.avatarBackfills.get(phoneNumberId);
        if (backfill?.state === 'running') backfill.breakerTrips++;
        const pause = Math.min(
            this.AVATAR_PAUSE_MAX_MS,
            this.AVATAR_PAUSE_BASE_MS * 2 ** (this.avatarConsecutive429 - 1)
        );
        this.avatarPausedUntil = Date.now() + pause;
        void this.debugLog(phoneNumberId, 'avatar_rate_limited', jid, {
            consecutive_429: this.avatarConsecutive429,
            paused_for_ms: pause,
            paused_until: new Date(this.avatarPausedUntil).toISOString(),
        });
        return this.avatarPausedUntil;
    }

    /** Estado da fila para o /health — sem isso não há como ver a pausa acontecendo. */
    getAvatarQueueStats(): {
        queued: number;
        inFlight: number;
        dropped: number;
        pausedUntil: string | null;
        consecutive429: number;
    } {
        return {
            queued: this.avatarQueue.size,
            inFlight: this.avatarInFlight.size,
            dropped: this.avatarQueueDropped,
            pausedUntil: this.avatarPausedUntil > Date.now()
                ? new Date(this.avatarPausedUntil).toISOString()
                : null,
            consecutive429: this.avatarConsecutive429,
        };
    }

    // ============================================
    // AVATAR BACKFILL
    // ============================================

    /**
     * Varredura pausada das conversas sem foto. Produtora contra a MESMA fila do
     * tráfego vivo: herda o espaçamento, o disjuntor de 429 e a preempção (job vivo
     * sempre passa na frente). É por isso que existe uma fila só.
     *
     * Não persiste estado de propósito: como toda conversa conferida sai carimbada em
     * `contact_avatar_updated_at` (com foto OU sem), a consulta de candidatos é
     * idempotente e o backfill se retoma sozinho depois de um restart.
     */
    async startAvatarBackfill(
        phoneNumberId: string,
        opts: { activeDays?: number; limit?: number; scope?: 'all' | 'groups' | 'individual' } = {}
    ): Promise<AvatarBackfillState> {
        const session = this.sessions.get(phoneNumberId);
        if (!session?.client || session.status !== 'connected') {
            throw new Error('SESSION_NOT_CONNECTED');
        }

        const running = this.avatarBackfills.get(phoneNumberId);
        if (running && running.state === 'running') {
            throw new Error('AVATAR_BACKFILL_ALREADY_RUNNING');
        }

        const state: AvatarBackfillState = {
            jobId: `avbf_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
            phoneNumberId,
            state: 'running',
            scope: opts.scope ?? 'all',
            activeDays: Math.max(1, Math.min(opts.activeDays ?? 90, 3650)),
            limit: Math.max(1, Math.min(opts.limit ?? 500, 5000)),
            startedAt: new Date().toISOString(),
            finishedAt: null,
            scanned: 0,
            enqueued: 0,
            ok: 0,
            noPhoto: 0,
            forbidden: 0,
            transient: 0,
            noConversation: 0,
            breakerTrips: 0,
        };
        this.avatarBackfills.set(phoneNumberId, state);

        void this.runAvatarBackfill(state).catch((err) => {
            console.error('[AvatarBackfill] erro fatal:', err);
            state.state = 'done';
            state.finishedAt = new Date().toISOString();
        });

        return state;
    }

    getAvatarBackfill(phoneNumberId: string): AvatarBackfillState | null {
        return this.avatarBackfills.get(phoneNumberId) ?? null;
    }

    cancelAvatarBackfill(phoneNumberId: string): AvatarBackfillState | null {
        const state = this.avatarBackfills.get(phoneNumberId);
        if (!state || state.state !== 'running') return state ?? null;

        state.state = 'cancelled';
        state.finishedAt = new Date().toISOString();
        // Tira da fila o que ainda não partiu deste backfill.
        for (const [key, job] of this.avatarQueue) {
            if (job.backfillId === state.jobId) this.avatarQueue.delete(key);
        }
        return state;
    }

    private avatarSleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const t = setTimeout(resolve, ms);
            t.unref?.();
        });
    }

    private countBackfillOutcome(backfillId: string | undefined, outcome: AvatarOutcome): void {
        if (!backfillId) return;
        for (const state of this.avatarBackfills.values()) {
            if (state.jobId !== backfillId) continue;
            if (outcome === 'ok') state.ok++;
            else if (outcome === 'no_photo') state.noPhoto++;
            else if (outcome === 'forbidden') state.forbidden++;
            else if (outcome === 'no_conversation') state.noConversation++;
            else state.transient++;
            return;
        }
    }

    private async runAvatarBackfill(state: AvatarBackfillState): Promise<void> {
        const cutoff = new Date(Date.now() - state.activeDays * 86_400_000).toISOString();
        // Keyset por last_message_at (não offset): a lista muda embaixo da varredura.
        // DESC de propósito — quem conversou mais recentemente é quem está visível na
        // lista, então cancelar no meio ainda deixa a metade que importa pronta.
        let cursor: string | null = null;
        const PAGE = 200;

        try {
            while (state.state === 'running' && state.enqueued < state.limit) {
                let query = supabase
                    .from('conversations')
                    .select('id, contact_phone, group_jid, is_group, contact_avatar_url, contact_avatar_updated_at, last_message_at')
                    .eq('phone_number_id', state.phoneNumberId)
                    .is('contact_avatar_url', null)
                    .gte('last_message_at', cutoff)
                    .order('last_message_at', { ascending: false })
                    .limit(PAGE);

                if (state.scope === 'groups') query = query.eq('is_group', true);
                else if (state.scope === 'individual') query = query.eq('is_group', false);
                if (cursor) query = query.lt('last_message_at', cursor);

                const { data: rows, error } = await query;
                if (error) {
                    console.error('[AvatarBackfill] erro na consulta de candidatos:', error.message);
                    break;
                }
                if (!rows || rows.length === 0) break;

                cursor = (rows[rows.length - 1].last_message_at as string) ?? null;

                for (const row of rows) {
                    if (state.state !== 'running' || state.enqueued >= state.limit) break;
                    state.scanned++;

                    // Já conferida há pouco (com ou sem foto): sai do conjunto sozinha.
                    if (this.isAvatarFresh({
                        avatarUrl: row.contact_avatar_url as string | null,
                        checkedAt: row.contact_avatar_updated_at as string | null,
                    })) continue;

                    const jid = this.backfillJidFor(row);
                    if (!jid) continue;

                    this.enqueueAvatarFetch(state.phoneNumberId, jid, {
                        priority: 1,
                        backfillId: state.jobId,
                    });
                    state.enqueued++;
                }

                // Segura a produção enquanto a fila estiver funda: o teto da fila é
                // compartilhado com o tráfego vivo e ele não pode ser espremido.
                while (state.state === 'running' && this.avatarQueue.size > 50) {
                    await this.avatarSleep(1000);
                }

                if (!cursor) break;
            }

            // Espera o que já foi enfileirado terminar, para o status refletir o fim real.
            while (state.state === 'running') {
                const pending = [...this.avatarQueue.values()].some(j => j.backfillId === state.jobId);
                if (!pending && this.avatarInFlight.size === 0) break;
                await this.avatarSleep(1000);
            }
        } finally {
            if (state.state === 'running') state.state = 'done';
            state.finishedAt = state.finishedAt ?? new Date().toISOString();
            console.log(
                `[AvatarBackfill] ${state.phoneNumberId} ${state.state}: scanned=${state.scanned} ` +
                `enqueued=${state.enqueued} ok=${state.ok} noPhoto=${state.noPhoto} ` +
                `forbidden=${state.forbidden} noConv=${state.noConversation} transient=${state.transient}`
            );
        }
    }

    /**
     * JID a consultar a partir da linha da conversa.
     *
     * O caminho vivo sempre tem o JID real vindo da mensagem; o backfill tem que
     * sintetizar, e aí aparecem duas armadilhas: `contact_phone` que na verdade é um
     * LID cru (ver `scripts/resolve-lid-conversations.mjs`, na raiz deste repositório) e telefone que o cron de
     * merge reescreveu para a forma com o 9º dígito. Descarta o que não parece
     * telefone; a deriva do 9º dígito é problema do resolve, que testa as variações.
     */
    private backfillJidFor(row: Record<string, unknown>): string | null {
        if (row.is_group) {
            const jid = (row.group_jid as string | null) ?? (row.contact_phone as string | null);
            return jid && jid.endsWith('@g.us') ? jid : null;
        }
        const digits = String(row.contact_phone ?? '').replace(/\D/g, '');
        // LID cru tem 15+ dígitos; telefone de verdade fica entre 10 e 15.
        if (digits.length < 10 || digits.length > 14) return null;
        return `${digits}@s.whatsapp.net`;
    }

    /** Esquece tudo que faria o serviço achar que a foto deste JID já está fresca. */
    private invalidateAvatarCaches(phoneNumberId: string, jid: string, contactPhone?: string): void {
        this.avatarAttemptCache.del(this.avatarKey(phoneNumberId, jid));
        this.avatarTimestampCache.del(this.avatarKey(phoneNumberId, contactPhone ?? jid));
        this.groupAvatarUrlCache.del(this.avatarKey(phoneNumberId, jid));
    }

    /**
     * Variações de telefone que a edge function usa para achar a conversa.
     *
     * Espelha `normalizePhoneNumber` do whatsapp-webhook (index.ts:139-162) DE
     * PROPÓSITO: se os dois lados discordarem sobre "qual linha é esse contato", a
     * foto vai parar numa linha que a edge nunca toca. Não dá para reaproveitar o
     * `getBrazilianPhoneVariations` daqui — aquele é do caminho de ENVIO (que
     * deliberadamente não varia) e não gera as formas sem o 55.
     */
    private conversationPhoneVariations(phone: string): string[] {
        const digits = (phone || '').replace(/\D/g, '');
        if (!digits) return [];
        const variations = [digits];

        if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
            const ddd = digits.substring(2, 4);
            const local = digits.substring(4);
            variations.push(ddd + local);
            if (local.length === 8) {
                variations.push('55' + ddd + '9' + local);
                variations.push(ddd + '9' + local);
            } else if (local.length === 9) {
                variations.push('55' + ddd + local.substring(1));
                variations.push(ddd + local.substring(1));
            }
        }
        return [...new Set(variations)];
    }

    /**
     * Acha a conversa ANTES de gastar consulta no WhatsApp.
     *
     * A ordem antiga era: consulta o WhatsApp → baixa → sobe no Storage → tenta
     * atualizar por `contact_phone` exato. Quando não casava linha nenhuma (contato
     * novo cuja conversa a edge ainda não criou, ou telefone que o cron de merge
     * reescreveu para a forma com o 9º dígito), o UPDATE NÃO dava erro — PostgREST
     * não trata 0 linhas como erro — e o serviço gravava o cache como se tivesse dado
     * certo. Parte dos arquivos de foto individual no Storage não
     * casava com conversa nenhuma: o download era descartado em silêncio.
     */
    /**
     * Dígitos pelos quais a conversa 1:1 é procurada: o telefone resolvido pelo caminho
     * da mensagem, senão o cache LID→telefone, senão os dígitos do próprio JID (que, para
     * `@lid`, só casam conversa gravada com o LID cru). Par do `backfillJidFor`, que faz
     * o caminho inverso (telefone → JID).
     */
    private avatarLookupPhone(jid: string, contactPhone?: string): string {
        const hinted = (contactPhone ?? '').replace(/\D/g, '');
        if (hinted) return hinted;
        const local = jid.split('@')[0];
        if (jid.endsWith('@lid')) return this.lidPhoneCache.get<string>(local) ?? local;
        return local;
    }

    private async resolveConversationForAvatar(
        phoneNumberId: string,
        jid: string,
        isGroup: boolean,
        contactPhone?: string
    ): Promise<{ id: string; avatarUrl: string | null; checkedAt: string | null } | null> {
        try {
            const base = supabase
                .from('conversations')
                .select('id, contact_avatar_url, contact_avatar_updated_at')
                .eq('phone_number_id', phoneNumberId);

            let query;
            if (isGroup) {
                // O JID entra numa string de filtro do PostgREST: só passa o formato
                // conhecido (dígitos, com o sufixo legado `-<epoch>` de grupo antigo).
                if (!/^[0-9]+(-[0-9]+)?@g\.us$/.test(jid)) return null;
                query = base.or(`group_jid.eq.${jid},contact_phone.eq.${jid}`);
            } else {
                const variations = this.conversationPhoneVariations(this.avatarLookupPhone(jid, contactPhone));
                if (variations.length === 0) return null;
                query = base.eq('is_group', false).in('contact_phone', variations);
            }

            // created_at ASC casa com o master que o merge_duplicate_conversations
            // elege (grp.all_ids[1]): havendo duplicata, a foto vai para a que sobrevive.
            const { data, error } = await query
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle();

            if (error) {
                console.error(`[ProfilePic] Erro ao resolver conversa de ${jid}:`, error.message);
                return null;
            }
            if (!data) return null;
            return {
                id: data.id as string,
                avatarUrl: (data.contact_avatar_url as string | null) ?? null,
                checkedAt: (data.contact_avatar_updated_at as string | null) ?? null,
            };
        } catch (e) {
            console.error(`[ProfilePic] Falha ao resolver conversa de ${jid}:`, e);
            return null;
        }
    }

    /**
     * `contact_avatar_updated_at` é a data da última CONFERIDA, não da última troca:
     * url preenchida + carimbo = foto guardada; url NULL + carimbo = conferido e não
     * tem foto. É isso que sobrevive ao restart e impede o serviço de reconsultar as
     * conversas sem foto a cada deploy.
     */
    private isAvatarFresh(row: { avatarUrl: string | null; checkedAt: string | null }): boolean {
        if (!row.checkedAt) return false;
        const days = (Date.now() - new Date(row.checkedAt).getTime()) / 86_400_000;
        return row.avatarUrl !== null
            ? days < this.AVATAR_REFRESH_DAYS
            : days < this.AVATAR_NEGATIVE_REFRESH_DAYS;
    }

    /** Baixa a foto. `null` = falha transitória (vale tentar de novo mais tarde). */
    private async downloadAvatar(pictureUrl: string): Promise<Buffer | null> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
            const response = await fetch(pictureUrl, { signal: controller.signal });
            if (!response.ok) {
                console.error(`[ProfilePic] Failed to download: ${response.status}`);
                return null;
            }
            return Buffer.from(await response.arrayBuffer());
        } catch (e) {
            console.error('[ProfilePic] Download error:', e);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Executa um job da fila. Único caminho que consulta foto no WhatsApp.
     */
    private async processAvatarJob(job: AvatarJob, client: WhatsAppClient): Promise<void> {
        const { phoneNumberId, jid, isGroup } = job;
        // Fecha a tentativa num lugar só: cache de desfecho + contabilidade do backfill.
        const finish = (outcome: AvatarOutcome) => {
            this.rememberAvatarAttempt(phoneNumberId, jid, outcome);
            this.countBackfillOutcome(job.backfillId, outcome);
        };

        try {
            const conv = await this.resolveConversationForAvatar(phoneNumberId, jid, isGroup, job.contactPhone);

            if (!conv) {
                // A conversa é criada pela edge function DEPOIS que a mensagem passa
                // por aqui: na primeira mensagem de um contato novo o vínculo sempre
                // erra na primeira tentativa. Reagendar resolve ~100% dos casos, e é
                // mais barato que acoplar o serviço à resposta do webhook.
                const backoff = [20_000, 90_000, 300_000][job.resolveMisses];
                if (backoff !== undefined) {
                    this.requeueAvatarJob(job, { notBefore: Date.now() + backoff, resolveMisses: job.resolveMisses + 1 });
                } else {
                    finish('no_conversation');
                    // Uma linha só, na desistência — não uma por tentativa.
                    void this.debugLog(phoneNumberId, 'avatar_no_conversation', jid, {
                        attempts: job.resolveMisses + 1,
                    });
                }
                return;
            }

            if (this.isAvatarFresh(conv)) {
                finish(conv.avatarUrl ? 'ok' : 'no_photo');
                return;
            }

            const pictureUrl = await client.getProfilePictureUrl(jid, job.quality);
            this.avatarConsecutive429 = 0; // consulta que passou zera o disjuntor

            if (!pictureUrl) {
                // Sem foto é resultado. NÃO apaga a url existente: remoção real chega
                // pelo contacts.update com imgUrl 'removed', e uma resposta vazia
                // transitória não pode custar a foto que já está guardada.
                await this.markAvatarChecked(conv.id);
                finish('no_photo');
                return;
            }

            const buffer = await this.downloadAvatar(pictureUrl);
            if (!buffer) {
                finish('transient');
                return;
            }

            const stored = await this.storeAvatarBuffer(phoneNumberId, jid, buffer);
            if (!stored) {
                finish('transient');
                return;
            }

            const linked = await this.linkAvatarToConversation(conv.id, stored, conv.avatarUrl);
            if (!linked) {
                // Corrida estreita: o cron de merge (roda a cada minuto) pode ter
                // apagado a linha entre o resolve e o update. Uma re-tentativa e pronto.
                if (job.resolveMisses === 0) {
                    this.requeueAvatarJob(job, { notBefore: Date.now() + 5_000, resolveMisses: 1 });
                    return;
                }
                void this.debugLog(phoneNumberId, 'avatar_unlinked', jid, { conversation_id: conv.id });
                finish('transient');
                return;
            }

            finish('ok');
            if (isGroup) {
                this.cacheSet(this.groupAvatarUrlCache, this.avatarKey(phoneNumberId, jid), stored);
            }
            void this.debugLog(phoneNumberId, 'avatar_stored', jid, {
                quality: job.quality,
                bytes: buffer.length,
                changed: stored !== conv.avatarUrl,
                source: job.priority === 1 ? 'backfill' : 'live',
            });
        } catch (error: any) {
            const statusCode = errorStatus(error);

            if (statusCode === 401 || statusCode === 403) {
                // Perfil restrito por privacidade — resultado, não erro.
                finish('forbidden');
                return;
            }
            if (statusCode === 404) {
                finish('no_photo');
                return;
            }
            if (statusCode === 429) {
                // 429 não diz nada sobre ESTE contato: diz que a linha pediu demais.
                // Pausa global e reenfileira para depois da pausa.
                const until = this.tripAvatarBreaker(phoneNumberId, jid);
                this.requeueAvatarJob(job, { notBefore: until + Math.floor(Math.random() * 5_000) });
                return;
            }

            console.error(`[ProfilePic] Error fetching for ${jid}:`, error?.message || error);
            finish('transient');
        }
    }

    /**
     * Sobe o buffer no Storage e devolve a URL pública já com o cache-buster.
     * Devolve null em falha (transitória).
     */
    private async storeAvatarBuffer(
        phoneNumberId: string,
        jid: string,
        buffer: Buffer
    ): Promise<string | null> {
        // `.replace` com string troca só a PRIMEIRA ocorrência — mantido de propósito:
        // o caminho já existente no bucket foi gerado assim e precisa continuar estável.
        const safeJid = jid.replace('@', '_').replace('.', '_');
        const storagePath = `contact-avatars/${phoneNumberId}/${safeJid}.jpg`;

        // Fixo em image/jpeg: o caminho termina em .jpg e a foto do WhatsApp é sempre
        // JPEG. O header da CDN ia cru para o Storage, e um `image/jpeg; charset=…`
        // seria recusado pela allowlist de mime do bucket, em silêncio.
        const { error: uploadError } = await supabase.storage
            .from('attachments')
            .upload(storagePath, buffer, { contentType: 'image/jpeg', upsert: true });

        if (uploadError) {
            void this.debugLog(phoneNumberId, 'avatar_upload_failed', jid, {
                path: storagePath,
                error: uploadError.message,
            });
            return null;
        }

        // URL pública (ECHO_PUBLIC_URL no Docker; sem ela, SUPABASE_URL): é a que o navegador abre.
        const publicUrl = urlPublicaDoAnexo(storagePath);
        // Cache-buster pelo CONTEÚDO, não pelo relógio. Com `?t=${Date.now()}` toda
        // revalidação mintava uma URL nova → UPDATE na conversa → broadcast do realtime
        // → refetch da lista inteira em todo cliente conectado → download de uma imagem
        // idêntica. Com o hash, foto que não mudou não move nada disso.
        const digest = createHash('sha1').update(buffer).digest('hex').slice(0, 8);
        return `${publicUrl}?v=${digest}`;
    }

    /**
     * Foto removida no aparelho (`imgUrl: 'removed'`): zera a url e carimba a
     * conferida. Sem consulta nenhuma ao WhatsApp — o evento já é a resposta.
     */
    private async clearConversationAvatar(phoneNumberId: string, jid: string, contactPhone?: string): Promise<void> {
        const conv = await this.resolveConversationForAvatar(phoneNumberId, jid, jid.endsWith('@g.us'), contactPhone);
        if (!conv) return;

        const { error } = await supabase
            .from('conversations')
            .update({ contact_avatar_url: null, contact_avatar_updated_at: new Date().toISOString() })
            .eq('id', conv.id);

        if (error) {
            console.error('[ProfilePic] clearConversationAvatar error:', error.message);
            return;
        }
        this.rememberAvatarAttempt(phoneNumberId, jid, 'no_photo');
        if (jid.endsWith('@g.us')) {
            this.cacheSet(this.groupAvatarUrlCache, this.avatarKey(phoneNumberId, jid), null);
        }
    }

    /** Só carimba a conferida (sem mexer na url). Ver isAvatarFresh. */
    private async markAvatarChecked(conversationId: string): Promise<void> {
        const { error } = await supabase
            .from('conversations')
            .update({ contact_avatar_updated_at: new Date().toISOString() })
            .eq('id', conversationId);
        if (error) console.error('[ProfilePic] markAvatarChecked error:', error.message);
    }

    /**
     * Grava a url na conversa por ID e devolve se a escrita realmente pousou.
     *
     * O `.select('id')` é o que faz o PostgREST devolver as linhas afetadas: sem ele,
     * um UPDATE que não casa nada é indistinguível de sucesso — foi assim que o
     * serviço passou meses gravando cache de "foto ok" para conversas que não existiam.
     */
    private async linkAvatarToConversation(
        conversationId: string,
        avatarUrl: string,
        previousUrl: string | null
    ): Promise<boolean> {
        try {
            const patch: Record<string, string> = {
                contact_avatar_updated_at: new Date().toISOString(),
            };
            // Foto idêntica (mesmo hash): só renova a conferida. Evita um UPDATE de
            // url que dispararia realtime à toa em todo cliente.
            if (avatarUrl !== previousUrl) patch.contact_avatar_url = avatarUrl;

            const { data, error } = await supabase
                .from('conversations')
                .update(patch)
                .eq('id', conversationId)
                .select('id');

            if (error) {
                console.error('[ProfilePic] DB update error:', error.message);
                return false;
            }
            return (data?.length ?? 0) > 0;
        } catch (e) {
            console.error('[ProfilePic] Update error:', e);
            return false;
        }
    }

    // ============================================
    // MESSAGE DELIVERY LOGGING
    // ============================================

    /**
     * Log a message event to both console and the qr_message_log table in Supabase.
     * Fire-and-forget: never blocks message sending.
     */
    /**
     * Diagnóstico legível por SQL. Os logs do container nem sempre são acessíveis de
     * fora, e sem eles casos como "view-once não chega" e "voto não
     * conta" são indepuráveis — aqui a evidência fica no banco, na mesma tabela
     * de log dos envios.
     */
    private async debugLog(
        phoneNumberId: string,
        action: string,
        toJid: string,
        payload: Record<string, unknown>,
        messageId?: string | null
    ): Promise<void> {
        try {
            // Dentro do try: um payload não-serializável não pode custar o rastro
            // (o insert usa o mesmo objeto — se stringify falhar, o log de console
            // degrada mas o catch ainda registra a falha).
            try {
                console.log(`[QR_DEBUG] ${action} to=${toJid} msgId=${messageId ?? 'N/A'} ${JSON.stringify(payload)}`);
            } catch {
                console.log(`[QR_DEBUG] ${action} to=${toJid} msgId=${messageId ?? 'N/A'} [payload não serializável]`);
            }
            // success reflete a semântica da action: perda/quase-perda grava false.
            // Antes TUDO era true — inclusive msg_handler_throw — e o índice parcial
            // de falhas (WHERE success = false) não cobria nenhuma perda de entrada.
            // Validado: nenhum consumidor filtra por success=true (só por action).
            const isFailure =
                action.startsWith('handler_throw') ||
                action.startsWith('msg_drop_') ||
                action.startsWith('msg_handler_throw') ||
                action.startsWith('webhook_') ||
                action.startsWith('media_') ||
                action === 'offline_drain_short' ||
                action === 'capping_capped' ||
                action === 'msg_resend_unavailable' ||
                action === 'msg_resend_request_failed';
            await supabase.from('qr_message_log').insert({
                phone_number_id: phoneNumberId,
                to_jid: toJid,
                message_id: messageId ?? null,
                action,
                success: !isFailure,
                baileys_result: payload,
            });
        } catch (err) {
            console.error(`[QR_DEBUG] Falha ao gravar ${action}:`, err);
        }
    }

    /**
     * Embrulha um handler de evento do Baileys para que NENHUM throw escape.
     *
     * O event-buffer do Baileys emite os eventos num for síncrono dentro de um
     * timer de flush: um throw síncrono de um handler nosso (a) aborta os eventos
     * seguintes do mesmo flush e (b) sobe como uncaughtException → process.exit(1)
     * — tudo que estava em vôo morre. Uma rejeição async vira unhandledRejection
     * e o resto do handler nunca roda (foi assim que um chunk de history sync
     * inteiro podia sumir). Aqui, qualquer exceção vira uma linha
     * handler_throw:<evento> em qr_message_log (que o cron de alerta conta) e o
     * fluxo segue.
     */
    private safeHandler<T>(
        phoneNumberId: string,
        name: string,
        fn: (arg: T) => void | Promise<void>
    ): (arg: T) => void {
        return (arg: T) => {
            try {
                const result = fn(arg);
                if (result && typeof (result as Promise<void>).then === 'function') {
                    (result as Promise<void>).catch((err: unknown) =>
                        this.reportHandlerThrow(phoneNumberId, name, err)
                    );
                }
            } catch (err) {
                this.reportHandlerThrow(phoneNumberId, name, err);
            }
        };
    }

    private reportHandlerThrow(phoneNumberId: string, name: string, err: unknown): void {
        console.error(`[SessionManager] HANDLER_THROW ${name}:`, err);
        void this.debugLog(phoneNumberId, `handler_throw:${name}`, 'system', {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? (err.stack?.slice(0, 1500) ?? null) : null,
        });
    }

    /**
     * Registra close/open do socket em session_connection_log. O motivo de uma
     * queda só existia no console do container, que é inacessível em produção —
     * sem isso, investigar "por que o número caiu" vira correlação de horário.
     * Nunca lança: é diagnóstico, não pode derrubar o handler de conexão.
     */
    private async logConnectionEvent(
        phoneNumberId: string,
        event: 'close' | 'open',
        data: {
            statusCode?: number;
            errorMessage?: string;
            reason?: string;
            reconnectAttempts?: number;
        } = {}
    ): Promise<void> {
        try {
            await supabase.from('session_connection_log').insert({
                phone_number_id: phoneNumberId,
                event,
                status_code: data.statusCode ?? null,
                error_message: data.errorMessage ?? null,
                reason: data.reason ?? null,
                reconnect_attempts: data.reconnectAttempts ?? null,
            });
        } catch (err) {
            console.error(`[SessionManager] Falha ao gravar connection log (${event}):`, err);
        }
    }

    private async logMessageEvent(params: {
        phoneNumberId: string;
        toJid: string;
        messageId?: string;
        action: 'send_text' | 'send_media' | 'send_contact' | 'send_location' | 'delivery_update' | 'delivery_fail' | 'group_receipt'
            | 'reachout_rejected' | 'reachout_blocked' | 'reachout_active' | 'send_capped' | 'capping_blocked';
        success: boolean;
        error?: string;
        socketState?: number;
        sessionStatus?: string;
        baileysResult?: Record<string, unknown>;
    }): Promise<void> {
        const tag = params.success ? '✅' : '❌';
        console.log(`[QR_MSG_LOG] ${tag} action=${params.action} to=${params.toJid} msgId=${params.messageId || 'N/A'} success=${params.success} socketState=${params.socketState ?? 'N/A'} sessionStatus=${params.sessionStatus || 'N/A'}${params.error ? ` error="${params.error}"` : ''}`);

        // Persist to DB (fire-and-forget)
        try {
            await supabase.from('qr_message_log').insert({
                phone_number_id: params.phoneNumberId,
                to_jid: params.toJid,
                message_id: params.messageId || null,
                action: params.action,
                success: params.success,
                error: params.error || null,
                socket_state: params.socketState ?? null,
                session_status: params.sessionStatus || null,
                baileys_result: params.baileysResult || null,
            });
        } catch (dbErr) {
            console.error('[QR_MSG_LOG] Failed to persist log to DB:', dbErr);
        }
    }

    private checkConnections() {
        const now = Date.now();
        console.log('[ConnectionWatchdog] Checking active sessions...');
        this.sessions.forEach((session, id) => {
            if (session.status === 'connected' && session.client) {
                // Use activity-based detection instead of unreliable ws.readyState
                const inactiveMs = now - (session.lastActivityAt || 0);
                const INACTIVE_THRESHOLD_MS = 20 * 60 * 1000; // 20 min (keepAlive is every 10 min)

                if (inactiveMs > INACTIVE_THRESHOLD_MS) {
                    // Check cooldown to prevent reconnection loops
                    const lastReconnect = this.lastWatchdogReconnect.get<number>(id) || 0;

                    if (now - lastReconnect < this.WATCHDOG_COOLDOWN_MS) {
                        console.log(`[ConnectionWatchdog] Session ${id} in cooldown, skipping`);
                        return;
                    }

                    this.cacheSet(this.lastWatchdogReconnect, id, now);
                    console.warn(`[ConnectionWatchdog] Session ${id} inactive for ${Math.round(inactiveMs / 1000)}s, closing socket...`);
                    // Let connection.close handler manage reconnection (avoid duplicate connect calls)
                    try {
                        // end() destrói o buffer sem flush — drenar antes de matar.
                        void session.client.close().catch(() => { /* já fechado */ });
                    } catch (e) {
                        console.error(`[ConnectionWatchdog] Error ending socket for ${id}:`, e);
                        // Force status change so reconnect handler can act
                        session.status = 'disconnected';
                    }
                } else {
                    console.log(`[ConnectionWatchdog] Session ${id} OK (last activity ${Math.round(inactiveMs / 1000)}s ago)`);
                }
            }
            if (session.status === 'connecting') {
                // Sessão presa em 'connecting' há mais de 10 min é zumbi (o handshake
                // real leva segundos): sem esta cura, ela recebia mensagens mas
                // recusava envio/recuperação até um redeploy manual.
                const stuckMs = now - (session.lastActivityAt || now);
                const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
                if (stuckMs > STUCK_THRESHOLD_MS) {
                    const lastReconnect = this.lastWatchdogReconnect.get<number>(id) || 0;
                    if (now - lastReconnect >= this.WATCHDOG_COOLDOWN_MS) {
                        this.cacheSet(this.lastWatchdogReconnect, id, now);
                        console.warn(`[ConnectionWatchdog] Session ${id} presa em 'connecting' há ${Math.round(stuckMs / 1000)}s — forçando reconexão`);
                        try {
                            void session.client?.close().catch(() => { /* já fechado */ });
                        } catch { /* socket pode nem existir */ }
                        void this.connect(id, false).catch((err) =>
                            console.error(`[ConnectionWatchdog] Reconexão de ${id} falhou:`, err)
                        );
                    }
                } else {
                    console.log(`[ConnectionWatchdog] Session ${id} is connecting (attempt ${session.reconnectAttempts})`);
                }
            }
        });
    }

    // Restore all QR-connected phone numbers from local session files on startup
    async restoreAllSessions(): Promise<void> {
        try {
            // Cada provider sabe onde guarda as sessões; a linha decide qual provider a
            // atende no connect(). Sessão cujo phone_number sumiu do banco é apagada.
            const stored = new Map<string, WhatsAppClientFactory>();
            const pending: WhatsAppClientFactory[] = [];
            for (const factory of this.providers.all()) {
                const ids = await listStoredOnce(factory);
                if (!ids) { pending.push(factory); continue; }
                for (const id of ids) {
                    if (!stored.has(id)) stored.set(id, factory);
                }
            }
            await this.restoreStoredSessions(stored);
            // Provider cuja listagem falhou (zapo com o banco ainda subindo após reboot do
            // host) tenta de novo em segundo plano. O Baileys, que lê do disco, já restaurou.
            for (const factory of pending) void this.retryDiscovery(factory);
        } catch (error) {
            console.error('[SessionManager] restoreAllSessions failed:', error);
        }
    }

    private async retryDiscovery(factory: WhatsAppClientFactory): Promise<void> {
        try {
            const ids = await listStoredWithRetry(factory, undefined, undefined, () => this.shuttingDown);
            if (!ids) return;
            if (this.shuttingDown) {
                console.log(`[SessionManager] Encerrando: restore de '${factory.name}' abandonado`);
                return;
            }
            const stored = new Map<string, WhatsAppClientFactory>();
            for (const id of ids) {
                // Alguém pode ter conectado a linha à mão enquanto o banco estava fora.
                if (!this.sessions.has(id) && !this.connectInFlight.has(id)) stored.set(id, factory);
            }
            await this.restoreStoredSessions(stored);
        } catch (error) {
            console.error(`[SessionManager] Nova tentativa de restore de '${factory.name}' falhou:`, error);
        }
    }

    private async restoreStoredSessions(stored: Map<string, WhatsAppClientFactory>): Promise<void> {
        const candidates = [...stored.keys()];
        if (candidates.length === 0) {
            console.log('[SessionManager] No stored sessions to restore');
            return;
        }
        console.log(`[SessionManager] Found ${candidates.length} stored session(s), restoring...`);
        let validIds: Set<string> | null = null;
        const { data: rows, error } = await supabase
            .from('phone_numbers')
            .select('id')
            .in('id', candidates);
        if (error) {
            console.error('[SessionManager] Could not validate stored sessions against phone_numbers:', error.message);
        } else {
            validIds = new Set((rows ?? []).map((row: { id: string }) => row.id));
        }
        let restored = 0;
        for (const [phoneNumberId, factory] of stored) {
            if (validIds && !validIds.has(phoneNumberId)) {
                console.warn(`[SessionManager] Stored session ${phoneNumberId} has no phone_number row — removing`);
                await factory.createStore(phoneNumberId).wipe().catch(() => { /* best-effort */ });
                continue;
            }
            try {
                // Escalonado: N sessões abrindo ao mesmo tempo é o padrão que o WhatsApp pune.
                if (this.shuttingDown) break;
                if (restored > 0) await sleep(RESTORE_STAGGER_MS);
                if (this.shuttingDown) break;
                restored++;
                await this.connect(phoneNumberId, false);
            } catch (e) {
                console.error(`[SessionManager] Failed to restore session ${phoneNumberId}:`, e);
            }
        }
        if (this.shuttingDown) console.log('[SessionManager] Restore interrompido pelo encerramento');
        console.log(`[SessionManager] Restore complete: ${restored} session(s)`);
    }

    async connect(phoneNumberId: string, forceNew: boolean = false, opts?: ConnectOptions): Promise<string> {
        // Single-flight por número: a sessão entra no mapa com socket=null e só
        // recebe o socket 3 awaits depois — um segundo connect() nessa janela
        // passava a guarda de status e criava um SOCKET DUPLO (o antigo ficava
        // órfão recebendo mensagens e disputando o device slot até um conflict
        // 401). Com a promise compartilhada, connects concorrentes convergem.
        const inFlight = this.connectInFlight.get(phoneNumberId);
        if (inFlight) {
            console.log(`[SessionManager] connect() já em andamento para ${phoneNumberId} — reusando`);
            return inFlight;
        }
        const run = this.doConnect(phoneNumberId, forceNew, opts);
        this.connectInFlight.set(phoneNumberId, run);
        try {
            return await run;
        } finally {
            this.connectInFlight.delete(phoneNumberId);
        }
    }

    private async doConnect(phoneNumberId: string, forceNew: boolean = false, opts?: ConnectOptions): Promise<string> {
        console.log(`[SessionManager] connect() called with phoneNumberId=${phoneNumberId}, forceNew=${forceNew}, usePairingCode=${opts?.usePairingCode ?? 'inherit'}`);
        // Resolve o provider UMA vez: store e factory têm de ser do mesmo provider (uma 2ª leitura de
        // qr_provider com o banco oscilando podia dar outro e o cliente lançava bad_store).
        const factory = await this.providerFor(phoneNumberId);
        const store = factory.createStore(phoneNumberId);
        const storedPaired = await store.isPaired();

        // Só pedidos explícitos (rota) passam pela proteção; reconexão interna e
        // restore do boot não pareiam de novo.
        if (opts) {
            const refusal = this.checkPairingBudget(phoneNumberId, storedPaired, forceNew);
            if (refusal) {
                console.warn(`[PairingGuard] connect recusado para ${phoneNumberId}: ${refusal}`);
                throw new ConnectRefusedError(refusal);
            }
        }

        // Force new session - clear existing session files
        if (forceNew) {
            console.log(`[SessionManager] Force new session, clearing ${store.locator}`);
            // Stop existing socket if any
            const existing = this.sessions.get(phoneNumberId);
            if (existing?.client) {
                try {
                    void existing.client.close().catch(() => { /* já fechado */ });
                } catch (e) {
                    console.log('[SessionManager] Error closing existing socket:', e);
                }
            }
            // Preserve SSE listeners across the forceNew recreation (senão o front
            // para de receber eventos até reabrir o EventSource)
            if (existing && existing.listeners.size > 0) {
                const pending = this.pendingListeners.get(phoneNumberId) ?? new Set();
                existing.listeners.forEach((l) => pending.add(l));
                this.pendingListeners.set(phoneNumberId, pending);
            }
            this.sessions.delete(phoneNumberId);
            // Clear session files
            await store.wipe();
        }

        // Check if session already exists
        const existingSession = this.sessions.get(phoneNumberId);
        if (existingSession) {
            if (existingSession.status === 'connected') {
                return 'already_connected';
            }
            // If already connecting with an active socket, don't start another connection
            if (existingSession.status === 'connecting' && existingSession.client) {
                // Check if socket is actually still active
                const socketState = this.getSocketReadyState(existingSession);
                if (socketState === 0 || socketState === 1) { // CONNECTING or OPEN
                    console.log(`[SessionManager] Session ${phoneNumberId} already connecting with active socket (state=${socketState}), skipping duplicate connect`);
                    return 'already_connecting';
                }
                console.log(`[SessionManager] Session ${phoneNumberId} was connecting but socket is dead (state=${socketState}), proceeding with reconnect`);
            }
            // Clear presenceInterval to prevent memory leak (timers accumulating)
            if (existingSession.presenceInterval) {
                clearInterval(existingSession.presenceInterval);
                existingSession.presenceInterval = undefined;
                console.log(`[SessionManager] Cleared presenceInterval for ${phoneNumberId}`);
            }

            // Clear any pending reconnect timer to prevent overlapping reconnections
            if (existingSession.reconnectTimer) {
                clearTimeout(existingSession.reconnectTimer);
                existingSession.reconnectTimer = undefined;
                console.log(`[SessionManager] Cleared pending reconnectTimer for ${phoneNumberId}`);
            }

            // Clear any pending disconnect alert timer
            this.clearDisconnectAlertTimer(phoneNumberId);

            // Close existing socket before reconnecting. O adapter faz o flush do
            // event-buffer ANTES de fechar (eventos pendentes passam pelos handlers
            // antigos, que enfileiram no outbox, em vez de morrerem com o socket —
            // F45/F46); os listeners saem depois do close.
            if (existingSession.client) {
                const old = existingSession.client;
                void old.close()
                    .catch((e: unknown) => console.log('[SessionManager] Error closing existing socket during reconnect:', e))
                    .finally(() => old.removeAllListeners());
                console.log(`[SessionManager] Socket cleanup scheduled for ${phoneNumberId}`);
            }
        }

        // Preserve reconnectAttempts from existing session, or start fresh
        const previousAttempts = existingSession?.reconnectAttempts ?? 0;

        // Pairing mode: explicit opts win (route calls); internal reconnects (opts undefined)
        // inherit from the existing session so the auto-reconnect cycle refreshes expired codes
        const usePairingCode = opts ? (opts.usePairingCode ?? false) : (existingSession?.usePairingCode ?? false);
        const pairingPhone = opts ? opts.phoneNumber : existingSession?.pairingPhone;

        // Initialize session
        const session: Session = {
            client: null,
            qrCode: null,
            status: 'connecting',
            phoneNumberId,
            listeners: existingSession?.listeners ?? this.pendingListeners.get(phoneNumberId) ?? new Set(),
            reconnectAttempts: previousAttempts, // Preserve attempts for exponential backoff
            lastDisconnectedAt: this.loadDisconnectTimestamp(phoneNumberId), // Load from file for offline sync
            lastActivityAt: Date.now(), // Initialize for watchdog tracking
            offlineRecovered: 0,
            offlineDrainPending: true,
            pairingCode: null,
            usePairingCode,
            pairingPhone,
            pairingCodeRequested: false,
            // Explicit opts = user action (route): reset the renewal budget.
            // Internal reconnects inherit it so renewals can actually exhaust.
            pairingRenewals: opts ? 0 : (existingSession?.pairingRenewals ?? 0),
            // O bloqueio 463 e os contatos "quentes" são da CONTA, não do socket:
            // sobrevivem a reconexão (senão uma queda zeraria o bloqueio).
            reachoutLock: existingSession?.reachoutLock,
            messageCapping: existingSession?.messageCapping,
            warmJids: existingSession?.warmJids,
            newContactWindow: existingSession?.newContactWindow,
        };
        // Clear pending listeners now that they're attached
        this.pendingListeners.delete(phoneNumberId);
        this.sessions.set(phoneNumberId, session);

        // O arquivo é a fonte rápida, mas ele vive dentro do volume: um redeploy sem
        // mount, ou o rmSync do ramo loggedOut, levam o cutoff embora. O banco é o
        // espelho que sobrevive a isso.
        if (session.lastDisconnectedAt === undefined) {
            session.lastDisconnectedAt = await this.loadDisconnectTimestampFromDb(phoneNumberId);
        }

        // A lib entra pelo adapter (fase 2): browser tuple, versão WA, getMessage, cache de
        // grupo e filtro de histórico vivem no BaileysClient. Os handlers abaixo ainda
        // penduram no socket cru — vão migrando para os eventos normalizados (fase 3).
        const client = factory.create({
            sessionId: phoneNumberId,
            store,
            pairing: session.usePairingCode && session.pairingPhone ? { phone: session.pairingPhone } : undefined,
            getSentMessage: (id) => this.msgCache.get(id),
            // Sem isto o Baileys refaz groupMetadata (IQ ao servidor) a CADA envio em
            // grupo para enumerar participantes. O miss busca uma vez e guarda.
            getCachedGroup: async (jid) => {
                const hit = this.groupMetaFullCache.get<GroupInfo>(jid);
                if (hit) return hit;
                const live = this.sessions.get(phoneNumberId)?.client;
                if (!live) return undefined;
                const info = await live.getGroup(jid);
                this.cacheSet(this.groupMetaFullCache, jid, info);
                return info;
            },
            logLevel: 'warn',
            voice: VOIP_ENABLED ? { maxConcurrentCalls: VOIP_MAX_CONCURRENT_CALLS } : false,
        });
        client.on('error', ({ scope, error }) => this.reportHandlerThrow(phoneNumberId, `adapter:${scope}`, error));
        session.client = client;
        session.providerName = factory.name;

        // Todo handler de evento passa pelo safeHandler: um throw síncrono dentro
        // do timer de flush do event-buffer viraria uncaughtException → exit(1)
        // (matando downloads, webhooks pendentes e o buffer inteiro), e uma
        // rejeição abortava o resto do próprio handler. Com o wrapper, qualquer
        // exceção vira handler_throw:<evento> em qr_message_log e o fluxo segue.
        // Os eventos já chegam normalizados pelo adapter: nada aqui conhece a lib.
        const on = <E extends ClientEventName>(
            event: E,
            listener: (arg: ClientEventMap[E]) => void | Promise<void>
        ): void => {
            client.on(event, this.safeHandler(phoneNumberId, event, listener));
        };

        // Handle connection updates
        // QR/pareamento: evento próprio do adapter (não vem mais dentro do connection.update).
        on('qr', async ({ qr }) => {
            const live = this.sessions.get(phoneNumberId) ?? session;
            if (live.client !== client) return; // socket antigo
            if (session.usePairingCode && session.pairingPhone && !client.isRegistered()) {
                // Pairing mode: request the code once per socket (it doesn't rotate with qr
                // events); subsequent qr events are ignored so no QR is generated/emitted
                if (!session.pairingCodeRequested) {
                    session.pairingCodeRequested = true;
                    try {
                        const code = await client.requestPairingCode();
                        console.log(`[SessionManager] Pairing code generated for ${phoneNumberId}`);
                        session.pairingCode = code;
                        session.qrCode = null;
                        session.status = 'qr_ready';
                        session.reconnectAttempts = 0; // User action required, same as QR
                        this.notifyListeners(phoneNumberId, 'pairing_code', {
                            pairingCode: code,
                            phoneNumber: session.pairingPhone,
                        });
                        await this.updateSessionInDb(phoneNumberId, 'qr_ready', null);
                    } catch (e) {
                        // Fall back to QR so the user is never stuck: next qr event takes the normal path
                        console.error(`[SessionManager] requestPairingCode failed for ${phoneNumberId}, falling back to QR:`, e);
                        session.usePairingCode = false;
                        this.notifyListeners(phoneNumberId, 'pairing_error', {
                            message: e instanceof Error ? e.message : 'Failed to request pairing code',
                        });
                    }
                }
            } else if (session.qrEmitted) {
                // Um QR por pedido. O Baileys renova o ref a cada 20-60s até esgotar
                // os refs (~2min) e, na queda por 408, o reconnect abria socket novo
                // e recomeçava — QR infinito até alguém escanear. Cada QR é um
                // pareamento pendente a mais para o anti-abuso do WhatsApp; a
                // renovação passa a exigir um novo POST /session/connect.
                console.log(`[SessionManager] QR expirou sem leitura para ${phoneNumberId} — encerrando o socket (um QR por pedido)`);
                session.qrCode = null;
                session.status = 'qr_expired';
                void client.close().catch(() => { /* já fechado */ });
            } else {
                session.qrEmitted = true;
                console.log('[SessionManager] QR code received, generating data URL...');
                // Generate QR code as data URL
                session.qrCode = await QRCode.toDataURL(qr);
                session.status = 'qr_ready';
                session.reconnectAttempts = 0; // Reset attempts when QR is shown (user action required)
                console.log('[SessionManager] QR code generated, notifying listeners:', session.listeners.size);
                this.notifyListeners(phoneNumberId, 'qr', { qrCode: session.qrCode });

                // Update database
                await this.updateSessionInDb(phoneNumberId, 'qr_ready', session.qrCode);
            }
        });

        on('connection.update', async (update) => {
            const connection = update.state;

            console.log('[SessionManager] Connection update:', { connection, cause: update.cause, phoneNumberId });

            // Estado de sessão SEMPRE via o objeto vivo do mapa: connect() cria um
            // Session novo a cada reconexão e o closure deste handler aponta para o
            // antigo — flags lidas/escritas no objeto errado faziam a varredura de
            // gap disparar duas vezes ou nunca (F57/F58/F64).
            const live = this.sessions.get(phoneNumberId) ?? session;

            // Um 'close' atrasado do socket ANTIGO não pode derrubar a sessão nova
            // que acabou de conectar no lugar dele.
            if (connection === 'close' && live.client && live.client !== client) {
                console.log(`[SessionManager] close atrasado de socket antigo de ${phoneNumberId} — ignorando (sessão viva tem outro socket)`);
                return;
            }

            // Fim da drenagem da fila offline: o Baileys já entregou e flushou tudo o que
            // estava pendente (CB:ib,,offline). É o único ponto em que se sabe quanto
            // voltou depois de uma queda — os logs do container não são acessíveis.
            if (update.receivedPendingNotifications === true && live.offlineDrainPending) {
                live.offlineDrainPending = false;
                const recovered = live.offlineRecovered ?? 0;
                console.log(`[OfflineSync] Drenagem concluída: ${recovered} mensagem(ns) da fila offline (phoneNumberId=${phoneNumberId})`);
                void this.recordOfflineRecovery(phoneNumberId, recovered);

                // Queda longa: a fila nativa pode não cobrir o gap inteiro. Varre as
                // conversas ativas e pede o restante por conversa (fetchMessageHistory
                // é on-demand, não existe "me dê tudo desde X" cross-chat).
                const gapStart = live.lastDisconnectedAt;
                const gapMs = gapStart ? Date.now() - gapStart : 0;
                if (gapStart && gapMs > AUTO_RECOVERY_GAP_THRESHOLD_MS && !live.autoRecoveryRunning) {
                    void this.autoRecoverConversations(phoneNumberId, gapStart, recovered);
                }
            }


            if (connection === 'close') {
                const statusCode = update.statusCode;
                const errorMessage = update.errorMessage;
                const cause = update.cause ?? 'unknown';
                // 'logged_out' e 'conflict' são o 401 do WhatsApp: credenciais inválidas.
                const shouldReconnect = cause !== 'logged_out' && cause !== 'conflict';

                console.log('[SessionManager] Connection closed:', { statusCode, errorMessage, shouldReconnect, reconnectAttempts: session.reconnectAttempts });

                // "Stream Errored (conflict)" chega como 401, mas não é logout: outro
                // socket assumiu o device slot desse número (outro dispositivo vinculado
                // ou segunda instância com as mesmas creds).
                const isConflict = cause === 'connection_replaced' || cause === 'conflict'
                    || /conflict/i.test(errorMessage ?? '');

                // "Já pareou" = creds.me preenchido (pair-success dos DOIS fluxos).
                // creds.registered só vira true no pareamento por CÓDIGO
                // (link_code_companion_reg); sessão pareada por QR fica registered=false
                // para sempre — usar só a flag tratava toda queda de sessão QR como
                // "pareamento pendente" e não reconectava (2.3.15).
                const hasPairedCreds = client.isRegistered() || !!client.me();

                // 401 (loggedOut) ou 403 em sessão que estava REGISTRADA = o WhatsApp
                // derrubou o dispositivo. Re-parear em seguida agrava; o connect()
                // manual fica em cooldown. O 401 do pareamento pendente não conta.
                if (!isConflict && hasPairedCreds
                    && (cause === 'logged_out' || cause === 'forbidden')) {
                    this.fatalCloseAt.set(phoneNumberId, { at: Date.now(), statusCode: statusCode ?? 0 });
                }

                void this.logConnectionEvent(phoneNumberId, 'close', {
                    statusCode,
                    errorMessage,
                    reason: isConflict
                        ? 'conflict'
                        : !hasPairedCreds ? 'pairing_pending' : shouldReconnect ? 'reconnect' : 'fatal',
                    reconnectAttempts: session.reconnectAttempts,
                });

                // Store disconnect timestamp for offline message sync (in memory + file)
                session.lastDisconnectedAt = Date.now();
                this.saveDisconnectTimestamp(phoneNumberId, session.lastDisconnectedAt);
                console.log(`[SessionManager] Stored disconnect timestamp: ${new Date(session.lastDisconnectedAt).toISOString()}`);

                // Start disconnect alert timer
                this.startDisconnectAlertTimer(phoneNumberId);

                // Clear presence interval
                if (session.presenceInterval) {
                    clearInterval(session.presenceInterval);
                    session.presenceInterval = undefined;
                }

                const MAX_RECONNECT_ATTEMPTS = 10;

                // Pareamento por QR sem leitura: ou nós encerramos o socket no segundo
                // ref (ramo do qr acima), ou ele caiu antes da leitura. Não reconecta:
                // reconectar geraria QR novo sem ninguém pedir. O 515 (restartRequired)
                // vem DEPOIS do pair-success e segue o reconnect normal.
                const qrPending = !session.usePairingCode
                    && !hasPairedCreds
                    && cause !== 'restart_required';
                if (session.status === 'qr_expired' || qrPending) {
                    if (session.reconnectTimer) {
                        clearTimeout(session.reconnectTimer);
                        session.reconnectTimer = undefined;
                    }
                    // Nunca conectou: "número caiu" seria alerta falso.
                    this.clearDisconnectAlertTimer(phoneNumberId);
                    const reason = session.status === 'qr_expired' ? 'qr_expired' : 'qr_aborted';
                    session.status = 'disconnected';
                    session.qrCode = null;
                    session.reconnectAttempts = 0;
                    console.log(`[SessionManager] Pareamento por QR encerrado (${reason}, statusCode=${statusCode}) — aguardando novo pedido`);
                    this.notifyListeners(phoneNumberId, 'disconnected', { statusCode, errorMessage, reason });
                    await this.updateSessionInDb(phoneNumberId, 'disconnected', null);
                    return;
                }

                // Don't reconnect if we intentionally stopped because QR is needed
                if (session.status === 'needs_reconnect') {
                    console.log('[SessionManager] Not reconnecting - session requires manual QR scan');
                    return;
                }

                // Pairing pendente: o socket morre quando os QR refs acabam (408) e
                // reconectar com as MESMAS creds é rejeitado com 401 Connection Failure,
                // que caía no branch fatal e matava a sessão em silêncio. Renova com
                // creds NOVAS (socket novo pede código novo e o emite via SSE), com
                // orçamento limitado. Exclui o restartRequired (515) do pareamento
                // bem-sucedido — esse segue o reconnect normal para completar o registro.
                const MAX_PAIRING_RENEWALS = 4;
                const pairingPending = session.usePairingCode && session.pairingPhone
                    && !client.isRegistered()
                    && cause !== 'restart_required';
                if (pairingPending) {
                    if (session.reconnectTimer) {
                        clearTimeout(session.reconnectTimer);
                        session.reconnectTimer = undefined;
                    }
                    const renewals = session.pairingRenewals ?? 0;
                    if (renewals < MAX_PAIRING_RENEWALS) {
                        session.pairingRenewals = renewals + 1;
                        session.status = 'connecting';
                        session.pairingCode = null;
                        console.log(`[SessionManager] Pairing socket closed (${statusCode}); renewing code with fresh creds (${session.pairingRenewals}/${MAX_PAIRING_RENEWALS})...`);
                        session.reconnectTimer = setTimeout(async () => {
                            session.reconnectTimer = undefined;
                            try {
                                await store.wipe();
                                // Sem opts: herda modo pairing, telefone e listeners da sessão existente
                                await this.connect(phoneNumberId, false);
                            } catch (e) {
                                console.error(`[SessionManager] Pairing renewal failed for ${phoneNumberId}:`, e);
                            }
                        }, 2000);
                    } else {
                        console.log(`[SessionManager] Pairing renewals exhausted for ${phoneNumberId}; shutting session down.`);
                        session.status = 'disconnected';
                        this.notifyListeners(phoneNumberId, 'disconnected', { statusCode, errorMessage, reason: 'pairing_expired' });
                        await this.updateSessionInDb(phoneNumberId, 'disconnected', null);
                        this.sessions.delete(phoneNumberId);
                        {
                            try {
                                await store.wipe();
                            } catch (e) {
                                console.error('[SessionManager] Error deleting session files:', e);
                            }
                        }
                    }
                    return;
                }

                if (shouldReconnect && session.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    // Exponential backoff
                    const delay = Math.min(5000 * Math.pow(2, session.reconnectAttempts), 300000); // Max 5 min
                    session.reconnectAttempts++;

                    console.log(`[SessionManager] Reconnecting session ${phoneNumberId} in ${delay}ms (Attempt ${session.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                    session.status = 'connecting';

                    // Clear any pending reconnect timer to prevent overlapping reconnections
                    if (session.reconnectTimer) {
                        clearTimeout(session.reconnectTimer);
                    }

                    session.reconnectTimer = setTimeout(async () => {
                        session.reconnectTimer = undefined;
                        console.log(`[SessionManager] Executing reconnect for ${phoneNumberId}...`);
                        try {
                            await this.connect(phoneNumberId, false);
                            console.log(`[SessionManager] Reconnect call completed for ${phoneNumberId}`);
                        } catch (e) {
                            console.error(`[SessionManager] Reconnect FAILED for ${phoneNumberId}:`, e);
                            // Don't schedule another retry here - the connection.update handler will handle it
                        }
                    }, delay);
                } else if (session.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    // Too many attempts - give up and require manual reconnection
                    console.error(`[SessionManager] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached for ${phoneNumberId}. Giving up.`);
                    session.status = 'disconnected';
                    session.reconnectAttempts = 0; // Reset for next manual connect
                    this.notifyListeners(phoneNumberId, 'disconnected', { statusCode, errorMessage, reason: 'max_attempts_reached' });
                    await this.updateSessionInDb(phoneNumberId, 'disconnected', null);
                } else {
                    // Logged out or fatal error
                    console.log(`[SessionManager] Fatal error or logged out (conflict=${isConflict}). NOT reconnecting.`);
                    session.status = 'disconnected';
                    // Um reconnect agendado por um close anterior ressuscitaria a sessão deletada
                    if (session.reconnectTimer) {
                        clearTimeout(session.reconnectTimer);
                        session.reconnectTimer = undefined;
                    }
                    this.notifyListeners(phoneNumberId, 'disconnected', {
                        statusCode,
                        errorMessage,
                        ...(isConflict ? { reason: 'conflict' } : {}),
                    });
                    await this.updateSessionInDb(phoneNumberId, 'disconnected', null);

                    // Cleanup
                    this.sessions.delete(phoneNumberId);
                    // Conflito NÃO é logout: as credenciais continuam válidas, quem tomou
                    // o slot foi outro socket. Apagá-las transformava uma disputa
                    // temporária em "precisa parear de novo" — reconectar pelo painel
                    // reusa as creds e volta sozinho.
                    if (!isConflict) {
                        try {
                            await store.wipe();
                        } catch (e) {
                            console.error('[SessionManager] Error deleting session files:', e);
                        }
                    }
                }
            }

            if (connection === 'open') {
                // Get phone number from socket
                const phoneNumber = client.me()?.phone || '';

                // Detecta duplicata GLOBAL antes de marcar como conectado.
                // - Outro registro ativo + sessão ativa  → BLOQUEIA este registro.
                // - Outro registro ativo + sessão morta → MERGE (frontend redireciona pro antigo).
                // Nos dois casos a sessão local morre; a linha de phone_numbers só é
                // deletada se for placeholder recém-criado (ver cleanupDuplicateSession).
                //
                // Fail-open: um soluço de banco aqui lançava, o bloco 'open' nunca
                // terminava e a sessão ficava ZUMBI em 'connecting' — recebendo
                // mensagens mas recusando envio/recuperação e invisível ao watchdog.
                // O UNIQUE INDEX no banco continua segurando a duplicata real.
                let result: Awaited<ReturnType<SessionManager['updatePhoneNumber']>>;
                try {
                    result = await this.updatePhoneNumber(phoneNumberId, phoneNumber);
                } catch (err) {
                    console.error(`[SessionManager] updatePhoneNumber falhou para ${phoneNumberId} — seguindo conectado (fail-open):`, err);
                    result = { ok: true };
                }

                if (!result.ok) {
                    console.log(`[SessionManager] Duplicate JID detected (${result.reason}) for ${phoneNumberId} → existing ${result.existingPhoneNumberId} (${result.existingDisplayName})`);
                    this.notifyListeners(
                        phoneNumberId,
                        result.reason === 'blocked' ? 'duplicate_blocked' : 'duplicate_merged',
                        {
                            existingPhoneNumberId: result.existingPhoneNumberId,
                            existingDisplayName: result.existingDisplayName,
                        }
                    );
                    await this.cleanupDuplicateSession(phoneNumberId, session, result.reason);
                    return;
                }

                console.log('[SessionManager] Connection OPEN! Notifying connected event, listeners:', session.listeners.size);
                void this.logConnectionEvent(phoneNumberId, 'open', {
                    reconnectAttempts: session.reconnectAttempts,
                });
                session.status = 'connected';
                session.qrCode = null;
                session.pairingCode = null;
                session.usePairingCode = false;
                session.pairingPhone = undefined;
                session.reconnectAttempts = 0; // Reset attempts
                session.lastActivityAt = Date.now(); // Track for watchdog

                // Fallback da drenagem: em quedas por 515/conflict o servidor às vezes
                // NÃO manda receivedPendingNotifications — offlineDrainPending ficava
                // true para sempre e a varredura de gap NUNCA rodava (F59). Após 90s
                // sem o flag, fecha a drenagem e roda a mesma lógica de gap.
                const drainFallback = setTimeout(() => {
                    const liveNow = this.sessions.get(phoneNumberId);
                    if (!liveNow || liveNow.client !== client) return; // reconectou de novo
                    if (!liveNow.offlineDrainPending) return; // fechou pelo caminho normal
                    liveNow.offlineDrainPending = false;
                    const recovered = liveNow.offlineRecovered ?? 0;
                    console.warn(`[OfflineSync] receivedPendingNotifications não chegou em 90s — fechando drenagem (recovered=${recovered})`);
                    void this.recordOfflineRecovery(phoneNumberId, recovered);
                    const gapStart = liveNow.lastDisconnectedAt;
                    const gapMs = gapStart ? Date.now() - gapStart : 0;
                    if (gapStart && gapMs > AUTO_RECOVERY_GAP_THRESHOLD_MS && !liveNow.autoRecoveryRunning) {
                        void this.autoRecoverConversations(phoneNumberId, gapStart, recovered);
                    }
                }, 90_000);
                drainFallback.unref();

                // Clear any pending disconnect alert timer
                this.clearDisconnectAlertTimer(phoneNumberId);

                this.notifyListeners(phoneNumberId, 'connected', {});
                this.fatalCloseAt.delete(phoneNumberId);

                // Conta já restringida antes desta conexão (ou o processo reiniciou no
                // meio de um bloqueio): uma consulta e o bloqueio local nasce armado.
                void this.probeReachoutTimelock(session);
                void this.probeMessageCapping(session);

                // Presença global imediata, sem esperar o primeiro tick do keep-alive.
                // O estado sai de phone_numbers.keep_device_notifications e é um tradeoff
                // que só o operador sabe resolver (ver resolvePresenceState):
                //   'unavailable' -> o celular continua notificando, mas não recebemos
                //                    presença do contato;
                //   'available'   -> presença completa do contato (inclusive o chatstate
                //                    de "digitando"), ao custo das notificações no celular.
                // markOnlineOnConnect fica false nos DOIS modos de propósito: este send é
                // a única fonte de verdade do estado, senão o Baileys decidiria em paralelo.
                const presenceState = await this.resolvePresenceState(phoneNumberId);
                session.keepDeviceNotifications = presenceState === 'unavailable';
                try {
                    await client.setGlobalPresence(presenceState);
                } catch (e) {
                    console.log(`[PresenceKeepAlive] Initial ${presenceState} failed for ${phoneNumberId}:`, (e as Error).message);
                }

                // Clear any existing presence interval before creating new one
                if (session.presenceInterval) {
                    clearInterval(session.presenceInterval);
                }

                // Presence Keep-Alive (a cada 10 min): reafirma o estado escolhido no
                // toggle e atualiza lastActivityAt para o ConnectionWatchdog (threshold
                // de 20 min). Lê o flag cacheado, então /session/presence-mode troca o
                // comportamento sem reconectar.
                session.presenceInterval = setInterval(async () => {
                    // Only send if still connected and socket is open
                    if (session.status !== 'connected' || !session.client) {
                        return;
                    }
                    try {
                        await this.clientOf(session).setGlobalPresence(
                            session.keepDeviceNotifications === false ? 'available' : 'unavailable'
                        );
                        session.lastActivityAt = Date.now(); // Track for watchdog
                    } catch (e) {
                        // Ignore errors - connection might have closed
                        console.log(`[PresenceKeepAlive] Error for ${phoneNumberId}:`, (e as Error).message);
                    }
                }, 10 * 60 * 1000);

                await this.updateSessionInDb(phoneNumberId, 'connected', null);

                console.log(`✅ Session ${phoneNumberId} connected as ${phoneNumber}`);
            }
        });

        // Handle history sync - messages received while offline
        // Histórico (RECENT no pareamento, ON_DEMAND no refetch manual). Normalizado
        // pelo adapter; aqui só cutoff, dedupe no banco, LID e encaminhamento.
        on('history.sync', async ({ messages, isLatest, requestId }) => {
            const live = this.sessions.get(phoneNumberId) ?? session;
            live.lastActivityAt = Date.now(); // Track for watchdog
            const isOnDemand = !!requestId;
            const rawCutoff = live.lastDisconnectedAt || (Date.now() - 7 * 24 * 60 * 60 * 1000);
            const cutoffTime = isOnDemand
                ? (live.onDemandSync?.cutoffMs ?? 0) // 0 = aceita tudo o que foi pedido
                : rawCutoff - (5 * 60 * 1000); // 5 minutes tolerance
            console.log(`[HistorySync] ${messages.length} mensagem(ns) recebidas (isLatest=${isLatest}, onDemand=${isOnDemand}, cutoff=${new Date(cutoffTime).toISOString()})`);

            let skippedOld = 0;
            let skippedDupe = 0;
            let skippedProtocol = 0;
            type Candidate = { msg: InboundMessage; remoteJid: string; messageId: string };
            const candidates: Candidate[] = [];
            for (const msg of messages) {
                const remoteJid = msg.key.chatJid;
                if (remoteJid.endsWith('@broadcast')) continue;
                if (msg.timestamp < cutoffTime) {
                    skippedOld++;
                    continue;
                }
                const messageId = msg.key.id;
                if (!messageId || msg.content.type === 'undecryptable') continue;
                // Protocolo (revoke/edit/ephemeral/sync) não vira mensagem nova no histórico.
                if (msg.content.type === 'protocol' || msg.content.type === 'revoke' || msg.content.type === 'edit'
                    || msg.content.type === 'reaction' || msg.content.type === 'poll_vote') {
                    skippedProtocol++;
                    continue;
                }
                // Envelope sem conteúdo próprio (álbum, stanza só de protocolo): o
                // caminho ao vivo já dá skip, o histórico inseria com content vazio.
                if (msg.content.type === 'unsupported' && msg.content.skip) {
                    skippedProtocol++;
                    continue;
                }
                candidates.push({ msg, remoteJid, messageId });
            }

            // Dedupe em lote contra o banco (o webhook também é idempotente por wamid).
            const existingIds = new Set<string>();
            const DEDUPE_CHUNK = 500;
            for (let i = 0; i < candidates.length; i += DEDUPE_CHUNK) {
                const chunkIds = candidates.slice(i, i + DEDUPE_CHUNK).map(c => c.messageId);
                const { data, error } = await supabase
                    .from('messages')
                    .select('whatsapp_message_id, conversations!inner(phone_number_id)')
                    .in('whatsapp_message_id', chunkIds)
                    .eq('conversations.phone_number_id', phoneNumberId);
                if (error) {
                    console.error('[HistorySync] dedupe falhou no chunk, seguindo sem dedupe:', error.message);
                    continue;
                }
                data?.forEach((row: { whatsapp_message_id: string }) => existingIds.add(row.whatsapp_message_id));
            }

            const groupSubjects = new Map<string, string | undefined>();
            for (const jid of new Set(candidates.map(c => c.remoteJid).filter(j => j.endsWith('@g.us')))) {
                groupSubjects.set(jid, await this.resolveGroupSubject(session.client, jid));
            }

            const lidPhones = new Map<string, string>();
            const pendingLids = [...new Set(
                candidates.map(c => c.remoteJid).filter(j => j.endsWith('@lid')).map(j => j.replace('@lid', ''))
            )].filter(lid => {
                const cached = this.lidPhoneCache.get<string>(lid);
                if (cached) lidPhones.set(lid, cached);
                return !cached;
            });
            if (pendingLids.length > 0 && session.client) {
                const resolved = await this.lookupPnsForLids(session, pendingLids);
                for (const [lid, phone] of resolved) {
                    lidPhones.set(lid, phone);
                    this.cacheSet(this.lidPhoneCache, lid, phone);
                }
            }

            type WebhookPayload = Parameters<SessionManager['forwardToWebhook']>[1];
            const payloads: WebhookPayload[] = [];
            const pendingMedia = new Map<string, InboundMessage>();
            for (const { msg, remoteJid, messageId } of candidates) {
                if (existingIds.has(messageId)) {
                    skippedDupe++;
                    continue;
                }
                const isFromMe = msg.key.fromMe;
                const alt = msg.chatAltJid ?? '';
                let from = '';
                if (alt.endsWith('@s.whatsapp.net')) {
                    from = alt.replace('@s.whatsapp.net', '');
                } else if (remoteJid.endsWith('@s.whatsapp.net')) {
                    from = remoteJid.replace('@s.whatsapp.net', '');
                } else if (remoteJid.endsWith('@lid')) {
                    const lidId = remoteJid.replace('@lid', '');
                    from = lidPhones.get(lidId)
                        ?? (msg.key.participantJid?.endsWith('@s.whatsapp.net')
                            ? msg.key.participantJid.replace('@s.whatsapp.net', '')
                            : lidId);
                } else {
                    from = remoteJid; // grupo (@g.us) ou outro formato
                }
                const described = this.describeContent(msg, 'history');
                const isGroupMsg = remoteJid.endsWith('@g.us');
                const pushName = isFromMe ? undefined : (msg.pushName || undefined);
                payloads.push({
                    from,
                    content: described.content,
                    messageId,
                    timestamp: msg.timestamp ? msg.timestamp / 1000 : null,
                    contactName: isGroupMsg ? groupSubjects.get(remoteJid) : pushName,
                    messageType: described.messageType,
                    fromMe: isFromMe,
                    isGroup: isGroupMsg,
                    groupJid: isGroupMsg ? remoteJid : undefined,
                    groupSubject: isGroupMsg ? groupSubjects.get(remoteJid) : undefined,
                    senderPhone: msg.key.participantJid?.replace('@s.whatsapp.net', '').replace('@lid', ''),
                    senderName: pushName,
                    mediaMimeType: described.mediaMimeType,
                    mediaFilename: described.mediaFilename,
                    contactMetadata: described.contactMetadata,
                    metadata: msg.isViewOnce
                        ? { ...(described.metadata ?? {}), view_once: true }
                        : described.metadata,
                });
                if (described.media && !msg.isViewOnce) {
                    pendingMedia.set(messageId, msg);
                }
            }

            const FORWARD_CONCURRENCY = 10;
            const MEDIA_CONCURRENCY = 3;
            let syncedCount = 0;
            let mediaRecovered = 0;
            let mediaExpired = 0;
            const textPayloads = payloads.filter(p => !p.messageId || !pendingMedia.has(p.messageId));
            const mediaPayloads = payloads.filter(p => p.messageId && pendingMedia.has(p.messageId));
            for (let i = 0; i < textPayloads.length; i += FORWARD_CONCURRENCY) {
                const batch = textPayloads.slice(i, i + FORWARD_CONCURRENCY);
                await Promise.all(batch.map(p => this.forwardToWebhook(phoneNumberId, p)));
                syncedCount += batch.length;
            }
            for (let i = 0; i < mediaPayloads.length; i += MEDIA_CONCURRENCY) {
                const batch = mediaPayloads.slice(i, i + MEDIA_CONCURRENCY);
                await Promise.all(batch.map(async (payload) => {
                    const original = pendingMedia.get(payload.messageId!);
                    const downloaded = original
                        ? await downloadInboundMedia(original, session.client, 2, 1000).catch(() => null)
                        : null;
                    if (downloaded) {
                        if ('buffer' in downloaded) payload.mediaBuffer = downloaded.buffer.toString('base64');
                        else payload.mediaFile = downloaded.file;
                        mediaRecovered++;
                    } else {
                        mediaExpired++;
                    }
                    await this.forwardToWebhook(phoneNumberId, payload);
                }));
                syncedCount += batch.length;
            }
            console.log(`[HistorySync] ${syncedCount} encaminhadas (antigas=${skippedOld}, dup=${skippedDupe}, protocolo=${skippedProtocol}, mídia ok=${mediaRecovered}, mídia expirada=${mediaExpired})`);

            if (isOnDemand && live.onDemandSync) {
                live.onDemandSync.received += syncedCount;
            }
            if (isLatest === true && !isOnDemand && !live.autoRecoveryRunning) {
                live.lastDisconnectedAt = undefined;
                const timestampFile = path.join(this.sessionsDir, phoneNumberId, 'disconnect_timestamp.txt');
                try {
                    if (fs.existsSync(timestampFile)) {
                        fs.unlinkSync(timestampFile);
                    }
                } catch (e) { /* ignore */ }
            }
        });

        // Mensagens ao vivo ('notify') e fila offline / eco próprio ('append').
        on('messages.upsert', async ({ messages, kind }) => {
            const live = this.sessions.get(phoneNumberId) ?? session;
            live.lastActivityAt = Date.now(); // Track for watchdog
            if (kind === 'append' && live.offlineDrainPending) {
                live.offlineRecovered = (live.offlineRecovered ?? 0) + messages.length;
            }

            for (const msg of messages) {
                const remoteJid = msg.key.chatJid;
                try {
                    const isFromMe = msg.key.fromMe;
                    if (!isFromMe && remoteJid.endsWith('@s.whatsapp.net')) {
                        this.markWarmJid(session, remoteJid.split('@')[0]);
                    }
                    if (msg.isViewOnce) {
                        void this.debugLog(phoneNumberId, 'view_once_seen', remoteJid || 'unknown', {
                            shape: msg.shape ?? null,
                            unavailable: msg.content.type === 'view_once_placeholder',
                            from_me: isFromMe,
                        }, msg.key.id);
                    }
                    if (remoteJid.endsWith('@broadcast')) {
                        continue;
                    }
                    if (msg.key.id && msg.messageSecret) {
                        this.cacheSet(this.msgSecretCache, msg.key.id, msg.messageSecret);
                    }

                    const c = msg.content;

                    if (c.type === 'revoke') {
                        const deletedMsgId = c.revoke.targetKey.id;
                        if (!deletedMsgId || isUntrackedRevokeOrigin(remoteJid)) continue;
                        console.log(`[MESSAGE_DELETE] ${deletedMsgId} apagada em ${remoteJid} (fromMe=${isFromMe})`);
                        this.forwardMessageDeletedToWebhook(phoneNumberId, deletedMsgId).catch(console.error);
                        continue;
                    }
                    if (c.type === 'edit') {
                        const editedMsgId = c.edit.targetKey.id;
                        if (!editedMsgId) continue;
                        if (c.edit.encrypted) {
                            // Edição cifrada com o segredo da original: o adapter abre, nós escolhemos o autor.
                            const newText = this.decryptSecretEncryptedEdit(c.edit.encrypted.handle, editedMsgId, msg, client);
                            this.forwardMessageEditedToWebhook(phoneNumberId, editedMsgId, newText).catch(console.error);
                            continue;
                        }
                        if (c.edit.newText) {
                            console.log(`[MESSAGE_EDIT] ${editedMsgId} editada em ${remoteJid}`);
                            this.forwardMessageEditedToWebhook(phoneNumberId, editedMsgId, c.edit.newText).catch(console.error);
                        } else {
                            console.warn(`[MESSAGE_EDIT] ${editedMsgId} sem texto novo extraível — ignorada`);
                        }
                        continue;
                    }
                    if (c.type === 'protocol') {
                        console.log(`[PROTOCOL] kind=${c.kind} fromMe=${isFromMe} group=${remoteJid.endsWith('@g.us')} from=${remoteJid}`);
                        if (c.kind === 'ephemeral_setting') {
                            const durationSec = c.ephemeralSeconds ?? 0;
                            const durationLabel =
                                durationSec === 0 ? 'desativadas'
                                : durationSec === 86400 ? 'ativadas: 24 horas'
                                : durationSec === 604800 ? 'ativadas: 7 dias'
                                : durationSec === 7776000 ? 'ativadas: 90 dias'
                                : `ativadas: ${Math.round(durationSec / 86400)} dias`;
                            const ephIsGroup = remoteJid.endsWith('@g.us');
                            // Mesma resolução LID→telefone da mensagem comum: o split cru do
                            // remoteJid criava conversa com o LID no lugar do telefone. LID que
                            // não resolve em 1:1 não vira conversa nova só por causa do aviso.
                            const eph = ephIsGroup ? { from: remoteJid.split('@')[0], unresolvedLid: false } : await this.resolveChatFrom(phoneNumberId, session, msg, remoteJid);
                            if (eph.unresolvedLid) {
                                console.warn(`[PROTOCOL] aviso de temporária em ${remoteJid} sem telefone resolvido — ignorado`);
                                continue;
                            }
                            const ephFrom = eph.from;
                            setImmediate(() => {
                                this.forwardToWebhook(phoneNumberId, {
                                    from: ephFrom,
                                    content: `Mensagens temporárias ${durationLabel}`,
                                    messageId: msg.key.id,
                                    timestamp: msg.timestamp ? Math.floor(msg.timestamp / 1000) : null,
                                    contactName: msg.pushName || undefined,
                                    messageType: 'group_action',
                                    isGroup: ephIsGroup,
                                    groupJid: ephIsGroup ? remoteJid : undefined,
                                    metadata: {
                                        groupAction: {
                                            action: 'ephemeral',
                                            duration: durationSec,
                                            actor: {
                                                jid: msg.key.participantJid || remoteJid,
                                                name: msg.pushName ?? null,
                                            },
                                        },
                                    },
                                    fromMe: isFromMe,
                                })
                                    .catch(err => console.error('[Webhook] Ephemeral notice forward error:', err));
                            });
                        }
                        continue;
                    }
                    if (c.type === 'poll_vote') {
                        this.handlePollUpdate(phoneNumberId, client, msg, c.vote)
                            .catch((err) => console.error('[Poll] Error handling vote:', err));
                        continue;
                    }
                    if (c.type === 'reaction') {
                        const targetMessageId = c.reaction.targetKey.id;
                        if (targetMessageId) {
                            // Prefere a forma telefone do remetente; em 1:1 sem participante é o próprio chat.
                            const reactorJid = msg.senderPn ?? (msg.senderJid || remoteJid);
                            await this.forwardReactionToWebhook(phoneNumberId, {
                                reactionEmoji: c.reaction.emoji,
                                targetMessageId,
                                fromMe: isFromMe,
                                timestamp: msg.timestamp ? Math.floor(msg.timestamp / 1000) : null,
                                reactorJid,
                                reactorName: msg.pushName ?? null,
                            });
                        }
                        continue; // Reações não criam mensagem nova
                    }

                    // --- identificação do chat (from) ---
                    const from = (await this.resolveChatFrom(phoneNumberId, session, msg, remoteJid)).from;

                    // --- remetente em grupo ---
                    const isGroup = remoteJid.endsWith('@g.us');
                    let groupSubject: string | undefined;
                    let senderPhone: string | undefined;
                    let senderName: string | undefined;
                    let senderJid: string | undefined; // JID original do participante (reações)
                    if (isGroup) {
                        const participant = msg.senderJid || '';
                        senderJid = participant;
                        let lidId: string | undefined;
                        if (participant.endsWith('@s.whatsapp.net')) {
                            senderPhone = participant.replace('@s.whatsapp.net', '');
                        } else if (participant.endsWith('@lid')) {
                            lidId = participant.replace('@lid', '');
                            const altPhone = this.pnDigits(msg.senderPn);
                            senderPhone = altPhone || this.lidPhoneCache.get<string>(lidId) || lidId;
                            if (altPhone) {
                                this.cacheSet(this.lidPhoneCache, lidId, altPhone);
                            }
                        }
                        senderName = msg.pushName || undefined;
                        if (lidId && senderName) {
                            this.cacheSet(this.lidNameCache, lidId, senderName);
                        }
                        groupSubject = await this.resolveGroupSubject(session.client, remoteJid);
                    }
                    const contactName = isGroup
                        ? groupSubject
                        : (isFromMe ? undefined : (msg.pushName || msg.businessName || undefined));

                    // --- conteúdo por tipo ---
                    const described = this.describeContent(msg, 'live');
                    if (described.skip) {
                        void this.debugLog(
                            phoneNumberId,
                            SKIP_ACTION[described.skip],
                            remoteJid,
                            { shape: msg.shape ?? null, from_me: isFromMe },
                            msg.key.id
                        );
                        continue;
                    }
                    let { content, messageType } = described;
                    const { mediaMimeType, mediaFilename, contactMetadata, stickerShaHex } = described;
                    let extraMetadata: Record<string, unknown> | null = described.metadata;
                    let mediaBuffer: Buffer | null = null;
                    let mediaFile: InboundMediaFile | null = null;
                    let preUploadedMediaUrl: string | null = null;
                    const mediaRetries = msg.isViewOnce ? 1 : 4;
                    const mediaSkip: MediaDownloadInfo = {};
                    if (described.media) {
                        const downloaded = await downloadInboundMedia(msg, client, mediaRetries, 1000, mediaSkip);
                        if (downloaded && 'buffer' in downloaded) mediaBuffer = downloaded.buffer;
                        if (downloaded && 'file' in downloaded) mediaFile = downloaded.file;
                        if (!mediaBuffer && !mediaFile && stickerShaHex) {
                            preUploadedMediaUrl = await this.getCachedStickerUrl(stickerShaHex);
                        }
                    }
                    if (msg.isViewOnce) {
                        extraMetadata = { ...(extraMetadata ?? {}), view_once: true };
                    }
                    if (described.linkPreview) {
                        const linkPreviewMeta: Record<string, unknown> = {
                            url: described.linkPreview.url ?? null,
                            title: described.linkPreview.title ?? null,
                            description: described.linkPreview.description ?? null,
                        };
                        const thumb = described.linkPreview.thumbnail;
                        if (thumb && thumb.length > 0 && thumb.length <= 65536) {
                            try {
                                const thumbUrl = await this.uploadToStorage(phoneNumberId, thumb, 'image/jpeg', 'link-preview.jpg');
                                if (thumbUrl) linkPreviewMeta.thumb_url = thumbUrl;
                            } catch {
                                /* preview segue sem thumb */
                            }
                        }
                        extraMetadata = { ...(extraMetadata ?? {}), link_preview: linkPreviewMeta };
                    }
                    if (msg.isForwarded) {
                        extraMetadata = {
                            ...(extraMetadata ?? {}),
                            forwarded: true,
                            ...(msg.forwardingScore >= 5 ? { frequently_forwarded: true } : {}),
                        };
                    }
                    const ctwa = msg.referral ?? null;
                    if (ctwa) {
                        console.log(`[CTWA] Referral de anúncio em ${msg.key.id} (clid=${ctwa.ctwaClid ?? 'n/a'})`);
                    }
                    let quotedStanzaId: string | null = null;
                    let quotedContent: string | null = null;
                    if (msg.quoted?.key.id) {
                        quotedStanzaId = msg.quoted.key.id;
                        if (msg.quoted.content) quotedContent = quotedLabel(msg.quoted.content);
                    }

                    // --- vazio: view-once sem mídia, stub indecifrável ---
                    if (!content && !mediaBuffer && !mediaFile) {
                        if (c.type === 'undecryptable') {
                            const stub = c.stubType ?? null;
                            const isLossShape = c.stub === 'none' || c.stub === 'ciphertext';
                            const wamidKey = msg.key.id ? `${phoneNumberId}:${msg.key.id}` : null;
                            console.warn(`[SessionManager] Empty/undecrypted message id=${msg.key.id} from=${remoteJid} stubType=${stub} fromMe=${isFromMe}`);
                            if (isLossShape && remoteJid.endsWith('@newsletter')) {
                                void this.debugLog(phoneNumberId, 'msg_skip_newsletter', remoteJid, {
                                    stub_type: stub,
                                    from_me: isFromMe,
                                }, msg.key.id);
                                continue;
                            }
                            // Stub que chegou DEPOIS da entrega real (sessão espelhada/duplicata): não é perda.
                            if (isLossShape && wamidKey && this.forwardedWamids.get(wamidKey)) {
                                continue;
                            }
                            if (isLossShape) {
                                if (wamidKey && this.undecryptedSeen.get(wamidKey)) {
                                    void this.debugLog(phoneNumberId, 'msg_undecrypted_repeat', remoteJid, {
                                        stub_type: stub,
                                        from_me: isFromMe,
                                    }, msg.key.id);
                                    continue;
                                }
                                if (wamidKey) this.cacheSet(this.undecryptedSeen, wamidKey, true);
                                void this.debugLog(phoneNumberId, 'msg_drop_undecrypted', remoteJid, {
                                    stub_type: stub,
                                    from_me: isFromMe,
                                }, msg.key.id);
                            } else if (c.stub === 'other') {
                                // Indisponível por outro motivo (zapo: hosted = conta Cloud API que não
                                // distribuiu, bot...). Não é o alerta de perda, mas precisa de rastro: os
                                // logs do container não são acessíveis, só o qr_message_log.
                                void this.debugLog(phoneNumberId, 'msg_drop_unavailable', remoteJid, {
                                    stub_type: stub,
                                    from_me: isFromMe,
                                }, msg.key.id);
                            }
                            if (c.stub === 'ciphertext' && c.resendRequested !== undefined) {
                                // A lib decidiu sozinha (zapo): registra o que ela fez. false = o
                                // servidor não reenvia (fora da janela, aparelho principal) — perda firme.
                                void this.debugLog(phoneNumberId, c.resendRequested ? 'msg_resend_requested' : 'msg_resend_unavailable', remoteJid, {
                                    request_id: c.resendRequested ? 'auto' : null,
                                    stub_type: stub,
                                }, msg.key.id);
                            } else if (c.stub === 'ciphertext' && session.client) {
                                void session.client.requestPlaceholderResend([msg.key]).then(([reqId]) => {
                                    void this.debugLog(phoneNumberId, 'msg_resend_requested', remoteJid, {
                                        request_id: reqId ?? null,
                                    }, msg.key.id);
                                }).catch((err: unknown) => {
                                    void this.debugLog(phoneNumberId, 'msg_resend_request_failed', remoteJid, {
                                        error: err instanceof Error ? err.message : String(err),
                                    }, msg.key.id);
                                });
                            }
                            continue;
                        }
                        if (c.type === 'view_once_placeholder') {
                            void this.debugLog(phoneNumberId, 'view_once_placeholder', remoteJid, {
                                shape: msg.shape ?? null,
                                message_type: messageType,
                            }, msg.key.id);
                        }
                    }

                    if (!isFromMe) {
                        // `from` é o telefone já resolvido (LID → PN); o JID fica para a consulta.
                        this.enqueueAvatarFetch(phoneNumberId, remoteJid, isGroup ? {} : { contactPhone: from });
                    }

                    if (mediaBuffer && mediaBuffer.length > MAX_MEDIA_BYTES) {
                        void this.debugLog(phoneNumberId, 'media_skipped_too_large', remoteJid, {
                            size_bytes: mediaBuffer.length,
                            limit_bytes: MAX_MEDIA_BYTES,
                            message_type: messageType,
                        }, msg.key.id);
                        mediaBuffer = null;
                        extraMetadata = { ...(extraMetadata ?? {}), media_too_large: true };
                    } else if (mediaSkip.tooLarge) {
                        void this.debugLog(phoneNumberId, 'media_skipped_too_large', remoteJid, {
                            size_bytes: mediaSkip.declaredBytes ?? null,
                            limit_bytes: MAX_MEDIA_BYTES,
                            message_type: messageType,
                            source: mediaSkip.diskFull ? 'disk_full' : 'declared_file_length',
                            filename: mediaFilename,
                        }, msg.key.id);
                        extraMetadata = { ...(extraMetadata ?? {}), media_too_large: true };
                    } else if (mediaSkip.failed && !preUploadedMediaUrl) {
                        void this.debugLog(phoneNumberId, 'media_download_failed', remoteJid, {
                            message_type: messageType,
                            filename: mediaFilename,
                            mime: mediaMimeType,
                            declared_bytes: mediaSkip.declaredBytes ?? null,
                            last_error: mediaSkip.lastError ?? null,
                            last_error_code: mediaSkip.lastErrorCode ?? null,
                            attempts: mediaSkip.attempts ?? null,
                            elapsed_ms: mediaSkip.elapsedMs ?? null,
                            has_media_key: mediaSkip.hasMediaKey ?? null,
                            has_direct_path: mediaSkip.hasDirectPath ?? null,
                            has_url: mediaSkip.hasUrl ?? null,
                            from_me: isFromMe,
                        }, msg.key.id);
                        extraMetadata = { ...(extraMetadata ?? {}), media_download_failed: true };
                    }

                    const mediaBase64 = mediaBuffer ? mediaBuffer.toString('base64') : null;
                    mediaBuffer = null; // libera o binário

                    if (msg.key.id) {
                        this.cacheSet(this.forwardedWamids, `${phoneNumberId}:${msg.key.id}`, true);
                    }
                    setImmediate(() => {
                        this.forwardToWebhook(phoneNumberId, {
                            from,
                            content,
                            messageId: msg.key.id,
                            timestamp: msg.timestamp ? Math.floor(msg.timestamp / 1000) : null,
                            contactName,
                            messageType,
                            mediaBuffer: mediaBase64,
                            mediaFile,
                            mediaMimeType,
                            mediaFilename,
                            mediaUrl: preUploadedMediaUrl,
                            mediaSizeBytes: mediaSkip.declaredBytes ?? null,
                            mediaDownloadFailed: mediaSkip.failed === true && !preUploadedMediaUrl,
                            stickerShaHex,
                            isGroup,
                            groupJid: isGroup ? remoteJid : undefined,
                            groupSubject,
                            senderPhone,
                            senderName,
                            senderJid,
                            quotedStanzaId,
                            quotedContent,
                            contactMetadata,
                            ctwaClid: ctwa?.ctwaClid ?? null,
                            referral: ctwa?.referral ?? null,
                            metadata: extraMetadata,
                            fromMe: isFromMe,
                        })
                            .catch(err => console.error('[Webhook] Forward error:', err));
                    });
                } catch (handlerError) {
                    console.error(
                        `[SessionManager] MESSAGE_HANDLER_THROW id=${msg.key.id || 'unknown'} from=${remoteJid || 'unknown'} shape=${msg.shape ?? 'n/a'}`,
                        handlerError
                    );
                    void this.debugLog(phoneNumberId, 'msg_handler_throw', remoteJid || 'unknown', {
                        shape: msg.shape ?? null,
                        from_me: msg.key.fromMe,
                        error: handlerError instanceof Error ? handlerError.message : String(handlerError),
                        stack: handlerError instanceof Error ? handlerError.stack?.slice(0, 1500) ?? null : null,
                    }, msg.key.id);
                }
            }
        });

        on('contacts.update', (contacts) => {
            for (const contact of contacts) {
                try {
                    const lid = contact.jid.replace('@lid', '').replace('@s.whatsapp.net', '');
                    const phoneNumber = this.pnDigits(contact.phoneJid);
                    if (lid && phoneNumber) {
                        this.cacheSet(this.lidPhoneCache, lid, phoneNumber);
                    }
                    const jid = contact.jid;
                    if (contact.avatar && jid.includes('@')) {
                        void this.debugLog(phoneNumberId, 'avatar_picture_event', jid, { img_url: contact.avatar });
                        this.invalidateAvatarCaches(phoneNumberId, jid);
                        if (contact.avatar === 'removed') {
                            void this.clearConversationAvatar(phoneNumberId, jid, phoneNumber);
                        } else {
                            this.enqueueAvatarFetch(phoneNumberId, jid, { force: true, contactPhone: phoneNumber });
                        }
                    }
                } catch (err) {
                    console.error('[ContactsUpdate] handler error:', err);
                }
            }
        });

        on('lid-mapping.update', ({ lid, pn }) => {
            const lidId = (lid.includes('@') ? normalizeJidUser(lid) : lid).split('@')[0].split(':')[0];
            const phoneNumber = this.pnDigits(pn);
            if (lidId && phoneNumber) {
                this.cacheSet(this.lidPhoneCache, lidId, phoneNumber);
            }
        });

        on('message_capping', (capping) => this.applyMessageCapping(phoneNumberId, capping, 'event'));

        on('call.update', (rawCall) => {
            // O plugin emite o mesmo estado por dois eventos (voip_call_state + incoming/ended):
            // um marcador por (ligação, estado) evita linha dupla no log e no SSE.
            const marker = `${rawCall.callId}:${rawCall.state}:${rawCall.endReason ?? ''}`;
            if (this.callStateSeen.get(marker)) return;
            this.cacheSet(this.callStateSeen, marker, true);
            // Quem liga chega como LID; o telefone só vem quando a lib entrega. Completa
            // pelo cache LID→telefone do processo, para o front achar a conversa.
            let call = rawCall;
            if (!call.peerPn && call.peerJid.endsWith('@lid')) {
                const phone = this.lidPhoneCache.get<string>(call.peerJid.split('@')[0].split(':')[0]);
                if (phone) call = { ...call, peerPn: `${phone}@s.whatsapp.net` };
            }
            this.callEvents.emit('update', phoneNumberId, call);
            const peer = call.peerPn ?? call.peerJid;
            if (call.direction === 'incoming' && call.state === 'incoming_ringing') {
                void this.debugLog(phoneNumberId, 'call_incoming', peer, { call_id: call.callId, is_video: call.isVideo });
            } else if (call.state === 'ended') {
                void this.debugLog(phoneNumberId, 'call_ended', peer, {
                    call_id: call.callId, direction: call.direction, reason: call.endReason ?? null,
                    duration_secs: call.durationSecs ?? null, connected: !!call.connectedAt,
                });
                this.recordCallInConversation(phoneNumberId, call);
            } else {
                void this.debugLog(phoneNumberId, 'call_state', peer, { call_id: call.callId, direction: call.direction, state: call.state });
            }
        });
        on('call.audio', ({ callId, pcm }) => { this.callEvents.emit('audio', phoneNumberId, callId, pcm); });

        // Fim da fila offline visto pela lib. `count` é o total que o SERVIDOR anunciou
        // (stanzas: mensagens, recibos, notificações — -1 quando a lib não conta);
        // `forced` + `remaining` > 0 é o servidor dizendo que cortou a drenagem e o
        // resto fica para a próxima conexão: o único sinal direto de "faltou coisa".
        on('offline.drained', ({ count, remaining, forced }) => {
            const live = this.sessions.get(phoneNumberId) ?? session;
            const short = forced === true && (remaining ?? 0) > 0;
            void this.debugLog(phoneNumberId, short ? 'offline_drain_short' : 'offline_drained', 'system', {
                server_total: count,
                server_remaining: remaining ?? null,
                forced: forced ?? null,
                messages_recovered: live.offlineRecovered ?? 0,
                gap_ms: live.lastDisconnectedAt ? Date.now() - live.lastDisconnectedAt : null,
            });
        });

        on('group-participants.update', (update) => {
            if (update.groupJid) this.groupMetaFullCache.del(update.groupJid);
            this.handleGroupParticipantsUpdate(phoneNumberId, update).catch((err) =>
                console.error('[GroupParticipants] handler error:', err)
            );
        });

        on('group-subject.update', (update) => {
            this.handleGroupSubjectUpdate(phoneNumberId, update).catch((err) =>
                console.error('[GroupSubject] handler error:', err)
            );
        });

        on('groups.upsert', (metas) => {
            this.handleGroupsUpsert(phoneNumberId, metas).catch((err) =>
                console.error('[GroupsUpsert] handler error:', err)
            );
        });

        on('messages.update', (updates) => {
            for (const update of updates) {
                try {
                    const msgId = update.key.id;
                    const remoteJid = update.key.chatJid || 'unknown';
                    if (update.type === 'revoke') {
                        if (!msgId || isUntrackedRevokeOrigin(remoteJid)) continue;
                        this.forwardMessageDeletedToWebhook(phoneNumberId, msgId).catch(console.error);
                        continue;
                    }
                    if (update.type === 'edit') {
                        if (msgId && update.newText) {
                            this.forwardMessageEditedToWebhook(phoneNumberId, msgId, update.newText).catch(console.error);
                        }
                        continue;
                    }
                    if (update.type !== 'status') continue;
                    // Números legados do webhook: 0 erro, 1 pendente, 2 servidor, 3 entregue, 4 lido, 5 tocado.
                    const STATUS_CODE: Record<string, number> = { error: 0, pending: 1, sent: 2, delivered: 3, read: 4, played: 5 };
                    const STATUS_LABEL: Record<number, string> = { 1: 'PENDING', 2: 'SENT_TO_SERVER', 3: 'DELIVERED', 4: 'READ', 5: 'PLAYED' };
                    const status = STATUS_CODE[update.status];
                    const statusLabel = status ? (STATUS_LABEL[status] || `UNKNOWN(${status})`) : 'NO_STATUS';
                    if (update.key.fromMe && status === 0) {
                        const ackError = update.errorCode ?? 'unknown';
                        console.warn(`[DeliveryUpdate] ack ERROR ${ackError} para ${msgId} em ${remoteJid}`);
                        // Ack de UM dispositivo do contato (jid com :N@) não é falha da mensagem: o
                        // aparelho principal já recebeu (vem DELIVERED antes) e um secundário
                        // ausente responde 479. Fica no log, não regride o status no Echo.
                        const deviceLevel = /:\d+@/.test(remoteJid);
                        if (ackError === '463') {
                            void this.handleReachoutRejected(session, remoteJid, msgId || undefined);
                        } else if (deviceLevel) {
                            void this.logMessageEvent({
                                phoneNumberId,
                                toJid: remoteJid,
                                messageId: msgId || undefined,
                                action: 'delivery_fail',
                                success: false,
                                error: `ack error ${ackError} (dispositivo secundário, ignorado)`,
                                sessionStatus: session.status,
                            });
                            continue;
                        } else {
                            void this.logMessageEvent({
                                phoneNumberId,
                                toJid: remoteJid,
                                messageId: msgId || undefined,
                                action: 'delivery_fail',
                                success: false,
                                error: `ack error ${ackError}`,
                                sessionStatus: session.status,
                            });
                        }
                        if (msgId) {
                            this.forwardDeliveryUpdateToWebhook(phoneNumberId, {
                                messageId: msgId,
                                status: 0,
                                statusLabel: `ERROR_${ackError}`,
                                remoteJid,
                            }).catch(console.error);
                        }
                        continue;
                    }
                    if (update.key.fromMe && status) {
                        if (status === 1) {
                            this.logMessageEvent({
                                phoneNumberId,
                                toJid: remoteJid,
                                messageId: msgId || undefined,
                                action: 'delivery_fail',
                                success: false,
                                error: `Delivery status: ${statusLabel}(${status})`,
                                sessionStatus: session.status,
                            });
                        }
                        if (status >= 3) {
                            this.logMessageEvent({
                                phoneNumberId,
                                toJid: remoteJid,
                                messageId: msgId || undefined,
                                action: 'delivery_update',
                                success: true,
                                sessionStatus: session.status,
                                baileysResult: { status, statusLabel },
                            });
                            if (msgId) {
                                this.forwardDeliveryUpdateToWebhook(phoneNumberId, {
                                    messageId: msgId,
                                    status,
                                    statusLabel,
                                    remoteJid,
                                }).catch(console.error);
                            }
                        }
                    }
                } catch (err) {
                    console.error('[MessagesUpdate] handler error:', err);
                }
            }
        });

        // Recibos por participante em grupo (quem leu). Em grupo o status nunca vem por messages.update.
        on('message-receipt.update', async (updates) => {
            type GroupReceipt = {
                participant_jid: string;
                participant_phone: string | null;
                kind: 'delivered' | 'read';
                ts: number;
            };
            const ourPn = client.me()?.jid ?? null;
            const ourLid = client.me()?.lid ?? null;
            const items: Array<{ wamid: string; remoteJid: string; jid: string; kind: 'delivered' | 'read'; ts: number }> = [];
            const lids = new Set<string>();
            for (const receipt of updates) {
                try {
                    const remoteJid = receipt.key.chatJid;
                    const wamid = receipt.key.id;
                    if (!remoteJid.endsWith('@g.us') || !receipt.key.fromMe || !wamid || !receipt.userJid) continue;
                    const jid = normalizeJidUser(receipt.userJid);
                    if (jid === ourPn || jid === ourLid) continue;
                    // 'played' conta como lido; 'other'/'retry' não é recibo de entrega.
                    const kind = receipt.type === 'read' || receipt.type === 'played' ? ('read' as const)
                        : receipt.type === 'delivered' ? ('delivered' as const) : null;
                    if (!kind) continue;
                    items.push({ wamid, remoteJid, jid, kind, ts: Math.floor(receipt.timestamp / 1000) });
                    if (jid.endsWith('@lid')) lids.add(jid.split('@')[0]);
                } catch (err) {
                    console.error('[GroupReceipts] item error:', err);
                }
            }
            if (items.length === 0) return;
            const lidPhones = new Map<string, string>();
            const pendingLids: string[] = [];
            for (const lid of lids) {
                const cached = this.lidPhoneCache.get<string>(lid);
                if (cached) lidPhones.set(lid, cached);
                else pendingLids.push(lid);
            }
            if (pendingLids.length > 0) {
                const resolved = await this.lookupPnsForLids(this.sessions.get(phoneNumberId) ?? session, pendingLids);
                for (const [lid, phone] of resolved) {
                    this.cacheSet(this.lidPhoneCache, lid, phone);
                    lidPhones.set(lid, phone);
                }
            }
            const byWamid = new Map<string, { remoteJid: string; receipts: GroupReceipt[] }>();
            for (const item of items) {
                const phone = this.pnDigits(item.jid) ?? lidPhones.get(item.jid.split('@')[0]) ?? null;
                const entry = byWamid.get(item.wamid) ?? { remoteJid: item.remoteJid, receipts: [] };
                entry.receipts.push({
                    participant_jid: item.jid,
                    participant_phone: phone,
                    kind: item.kind,
                    ts: item.ts,
                });
                byWamid.set(item.wamid, entry);
            }
            for (const [wamid, entry] of byWamid) {
                try {
                    const groupSize = await this.getGroupSizeExcludingSelf(client, entry.remoteJid, ourPn, ourLid);
                    await this.forwardMessageReceiptsToWebhook(phoneNumberId, {
                        messageId: wamid,
                        remoteJid: entry.remoteJid,
                        groupSize,
                        receipts: entry.receipts,
                    });
                    this.logMessageEvent({
                        phoneNumberId,
                        toJid: entry.remoteJid,
                        messageId: wamid,
                        action: 'group_receipt',
                        success: true,
                        sessionStatus: session.status,
                        baileysResult: {
                            receipts: entry.receipts.length,
                            reads: entry.receipts.filter((r) => r.kind === 'read').length,
                            group_size: groupSize,
                        },
                    });
                } catch (err) {
                    console.error('[GroupReceipts] forward error:', err);
                }
            }
        });

        on('presence.update', ({ chatJid, participantJid, state }) => {
            const mapped = this.mapChatState(state);
            if (!mapped) return;
            this.broadcastChatState(phoneNumberId, {
                chatJid,
                participantJid,
                state: mapped,
                isGroup: chatJid.endsWith('@g.us'),
            }).catch(() => { /* best-effort */ });
        });

        // Handlers pendurados; agora sim o socket pode abrir.
        await client.connect();

        return 'connecting';
    }

    /**
     * Identificador do chat para o webhook (`from`): telefone sempre que der para resolver
     * — par do stanza (chatAltJid), cache LID→telefone, participante PN ou o store da lib —
     * e só em último caso o próprio LID (`unresolvedLid`). Grupo devolve o JID inteiro.
     */
    private async resolveChatFrom(
        phoneNumberId: string,
        session: Session,
        msg: InboundMessage,
        remoteJid: string,
    ): Promise<{ from: string; unresolvedLid: boolean }> {
        const alt = msg.chatAltJid ?? '';
        if (alt.endsWith('@s.whatsapp.net')) {
            const from = alt.replace('@s.whatsapp.net', '');
            if (remoteJid.endsWith('@lid')) {
                this.cacheSet(this.lidPhoneCache, remoteJid.replace('@lid', ''), from);
            }
            return { from, unresolvedLid: false };
        }
        if (remoteJid.endsWith('@s.whatsapp.net')) return { from: remoteJid.replace('@s.whatsapp.net', ''), unresolvedLid: false };
        if (!remoteJid.endsWith('@lid')) return { from: remoteJid, unresolvedLid: false }; // grupo (@g.us) ou outro formato
        const lidId = remoteJid.replace('@lid', '');
        const cachedPhone = this.lidPhoneCache.get<string>(lidId);
        if (cachedPhone) return { from: cachedPhone, unresolvedLid: false };
        if (msg.key.participantJid?.endsWith('@s.whatsapp.net')) {
            const from = msg.key.participantJid.replace('@s.whatsapp.net', '');
            this.cacheSet(this.lidPhoneCache, lidId, from);
            return { from, unresolvedLid: false };
        }
        const storePhone = (await this.lookupPnsForLids(this.sessions.get(phoneNumberId) ?? session, [lidId])).get(lidId);
        if (storePhone) {
            this.cacheSet(this.lidPhoneCache, lidId, storePhone);
            return { from: storePhone, unresolvedLid: false };
        }
        return { from: lidId, unresolvedLid: true };
    }

    /**
     * Traduz o lastKnownPresence do Baileys para o que a UI entende.
     *
     * "Parou de digitar" chega de dois jeitos: o Baileys converte o <paused/> em
     * 'available' antes de emitir (Socket/chats.ts, handlePresenceUpdate); a zapo
     * emite 'paused' como veio. Os três são sinal de parada — sem o 'paused' o
     * "digitando…" ficava preso nas linhas da zapo até o timeout do front.
     */
    private mapChatState(lastKnownPresence?: string): 'typing' | 'recording' | 'stopped' | null {
        switch (lastKnownPresence) {
            case 'composing': return 'typing';
            case 'recording': return 'recording';
            case 'paused':
            case 'available':
            case 'unavailable': return 'stopped';
            default: return null;
        }
    }

    /**
     * Semeia LID -> telefone no momento do subscribe, que é a única hora em que
     * temos os dois lados: o front assina passando o telefone da conversa aberta,
     * enquanto o presence.update depois chega só com o @lid.
     *
     * Vai pelo sentido PN->LID de propósito. É o único que tem fallback de rede
     * (USync) quando o store local está vazio — LID->PN é puramente local, e era
     * por isso que a tradução falhava para contato que nunca mandou mensagem.
     * O getLIDsForPNs ainda persiste os dois sentidos no store, então o próximo
     * restart já resolve sem rede.
     */
    private async seedLidForPresence(session: Session, pnJid: string): Promise<void> {
        if (!session.client || !pnJid.endsWith('@s.whatsapp.net')) return;

        try {
            const lid = await session.client.lidForPn(pnJid);
            if (!lid) return;

            // O LID pode vir com device (`123:4@lid`); a presença chega sem.
            const lidUser = lid.split('@')[0].split(':')[0];
            const phone = pnJid.split('@')[0];
            if (!lidUser || !phone) return;

            if (!session.presenceLidPhone) session.presenceLidPhone = new Map();
            // Teto: é cache de conveniência — limpar tudo é inofensivo (re-semeia
            // no próximo subscribe) e evita crescer sem limite pela vida da sessão.
            if (session.presenceLidPhone.size > 2000) session.presenceLidPhone.clear();
            session.presenceLidPhone.set(lidUser, phone);
            this.cacheSet(this.lidPhoneCache, lidUser, phone);
            console.log(`[Presence] lid ${lidUser} -> ${phone}`);
        } catch (e) {
            console.debug('[Presence] seedLidForPresence falhou:', (e as Error).message);
        }
    }

    /**
     * Telefone (só dígitos) a partir do JID de um chat 1:1. Um `@lid` NÃO carrega
     * o telefone nos dígitos: sem traduzir, o cliente compararia o LID com o
     * contact_phone da conversa e nunca casaria — e na prática TODO chatstate de
     * 1:1 chega como @lid, então isto é o que faz o indicador aparecer.
     *
     * Ordem: o mapa semeado no subscribe (sempre cobre a conversa aberta, que é
     * a única que importa), depois lidPhoneCache, depois o store do Baileys.
     */
    private async presencePhoneFromJid(session: Session, jid: string): Promise<string> {
        const bare = jid.split('@')[0];
        if (!jid.endsWith('@lid')) return bare;

        const seeded = session.presenceLidPhone?.get(bare);
        if (seeded) return seeded;

        const cached = this.lidPhoneCache.get<string>(bare);
        if (cached) return cached;

        if (!session.client) return bare;
        const resolved = await this.lookupPnsForLids(session, [bare]);
        const phone = resolved.get(bare);
        if (phone) {
            this.cacheSet(this.lidPhoneCache, bare, phone);
            return phone;
        }

        return bare;
    }

    /**
     * Manda o chatstate para o navegador via broadcast do Realtime — efêmero, SEM
     * escrita no banco. Uma linha por rajada de tecla castigaria messages/
     * conversations e re-dispararia todo o pipeline de notificação.
     *
     * O tópico é por phone_number_id, não por conversa: aqui só temos o JID, e
     * resolver conversation_id custaria um SELECT por evento de digitação. O
     * navegador já sabe o telefone da conversa aberta e filtra localmente.
     */
    private async broadcastChatState(
        phoneNumberId: string,
        event: { chatJid: string; participantJid: string; state: string; isGroup: boolean }
    ): Promise<void> {
        const supabaseUrl = process.env.SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_KEY;
        if (!supabaseUrl || !serviceKey) return;

        const session = this.sessions.get(phoneNumberId);
        if (!session) return;

        const key = `${phoneNumberId}:${event.chatJid}:${event.participantJid}`;
        const previous = this.presenceThrottle.get<{ state: string; sentAt: number }>(key);

        if (previous) {
            const isSameState = previous.state === event.state;
            const isFresh = Date.now() - previous.sentAt < this.PRESENCE_REFRESH_MS;
            // Mudança de estado passa na hora; repetição só a cada PRESENCE_REFRESH_MS
            // pra refrescar o TTL do cliente. 'stopped' repetido é sempre descartado —
            // o cliente já apagou os pontinhos, não há TTL a manter.
            if (isSameState && (isFresh || event.state === 'stopped')) return;
        }

        // cacheSet nunca lança: perder o dedup é muito melhor que perder o broadcast.
        this.cacheSet(this.presenceThrottle, key, { state: event.state, sentAt: Date.now() });

        try {
            await postJson(
                `${supabaseUrl}/realtime/v1/api/broadcast`,
                {
                    messages: [{
                        topic: `presence-${phoneNumberId}`,
                        event: 'chatstate',
                        payload: {
                            phone_number_id: phoneNumberId,
                            chat_jid: event.chatJid,
                            participant_jid: event.participantJid,
                            // Casa com conversations.contact_phone (que em grupo guarda
                            // o próprio group_jid). Resolvido AQUI porque o LID só é
                            // traduzível com o cache do serviço — o navegador veria
                            // dígitos que não são telefone nenhum e nunca casaria.
                            contact_phone: event.isGroup
                                ? event.chatJid
                                : await this.presencePhoneFromJid(session, event.chatJid),
                            // Fallback: se o LID nao for traduzivel, os digitos crus
                            // ainda casam com as conversas que guardam o proprio LID
                            // em contact_phone. O cliente aceita qualquer um dos dois.
                            contact_phone_raw: event.isGroup ? event.chatJid : event.chatJid.split('@')[0],
                            state: event.state,
                            is_group: event.isGroup,
                        },
                    }],
                },
                2000, // presença é best-effort: falhar rápido, sem segurar heap
                // apikey É obrigatório junto do Bearer: sem ele o serviço lê a
                // service key (sb_secret_) como JWT e responde "Invalid Compact JWS".
                { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
            );
        } catch (e) {
            console.debug(`[Presence] broadcast failed for ${phoneNumberId}:`, (e as Error).message);
        }
    }

    /**
     * Métricas pra /health: detectar leak/backpressure antes do OOM.
     */
    getPendingWebhooks(): number {
        return this.outbox.memCount();
    }

    getOutboxStats(): ReturnType<WebhookOutbox['stats']> {
        return this.outbox.stats();
    }

    /** Replay dos jobs spillados em disco (chamado no boot pelo index.ts). */
    async replayOutbox(): Promise<void> {
        await this.outbox.replayFromDisk();
    }

    /** Dreno do outbox no shutdown: espera a fila em memória até maxMs. */
    async drainOutbox(maxMs: number): Promise<void> {
        await this.outbox.drain(maxMs);
    }

    /** Spilla o que sobrou em memória — shutdown e uncaughtException. */
    persistOutboxSync(): number {
        return this.outbox.persistPendingSync();
    }

    getSessionCount(): number {
        return this.sessions.size;
    }

    /**
     * Fecha todos os sockets sem fazer logout (preserva auth files).
     * Chamado pelo SIGTERM/SIGINT pra evitar corromper credenciais
     * quando o orquestrador reinicia o container.
     */
    async shutdownAll(): Promise<void> {
        this.shuttingDown = true;
        console.log(`[SessionManager] Shutting down ${this.sessions.size} sessions gracefully...`);
        for (const [id, session] of this.sessions) {
            try {
                if (session.presenceInterval) {
                    clearInterval(session.presenceInterval);
                    session.presenceInterval = undefined;
                }
                if (session.reconnectTimer) {
                    clearTimeout(session.reconnectTimer);
                    session.reconnectTimer = undefined;
                }
                // socket.end() destrói o event-buffer SEM flush — no SIGTERM de todo
                // redeploy, o que estivesse bufferizado morria. Flush primeiro: os
                // handlers enfileiram no outbox, e o shutdown drena/spilla o outbox.
                await session.client?.close().catch(() => { /* já fechado */ });
            } catch (e) {
                console.error(`[Shutdown] Error closing session ${id}:`, e);
            }
        }
        // Limpa timers de alerta de desconexão
        for (const timer of this.disconnectAlertTimers.values()) {
            clearTimeout(timer);
        }
        this.disconnectAlertTimers.clear();
    }

    async disconnect(phoneNumberId: string): Promise<boolean> {
        console.log(`[SessionManager] disconnect() called for ${phoneNumberId}`);
        await this.destroyLocalSession(phoneNumberId);

        // Always update DB
        await this.updateSessionInDb(phoneNumberId, 'disconnected', null);
        console.log(`[SessionManager] Session ${phoneNumberId} disconnected`);
        return true;
    }

    // Encerra socket, timers, Map e pasta de auth — sem tocar no DB.
    private async destroyLocalSession(phoneNumberId: string): Promise<void> {
        const session = this.sessions.get(phoneNumberId);

        if (session) {
            // Clear timers so a pending reconnect can't resurrect the session
            if (session.reconnectTimer) {
                clearTimeout(session.reconnectTimer);
                session.reconnectTimer = undefined;
            }
            if (session.presenceInterval) {
                clearInterval(session.presenceInterval);
                session.presenceInterval = undefined;
            }
        }

        // Try to logout if socket exists
        if (session?.client) {
            try {
                // Solta os handlers ANTES do logout: o 'close' do logout não pode
                // disparar a lógica de reconexão.
                session.client.removeAllListeners();
                await this.clientOf(session).logout();
                console.log(`[SessionManager] Socket logged out for ${phoneNumberId}`);
            } catch (error) {
                console.error(`[SessionManager] Error during logout:`, error);
                // Continue with cleanup even if logout fails
            }
        }

        // Remove from memory
        this.sessions.delete(phoneNumberId);
        this.pendingListeners.delete(phoneNumberId);

        // Clean up local session files
        await (await this.storeFor(phoneNumberId)).wipe().catch((e: unknown) =>
            console.error('[SessionManager] wipe do store falhou:', e instanceof Error ? e.message : e));
    }

    getStatus(phoneNumberId: string): Session | null {
        return this.sessions.get(phoneNumberId) || null;
    }

    getQRCode(phoneNumberId: string): string | null {
        return this.sessions.get(phoneNumberId)?.qrCode || null;
    }

    getPairingCode(phoneNumberId: string): string | null {
        return this.sessions.get(phoneNumberId)?.pairingCode || null;
    }

    // ============================================
    // Restrição de abordagem (ack 463 / reach-out time-lock)
    // ============================================
    // O WhatsApp devolve 463 no ack quando a conta está impedida de ABRIR conversa
    // nova (contatos que já falaram conosco continuam funcionando). O Baileys não
    // reenvia (cada reenvio conta como nova abordagem e alonga a punição); aqui a
    // punição vira bloqueio local para que o atendente veja o motivo na hora e
    // nenhum retry chegue ao servidor.

    private static readonly REACHOUT_FALLBACK_BASE_MS = 30 * 60 * 1000;
    private static readonly REACHOUT_FALLBACK_MAX_MS = 24 * 60 * 60 * 1000;
    private static readonly WARM_JIDS_MAX = 20_000;

    private markWarmJid(session: Session, user: string): void {
        const digits = user.replace(/\D/g, '');
        if (!digits) return;
        if (!session.warmJids) session.warmJids = new Set();
        if (session.warmJids.size >= SessionManager.WARM_JIDS_MAX) session.warmJids.clear();
        session.warmJids.add(digits);
    }

    private applyReachoutState(session: Session, state: ReachoutTimelock | undefined, hits: number, lastJid: string): ReachoutLock {
        const fallbackMs = Math.min(
            SessionManager.REACHOUT_FALLBACK_BASE_MS * 2 ** Math.max(0, hits - 1),
            SessionManager.REACHOUT_FALLBACK_MAX_MS
        );
        const serverEnds = state?.isActive && state.lockedUntil ? state.lockedUntil : 0;
        const lock: ReachoutLock = serverEnds > Date.now()
            ? { hits, lockedUntil: serverEnds, lastJid, lastAt: Date.now(), source: 'server', enforcementType: state?.enforcementType }
            : { hits, lockedUntil: Date.now() + fallbackMs, lastJid, lastAt: Date.now(), source: 'fallback', enforcementType: state?.enforcementType };
        session.reachoutLock = lock;
        return lock;
    }

    private async handleReachoutRejected(session: Session, remoteJid: string, msgId?: string): Promise<void> {
        const prev = session.reachoutLock;
        const hits = (prev && Date.now() < prev.lockedUntil ? prev.hits : 0) + 1;
        let state: ReachoutTimelock | undefined;
        try {
            state = await session.client?.fetchReachoutTimelock();
        } catch (e) {
            console.warn(`[REACHOUT_463] fetchAccountReachoutTimelock falhou para ${session.phoneNumberId}:`, (e as Error).message);
        }
        const lock = this.applyReachoutState(session, state, hits, remoteJid);
        const until = new Date(lock.lockedUntil).toISOString();
        console.error(`[REACHOUT_463] ${session.phoneNumberId} → ${remoteJid} msgId=${msgId ?? 'N/A'} hit=${hits} bloqueado até ${until} (${lock.source})`);
        await this.logMessageEvent({
            phoneNumberId: session.phoneNumberId,
            toJid: remoteJid,
            messageId: msgId,
            action: 'reachout_rejected',
            success: false,
            error: `463 reach-out time-locked (hit ${hits}, bloqueado até ${until}, ${lock.source})`,
            sessionStatus: session.status,
            baileysResult: {
                hits,
                lockedUntil: until,
                source: lock.source,
                isActive: state?.isActive ?? null,
                enforcementType: state?.enforcementType ?? null,
                timeEnforcementEnds: state?.lockedUntil ? new Date(state.lockedUntil).toISOString() : null,
            },
        });
    }

    private async probeReachoutTimelock(session: Session): Promise<void> {
        try {
            const state = await session.client?.fetchReachoutTimelock();
            const ends = state?.isActive && state.lockedUntil ? state.lockedUntil : 0;
            if (ends <= Date.now()) return;
            const lock = this.applyReachoutState(session, state, session.reachoutLock?.hits ?? 1, session.reachoutLock?.lastJid ?? '');
            const until = new Date(lock.lockedUntil).toISOString();
            console.error(`[REACHOUT_463] ${session.phoneNumberId} conectou já restringido — bloqueio até ${until}`);
            await this.logMessageEvent({
                phoneNumberId: session.phoneNumberId,
                toJid: lock.lastJid || 'account',
                action: 'reachout_active',
                success: false,
                error: `conta em reach-out time-lock ao conectar (até ${until})`,
                sessionStatus: session.status,
                baileysResult: { enforcementType: state?.enforcementType ?? null, timeEnforcementEnds: until },
            });
        } catch (e) {
            console.warn(`[REACHOUT_463] probe falhou para ${session.phoneNumberId}:`, (e as Error).message);
        }
    }

    private applyMessageCapping(phoneNumberId: string, capping: MessageCapping, source: 'event' | 'probe'): void {
        const session = this.sessions.get(phoneNumberId);
        if (!session) return;
        session.messageCapping = { ...capping, at: Date.now(), source };
        // A sonda roda a cada conexão: só vira linha de log quando há algo a dizer.
        if (source === 'probe' && capping.status === 'NONE') return;
        const capped = capping.status === 'CAPPED';
        const until = capping.cycleEnd ? new Date(capping.cycleEnd).toISOString() : null;
        console[capped ? 'error' : 'warn'](`[CAPPING] ${phoneNumberId} ${capping.status} ${capping.usedQuota ?? '?'}/${capping.totalQuota ?? '?'} ciclo até ${until ?? '?'} (${source})`);
        void this.debugLog(phoneNumberId, capped ? 'capping_capped' : 'message_capping', 'account', {
            status: capping.status,
            used_quota: capping.usedQuota ?? null,
            total_quota: capping.totalQuota ?? null,
            cycle_start: capping.cycleStart ? new Date(capping.cycleStart).toISOString() : null,
            cycle_end: until,
            ote_status: capping.oteStatus ?? null,
            mv_status: capping.mvStatus ?? null,
            source,
        });
    }

    /** Uma consulta ao conectar (como o 463): conta já capada nasce bloqueada. */
    private async probeMessageCapping(session: Session): Promise<void> {
        const client = session.client;
        if (!client?.capabilities.has('message_capping')) return;
        try {
            this.applyMessageCapping(session.phoneNumberId, await client.fetchMessageCapping(), 'probe');
        } catch (e) {
            console.warn(`[CAPPING] sonda falhou para ${session.phoneNumberId}:`, (e as Error).message);
        }
    }

    /**
     * Cota de conversas novas esgotada (CAPPED): o servidor recusaria a mensagem a um
     * contato frio e cada tentativa pesa contra a conta. Barra localmente até o fim
     * do ciclo. Grupos e contatos que já nos escreveram passam sempre.
     */
    private async checkMessageCapping(session: Session, to: string, action: string): Promise<string | null> {
        const capping = session.messageCapping;
        if (!capping || capping.status !== 'CAPPED') return null;
        if (capping.cycleEnd && Date.now() >= capping.cycleEnd) {
            console.log(`[CAPPING] ciclo de ${session.phoneNumberId} terminou — liberando contatos novos`);
            session.messageCapping = undefined;
            return null;
        }
        if (to.includes('@g.us')) return null;
        const digits = to.split('@')[0].replace(/\D/g, '');
        if (!digits || !(await this.isColdContact(session, digits))) return null;
        const quota = `${capping.usedQuota ?? '?'}/${capping.totalQuota ?? '?'}`;
        const untilLabel = capping.cycleEnd
            ? new Date(capping.cycleEnd).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
            : 'o próximo ciclo';
        void this.logMessageEvent({
            phoneNumberId: session.phoneNumberId,
            toJid: to,
            action: 'capping_blocked',
            success: false,
            error: `${action}: cota de conversas novas esgotada (${quota}, até ${capping.cycleEnd ? new Date(capping.cycleEnd).toISOString() : '?'})`,
            sessionStatus: session.status,
        });
        return `Envio bloqueado: este número esgotou a cota de conversas novas do WhatsApp (${quota}) até ${untilLabel}. `
            + 'Contatos que já escreveram para este número seguem liberados.';
    }

    /** Conversa 1:1 com pelo menos uma mensagem RECEBIDA = contato que já nos
     *  escreveu (tem tctoken conosco). Espelha a busca da edge pelo telefone. */
    private async hasInboundHistory(phoneNumberId: string, digits: string): Promise<boolean> {
        const variations = this.conversationPhoneVariations(digits);
        if (variations.length === 0) return false;
        const { data: convs, error } = await supabase
            .from('conversations')
            .select('id')
            .eq('phone_number_id', phoneNumberId)
            .eq('is_group', false)
            .in('contact_phone', variations)
            .limit(5);
        if (error) {
            console.error('[REACHOUT_463] Erro ao buscar conversa:', error.message);
            return false;
        }
        if (!convs?.length) return false;
        const { data: inbound, error: inboundError } = await supabase
            .from('messages')
            .select('id')
            .in('conversation_id', convs.map((c) => c.id as string))
            .eq('direction', 'inbound')
            .limit(1);
        if (inboundError) {
            console.error('[REACHOUT_463] Erro ao buscar inbound:', inboundError.message);
            return false;
        }
        return (inbound?.length ?? 0) > 0;
    }

    /**
     * Devolve a mensagem de recusa se o envio a `to` deve ser barrado pelo bloqueio
     * 463; null libera. Grupos e contatos que já nos escreveram passam sempre.
     * Em erro de banco falha FECHADO: o bloqueio existe porque enviar está
     * machucando a conta.
     */
    private async checkReachoutLock(session: Session, to: string, action: string): Promise<string | null> {
        const lock = session.reachoutLock;
        if (!lock) return null;
        if (Date.now() >= lock.lockedUntil) {
            console.log(`[REACHOUT_463] bloqueio de ${session.phoneNumberId} expirou — liberando envios`);
            session.reachoutLock = undefined;
            return null;
        }
        if (to.includes('@g.us')) return null;
        const digits = to.split('@')[0].replace(/\D/g, '');
        if (!digits) return null;
        if (!(await this.isColdContact(session, digits))) return null;
        const untilLabel = new Date(lock.lockedUntil).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        void this.logMessageEvent({
            phoneNumberId: session.phoneNumberId,
            toJid: to,
            action: 'reachout_blocked',
            success: false,
            error: `${action}: bloqueio local 463 (hit ${lock.hits}, até ${new Date(lock.lockedUntil).toISOString()})`,
            sessionStatus: session.status,
        });
        return `Envio bloqueado: o WhatsApp restringiu novas conversas deste número (erro 463) até ${untilLabel}. `
            + 'Contatos que já escreveram para este número seguem liberados. Insistir prolonga a restrição.';
    }

    /** Contato "frio" = nunca nos escreveu por esta linha. Positivo (quente) fica
     *  em warmJids para sempre; negativo fica 5 min no coldContactCache. */
    private async isColdContact(session: Session, digits: string): Promise<boolean> {
        if (session.warmJids?.has(digits)) return false;
        const key = `${session.phoneNumberId}:${digits}`;
        if (this.coldContactCache.get(key)) return true;
        if (await this.hasInboundHistory(session.phoneNumberId, digits)) {
            this.markWarmJid(session, digits);
            return false;
        }
        this.cacheSet(this.coldContactCache, key, true);
        return true;
    }

    /**
     * JID de saída de um telefone, com cache por linha. onWhatsApp() é um IQ ao
     * servidor: sem cache era uma consulta POR MENSAGEM, e checar existência de
     * números em série é o padrão de enumeração que o anti-abuso vigia.
     * Número inexistente também fica em cache (10 min) — reconsultar não muda nada.
     */
    private async resolveOutboundJid(session: Session, cleanNumber: string, tag: string): Promise<string> {
        const raw = `${cleanNumber}@s.whatsapp.net`;
        if (!cleanNumber || !session.client) return raw;
        const key = `${session.phoneNumberId}:${cleanNumber}`;
        const hit = this.outboundJidCache.get<string>(key);
        if (hit) return hit;
        try {
            const results = await this.clientOf(session).lookup([cleanNumber]);
            const result = results[0];
            if (result?.exists) {
                this.cacheSet(this.outboundJidCache, key, result.jid);
                return result.jid;
            }
            console.warn(`[${tag}] Number not found on WhatsApp, using raw JID:`, raw);
            this.cacheSet(this.outboundJidCache, key, raw, 600);
            return raw;
        } catch (e) {
            console.warn(`[${tag}] onWhatsApp check failed, using raw JID:`, raw, (e as Error).message);
            return raw;
        }
    }

    /**
     * Porteiro de envio por sessão: (1) teto de contatos novos por hora,
     * (2) espaçamento aleatório sequencial entre envios (opt-in por env, ver
     * SEND_SPACING_ENABLED). Devolve a recusa ou null depois de esperar a vez.
     * Grupos só passam pelo espaçamento.
     */
    private async acquireSendSlot(session: Session, to: string, action: string): Promise<string | null> {
        const isGroup = to.includes('@g.us');
        const digits = isGroup ? '' : to.split('@')[0].replace(/\D/g, '');

        if (digits && NEW_CONTACT_HOURLY_CAP > 0 && await this.isColdContact(session, digits)) {
            if (!session.newContactWindow) session.newContactWindow = new Map();
            const win = session.newContactWindow;
            const cutoff = Date.now() - 60 * 60 * 1000;
            for (const [k, t] of win) if (t < cutoff) win.delete(k);
            if (!win.has(digits) && win.size >= NEW_CONTACT_HOURLY_CAP) {
                const oldest = Math.min(...win.values());
                const freeAt = new Date(oldest + 60 * 60 * 1000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
                void this.logMessageEvent({
                    phoneNumberId: session.phoneNumberId,
                    toJid: to,
                    action: 'send_capped',
                    success: false,
                    error: `${action}: ${NEW_CONTACT_HOURLY_CAP} contatos novos/hora atingido`,
                    sessionStatus: session.status,
                });
                return `Limite de ${NEW_CONTACT_HOURLY_CAP} contatos novos por hora atingido neste número (proteção contra restrição do WhatsApp). `
                    + `Libera às ${freeAt}. Contatos que já escreveram para o número não contam.`;
            }
            win.set(digits, Date.now());
        }

        if (!SEND_SPACING_ENABLED) return null;

        const now = Date.now();
        const base = Math.max(now, session.nextSendAt ?? 0);
        const wait = base - now;
        if (wait > SEND_MAX_QUEUE_WAIT_MS) {
            void this.logMessageEvent({
                phoneNumberId: session.phoneNumberId,
                toJid: to,
                action: 'send_capped',
                success: false,
                error: `${action}: fila de envio com ${Math.round(wait / 1000)}s de espera`,
                sessionStatus: session.status,
            });
            return `Fila de envio deste número está cheia (${Math.round(wait / 1000)}s de espera). Tente novamente em instantes.`;
        }
        const gap = SEND_MIN_GAP_MS + Math.random() * (SEND_MAX_GAP_MS - SEND_MIN_GAP_MS);
        session.nextSendAt = base + gap;
        if (wait > 0) await sleep(wait);
        return null;
    }

    /** Recusa (string) ou null para um pedido EXPLÍCITO de connect(). */
    private checkPairingBudget(phoneNumberId: string, storedPaired: boolean, forceNew: boolean): string | null {
        const fatal = this.fatalCloseAt.get(phoneNumberId);
        if (fatal && Date.now() - fatal.at < CONNECT_COOLDOWN_AFTER_FATAL_MS) {
            const until = new Date(fatal.at + CONNECT_COOLDOWN_AFTER_FATAL_MS)
                .toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
            const minutesAgo = Math.round((Date.now() - fatal.at) / 60000);
            return `O WhatsApp desconectou este número há ${minutesAgo} min (código ${fatal.statusCode}). `
                + `Reconectar em sequência agrava a restrição — aguarde até ${until}.`;
        }
        // Só conta quando o pedido vai gerar pareamento novo: forceNew apaga as
        // creds, e store sem pareamento concluído nunca completou um pair-success
        // (ver hasPairedCreds no connection.update). O que é "pareado" é do provider.
        const willPair = forceNew || !storedPaired;
        if (!willPair) return null;

        const cutoff = Date.now() - 60 * 60 * 1000;
        const recent = (this.pairingRequests.get(phoneNumberId) ?? []).filter((t) => t >= cutoff);
        if (recent.length >= QR_HOURLY_CAP) {
            const freeAt = new Date(recent[0] + 60 * 60 * 1000)
                .toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
            this.pairingRequests.set(phoneNumberId, recent);
            return `Limite de ${QR_HOURLY_CAP} pareamentos por hora neste número. `
                + `Cada QR/código gerado conta como novo dispositivo para o WhatsApp — aguarde até ${freeAt}.`;
        }
        recent.push(Date.now());
        this.pairingRequests.set(phoneNumberId, recent);
        return null;
    }

    getProtectionLimits(): Record<string, number> {
        return {
            send_spacing_enabled: SEND_SPACING_ENABLED ? 1 : 0,
            send_min_gap_ms: SEND_MIN_GAP_MS,
            send_max_gap_ms: SEND_MAX_GAP_MS,
            send_max_queue_wait_ms: SEND_MAX_QUEUE_WAIT_MS,
            new_contact_hourly_cap: NEW_CONTACT_HOURLY_CAP,
            qr_hourly_cap: QR_HOURLY_CAP,
            connect_cooldown_after_fatal_ms: CONNECT_COOLDOWN_AFTER_FATAL_MS,
            restore_stagger_ms: RESTORE_STAGGER_MS,
            max_media_bytes: MAX_MEDIA_BYTES,
            media_stream_threshold_bytes: MEDIA_STREAM_THRESHOLD_BYTES,
            media_disk_reserve_bytes: MEDIA_DISK_RESERVE_BYTES,
            media_temp_reserved_bytes: mediaTemp.reservedBytes,
        };
    }

    getReachoutLocks(): Record<string, { hits: number; locked_until: string; last_jid: string; source: string; enforcement_type: string | null }> {
        const out: Record<string, { hits: number; locked_until: string; last_jid: string; source: string; enforcement_type: string | null }> = {};
        this.sessions.forEach((session, id) => {
            const lock = session.reachoutLock;
            if (!lock || Date.now() >= lock.lockedUntil) return;
            out[id] = {
                hits: lock.hits,
                locked_until: new Date(lock.lockedUntil).toISOString(),
                last_jid: lock.lastJid,
                source: lock.source,
                enforcement_type: lock.enforcementType ?? null,
            };
        });
        return out;
    }

    // ============================================
    // LIGAÇÃO DE VOZ (capability 'voice_call')
    // ============================================

    private callSession(phoneNumberId: string): { session: Session; client: WhatsAppClient } | { error: string; code: string } {
        const session = this.sessions.get(phoneNumberId);
        if (!session?.client) return { error: 'Session not found', code: 'not_found' };
        if (session.status !== 'connected') return { error: 'Session not connected', code: 'not_connected' };
        if (!session.client.capabilities.has('voice_call')) {
            return { error: 'Ligação de voz não disponível nesta linha (provider sem suporte ou imagem sem o plugin)', code: 'unsupported_by_provider' };
        }
        return { session, client: session.client };
    }

    /**
     * Liga para um contato. Passa pelas mesmas guardas do envio a contato frio
     * (463 e cota de chats novos): ligar para quem nunca falou conosco pesa igual.
     */
    /**
     * Grava a ligação na conversa quando ela termina (message_type 'call').
     *
     * Aqui e não no front: o registro tem que existir mesmo que ninguém estivesse
     * com o Echo aberto — que é justamente o caso da chamada perdida. O front
     * monta o texto a partir de `metadata.call`; `content` é o que a lista de
     * conversas mostra na prévia.
     *
     * Idempotente pelo wamid sintético `call:<callId>`: a unicidade composta
     * (whatsapp_message_id, conversation_id) absorve reentrega do outbox.
     *
     * PRÉ-REQUISITOS de deploy, nesta ordem: migração que põe 'call' no CHECK de
     * messages.message_type → allowlist da edge `whatsapp-webhook` → esta imagem.
     * Fora de ordem, o insert volta 23514 ou vira 'unsupported'.
     */
    private recordCallInConversation(phoneNumberId: string, call: CallUpdate): void {
        // Ligação de grupo não tem conversa 1:1 para receber o registro.
        if (call.peerJid.endsWith('@g.us')) return;
        // Sem telefone resolvido, criar conversa pelo LID produziria exatamente as
        // conversas órfãs que o resolve-lid-conversations.mjs existe para limpar.
        const jid = call.peerPn ?? call.peerJid;
        if (!jid.endsWith('@s.whatsapp.net')) return;
        const from = jid.split('@')[0].split(':')[0];
        if (!/^\d{8,15}$/.test(from)) return;

        const connected = !!call.connectedAt;
        const seconds = call.durationSecs ?? 0;
        const duration = seconds >= 60
            ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
            : `${seconds}s`;
        const content = connected
            ? (seconds > 0 ? `Chamada de voz · ${duration}` : 'Chamada de voz')
            : (call.direction === 'outgoing' ? 'Chamada não atendida' : 'Chamada perdida');

        void this.forwardToWebhook(phoneNumberId, {
            from,
            content,
            messageId: `call:${call.callId}`,
            timestamp: Math.floor((call.endedAt ?? Date.now()) / 1000),
            messageType: 'call',
            fromMe: call.direction === 'outgoing',
            metadata: {
                call: {
                    call_id: call.callId,
                    direction: call.direction,
                    connected,
                    duration_secs: call.durationSecs ?? null,
                    end_reason: call.endReason ?? null,
                },
            },
        }).catch((error) => console.error('[Call] falha ao gravar registro da ligação:', error));
    }

    async startCall(phoneNumberId: string, to: string, opts: { audioFile?: string } = {}): Promise<
        { success: true; callId: string; to: string } | { success: false; error: string; code: string }
    > {
        const ctx = this.callSession(phoneNumberId);
        if ('error' in ctx) return { success: false, ...ctx };
        const { session, client } = ctx;
        const clean = to.replace(/\D/g, '');
        const jid = to.includes('@') ? to : await this.resolveOutboundJid(session, clean, 'Call');
        if (jid.endsWith('@g.us')) return { success: false, error: 'Ligação em grupo não suportada', code: 'bad_request' };
        const block = (await this.checkReachoutLock(session, jid, 'call')) ?? (await this.checkMessageCapping(session, jid, 'call'));
        if (block) return { success: false, error: block, code: 'blocked' };
        try {
            const { callId } = await client.startCall(jid, { audioFile: opts.audioFile });
            void this.debugLog(phoneNumberId, 'call_started', jid, { call_id: callId, audio_file: opts.audioFile ? path.basename(opts.audioFile) : null });
            return { success: true, callId, to: jid };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const code = error instanceof WhatsAppClientError ? error.code : 'call_failed';
            void this.debugLog(phoneNumberId, 'call_start_failed', jid, { error: message, code });
            return { success: false, error: message, code };
        }
    }

    async endCall(phoneNumberId: string, callId: string, reason?: 'user_ended' | 'declined' | 'busy'): Promise<{ success: boolean; error?: string; code?: string }> {
        const ctx = this.callSession(phoneNumberId);
        if ('error' in ctx) return { success: false, ...ctx };
        await ctx.client.endCall(callId, reason);
        return { success: true };
    }

    async acceptCall(phoneNumberId: string, callId: string): Promise<{ success: boolean; error?: string; code?: string }> {
        const ctx = this.callSession(phoneNumberId);
        if ('error' in ctx) return { success: false, ...ctx };
        await ctx.client.acceptCall(callId);
        return { success: true };
    }

    /** Lança se a linha não tem voz: quem chama (WS) fecha a conexão com o motivo. */
    setCallLiveAudio(phoneNumberId: string, callId: string, enabled: boolean): void {
        const ctx = this.callSession(phoneNumberId);
        if ('error' in ctx) throw new WhatsAppClientError(ctx.error, ctx.code, ctx.code === 'unsupported_by_provider' ? 501 : 409);
        ctx.client.setCallLiveAudio(callId, enabled);
    }

    feedCallAudio(phoneNumberId: string, callId: string, pcm: Float32Array): number {
        const client = this.sessions.get(phoneNumberId)?.client;
        return client?.capabilities.has('voice_call') ? client.feedCallAudio(callId, pcm) : 0;
    }

    setCallMuted(phoneNumberId: string, callId: string, muted: boolean): void {
        const client = this.sessions.get(phoneNumberId)?.client;
        if (client?.capabilities.has('voice_call')) client.setCallMuted(callId, muted);
    }

    getCall(phoneNumberId: string, callId: string): CallUpdate | null {
        const client = this.sessions.get(phoneNumberId)?.client;
        return client?.capabilities.has('voice_call') ? client.getCall(callId) : null;
    }

    listCalls(phoneNumberId: string): CallUpdate[] {
        const client = this.sessions.get(phoneNumberId)?.client;
        return client?.capabilities.has('voice_call') ? client.listCalls() : [];
    }

    /** Linha tem voz agora (provider + imagem). Para o front decidir se mostra o botão. */
    hasVoiceCall(phoneNumberId: string): boolean {
        return this.sessions.get(phoneNumberId)?.client?.capabilities.has('voice_call') === true;
    }

    getMessageCappings(): Record<string, { status: string; used_quota: number | null; total_quota: number | null; cycle_end: string | null; at: string; source: string }> {
        const out: Record<string, { status: string; used_quota: number | null; total_quota: number | null; cycle_end: string | null; at: string; source: string }> = {};
        this.sessions.forEach((session, id) => {
            const c = session.messageCapping;
            if (!c) return;
            out[id] = {
                status: c.status,
                used_quota: c.usedQuota ?? null,
                total_quota: c.totalQuota ?? null,
                cycle_end: c.cycleEnd ? new Date(c.cycleEnd).toISOString() : null,
                at: new Date(c.at).toISOString(),
                source: c.source,
            };
        });
        return out;
    }

    getAllSessionsStatus(): Record<string, string> {
        const statuses: Record<string, string> = {};
        this.sessions.forEach((session, id) => {
            statuses[id] = session.status;
        });
        return statuses;
    }

    addListener(
        phoneNumberId: string,
        callback: (event: string, data: unknown) => void
    ): void {
        const session = this.sessions.get(phoneNumberId);
        if (session) {
            session.listeners.add(callback);
            console.log(`[SessionManager] Added listener to existing session, total: ${session.listeners.size}`);
        } else {
            // Session doesn't exist yet, store in pending
            if (!this.pendingListeners.has(phoneNumberId)) {
                this.pendingListeners.set(phoneNumberId, new Set());
            }
            this.pendingListeners.get(phoneNumberId)!.add(callback);
            console.log(`[SessionManager] Added pending listener for ${phoneNumberId}, total pending: ${this.pendingListeners.get(phoneNumberId)!.size}`);
        }
    }

    removeListener(
        phoneNumberId: string,
        callback: (event: string, data: unknown) => void
    ): void {
        const session = this.sessions.get(phoneNumberId);
        if (session) {
            session.listeners.delete(callback);
        }
        // Also remove from pending if exists
        this.pendingListeners.get(phoneNumberId)?.delete(callback);
    }

    private notifyListeners(
        phoneNumberId: string,
        event: string,
        data: unknown
    ): void {
        const session = this.sessions.get(phoneNumberId);
        if (session) {
            session.listeners.forEach((listener) => listener(event, data));
        }
    }

    /**
     * Refetch on-demand de histórico (fetchMessageHistory → PDO HISTORY_SYNC_ON_DEMAND).
     *
     * O protocolo puxa mensagens ANTERIORES à âncora. Para preencher o gap de uma
     * queda, a âncora tem de ser a primeira mensagem DEPOIS do gap — sem nenhuma
     * mensagem posterior, esse caminho não tem por onde entrar, e o fallback é o
     * import de CSV.
     *
     * A resposta é assíncrona (chega no messaging-history.set) e o protocolo não
     * sinaliza fim de chunk para on-demand. Então esperamos uma janela e devolvemos o
     * que chegou nela: `received` é o que foi de fato encaminhado, não uma promessa.
     * Depende do aparelho principal estar acessível — ele pode não responder, e nesse
     * caso o honesto é devolver received=0 em vez de um "ok" otimista.
     */
    async syncMessageHistory(
        phoneNumberId: string,
        opts: {
            chatJid: string;
            anchorMessageId: string;
            anchorTimestampMs: number;
            anchorFromMe?: boolean;
            count?: number;
            /** Descarta o que for anterior a isso (ex.: início do gap). 0 = aceita tudo. */
            sinceMs?: number;
            waitMs?: number;
        }
    ): Promise<{ requested: number; received: number; requestId: string | null }> {
        const session = this.sessions.get(phoneNumberId);
        if (!session?.client || session.status !== 'connected') {
            throw new Error('SESSION_NOT_CONNECTED');
        }
        // Lib sem caminho que devolva as mensagens (zapo com messages:'none' descarta o
        // chunk): pedir mesmo assim só gera tráfego para o aparelho e volta received=0.
        if (!session.client.capabilities.has('history_fetch')) {
            throw new Error('HISTORY_UNSUPPORTED');
        }
        if (session.onDemandSync) {
            throw new Error('SYNC_ALREADY_RUNNING');
        }

        const count = Math.min(Math.max(Math.trunc(opts.count ?? 50), 1), 200);
        const waitMs = Math.min(Math.max(Math.trunc(opts.waitMs ?? 20_000), 1_000), 60_000);

        session.onDemandSync = { cutoffMs: Math.max(0, opts.sinceMs ?? 0), received: 0 };
        try {
            const requestId = await this.clientOf(session).fetchHistory(count, {
                key: { chatJid: opts.chatJid, id: opts.anchorMessageId, fromMe: opts.anchorFromMe === true },
                timestamp: opts.anchorTimestampMs,
            });
            console.log(`[OnDemandSync] Requested ${count} msgs before ${opts.anchorMessageId} in ${opts.chatJid} (requestId=${requestId})`);

            await new Promise<void>(resolve => setTimeout(resolve, waitMs));

            const received = session.onDemandSync?.received ?? 0;
            console.log(`[OnDemandSync] Completed: requested=${count}, received=${received}`);
            return { requested: count, received, requestId: requestId ?? null };
        } finally {
            // Sempre liberado: um erro no meio não pode deixar a sessão travada para
            // pedidos futuros (a guarda SYNC_ALREADY_RUNNING acima depende disso).
            session.onDemandSync = undefined;
        }
    }

    /**
     * Dispara autoRecoverConversations manualmente (fora da janela de reconexão),
     * pra rodar a varredura sob demanda: reconexão já passou antes do deploy desta
     * feature, ou queda ficou abaixo do limiar automático mas o operador quer
     * forçar mesmo assim. `sinceMs` sobrescreve o gap; sem ele cai no timestamp de
     * desconexão conhecido (memória ou DB).
     */
    async runManualAutoRecovery(
        phoneNumberId: string,
        sinceMs?: number,
    ): Promise<AutoRecoverySummary> {
        const session = this.sessions.get(phoneNumberId);
        if (!session?.client || session.status !== 'connected') {
            throw new Error('SESSION_NOT_CONNECTED');
        }
        if (session.autoRecoveryRunning) {
            throw new Error('AUTO_RECOVERY_ALREADY_RUNNING');
        }

        const gapStartMs = sinceMs
            ?? session.lastDisconnectedAt
            ?? await this.loadDisconnectTimestampFromDb(phoneNumberId);
        if (!gapStartMs) {
            throw new Error('NO_DISCONNECT_WINDOW');
        }

        return this.autoRecoverConversations(phoneNumberId, gapStartMs, 0);
    }

    /**
     * Varredura automática pós-reconexão: chama syncMessageHistory() uma vez por
     * conversa ativa (grupo ou 1:1) para cobrir o que a fila offline nativa não
     * trouxe numa queda longa. Sequencial de propósito — syncMessageHistory tem
     * uma guarda por sessão (SYNC_ALREADY_RUNNING), não dá pra paralelizar.
     */
    private async autoRecoverConversations(
        phoneNumberId: string,
        gapStartMs: number,
        passiveRecoveredCount: number,
    ): Promise<AutoRecoverySummary> {
        const session = this.sessions.get(phoneNumberId);
        const summary: AutoRecoverySummary = {
            scanned: 0,
            recovered: 0,
            skippedNoAnchor: 0,
            skippedNoJid: 0,
            failed: 0,
        };
        if (!session) return summary;
        if (session.client && !session.client.capabilities.has('history_fetch')) {
            console.log(`[AutoRecovery] ${phoneNumberId}: lib ${session.client.libraryId} sem history_fetch — varredura pulada`);
            return summary;
        }
        session.autoRecoveryRunning = true;

        try {
            const gapStartIso = new Date(gapStartMs).toISOString();
            const activitySinceIso = new Date(Date.now() - AUTO_RECOVERY_ACTIVITY_WINDOW_MS).toISOString();

            const { data: conversations, error: convError } = await supabase
                .from('conversations')
                .select('id, contact_phone, is_group, group_jid, last_message_at', { count: 'exact' })
                .eq('phone_number_id', phoneNumberId)
                .gte('last_message_at', activitySinceIso)
                .order('last_message_at', { ascending: false })
                .limit(AUTO_RECOVERY_MAX_CONVERSATIONS);

            if (convError) {
                console.error(`[AutoRecovery] Erro ao listar conversas de ${phoneNumberId}:`, convError);
                return summary;
            }
            if (!conversations || conversations.length === 0) {
                console.log(`[AutoRecovery] Nenhuma conversa ativa para ${phoneNumberId}, nada a varrer.`);
                return summary;
            }
            if (conversations.length === AUTO_RECOVERY_MAX_CONVERSATIONS) {
                console.log(`[AutoRecovery] Limite de ${AUTO_RECOVERY_MAX_CONVERSATIONS} conversas atingido para ${phoneNumberId} — pode haver conversas ativas fora da varredura.`);
            }

            console.log(`[AutoRecovery] Queda longa em ${phoneNumberId} (gap desde ${gapStartIso}); varrendo ${conversations.length} conversa(s).`);

            for (const conversation of conversations) {
                // A sessão pode ter caído de novo no meio da varredura.
                if (session.status !== 'connected') {
                    console.log(`[AutoRecovery] Sessão ${phoneNumberId} não está mais conectada, abortando varredura.`);
                    break;
                }

                const chatJid = conversation.is_group
                    ? conversation.group_jid
                    : `${(conversation.contact_phone ?? '').replace(/\D/g, '')}@s.whatsapp.net`;

                if (!chatJid) {
                    summary.skippedNoJid++;
                    continue;
                }

                const { data: anchor, error: anchorError } = await supabase
                    .from('messages')
                    .select('whatsapp_message_id, created_at, direction')
                    .eq('conversation_id', conversation.id)
                    .gt('created_at', gapStartIso)
                    .not('whatsapp_message_id', 'is', null)
                    .order('created_at', { ascending: true })
                    .limit(1)
                    .maybeSingle();

                if (anchorError) {
                    console.error(`[AutoRecovery] Erro ao buscar âncora da conversa ${conversation.id}:`, anchorError);
                    summary.failed++;
                    continue;
                }
                if (!anchor?.whatsapp_message_id) {
                    summary.skippedNoAnchor++;
                    continue;
                }

                summary.scanned++;
                try {
                    const result = await this.syncMessageHistory(phoneNumberId, {
                        chatJid,
                        anchorMessageId: anchor.whatsapp_message_id,
                        anchorTimestampMs: new Date(anchor.created_at).getTime(),
                        anchorFromMe: anchor.direction === 'outbound',
                        sinceMs: gapStartMs,
                        count: 50,
                        waitMs: 8_000,
                    });
                    summary.recovered += result.received;
                } catch (error) {
                    const code = error instanceof Error ? error.message : 'UNKNOWN';
                    if (code === 'SESSION_NOT_CONNECTED') {
                        console.log(`[AutoRecovery] Sessão ${phoneNumberId} caiu durante a varredura, abortando.`);
                        break;
                    }
                    console.error(`[AutoRecovery] Falha ao recuperar conversa ${conversation.id} (${chatJid}):`, error);
                    summary.failed++;
                }
            }

            console.log(`[AutoRecovery] Concluído para ${phoneNumberId}: scanned=${summary.scanned}, recovered=${summary.recovered}, skippedNoAnchor=${summary.skippedNoAnchor}, skippedNoJid=${summary.skippedNoJid}, failed=${summary.failed}`);

            void this.recordOfflineRecovery(phoneNumberId, passiveRecoveredCount + summary.recovered);
            return summary;
        } finally {
            session.autoRecoveryRunning = false;
        }
    }

    /**
     * Rótulo, tipo e metadata de uma mensagem recuperada do history sync.
     *
     * Deliberadamente separado do extrator do `messages.upsert`: aquele está
     * entrelaçado com download de mídia, cache de sticker e decriptação de enquete,
     * e é o caminho de TODA mensagem ao vivo. Aqui só interessa descrever o
     * conteúdo — quem baixa a mídia é o laço de forward. Os rótulos e o
     * `metadata` seguem o mesmo vocabulário do caminho ao vivo, senão a mesma
     * mensagem apareceria diferente dependendo de como chegou.
     *
     * `messageType` fica restrito aos valores que o CHECK de messages.message_type
     * já aceita — tipo novo aqui viraria 23514 e a mensagem se perderia calada.
     */

    /**
     * Nome do grupo, do cache ou do socket. Extraído porque os dois caminhos de
     * entrada precisam dele: o `messages.upsert` (mensagem ao vivo) e o
     * `messaging-history.set` (recuperação), e sem ele o webhook cria a conversa
     * batizada com os dígitos do JID.
     */
    /**
     * Conteúdo normalizado → campos do webhook (texto/rótulo, tipo, mídia, contato,
     * metadados). Serve o caminho ao vivo e o histórico; a diferença é só a enquete
     * (no histórico vira texto, ao vivo vira 'poll' com segredo).
     */
    private describeContent(msg: InboundMessage, mode: 'live' | 'history'): {
        content: string;
        messageType: string;
        mediaMimeType: string | null;
        mediaFilename: string | null;
        contactMetadata: ContactMetadata | null;
        metadata: Record<string, unknown> | null;
        media: MediaRef | null;
        stickerShaHex: string | null;
        linkPreview: { url?: string; title?: string; description?: string; thumbnail?: Buffer } | null;
        skip?: 'album' | 'deliberate' | 'protocol';
    } {
        const base = {
            mediaMimeType: null as string | null,
            mediaFilename: null as string | null,
            contactMetadata: null as ContactMetadata | null,
            metadata: null as Record<string, unknown> | null,
            media: null as MediaRef | null,
            stickerShaHex: null as string | null,
            linkPreview: null as { url?: string; title?: string; description?: string; thumbnail?: Buffer } | null,
        };
        const c = msg.content;
        switch (c.type) {
            case 'text':
                return { ...base, content: c.text, messageType: 'text', linkPreview: c.linkPreview ?? null };
            case 'media': {
                const m = c.media;
                const meta: Record<string, unknown> = {};
                if (m.isGif) meta.gif = true;
                // Largura/altura do proto: o Echo grava em metadata.media e o chat
                // reserva a caixa antes do download (sem isso a edge lê o cabeçalho
                // do arquivo por Range, mais lento).
                const dims = mediaDimsMeta(m);
                if (dims) meta.media = dims;
                switch (m.kind) {
                    case 'image':
                        return { ...base, content: m.caption || '[Imagem]', messageType: 'image', mediaMimeType: m.mimeType || 'image/jpeg', media: m, metadata: Object.keys(meta).length ? meta : null };
                    case 'video':
                        if (m.isVideoNote) meta.ptv = true;
                        return { ...base, content: m.caption || '[Vídeo]', messageType: 'video', mediaMimeType: m.mimeType || 'video/mp4', media: m, metadata: Object.keys(meta).length ? meta : null };
                    case 'audio':
                        if (m.isVoiceNote) meta.ptt = true;
                        return {
                            ...base,
                            content: m.isVoiceNote ? '[Áudio]' : '[Arquivo de Áudio]',
                            messageType: 'audio',
                            mediaMimeType: m.mimeType || (mode === 'live' ? 'audio/ogg; codecs=opus' : 'audio/ogg'),
                            media: m,
                            metadata: Object.keys(meta).length ? meta : null,
                        };
                    case 'document': {
                        const fileName = m.fileName || 'document';
                        return { ...base, content: m.caption || `[Documento: ${fileName}]`, messageType: 'document', mediaMimeType: m.mimeType || 'application/octet-stream', mediaFilename: fileName, media: m };
                    }
                    case 'sticker':
                        return { ...base, content: '[Sticker]', messageType: 'sticker', mediaMimeType: m.mimeType || 'image/webp', media: m, stickerShaHex: m.sha256 ?? null };
                }
                break;
            }
            case 'contacts': {
                const shared = c.contacts.map((k) => parseSharedContact(k.displayName, k.vcard));
                return { ...base, content: '[Contato]', messageType: 'contact', contactMetadata: shared.length > 0 ? { ...shared[0], contacts: shared } : null };
            }
            case 'location': {
                const { latitude: lat, longitude: lng } = c.location;
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) break;
                if (c.location.isLive) {
                    return { ...base, content: '[Localização em tempo real]', messageType: 'location', metadata: { location: { lat, lng, live: true, degraded_live: true } } };
                }
                return { ...base, content: `[Localização: ${lat}, ${lng}]`, messageType: 'location', metadata: { location: { lat, lng, name: c.location.name ?? null, address: c.location.address ?? null } } };
            }
            case 'poll_create':
                if (mode === 'history') {
                    return { ...base, content: `[Enquete] ${c.poll.name || ''}`.trim(), messageType: 'text' };
                }
                return {
                    ...base,
                    content: c.poll.name,
                    messageType: 'poll',
                    metadata: {
                        poll: {
                            question: c.poll.name,
                            options: c.poll.options.filter((o) => !!o),
                            selectable_count: Number(c.poll.selectableCount || 1),
                            message_secret: msg.messageSecret ? msg.messageSecret.toString('base64') : null,
                            creator_jid: msg.key.fromMe ? null : (msg.key.participantJid || msg.key.chatJid || null),
                            chat_jid: msg.key.chatJid || null,
                            votes: {},
                        },
                    },
                };
            case 'view_once_placeholder': {
                // Só o envelope chegou: rótulo neutro com o tipo, sem mídia.
                const kind = c.mediaKind;
                if (kind === 'video') return { ...base, content: '[Vídeo]', messageType: 'video' };
                if (kind === 'audio') return { ...base, content: '[Áudio]', messageType: 'audio' };
                if (kind === 'document') return { ...base, content: '[Documento]', messageType: 'document' };
                if (kind === 'sticker') return { ...base, content: '[Sticker]', messageType: 'sticker' };
                return { ...base, content: kind === 'image' ? '[Imagem]' : '[Visualização única]', messageType: 'image' };
            }
            case 'group_invite':
                return { ...base, content: c.invite.caption || `[Convite para o grupo ${c.invite.groupName || ''}]`.trim(), messageType: 'text', metadata: { group_invite: { group_jid: c.invite.groupJid, code: c.invite.inviteCode, expiration: c.invite.inviteExpiration ?? null, name: c.invite.groupName ?? null } } };
            case 'unsupported':
                if (c.skip) return { ...base, content: '', messageType: 'text', skip: c.skip };
                return { ...base, content: c.description ?? '[Mensagem não suportada]', messageType: c.messageType ?? 'unsupported', metadata: c.metadata ?? null };
            case 'undecryptable':
                return { ...base, content: '', messageType: 'text' };
            default:
                break;
        }
        return { ...base, content: `[${c.type}]`, messageType: 'text' };
    }

    private async resolveGroupSubject(
        client: WhatsAppClient | null | undefined,
        remoteJid: string
    ): Promise<string | undefined> {
        const cachedMeta = this.groupMetadataCache.get<{ subject: string; participants: string[] }>(remoteJid);
        if (cachedMeta) return cachedMeta.subject;

        try {
            const groupMeta = client ? await client.getGroup(remoteJid) : undefined;
            if (groupMeta) {
                this.cacheSet(this.groupMetadataCache, remoteJid, {
                    subject: groupMeta.subject,
                    participants: groupMeta.participants.map(p => p.jid)
                });
                console.log(`[SessionManager] Cached group metadata for ${remoteJid}: ${groupMeta.subject}`);
                return groupMeta.subject;
            }
            return undefined;
        } catch (e) {
            console.error('[SessionManager] Error fetching group metadata:', e);
            return remoteJid.replace('@g.us', ''); // Fallback to JID
        }
    }

    // Persist disconnect timestamp to file (survives service restart)
    private saveDisconnectTimestamp(phoneNumberId: string, timestamp: number): void {
        const sessionPath = path.join(this.sessionsDir, phoneNumberId);
        const timestampFile = path.join(sessionPath, 'disconnect_timestamp.txt');
        try {
            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
            }
            fs.writeFileSync(timestampFile, timestamp.toString());
            console.log(`[SessionManager] Saved disconnect timestamp to file: ${new Date(timestamp).toISOString()}`);
        } catch (e) {
            console.error('[SessionManager] Error saving disconnect timestamp:', e);
        }

        // Espelho em banco (fire-and-forget: o handler de 'close' não pode esperar
        // rede). O arquivo continua sendo a fonte rápida; o banco é o que sobrevive a
        // perda de volume e ao rmSync do ramo loggedOut.
        // supabase-js não rejeita em erro HTTP, mas uma falha de rede crua não
        // pode virar unhandledRejection — o espelho é best-effort.
        void (async () => {
            const { error } = await supabase
                .from('phone_number_sessions')
                .upsert({
                    phone_number_id: phoneNumberId,
                    last_disconnected_at: new Date(timestamp).toISOString(),
                }, { onConflict: 'phone_number_id' });
            if (error) console.error('[SessionManager] Error mirroring disconnect timestamp to DB:', error);
        })().catch((err: unknown) => console.error('[SessionManager] Disconnect mirror rejected:', err));
    }

    /** Cutoff do gap quando o arquivo local não existe mais. */
    private async loadDisconnectTimestampFromDb(phoneNumberId: string): Promise<number | undefined> {
        const { data, error } = await supabase
            .from('phone_number_sessions')
            .select('last_disconnected_at')
            .eq('phone_number_id', phoneNumberId)
            .maybeSingle();

        if (error) {
            console.error('[SessionManager] Error loading disconnect timestamp from DB:', error);
            return undefined;
        }
        if (!data?.last_disconnected_at) return undefined;

        const ms = new Date(data.last_disconnected_at).getTime();
        if (Number.isNaN(ms)) return undefined;
        console.log(`[SessionManager] Loaded disconnect timestamp from DB: ${data.last_disconnected_at}`);
        return ms;
    }

    /** Resultado da drenagem da fila offline, para o painel poder mostrar. */
    private async recordOfflineRecovery(phoneNumberId: string, count: number): Promise<void> {
        const { error } = await supabase
            .from('phone_number_sessions')
            .upsert({
                phone_number_id: phoneNumberId,
                last_offline_recovery_at: new Date().toISOString(),
                last_offline_recovered_count: count,
            }, { onConflict: 'phone_number_id' });

        if (error) console.error('[SessionManager] Error recording offline recovery:', error);
    }

    // Load disconnect timestamp from file
    private loadDisconnectTimestamp(phoneNumberId: string): number | undefined {
        const timestampFile = path.join(this.sessionsDir, phoneNumberId, 'disconnect_timestamp.txt');
        try {
            if (fs.existsSync(timestampFile)) {
                const timestamp = parseInt(fs.readFileSync(timestampFile, 'utf-8').trim(), 10);
                if (!isNaN(timestamp)) {
                    console.log(`[SessionManager] Loaded disconnect timestamp from file: ${new Date(timestamp).toISOString()}`);
                    return timestamp;
                }
            }
        } catch (e) {
            console.error('[SessionManager] Error loading disconnect timestamp:', e);
        }
        return undefined;
    }

    // ============================================
    // DISCONNECT ALERT MANAGEMENT
    // ============================================

    /**
     * Start a timer to send disconnect alert after threshold is reached
     */
    /**
     * Presença global da sessão, decidida por phone_numbers.keep_device_notifications.
     *
     * O WhatsApp suprime as notificações do aparelho sempre que um dispositivo
     * companheiro se apresenta online — e, em troca, só manda presença do contato
     * (online/visto por último/chatstate) para quem está online. Não há como ter
     * os dois, então quem escolhe é o operador, por número.
     *
     * Fail-safe para 'unavailable': se a consulta falhar, preservar as notificações
     * do celular é menos destrutivo do que silenciá-las sem o usuário ter pedido.
     */
    private async resolvePresenceState(phoneNumberId: string): Promise<'available' | 'unavailable'> {
        try {
            const { data, error } = await supabase
                .from('phone_numbers')
                .select('keep_device_notifications')
                .eq('id', phoneNumberId)
                .single();

            if (error) {
                console.warn(`[Presence] Could not read keep_device_notifications for ${phoneNumberId}, defaulting to unavailable:`, error.message);
                return 'unavailable';
            }

            return data?.keep_device_notifications === false ? 'available' : 'unavailable';
        } catch (e) {
            console.warn(`[Presence] keep_device_notifications lookup threw for ${phoneNumberId}, defaulting to unavailable:`, (e as Error).message);
            return 'unavailable';
        }
    }

    /**
     * Aplica o toggle de presença numa sessão viva, sem reconectar. Chamado pela
     * rota /session/presence-mode logo depois do update no banco.
     */
    async applyPresenceMode(
        phoneNumberId: string,
        keepDeviceNotifications: boolean
    ): Promise<{ success: boolean; applied: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session) {
            // Sem sessão em memória não há o que reafirmar: o próximo connect lê
            // o banco e já nasce no estado certo.
            return { success: true, applied: false };
        }

        session.keepDeviceNotifications = keepDeviceNotifications;

        if (session.status !== 'connected' || !session.client) {
            return { success: true, applied: false };
        }

        try {
            await this.clientOf(session).setGlobalPresence(keepDeviceNotifications ? 'unavailable' : 'available');
            console.log(`[Presence] ${phoneNumberId} agora é ${keepDeviceNotifications ? 'unavailable' : 'available'}`);
            return { success: true, applied: true };
        } catch (e) {
            const error = (e as Error).message;
            console.warn(`[Presence] applyPresenceMode failed for ${phoneNumberId}:`, error);
            return { success: false, applied: false, error };
        }
    }

    private async startDisconnectAlertTimer(phoneNumberId: string): Promise<void> {
        // Clear any existing timer
        this.clearDisconnectAlertTimer(phoneNumberId);

        try {
            // Fetch alert config from DB
            const { data: phoneConfig } = await supabase
                .from('phone_numbers')
                .select('disconnect_alert_enabled, disconnect_alert_threshold_minutes, disconnect_alert_emails')
                .eq('id', phoneNumberId)
                .single();

            if (!phoneConfig?.disconnect_alert_enabled) {
                console.log(`[SessionManager] Disconnect alerts not enabled for ${phoneNumberId}`);
                return;
            }

            if (!phoneConfig.disconnect_alert_emails || phoneConfig.disconnect_alert_emails.length === 0) {
                console.log(`[SessionManager] No alert emails configured for ${phoneNumberId}`);
                return;
            }

            const thresholdMinutes = phoneConfig.disconnect_alert_threshold_minutes || 1;
            const delayMs = thresholdMinutes * 60 * 1000;

            console.log(`[SessionManager] Starting disconnect alert timer for ${phoneNumberId} (${thresholdMinutes} min)`);

            const timer = setTimeout(() => {
                this.triggerDisconnectAlert(phoneNumberId);
            }, delayMs);

            this.disconnectAlertTimers.set(phoneNumberId, timer);
        } catch (e) {
            console.error('[SessionManager] Error starting disconnect alert timer:', e);
        }
    }

    /**
     * Clear disconnect alert timer (called when session reconnects)
     */
    private clearDisconnectAlertTimer(phoneNumberId: string): void {
        const existingTimer = this.disconnectAlertTimers.get(phoneNumberId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.disconnectAlertTimers.delete(phoneNumberId);
            console.log(`[SessionManager] Cleared disconnect alert timer for ${phoneNumberId}`);
        }
    }

    /**
     * Trigger disconnect alert by calling the Edge Function
     */
    private async triggerDisconnectAlert(phoneNumberId: string): Promise<void> {
        // Check if still disconnected
        const session = this.sessions.get(phoneNumberId);
        if (session && session.status === 'connected') {
            console.log(`[SessionManager] Phone ${phoneNumberId} reconnected, skipping alert`);
            return;
        }

        const supabaseUrl = process.env.SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_KEY;

        if (!supabaseUrl || !serviceKey) {
            console.error('[SessionManager] Missing Supabase credentials for alert');
            return;
        }

        try {
            console.log(`[SessionManager] Triggering disconnect alert for ${phoneNumberId}`);

            const alertController = new AbortController();
            const alertTimer = setTimeout(() => alertController.abort(), 15_000);
            let response: Response;
            try {
                response = await fetch(`${supabaseUrl}/functions/v1/send-disconnect-alert`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': serviceKey,
                        'Authorization': `Bearer ${serviceKey}`,
                    },
                    body: JSON.stringify({
                        phone_number_id: phoneNumberId,
                        disconnected_at: new Date().toISOString(),
                    }),
                    signal: alertController.signal,
                });
            } finally {
                clearTimeout(alertTimer);
            }

            const result = await response.json();
            console.log(`[SessionManager] Disconnect alert result:`, result);
        } catch (e) {
            console.error('[SessionManager] Error calling disconnect alert:', e);
        }
    }

    private async updateSessionInDb(
        phoneNumberId: string,
        status: string,
        qrCode: string | null
    ): Promise<void> {
        console.log(`[SessionManager] Updating DB: phoneNumberId=${phoneNumberId}, status=${status}`);
        const { error, data } = await supabase
            .from('phone_number_sessions')
            .upsert({
                phone_number_id: phoneNumberId,
                connection_status: status,
                qr_code: qrCode,
                // Omitida (não null) fora do 'connected': mandar null aqui APAGAVA o
                // registro de quando a sessão esteve viva a cada queda, e com isso a
                // janela de desconexão deixava de existir em banco.
                ...(status === 'connected' ? { last_connected_at: new Date().toISOString() } : {}),
            }, { onConflict: 'phone_number_id' })
            .select();

        if (error) {
            // FK violation: o phone_number foi deletado (o CASCADE já removeu a linha
            // de sessão no DB), mas a sessão local sobreviveu. Sem isso ela vira
            // fantasma regenerando QR e violando a FK a cada ciclo.
            if (error.code === '23503') {
                console.error(`[SessionManager] Orphan session ${phoneNumberId} (phone_number deleted), destroying local session`);
                await this.destroyLocalSession(phoneNumberId);
                return;
            }
            console.error('[SessionManager] Error updating session in DB:', error);
        } else {
            console.log('[SessionManager] DB update successful:', data);
        }
    }

    // Normaliza JID do WhatsApp: remove device suffix (:NN) e sufixo @s.whatsapp.net.
    // Necessário para comparar com phone_number armazenado e para casar com o
    // UNIQUE INDEX parcial que assume a forma limpa "5511999998888".
    private normalizeJid(raw: string): string {
        return (raw || '').split(':')[0].split('@')[0].trim();
    }

    private async updatePhoneNumber(
        phoneNumberId: string,
        phoneNumber: string
    ): Promise<PhoneUpdateResult> {
        const normalized = this.normalizeJid(phoneNumber);

        // Lookup pré-UPDATE para UX (mensagem rápida + decide blocked vs merge).
        // Fonte de verdade da atomicidade é o UNIQUE INDEX parcial no DB.
        const { data: existing } = await supabase
            .from('phone_numbers')
            .select('id, display_name, phone_number_sessions(connection_status)')
            .eq('phone_number', normalized)
            .eq('is_active', true)
            .neq('id', phoneNumberId)
            .maybeSingle();

        if (existing) {
            const sessions = (existing as { phone_number_sessions?: Array<{ connection_status?: string }> }).phone_number_sessions;
            const isActive = this.sessions.has(existing.id)
                || sessions?.[0]?.connection_status === 'connected';
            return {
                ok: false,
                reason: isActive ? 'blocked' : 'merge',
                existingPhoneNumberId: existing.id,
                existingDisplayName: (existing as { display_name?: string }).display_name ?? '(sem nome)',
            };
        }

        const { error } = await supabase
            .from('phone_numbers')
            .update({
                phone_number: normalized,
                connection_type: 'qr',
            })
            .eq('id', phoneNumberId);

        // Race condition: outro registro venceu entre o SELECT e o UPDATE.
        // UNIQUE INDEX dispara 23505 — tratamos como 'blocked' (vencedor está ativo).
        if (error && (error as { code?: string }).code === '23505') {
            const { data: winner } = await supabase
                .from('phone_numbers')
                .select('id, display_name')
                .eq('phone_number', normalized)
                .eq('is_active', true)
                .neq('id', phoneNumberId)
                .maybeSingle();
            return {
                ok: false,
                reason: 'blocked',
                existingPhoneNumberId: winner?.id ?? '',
                existingDisplayName: (winner as { display_name?: string } | null)?.display_name ?? '(desconhecido)',
            };
        }

        if (error) {
            console.error('Error updating phone number:', error);
            throw error;
        }

        return { ok: true };
    }

    // Limpa uma sessão que falhou na detecção de duplicata: encerra socket,
    // remove timers e deleta auth_state em disco. A linha de phone_numbers só é
    // removida quando é placeholder que nunca conectou ("Aguardando conexão...") —
    // deletar uma linha estabelecida cascateia logs/acessos/sessões e orfana as
    // conversas (SET NULL): por isso só o placeholder é apagado.
    private async cleanupDuplicateSession(
        phoneNumberId: string,
        session: Session,
        reason: 'blocked' | 'merge'
    ): Promise<void> {
        try {
            // Flush antes do end(): o buffer do socket duplicado pode carregar
            // mensagens que ainda não passaram pelos handlers.
            // O adapter faz o flush antes de fechar: mensagens no buffer do socket
            // duplicado ainda passam pelos handlers.
            await session.client?.close().catch(() => { /* já fechado */ });
            if (session.presenceInterval) {
                clearInterval(session.presenceInterval);
                session.presenceInterval = undefined;
            }
            if (session.reconnectTimer) {
                clearTimeout(session.reconnectTimer);
                session.reconnectTimer = undefined;
            }
            this.clearDisconnectAlertTimer(phoneNumberId);
            this.sessions.delete(phoneNumberId);

            await (await this.storeFor(phoneNumberId)).wipe().catch((e: unknown) =>
                console.error('[SessionManager] wipe do store falhou:', e instanceof Error ? e.message : e));

            // Placeholder ⇔ nunca conectou: no caminho de duplicata o UPDATE de
            // updatePhoneNumber não roda, então a linha ainda carrega o sentinel
            // do front. Erro no lookup conta como NÃO-placeholder: na dúvida a
            // linha fica, porque deletar é o ramo destrutivo.
            const { data: row, error: lookupError } = await supabase
                .from('phone_numbers')
                .select('phone_number')
                .eq('id', phoneNumberId)
                .maybeSingle();

            if (!lookupError && !row) return; // linha já não existe

            if (!lookupError && row?.phone_number === 'Aguardando conexão...') {
                const { error } = await supabase
                    .from('phone_numbers')
                    .delete()
                    .eq('id', phoneNumberId);
                if (error) {
                    console.error('[cleanupDuplicateSession] Error deleting phone_numbers row:', error);
                }
                return;
            }

            if (lookupError) {
                console.error('[cleanupDuplicateSession] Lookup falhou — mantendo a linha por segurança:', lookupError);
            }

            // Linha estabelecida: registra a queda e marca a sessão como
            // desconectada; resolver a duplicata é decisão do operador no painel.
            console.log(`[cleanupDuplicateSession] ${phoneNumberId} tem histórico — linha preservada (duplicate_${reason})`);
            await this.updateSessionInDb(phoneNumberId, 'disconnected', null);
            void this.logConnectionEvent(phoneNumberId, 'close', {
                reason: `duplicate_${reason}`,
            });
        } catch (e) {
            console.error('[cleanupDuplicateSession] error:', e);
        }
    }

    // ── Sticker cache por fileSha256 ─────────────────────────────────────────
    // WhatsApp deduplica stickers: um sticker já enviado antes chega sem mediaKey
    // e não pode ser baixado/decriptado. O cliente oficial resolve pelo cache
    // local indexado por fileSha256; aqui o cache vive no Storage num path
    // determinístico, então sobrevive a restarts e vale para todos os números.

    private stickerCachePublicUrl(shaHex: string): string {
        return urlPublicaDoAnexo(`sticker-cache/${shaHex}.webp`);
    }

    private async getCachedStickerUrl(shaHex: string): Promise<string | null> {
        const url = this.stickerCachePublicUrl(shaHex);
        try {
            // A URL guardada é a pública; o servidor consulta o Storage pela interna.
            const response = await fetch(paraUrlInterna(url), { method: 'HEAD' });
            return response.ok ? url : null;
        } catch {
            return null;
        }
    }

    private async cacheStickerMedia(shaHex: string, buffer: Buffer, mimeType: string): Promise<string | null> {
        try {
            const { error } = await supabase.storage
                .from('attachments')
                .upload(`sticker-cache/${shaHex}.webp`, buffer, {
                    contentType: mimeType.split(';')[0].trim(),
                    upsert: true,
                });

            if (error) {
                console.error('[StickerCache] Upload error:', error);
                return null;
            }

            return this.stickerCachePublicUrl(shaHex);
        } catch (error) {
            console.error('[StickerCache] Error caching sticker:', error);
            return null;
        }
    }

    /** Caminho no bucket `attachments` e content-type limpos para uma mídia recebida. */
    private inboundStorageTarget(phoneNumberId: string, mimeType: string, filename?: string): { storagePath: string; sanitizedContentType: string } {
        const ext = mimeType.split('/')[1]?.split(';')[0] || 'bin';
        const rawFilename = filename || `qr_${Date.now()}.${ext}`;
        const sanitizedFilename = rawFilename
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, '_')
            .replace(/[^a-zA-Z0-9_.\-]/g, '');
        return {
            storagePath: `inbound/${phoneNumberId}/${Date.now()}_${sanitizedFilename}`,
            sanitizedContentType: mimeType.split(';')[0].trim(),
        };
    }

    /**
     * Mídia grande: sobe do arquivo em pedaços (TUS), sem carregar na memória.
     * Mesmo contrato do uploadToStorage: URL pública ou null com `lastUploadError`.
     */
    private async uploadFileToStorage(
        phoneNumberId: string,
        file: InboundMediaFile,
        mimeType: string,
        filename?: string,
    ): Promise<string | null> {
        const { storagePath, sanitizedContentType } = this.inboundStorageTarget(phoneNumberId, mimeType, filename);
        const startedAt = Date.now();
        try {
            console.log(`[SessionManager] Upload resumível: ${storagePath}, type: ${sanitizedContentType}, bytes: ${file.size}`);
            await uploadFileResumable({
                endpoint: `${baseInterna()}/storage/v1/upload/resumable`,
                apiKey: process.env.SUPABASE_SERVICE_KEY ?? '',
                bucket: 'attachments',
                objectName: storagePath,
                contentType: sanitizedContentType,
                filePath: file.path,
                size: file.size,
            });
            this.lastUploadError = null;
            console.log(`[SessionManager] Upload resumível ok em ${Math.round((Date.now() - startedAt) / 1000)} s: ${storagePath}`);
            return urlPublicaDoAnexo(storagePath);
        } catch (error) {
            this.lastUploadError = errInfo(error).message.slice(0, 500);
            console.error(`[SessionManager] Upload resumível falhou (type=${sanitizedContentType}, bytes=${file.size}): ${this.lastUploadError}`);
            return null;
        }
    }

    private async uploadToStorage(
        phoneNumberId: string,
        buffer: Buffer,
        mimeType: string,
        filename?: string
    ): Promise<string | null> {
        try {
            const { storagePath, sanitizedContentType } = this.inboundStorageTarget(phoneNumberId, mimeType, filename);

            console.log(`[SessionManager] Uploading to storage: ${storagePath}, type: ${sanitizedContentType}`);

            // Upload to Supabase Storage
            const { error: uploadError } = await supabase.storage
                .from('attachments')
                .upload(storagePath, buffer, {
                    contentType: sanitizedContentType,
                    upsert: false
                });

            if (uploadError) {
                // Objeto cru aqui não distinguia "mime não suportado" de "payload
                // grande" de "duplicate", e os logs do container são inacessíveis
                // — sem a mensagem, todo media_degraded virava upload_failed sem
                // causa. O motivo fica no campo para o debugLog do chamador.
                const { message, statusCode } = uploadError as { message?: string; statusCode?: string };
                this.lastUploadError = message ?? String(uploadError);
                console.error(
                    `[SessionManager] Storage upload error (status=${statusCode ?? '?'}, ` +
                    `type=${sanitizedContentType}, bytes=${buffer.length}): ${this.lastUploadError}`
                );
                return null;
            }
            this.lastUploadError = null;

            // Get public URL
            return urlPublicaDoAnexo(storagePath);
        } catch (error) {
            console.error('[SessionManager] Error uploading to storage:', error);
            return null;
        }
    }

    private async handleGroupParticipantsUpdate(
        phoneNumberId: string,
        update: GroupParticipantsUpdate
    ): Promise<void> {
        const { groupJid, author: actor, participants, action } = update;
        const author = actor?.jid;
        const authorPn = actor?.phoneJid;
        const authorUsername = actor?.name;
        if (!groupJid || participants.length === 0) return;
        const webhookUrl = process.env.WEBHOOK_URL;
        if (!webhookUrl) {
            return;
        }
        const stripJid = (j?: string) => (j || '').split('@')[0];
        const resolvePhone = (jid?: string, pn?: string): string => {
            if (pn) return stripJid(pn);
            if (!jid) return '';
            const bare = stripJid(jid);
            if (jid.includes('@lid')) return this.lidPhoneCache.get<string>(bare) || bare;
            return bare;
        };
        const targets = participants.map((p) => ({
            jid: p.jid,
            phone: resolvePhone(p.jid, p.phoneJid),
            name: p.name || '',
        }));
        const actorJid = author || '';
        const actorPhone = resolvePhone(author, authorPn);
        const actorName = authorUsername || this.lidNameCache.get<string>(stripJid(author)) || '';

        // Distinguish self-initiated join/leave from admin add/remove.
        let displayAction: string = action;
        if (action === 'add' && targets.length === 1 && targets[0].phone && targets[0].phone === actorPhone) {
            displayAction = 'join';
        } else if (action === 'remove' && targets.length === 1 && targets[0].phone && targets[0].phone === actorPhone) {
            displayAction = 'leave';
        }

        // Our own number being added: surface the group in Echo (some server
        // flows deliver this as a participant 'add' instead of groups.upsert).
        const ownUser = this.sessions.get(phoneNumberId)?.client?.me();
        const ownPhone = stripJid(ownUser?.jid || '').split(':')[0];
        const ownLid = stripJid(ownUser?.lid || '').split(':')[0];
        if (
            action === 'add' &&
            targets.some((t) => (ownPhone && t.phone === ownPhone) || (ownLid && stripJid(t.jid) === ownLid))
        ) {
            displayAction = 'group_joined';
        }

        // Best-effort group subject (cache first, then socket).
        let groupSubject = '';
        const cachedMeta = this.groupMetadataCache.get<{ subject: string; participants: string[] }>(groupJid);
        if (cachedMeta?.subject) {
            groupSubject = cachedMeta.subject;
        } else {
            try {
                const session = this.sessions.get(phoneNumberId);
                const meta = await session?.client?.getGroup(groupJid);
                if (meta?.subject) groupSubject = meta.subject;
            } catch {
                // subject is cosmetic here
            }
        }

        // pt-BR fallback text (used for previews and when the frontend can't resolve names).
        const nameOf = (t: { name: string; phone: string }) => t.name || t.phone || 'alguém';
        const targetNames = targets.map(nameOf).join(', ');
        const actorLabel = actorName || actorPhone || 'Alguém';
        let content: string;
        switch (displayAction) {
            case 'group_joined':
                content = actorName || actorPhone ? `${actorLabel} adicionou você` : 'Você foi adicionado ao grupo';
                break;
            case 'join':
                content = `${targetNames} entrou`;
                break;
            case 'leave':
                content = `${targetNames} saiu`;
                break;
            case 'remove':
                content = `${actorLabel} removeu ${targetNames}`;
                break;
            case 'promote':
                content = `${actorLabel} promoveu ${targetNames} a admin`;
                break;
            case 'demote':
                content = `${actorLabel} rebaixou ${targetNames}`;
                break;
            case 'add':
            default:
                content = `${actorLabel} adicionou ${targetNames}`;
                break;
        }

        const timestamp = Math.floor(Date.now() / 1000);
        const targetKey = targets.map((t) => t.phone || stripJid(t.jid)).sort().join('-');
        // group_joined uses a day bucket so it collides/dedupes with the
        // groups.upsert-emitted event when both fire for the same add.
        const eventId =
            displayAction === 'group_joined'
                ? `grpevt_${stripJid(groupJid)}_group_joined_${Math.floor(Date.now() / 86_400_000)}`
                : `grpevt_${stripJid(groupJid)}_${displayAction}_${targetKey}_${timestamp}`;

        console.log(`[GroupParticipants] ${groupJid} action=${action}->${displayAction}: ${content}`);

        await this.outbox.enqueue({
            route: 'qr-group-event',
            phoneNumberId,
            toJid: groupJid,
            wamid: eventId,
            timeoutMs: 30_000,
            body: {
                phone_number_id: phoneNumberId,
                group_jid: groupJid,
                group_subject: groupSubject,
                action: displayAction,
                actor: { jid: actorJid, phone: actorPhone, name: actorName },
                targets,
                content,
                event_id: eventId,
                timestamp,
            },
        });
    }

    /**
     * Nome do grupo trocou (aviso do WhatsApp ou troca feita pelo próprio Echo): atualiza o
     * cache de metadados, que é compartilhado entre as sessões e alimenta o `group_subject` de
     * toda mensagem, e manda o evento `subject` ao Echo, que grava o nome novo na conversa da
     * linha e uma mensagem de sistema (`src/lib/groupSubject.ts`).
     */
    private async handleGroupSubjectUpdate(phoneNumberId: string, update: GroupSubjectUpdate): Promise<void> {
        const { groupJid, author } = update;
        const subject = update.subject.trim();
        if (!groupJid.endsWith('@g.us') || !subject) return;

        const cached = this.groupMetadataCache.get<{ subject: string; participants: string[] }>(groupJid);
        if (cached) {
            this.cacheSet(this.groupMetadataCache, groupJid, { ...cached, subject });
        }
        this.groupMetaFullCache.del(groupJid);

        if (!process.env.WEBHOOK_URL) return;

        const stripJid = (j?: string) => (j || '').split('@')[0];
        const actorJid = author?.jid || '';
        const actorPhone = author?.phoneJid
            ? stripJid(author.phoneJid)
            : actorJid.includes('@lid')
                ? this.lidPhoneCache.get<string>(stripJid(actorJid)) || ''
                : stripJid(actorJid).split(':')[0];
        const actorName = author?.name || this.lidNameCache.get<string>(stripJid(actorJid)) || '';
        const timestamp = update.timestamp ?? Math.floor(Date.now() / 1000);

        const evt = groupSubjectEvent({ groupJid, subject, actorName, actorPhone, timestamp });
        if (!evt) return;

        console.log(`[GroupSubject] ${groupJid} -> "${subject}" (${phoneNumberId})`);
        await this.outbox.enqueue({
            route: 'qr-group-event',
            phoneNumberId,
            toJid: groupJid,
            wamid: evt.eventId,
            timeoutMs: 30_000,
            body: {
                phone_number_id: phoneNumberId,
                group_jid: groupJid,
                group_subject: subject,
                action: 'subject',
                actor: { jid: actorJid, phone: actorPhone, name: actorName },
                targets: [],
                content: evt.content,
                event_id: evt.eventId,
                timestamp,
            },
        });
    }

    // groups.upsert fires when this session is added to (or creates) a group.
    // Forwards a 'group_joined' event so Echo creates and surfaces the group
    // conversation immediately, before any message arrives.
    /** Fomos adicionados a um grupo: notifica 'group_joined' e aquece o cache de metadados. */
    private async handleGroupsUpsert(phoneNumberId: string, metas: GroupInfo[]): Promise<void> {
        const webhookUrl = process.env.WEBHOOK_URL;
        if (!webhookUrl) {
            return;
        }
        const stripJid = (j?: string) => (j || '').split('@')[0];
        for (const meta of metas || []) {
            const groupJid = meta.jid || '';
            if (!groupJid.endsWith('@g.us')) continue;
            if (meta.subject) {
                this.cacheSet(this.groupMetadataCache, groupJid, {
                    subject: meta.subject,
                    participants: meta.participants.map((p) => p.jid),
                });
            }
            const actorJid = meta.author?.jid || '';
            const actorPhone = meta.author?.phoneJid
                ? stripJid(meta.author.phoneJid)
                : actorJid.includes('@lid')
                    ? this.lidPhoneCache.get<string>(stripJid(actorJid)) || ''
                    : stripJid(actorJid);
            const actorName = meta.author?.name || this.lidNameCache.get<string>(stripJid(actorJid)) || '';
            const actorLabel = actorName || actorPhone;
            const day = Math.floor(Date.now() / 86_400_000);
            const eventId = `grpevt_${stripJid(groupJid)}_group_joined_${day}`;
            const content = actorLabel ? `${actorLabel} adicionou você` : 'Você foi adicionado ao grupo';
            this.enqueueAvatarFetch(phoneNumberId, groupJid, { quality: 'image' });
            await this.outbox.enqueue({
                route: 'qr-group-event',
                phoneNumberId,
                toJid: groupJid,
                wamid: eventId,
                timeoutMs: 30_000,
                body: {
                    phone_number_id: phoneNumberId,
                    group_jid: groupJid,
                    group_subject: meta.subject || '',
                    action: 'group_joined',
                    actor: { jid: actorJid, phone: actorPhone, name: actorName },
                    targets: [],
                    content,
                    event_id: eventId,
                    timestamp: Math.floor(Date.now() / 1000),
                },
            });
        }
    }

    private async forwardToWebhook(
        phoneNumberId: string,
        message: {
            from: string;
            content: string;
            messageId: string | null | undefined;
            timestamp: number | null | undefined;
            contactName?: string;
            messageType?: string;
            mediaBuffer?: string | null; // Keep as base64 string for back-compat internally or change to Buffer?
            // Actually, in the caller it passes base64 string.
            // Wait, the caller (processMessage) passes `mediaBuffer: mediaBuffer ? mediaBuffer.toString('base64') : null`.
            // I should change the caller to pass Buffer directly or decode here.
            // Let's rely on the caller passing base64 for now to minimize changes, decoding it back to Buffer.
            mediaFile?: InboundMediaFile | null; // mídia grande já em disco: sobe por upload resumível e é apagada
            mediaMimeType?: string | null;
            mediaFilename?: string | null;
            mediaUrl?: string | null; // Pre-resolved URL (ex.: sticker cache hit) — skips upload
            mediaSizeBytes?: number | null; // fileLength declarado no proto — existe mesmo sem download
            mediaDownloadFailed?: boolean; // download esgotado: flag explícita para a edge (antes ela inferia)
            stickerShaHex?: string | null; // fileSha256 do sticker, chave do cache no Storage
            // Group-specific fields
            isGroup?: boolean;
            groupJid?: string;
            groupSubject?: string;
            senderPhone?: string;
            senderName?: string;
            senderJid?: string; // Original participant JID for reactions
            // Quoted message fields
            quotedStanzaId?: string | null;
            quotedContent?: string | null;
            // Contact message fields
            contactMetadata?: ContactMetadata | null;
            // Click-to-WhatsApp ad attribution (só na primeira mensagem de um lead de anúncio)
            ctwaClid?: string | null;
            referral?: Record<string, unknown> | null;
            // Metadata genérico (view_once, ptt, location…) mesclado ao messages.metadata
            metadata?: Record<string, unknown> | null;
            // Direction indicator (fromMe = sent from this device/Business app)
            fromMe?: boolean;
        }
    ): Promise<void> {
        try {
            console.log(`[SessionManager] Forwarding to webhook: type=${message.messageType}, hasMedia=${!!message.mediaBuffer}, isGroup=${message.isGroup}`);

            let mediaUrl: string | null = message.mediaUrl ?? null;
            let mediaDegraded: 'upload_failed' | null = null;

            // Mídia grande em disco: upload resumível e o arquivo sai logo depois,
            // com ou sem sucesso (nada de disco preso esperando o outbox).
            const mediaFile = message.mediaFile ?? null;
            message.mediaFile = null;
            if (mediaFile) {
                try {
                    if (!mediaUrl && message.mediaMimeType) {
                        mediaUrl = await this.uploadFileToStorage(
                            phoneNumberId,
                            mediaFile,
                            message.mediaMimeType,
                            message.mediaFilename || undefined,
                        );
                        if (!mediaUrl) {
                            mediaDegraded = 'upload_failed';
                            void this.debugLog(phoneNumberId, 'media_degraded', message.groupJid ?? message.from, {
                                reason: 'upload_failed',
                                message_type: message.messageType ?? 'text',
                                mime: message.mediaMimeType,
                                size_bytes: mediaFile.size,
                                transport: 'resumable',
                                error: this.lastUploadError,
                            }, message.messageId);
                        }
                    }
                } finally {
                    await mediaFile.release();
                }
            } else if (!mediaUrl && message.mediaBuffer && message.mediaMimeType) {
                const buffer = Buffer.from(message.mediaBuffer, 'base64');
                // Libera a string base64 (pode ser dezenas de MB) — o Buffer já tem a cópia binária
                message.mediaBuffer = null;

                // Stickers vão para um path determinístico por hash — o mesmo arquivo
                // atende reenvios dedupados que chegam sem mediaKey.
                if (message.messageType === 'sticker' && message.stickerShaHex) {
                    mediaUrl = await this.cacheStickerMedia(message.stickerShaHex, buffer, message.mediaMimeType);
                }

                if (!mediaUrl) {
                    mediaUrl = await this.uploadToStorage(
                        phoneNumberId,
                        buffer,
                        message.mediaMimeType,
                        message.mediaFilename || undefined
                    );
                }

                if (mediaUrl) {
                    console.log(`[SessionManager] Media uploaded successfully: ${mediaUrl}`);
                } else {
                    // Upload falhou (Storage fora, buffer inválido): a MENSAGEM segue
                    // mesmo assim — degradação explícita em vez de bolha sem mídia em
                    // silêncio. O rastro permite reprocessar depois.
                    mediaDegraded = 'upload_failed';
                    void this.debugLog(phoneNumberId, 'media_degraded', message.groupJid ?? message.from, {
                        reason: 'upload_failed',
                        message_type: message.messageType ?? 'text',
                        mime: message.mediaMimeType,
                        error: this.lastUploadError,
                    }, message.messageId);
                }
            } else if (!mediaUrl && message.mediaMimeType && message.mediaBuffer === '') {
                // Buffer vazio: o base64 de 0 bytes é '' (falsy), então o ramo acima
                // nem roda e a mensagem saía sem mídia E sem rastro. Registrar aqui
                // é o que torna a falha visível — antes só dava para notar olhando
                // a bolha sem imagem na UI.
                mediaDegraded = 'upload_failed';
                void this.debugLog(phoneNumberId, 'media_degraded', message.groupJid ?? message.from, {
                    reason: 'empty_buffer',
                    message_type: message.messageType ?? 'text',
                    mime: message.mediaMimeType,
                }, message.messageId);
            }

            // Entrega via outbox: retry + spill em disco. Nunca rejeita; o await
            // preserva o throttle de memória dos lotes do history sync.
            await this.outbox.enqueue({
                route: 'qr-message',
                phoneNumberId,
                toJid: message.isGroup && message.groupJid ? message.groupJid : message.from,
                wamid: message.messageId ?? null,
                timeoutMs: 30_000,
                body: {
                phone_number_id: phoneNumberId,
                from: message.from,
                content: message.content,
                contact_name: message.contactName,
                message_id: message.messageId,
                timestamp: message.timestamp,
                message_type: message.messageType || 'text',
                media_url: mediaUrl, // NEW FIELD
                media_mime_type: message.mediaMimeType,
                media_filename: message.mediaFilename,
                // Lidos pela edge como media_size_declared / media_download_failed: o
                // tamanho vale mesmo quando o binário não veio, e a flag substitui a
                // inferência "tipo mídia sem URL".
                media_size_bytes: message.mediaSizeBytes ?? null,
                media_download_failed: message.mediaDownloadFailed === true ? true : undefined,
                // REMOVED media_base64 to save bandwidth
                // Group-specific fields
                is_group: message.isGroup || false,
                group_jid: message.groupJid,
                group_subject: message.groupSubject,
                sender_phone: message.senderPhone,
                sender_name: message.senderName,
                sender_jid: message.senderJid, // Original participant JID for reactions
                // Quoted message fields
                quoted_stanza_id: message.quotedStanzaId,
                quoted_content: message.quotedContent,
                // Contact message fields
                contact_metadata: message.contactMetadata,
                // Click-to-WhatsApp ad attribution — repassado cru, como o Baileys entregou.
                // referral_transport diz em que formato o bloco está: o proto do Baileys usa
                // camelCase, a Cloud API entrega o mesmo conceito em snake_case.
                ctwa_clid: message.ctwaClid ?? null,
                referral: message.referral ?? null,
                referral_transport: message.referral ? 'baileys' : null,
                // Metadata genérico mesclado ao messages.metadata pelo webhook.
                // media_upload_failed marca a degradação explícita (bolha avisa).
                metadata: mediaDegraded
                    ? { ...(message.metadata ?? {}), media_upload_failed: true }
                    : (message.metadata ?? null),
                // Direction indicator (fromMe = sent from this device/Business app)
                from_me: message.fromMe || false,
                },
            });
        } catch (error) {
            // enqueue nunca rejeita; isto cobre só o preparo da mídia acima.
            console.error('Error forwarding to webhook:', error);
        }
    }

    /**
     * Voto em enquete (pollUpdateMessage): decripta com o message_secret da
     * enquete (cache de 2h → fallback no metadata.poll do banco, que sobrevive
     * a restart), mapeia os hashes SHA256 de volta aos nomes das opções e
     * encaminha para /qr-poll-vote.
     */
    /**
     * Voto de enquete recebido. As opções + secret vêm do banco (a mesma linha serve
     * para os dois). O endereçamento LID vs PN varia por chat e por dispositivo — em
     * vez de adivinhar a forma exata, tenta as combinações plausíveis até o GCM
     * validar (chave errada = AEAD falha, nunca decripta lixo). A cripto é do adapter.
     */
    private async handlePollUpdate(
        phoneNumberId: string,
        client: WhatsAppClient,
        msg: InboundMessage,
        vote: PollVoteContent
    ): Promise<void> {
        const pollKey = vote.pollKey;
        const pollMsgId = pollKey.id;
        if (!pollMsgId || (!vote.encrypted && !vote.selectedOptions)) return;

        const { data: rows } = await supabase
            .from('messages')
            .select('metadata, conversations!inner(phone_number_id)')
            .eq('whatsapp_message_id', pollMsgId)
            .eq('conversations.phone_number_id', phoneNumberId)
            .limit(1);
        const pollMeta = (rows?.[0]?.metadata as { poll?: { options?: unknown; message_secret?: string } } | null)?.poll;
        const options = Array.isArray(pollMeta?.options)
            ? (pollMeta!.options as unknown[]).filter((o): o is string => typeof o === 'string')
            : [];
        let secret: Buffer | undefined = this.msgSecretCache.get(pollMsgId);
        if (!secret && typeof pollMeta?.message_secret === 'string') {
            secret = Buffer.from(pollMeta.message_secret, 'base64');
        }
        if (!secret || options.length === 0) {
            console.warn(`[Poll] Vote for ${pollMsgId} sem secret/opções — ignorado`);
            return;
        }

        const ourPn = client.me()?.jid ?? '';
        const ourLid = client.me()?.lid ?? null;
        const norm = (j?: string | null) => (j ? normalizeJidUser(j) : null);
        const uniq = (list: Array<string | null | undefined>) =>
            [...new Set(list.filter((j): j is string => !!j))];
        const voterCandidates = msg.key.fromMe
            ? uniq([ourLid, ourPn])
            : uniq([norm(msg.senderJid || msg.key.chatJid), norm(msg.senderPn), norm(msg.senderLid)]);
        const creatorCandidates = uniq([norm(pollKey.participantJid || pollKey.chatJid), ourLid, ourPn]);

        let selectedHashes: string[] | null = null;
        let voterJid = voterCandidates[0] ?? '';
        let creatorUsed: string | null = null;
        // Lib que já entrega o voto aberto (zapo): pula a cripto e vai direto aos nomes.
        if (vote.selectedOptions) {
            selectedHashes = vote.selectedOptions.map((name) => createHash('sha256').update(name).digest('hex'));
        }
        outer: for (const voter of selectedHashes ? [] : voterCandidates) {
            for (const creator of creatorCandidates) {
                try {
                    selectedHashes = client.decryptPollVote(vote.encrypted!, secret, creator, voter);
                    voterJid = voter;
                    creatorUsed = creator;
                    break outer;
                } catch {
                    /* combinação errada — tenta a próxima */
                }
            }
        }
        void this.debugLog(phoneNumberId, 'poll_update_in', msg.key.chatJid || 'unknown', {
            poll_key: { remoteJid: pollKey.chatJid, id: pollKey.id, fromMe: pollKey.fromMe, participant: pollKey.participantJid ?? null },
            update_key: {
                remoteJid: msg.key.chatJid,
                id: msg.key.id,
                fromMe: msg.key.fromMe,
                participant: msg.key.participantJid ?? null,
                sender_pn: msg.senderPn ?? null,
            },
            our_pn: ourPn,
            our_lid: ourLid,
            decrypted: !!selectedHashes,
            voter_used: selectedHashes ? voterJid : null,
            creator_used: creatorUsed,
            voter_candidates: voterCandidates,
            creator_candidates: creatorCandidates,
        }, pollMsgId);
        if (!selectedHashes) {
            console.warn(`[Poll] Não decifrou o voto de ${pollMsgId} (candidatos: ${voterCandidates.join('|')})`);
            return;
        }
        const hashToName = new Map(
            options.map((name) => [createHash('sha256').update(name).digest('hex'), name])
        );
        const selected = selectedHashes
            .map((hash) => hashToName.get(hash))
            .filter((name): name is string => !!name);
        if (selected.length !== selectedHashes.length) {
            console.warn(`[Poll] ${selectedHashes.length - selected.length} hash(es) sem opção correspondente em ${pollMsgId}`);
        }
        const webhookUrl = process.env.WEBHOOK_URL;
        if (!webhookUrl) {
            return;
        }
        await this.outbox.enqueue({
            route: 'qr-poll-vote',
            phoneNumberId,
            toJid: voterJid,
            wamid: pollMsgId,
            timeoutMs: 10_000,
            body: {
                phone_number_id: phoneNumberId,
                poll_message_id: pollMsgId,
                voter_jid: voterJid,
                voter_name: msg.key.fromMe ? 'Você' : (msg.pushName ?? null),
                selected_options: selected,
                from_me: msg.key.fromMe,
            },
        });
    }

    private async forwardReactionToWebhook(
        phoneNumberId: string,
        reaction: {
            reactionEmoji: string;
            targetMessageId: string;
            fromMe: boolean;
            timestamp: number | null;
            /** JID de quem reagiu (participante em grupo, contato em 1:1). */
            reactorJid?: string | null;
            reactorName?: string | null;
        }
    ): Promise<void> {
        const webhookUrl = process.env.WEBHOOK_URL;
        if (!webhookUrl) {
            console.error('WEBHOOK_URL not configured');
            return;
        }

        console.log(`[SessionManager] Forwarding reaction to webhook: emoji="${reaction.reactionEmoji}", targetMsgId="${reaction.targetMessageId}"`);

        await this.outbox.enqueue({
            route: 'qr-reaction',
            phoneNumberId,
            toJid: reaction.reactorJid ?? 'unknown',
            wamid: reaction.targetMessageId,
            timeoutMs: 10_000,
            body: {
                phone_number_id: phoneNumberId,
                reaction_emoji: reaction.reactionEmoji,
                target_message_id: reaction.targetMessageId,
                from_me: reaction.fromMe,
                timestamp: reaction.timestamp,
                reactor_jid: reaction.reactorJid ?? null,
                reactor_name: reaction.reactorName ?? null,
            },
        });
    }

    /**
     * Forward delivery status updates to the webhook for database persistence.
     * This enables real-time status updates (sent -> delivered -> read) in the UI.
     */
    private async forwardDeliveryUpdateToWebhook(
        phoneNumberId: string,
        update: {
            messageId: string;
            status: number;
            statusLabel: string;
            remoteJid: string;
        }
    ): Promise<void> {
        const webhookUrl = process.env.WEBHOOK_URL;
        if (!webhookUrl) {
            console.error('[DeliveryUpdate] WEBHOOK_URL not configured');
            return;
        }

        console.log(`[DeliveryUpdate] Forwarding to webhook: msgId=${update.messageId}, status=${update.status} (${update.statusLabel}), remoteJid=${update.remoteJid}`);

        // spillable: false — recibo de leitura perdido numa outage longa é
        // aceitável; milhares de arquivos de status em disco não são.
        await this.outbox.enqueue({
            route: 'qr-delivery-update',
            phoneNumberId,
            toJid: update.remoteJid,
            wamid: update.messageId,
            timeoutMs: 10_000,
            spillable: false,
            body: {
                phone_number_id: phoneNumberId,
                message_id: update.messageId,
                status: update.status,
                status_label: update.statusLabel,
                remote_jid: update.remoteJid,
            },
        });
    }

    /**
     * Recibos de grupo por participante → edge /qr-message-receipt.
     * Um job por wamid (participantes em lote no body); spillable: false pela
     * mesma razão do qr-delivery-update — recibo perdido numa outage longa é
     * aceitável, milhares de arquivos de recibo em disco não são.
     */
    private async forwardMessageReceiptsToWebhook(
        phoneNumberId: string,
        update: {
            messageId: string;
            remoteJid: string;
            /** Participantes do grupo menos nós; null = metadata indisponível. */
            groupSize: number | null;
            receipts: Array<{
                participant_jid: string;
                participant_phone: string | null;
                kind: 'delivered' | 'read';
                ts: number;
            }>;
        }
    ): Promise<void> {
        const webhookUrl = process.env.WEBHOOK_URL;
        if (!webhookUrl) {
            console.error('[GroupReceipts] WEBHOOK_URL not configured');
            return;
        }

        console.log(
            `[GroupReceipts] msgId=${update.messageId} jid=${update.remoteJid} ` +
            `receipts=${update.receipts.length} groupSize=${update.groupSize ?? '?'}`
        );

        await this.outbox.enqueue({
            route: 'qr-message-receipt',
            phoneNumberId,
            toJid: update.remoteJid,
            wamid: update.messageId,
            timeoutMs: 10_000,
            spillable: false,
            body: {
                phone_number_id: phoneNumberId,
                message_id: update.messageId,
                remote_jid: update.remoteJid,
                group_size: update.groupSize,
                receipts: update.receipts,
            },
        });
    }

    /**
     * Participantes do grupo menos o nosso número — o denominador do "todos
     * leram". null quando o metadata não está disponível (a edge então só
     * promove a delivered, nunca agrega read). Os ids do cache podem vir em pn
     * ou lid conforme o addressingMode do grupo; a exclusão compara a parte
     * bare contra as duas identidades nossas.
     */
    private async getGroupSizeExcludingSelf(
        client: WhatsAppClient,
        groupJid: string,
        ourPn: string | null,
        ourLid: string | null
    ): Promise<number | null> {
        try {
            let participants = this.groupMetadataCache
                .get<{ subject: string; participants: string[] }>(groupJid)?.participants;
            if (!participants) {
                const meta = await client.getGroup(groupJid);
                participants = meta.participants.map((p) => p.jid);
                this.cacheSet(this.groupMetadataCache, groupJid, {
                    subject: meta.subject,
                    participants,
                });
            }
            const ourBare = [ourPn, ourLid]
                .filter((j): j is string => Boolean(j))
                .map((j) => j.split('@')[0]);
            const others = participants.filter((p) => {
                const bare = normalizeJidUser(p).split('@')[0];
                return !ourBare.includes(bare);
            });
            return others.length > 0 ? others.length : null;
        } catch (err) {
            console.error('[GroupReceipts] groupMetadata falhou:', err);
            return null;
        }
    }

    private async forwardMessageDeletedToWebhook(
        phoneNumberId: string,
        whatsappMessageId: string
    ): Promise<void> {
        await this.outbox.enqueue({
            route: 'qr-message-deleted',
            phoneNumberId,
            toJid: 'unknown',
            wamid: whatsappMessageId,
            timeoutMs: 10_000,
            body: {
                phone_number_id: phoneNumberId,
                message_id: whatsappMessageId,
            },
        });
    }

    /**
     * Decifra o texto novo de uma edição entregue como secretEncryptedMessage (conversas 1:1).
     *
     * Derivação conforme a implementação de referência do Baileys (PR #2690, ainda não publicada
     * em nenhuma versão — rc13 e rc14 não têm nada disso). É o mesmo esquema do decryptPollVote,
     * trocando o rótulo do caso de uso, e NÃO o do generateMsgSecretKey/HKDF:
     *
     *   sign   = origMsgId ‖ origMsgSenderJid ‖ editorJid ‖ 'Message Edit' ‖ 0x01
     *   key0   = HMAC-SHA256(chave = 32 zeros, dados = msgEncKey)
     *   decKey = HMAC-SHA256(chave = key0,     dados = sign)
     *   texto  = AES-256-GCM(encPayload, decKey, encIv, AAD VAZIO)
     *
     * Ao contrário de enquete e resposta de evento, a edição é selada SEM AAD.
     *
     * msgEncKey é o messageContextInfo.messageSecret da mensagem ORIGINAL, guardado no
     * msgSecretCache quando ela chegou. O remetente pode ter derivado com a identidade LID ou com
     * a PN, então tenta as duas: o GCM autentica, logo a errada falha na tag em vez de devolver lixo.
     */
    /**
     * Edição cifrada com o segredo da mensagem original. Só o autor edita a própria
     * mensagem, então o mesmo JID vale como autor da original e da edição; tentamos
     * as identidades plausíveis (LID, PN, forma telefone do cache) até o GCM validar.
     */
    private decryptSecretEncryptedEdit(
        handle: unknown,
        origMsgId: string,
        editMsg: InboundMessage,
        client: WhatsAppClient
    ): string | null {
        const secret = this.msgSecretCache.get<Buffer>(origMsgId);
        if (!secret) {
            console.warn(
                `[MSG_EDIT] messageSecret ausente no cache para ${origMsgId} — sem decifrar ` +
                `(cache tem ${this.msgSecretCache.keys().length} segredos)`
            );
            return null;
        }
        const me = client.me();
        const candidates = [...new Set(
            [
                ...(editMsg.key.fromMe
                    ? [me?.jid, me?.lid]
                    : [editMsg.senderJid || editMsg.key.chatJid, editMsg.senderPn, editMsg.senderLid, editMsg.chatAltJid]),
                editMsg.key.chatJid,
            ]
                .filter((jid): jid is string => typeof jid === 'string' && jid.length > 0)
                // Dígito cru sem servidor faz o jidNormalizedUser devolver string vazia, e aí a
                // forma PN nunca chegaria a ser testada.
                .map((jid) => (jid.includes('@') ? jid : `${jid}@s.whatsapp.net`))
                .flatMap((jid) => {
                    const normalized = normalizeJidUser(jid);
                    if (!normalized) return [];
                    const phone = normalized.endsWith('@lid')
                        ? this.lidPhoneCache.get<string>(normalized.replace('@lid', ''))
                        : undefined;
                    return phone ? [normalized, `${phone}@s.whatsapp.net`] : [normalized];
                })
        )];
        for (const authorJid of candidates) {
            const text = client.decryptSecretEdit(handle, secret, authorJid);
            if (text) return text;
        }
        console.warn(`[MSG_EDIT] Nenhuma identidade decifrou ${origMsgId}. Candidatos: ${candidates.join(' | ')}`);
        return null;
    }

    /**
     * Guarda o messageContextInfo.messageSecret de uma mensagem. É o que permite decifrar uma
     * edição futura dela (secretEncryptedMessage): sem o segredo da mensagem original não há chave.
     * Vale para as duas direções — o contato editando o que mandou, e nós editando do aparelho.
     */

    /**
     * Texto novo de uma edição. Cobre texto puro E legenda de mídia — ler só
     * conversation/extendedTextMessage descartava em silêncio toda edição de legenda.
     */

    /**
     * newContent null = houve edição mas não conseguimos o texto novo (edição cifrada sem o
     * segredo em cache). A edge marca a mensagem como editada sem tocar no conteúdo, para o
     * operador ao menos saber que o texto que ele lê não é mais o que o contato escreveu.
     */
    private async forwardMessageEditedToWebhook(
        phoneNumberId: string,
        whatsappMessageId: string,
        newContent: string | null
    ): Promise<void> {
        await this.outbox.enqueue({
            route: 'qr-message-edited',
            phoneNumberId,
            toJid: 'unknown',
            wamid: whatsappMessageId,
            timeoutMs: 10_000,
            body: {
                phone_number_id: phoneNumberId,
                message_id: whatsappMessageId,
                ...(newContent === null ? { flag_only: true } : { new_content: newContent }),
            },
        });
    }

    async sendMessage(
        phoneNumberId: string,
        to: string,
        content: string,
        quotedMessageId?: string,
        quotedContent?: string,
        quotedFromMe?: boolean,
        quotedParticipant?: string,
        mentions?: string[], // Array of JIDs to mention (e.g., ["5511999990001@s.whatsapp.net"])
        isForwarded?: boolean // Marca a mensagem com a tag nativa "Encaminhada" no aparelho do destinatário
    ): Promise<{ success: boolean; messageId?: string; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_text',
                success: false, error: 'Session not found',
                sessionStatus: 'no_session',
            });
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            const socketState = this.getSocketReadyState(session);
            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_text',
                success: false, error: `Session not connected (status=${session.status})`,
                socketState, sessionStatus: session.status,
            });
            return { success: false, error: 'Session not connected' };
        }

        const reachoutBlock = (await this.checkReachoutLock(session, to, 'send_text')) ?? (await this.checkMessageCapping(session, to, 'send_text'));
        if (reachoutBlock) return { success: false, error: reachoutBlock };
        const gateBlock = await this.acquireSendSlot(session, to, 'send_text');
        if (gateBlock) return { success: false, error: gateBlock };

        // Pre-send health check
        const socketState = this.getSocketReadyState(session);
        console.log(`[SendMessage] Pre-send check: phoneNumberId=${phoneNumberId}, sessionStatus=${session.status}, socketReadyState=${socketState}, to=${to}`);

        if (socketState !== 1) {
            console.error(`[SendMessage] ⚠️ Socket NOT OPEN (readyState=${socketState}) despite session status=connected. This message will likely fail!`);
        }

        try {
            let validJid: string;

            // Check if this is a group JID
            if (to.includes('@g.us')) {
                // Group JID - use as-is
                validJid = to;
                console.log('[SendMessage] Sending to group:', validJid);
            } else {
                // Individual contact - process phone number
                const cleanNumber = to.replace(/\D/g, '');

                // Use EXACT number — do NOT generate variations for outbound.
                // Both 551133330001 and 5511933330001 can be different people.
                validJid = `${cleanNumber}@s.whatsapp.net`; // Default

                validJid = await this.resolveOutboundJid(session, cleanNumber, 'SendMessage');

                console.log('[SendMessage] Using JID:', validJid);
            }

            // Build message options with quote if provided
            const messageOptions = this.quotedOptions(validJid, to, quotedMessageId, quotedContent, quotedFromMe, quotedParticipant);

            // Build message content with optional mentions
            if (mentions && mentions.length > 0) messageOptions.mentionedJids = mentions;
            if (isForwarded) messageOptions.forwarded = true;
            const sent = await this.clientOf(session).send(validJid, { type: 'text', text: content }, messageOptions);
            const result = sent.raw as RawSentMessage | undefined;

            // Log the full Baileys result
            const messageId = sent.key.id || result?.key?.id || undefined;
            const baileysResult = {
                keyId: result?.key?.id,
                keyRemoteJid: result?.key?.remoteJid,
                keyFromMe: result?.key?.fromMe,
                status: (result as any)?.status,
                messageTimestamp: (result as any)?.messageTimestamp,
            };
            console.log(`[SendMessage] Baileys result:`, JSON.stringify(baileysResult));

            // Cache the message for retries
            if (sent.key.id) {
                this.cacheSet(this.msgCache, sent.key.id, sent.raw);
                if (sent.messageSecret) this.cacheSet(this.msgSecretCache, sent.key.id, sent.messageSecret);
            }

            // Log success
            await this.logMessageEvent({
                phoneNumberId, toJid: validJid, messageId, action: 'send_text',
                success: true, socketState, sessionStatus: session.status,
                baileysResult,
            });

            return {
                success: true,
                messageId,
            };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[SendMessage] Error sending message:', error);

            // Log failure
            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_text',
                success: false, error: errMsg,
                socketState, sessionStatus: session.status,
            });

            return {
                success: false,
                error: errMsg,
            };
        }
    }

    // Send media message via QR connection
    async sendMediaMessage(
        phoneNumberId: string,
        to: string,
        mediaBuffer: Buffer,
        mimeType: string,
        filename?: string,
        caption?: string,
        quotedMessageId?: string,
        quotedContent?: string,
        quotedFromMe?: boolean,
        isPtt?: boolean,
        quotedParticipant?: string,
        isSticker?: boolean,
        isAnimated?: boolean,
        isForwarded?: boolean, // Marca a mensagem com a tag nativa "Encaminhada" no aparelho do destinatário
        viewOnce?: boolean, // Mídia "ver uma vez" (imagem/vídeo/áudio)
        isGif?: boolean // Vídeo com gifPlayback (loop sem som, como GIF no app)
    ): Promise<{ success: boolean; messageId?: string; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_media',
                success: false, error: 'Session not found',
                sessionStatus: 'no_session',
            });
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            const socketState = this.getSocketReadyState(session);
            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_media',
                success: false, error: `Session not connected (status=${session.status})`,
                socketState, sessionStatus: session.status,
            });
            return { success: false, error: 'Session not connected' };
        }

        const reachoutBlock = (await this.checkReachoutLock(session, to, 'send_media')) ?? (await this.checkMessageCapping(session, to, 'send_media'));
        if (reachoutBlock) return { success: false, error: reachoutBlock };
        const gateBlock = await this.acquireSendSlot(session, to, 'send_media');
        if (gateBlock) return { success: false, error: gateBlock };

        // Pre-send health check
        const socketState = this.getSocketReadyState(session);
        console.log(`[SendMediaMessage] Pre-send check: phoneNumberId=${phoneNumberId}, sessionStatus=${session.status}, socketReadyState=${socketState}, to=${to}, mimeType=${mimeType}, size=${mediaBuffer.length}`);

        if (socketState !== 1) {
            console.error(`[SendMediaMessage] ⚠️ Socket NOT OPEN (readyState=${socketState}) despite session status=connected. This message will likely fail!`);
        }

        try {
            let validJid: string;

            // Check if this is a group JID
            if (to.includes('@g.us')) {
                // Group JID - use as-is
                validJid = to;
                console.log('[SendMediaMessage] Sending to group:', validJid);
            } else {
                // Individual contact - process phone number
                const cleanNumber = to.replace(/\D/g, '');

                // Use EXACT number — do NOT generate variations for outbound.
                // Both 551133330001 and 5511933330001 can be different people.
                validJid = `${cleanNumber}@s.whatsapp.net`; // Default

                validJid = await this.resolveOutboundJid(session, cleanNumber, 'SendMediaMessage');

                console.log('[SendMediaMessage] Using JID:', validJid);
            }

            // Determine message type and build content
            const media = { data: mediaBuffer, mimeType, fileName: filename, caption };
            let outbound: OutboundContent;
            if (isSticker) {
                outbound = { type: 'sticker', media: { ...media, mimeType: 'image/webp' }, isAnimated: isAnimated === true };
            } else if (mimeType.startsWith('image/')) {
                outbound = { type: 'image', media, viewOnce };
            } else if (mimeType.startsWith('video/')) {
                outbound = { type: 'video', media, viewOnce, gifPlayback: isGif };
            } else if (mimeType.startsWith('audio/') || isPtt) {
                // PTT força o mimetype de voz; ogg também vira nota de voz.
                const isVoiceNote = isPtt === true || mimeType.includes('ogg');
                // Nota de voz leva forma de onda e duração (a zapo não calcula; o Baileys ignora o que vier).
                const voiceMeta = isVoiceNote ? await audioMeta(mediaBuffer) : null;
                outbound = {
                    type: 'audio',
                    media: { ...media, mimeType: isPtt ? 'audio/ogg; codecs=opus' : mimeType },
                    isVoiceNote,
                    seconds: voiceMeta?.seconds,
                    waveform: voiceMeta?.waveform,
                    viewOnce,
                };
            } else {
                outbound = { type: 'document', media: { ...media, fileName: filename || 'document' } };
            }
            const messageOptions = this.quotedOptions(validJid, to, quotedMessageId, quotedContent, quotedFromMe, quotedParticipant);
            if (isForwarded) messageOptions.forwarded = true;
            const sent = await this.clientOf(session).send(validJid, outbound, messageOptions);
            const result = sent.raw as RawSentMessage | undefined;

            // Log the full Baileys result
            const messageId = sent.key.id || result?.key?.id || undefined;
            const baileysResult = {
                keyId: result?.key?.id,
                keyRemoteJid: result?.key?.remoteJid,
                keyFromMe: result?.key?.fromMe,
                status: (result as any)?.status,
                messageTimestamp: (result as any)?.messageTimestamp,
                mimeType,
                mediaSize: mediaBuffer.length,
            };
            console.log(`[SendMediaMessage] Baileys result:`, JSON.stringify(baileysResult));

            // Cache the message for retries
            if (sent.key.id) {
                this.cacheSet(this.msgCache, sent.key.id, sent.raw);
                if (sent.messageSecret) this.cacheSet(this.msgSecretCache, sent.key.id, sent.messageSecret);
            }

            // Log success
            await this.logMessageEvent({
                phoneNumberId, toJid: validJid, messageId, action: 'send_media',
                success: true, socketState, sessionStatus: session.status,
                baileysResult,
            });

            return {
                success: true,
                messageId,
            };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[SendMediaMessage] Error sending media message:', error);

            // Log failure
            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_media',
                success: false, error: errMsg,
                socketState, sessionStatus: session.status,
            });

            return {
                success: false,
                error: errMsg,
            };
        }
    }

    // Send a voice message (PTT / nota de voz).
    // Recebe áudio em QUALQUER formato, transcodifica para OGG/Opus e envia como voz
    // de verdade (bolinha com onda). Separado de sendMediaMessage de propósito: mídia
    // genérica preserva o arquivo original; voz sempre vira opus + ptt:true.
    async sendVoiceMessage(
        phoneNumberId: string,
        to: string,
        inputBuffer: Buffer,
        quotedMessageId?: string,
        quotedContent?: string,
        quotedFromMe?: boolean,
        quotedParticipant?: string
    ): Promise<{ success: boolean; messageId?: string; error?: string }> {
        let opusBuffer: Buffer;
        try {
            opusBuffer = await transcodeToOpus(inputBuffer);
            console.log(`[SendVoiceMessage] Transcoded ${inputBuffer.length}B -> ${opusBuffer.length}B opus for ${to}`);
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : 'Unknown error';
            console.error('[SendVoiceMessage] Transcode to opus failed:', errMsg);
            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_media',
                success: false, error: `voice transcode failed: ${errMsg}`,
                sessionStatus: this.sessions.get(phoneNumberId)?.status ?? 'no_session',
            });
            return { success: false, error: 'Failed to transcode audio to opus' };
        }

        // Reaproveita sendMediaMessage com isPtt=true: ele já força mimetype
        // 'audio/ogg; codecs=opus' e ptt:true, além de resolver JID/quoted/logs.
        return this.sendMediaMessage(
            phoneNumberId,
            to,
            opusBuffer,
            'audio/ogg; codecs=opus',
            undefined, // filename (voz não tem)
            undefined, // caption (WhatsApp ignora em PTT)
            quotedMessageId,
            quotedContent,
            quotedFromMe,
            true, // isPtt
            quotedParticipant
        );
    }

    // Send a contact card (vCard)
    async sendContact(
        phoneNumberId: string,
        to: string,
        contact: { displayName: string; phone: string },
        quotedMessageId?: string,
        quotedContent?: string,
        quotedFromMe?: boolean,
        quotedParticipant?: string
    ): Promise<{ success: boolean; messageId?: string; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_contact',
                success: false, error: 'Session not found',
                sessionStatus: 'no_session',
            });
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            const socketState = this.getSocketReadyState(session);
            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_contact',
                success: false, error: `Session not connected (status=${session.status})`,
                socketState, sessionStatus: session.status,
            });
            return { success: false, error: 'Session not connected' };
        }

        const reachoutBlock = (await this.checkReachoutLock(session, to, 'send_contact')) ?? (await this.checkMessageCapping(session, to, 'send_contact'));
        if (reachoutBlock) return { success: false, error: reachoutBlock };
        const gateBlock = await this.acquireSendSlot(session, to, 'send_contact');
        if (gateBlock) return { success: false, error: gateBlock };

        const socketState = this.getSocketReadyState(session);
        console.log(`[SendContact] Pre-send check: phoneNumberId=${phoneNumberId}, sessionStatus=${session.status}, socketReadyState=${socketState}, to=${to}`);

        try {
            let validJid: string;

            // Check if this is a group JID
            if (to.includes('@g.us')) {
                validJid = to;
                console.log('[SendContact] Sending to group:', validJid);
            } else {
                const cleanNumber = to.replace(/\D/g, '');
                validJid = `${cleanNumber}@s.whatsapp.net`;

                validJid = await this.resolveOutboundJid(session, cleanNumber, 'SendContact');
            }

            // Build vCard
            const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${contact.displayName}
TEL;type=CELL;type=VOICE;waid=${contact.phone.replace(/\D/g, '')}:${contact.phone}
END:VCARD`;

            // Build message options with quote if provided
            const messageOptions = this.quotedOptions(validJid, to, quotedMessageId, quotedContent, quotedFromMe, quotedParticipant);

            // Send contact message
            const sent = await this.clientOf(session).send(validJid, {
                type: 'contacts',
                displayName: contact.displayName,
                contacts: [{ displayName: contact.displayName, vcard }],
            }, messageOptions);
            const result = sent.raw as RawSentMessage | undefined;

            const messageId = sent.key.id || result?.key?.id || undefined;
            console.log(`[SendContact] Contact sent successfully, messageId: ${messageId}`);

            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_contact',
                success: true, messageId,
                socketState, sessionStatus: session.status,
            });

            return {
                success: true,
                messageId,
            };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[SendContact] Error sending contact:', error);

            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_contact',
                success: false, error: errMsg,
                socketState, sessionStatus: session.status,
            });

            return {
                success: false,
                error: errMsg,
            };
        }
    }

    // Envio de localização fixa (pino no mapa)
    async sendLocation(
        phoneNumberId: string,
        to: string,
        location: { latitude: number; longitude: number; name?: string; address?: string },
        quotedMessageId?: string,
        quotedContent?: string,
        quotedFromMe?: boolean,
        quotedParticipant?: string
    ): Promise<{ success: boolean; messageId?: string; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_location',
                success: false, error: 'Session not found',
                sessionStatus: 'no_session',
            });
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            const socketState = this.getSocketReadyState(session);
            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_location',
                success: false, error: `Session not connected (status=${session.status})`,
                socketState, sessionStatus: session.status,
            });
            return { success: false, error: 'Session not connected' };
        }

        const reachoutBlock = (await this.checkReachoutLock(session, to, 'send_location')) ?? (await this.checkMessageCapping(session, to, 'send_location'));
        if (reachoutBlock) return { success: false, error: reachoutBlock };
        const gateBlock = await this.acquireSendSlot(session, to, 'send_location');
        if (gateBlock) return { success: false, error: gateBlock };

        const socketState = this.getSocketReadyState(session);

        try {
            let validJid: string;
            if (to.includes('@g.us')) {
                validJid = to;
            } else {
                const cleanNumber = to.replace(/\D/g, '');
                validJid = `${cleanNumber}@s.whatsapp.net`;
                validJid = await this.resolveOutboundJid(session, cleanNumber, 'SendLocation');
            }

            const messageOptions = this.quotedOptions(validJid, to, quotedMessageId, quotedContent, quotedFromMe, quotedParticipant);

            const sent = await this.clientOf(session).send(validJid, {
                type: 'location',
                location: {
                    latitude: location.latitude,
                    longitude: location.longitude,
                    name: location.name || undefined,
                    address: location.address || undefined,
                },
            }, messageOptions);
            const result = sent.raw as RawSentMessage | undefined;

            const messageId = sent.key.id || result?.key?.id || undefined;
            console.log(`[SendLocation] Location sent successfully, messageId: ${messageId}`);

            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_location',
                success: true, messageId,
                socketState, sessionStatus: session.status,
            });

            return { success: true, messageId };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[SendLocation] Error sending location:', error);

            await this.logMessageEvent({
                phoneNumberId, toJid: to, action: 'send_location',
                success: false, error: errMsg,
                socketState, sessionStatus: session.status,
            });

            return { success: false, error: errMsg };
        }
    }

    /**
     * Envio de enquete (poll). Devolve o message_secret em base64 — o edge fn
     * persiste em metadata.poll para os votos decriptarem após restart.
     */
    async sendPoll(
        phoneNumberId: string,
        to: string,
        poll: { question: string; options: string[]; selectableCount: number }
    ): Promise<{ success: boolean; messageId?: string; messageSecret?: string | null; error?: string }> {
        const session = this.sessions.get(phoneNumberId);
        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }
        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        const reachoutBlock = (await this.checkReachoutLock(session, to, 'send_poll')) ?? (await this.checkMessageCapping(session, to, 'send_poll'));
        if (reachoutBlock) return { success: false, error: reachoutBlock };
        const gateBlock = await this.acquireSendSlot(session, to, 'send_poll');
        if (gateBlock) return { success: false, error: gateBlock };

        try {
            let validJid: string;
            if (to.includes('@g.us')) {
                validJid = to;
            } else {
                const cleanNumber = to.replace(/\D/g, '');
                validJid = `${cleanNumber}@s.whatsapp.net`;
                validJid = await this.resolveOutboundJid(session, cleanNumber, 'SendPoll');
            }

            const sent = await this.clientOf(session).send(validJid, {
                type: 'poll',
                poll: { name: poll.question, options: poll.options, selectableCount: poll.selectableCount },
            });
            const result = sent.raw as RawSentMessage | undefined;
            const messageId = sent.key.id || result?.key?.id || undefined;
            if (messageId && sent.messageSecret) {
                this.cacheSet(this.msgSecretCache, messageId, sent.messageSecret);
            }
            const messageSecret = sent.pollSecret ? sent.pollSecret.toString('base64') : null;

            console.log(`[SendPoll] Poll sent, messageId: ${messageId}, secret: ${messageSecret ? 'ok' : 'MISSING'}`);
            return { success: true, messageId, messageSecret };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[SendPoll] Error sending poll:', error);
            return { success: false, error: errMsg };
        }
    }

    /**
     * Endereçamento de um voto: LID ou PN. Não é escolha nossa — o
     * relayMessage do Baileys deriva a identidade do REMETENTE do servidor do
     * JID de destino (`isLid = server === 'lid'`), e quem recebe deriva a chave
     * do voto do autor do stanza. Se cifrarmos com o LID e relayarmos para o
     * PN (ou vice-versa), o AEAD falha do outro lado e o voto é descartado em
     * silêncio — era exatamente o bug do "painel marca, aparelho não conta".
     *
     * Daí a regra: destino, votante e criador SEMPRE no mesmo modo.
     *
     * E qual modo? Não há um só. Medido em produção: o cliente do contato
     * cifrou o voto dele com o LID, enquanto o nosso próprio aparelho cifrou com
     * o PN — o rollout de LID é por conta, então o mesmo chat tem clientes
     * derivando de formas diferentes. Por isso devolvemos uma LISTA: em 1:1 o
     * voto sai nas duas formas (cada uma no seu endereçamento) e quem recebe
     * abre a que entende. É seguro porque voto é last-write-wins por autor: a
     * cópia ilegível é descartada e a legível vale o mesmo valor.
     * Em grupo o `addressingMode` do metadata é autoritativo — envio único.
     */
    private async resolvePollAddressing(
        session: Session,
        to: string,
        poll: {
            pollCreatorFromMe: boolean;
            pollCreatorJid?: string | null;
            pollChatJid?: string | null;
        }
    ): Promise<PollVoteAddressing[]> {
        const client = this.clientOf(session);
        const me = client.me();
        const ourPn = normalizeJidUser(me?.jid ?? '');
        const ourLid = me?.lid ? normalizeJidUser(me.lid) : null;
        const norm = (jid: string) => normalizeJidUser(jid);
        const asLid = async (jid: string): Promise<string | null> => {
            if (jid.endsWith('@lid')) return norm(jid);
            return client.lidForPn(jid);
        };
        const asPn = async (jid: string): Promise<string | null> => {
            if (jid.endsWith('@s.whatsapp.net')) return norm(jid);
            return client.pnForLid(jid);
        };
        if (to.includes('@g.us')) {
            // Grupo: o modo é do grupo (o Baileys assume 'lid' quando o
            // metadata não diz nada — ver messages-send.ts).
            let addressing: string | undefined;
            try {
                addressing = (await client.getGroup(to)).addressingMode;
            } catch {
                console.warn('[PollAddressing] groupMetadata falhou, assumindo lid:', to);
            }
            const mode: 'lid' | 'pn' = addressing === 'pn' ? 'pn' : 'lid';
            const ourInMode = mode === 'lid' ? (ourLid ?? (await asLid(ourPn))) : ourPn;
            const stored = poll.pollCreatorJid ? norm(poll.pollCreatorJid) : null;
            const creator = poll.pollCreatorFromMe
                ? ourInMode
                : stored
                    ? (mode === 'lid' ? await asLid(stored) : await asPn(stored)) ?? stored
                    : ourInMode;
            if (!ourInMode || !creator) throw new Error('Own JID unavailable');
            return [{ mode, relayJid: to, voterJid: ourInMode, creatorJid: creator }];
        }

        // 1:1 — resolve o PN canônico (nono dígito etc.) e o LID do contato.
        const cleanNumber = to.replace(/\D/g, '');
        let peerPn = `${cleanNumber}@s.whatsapp.net`;
        try {
            const results = await client.lookup([cleanNumber]);
            if (results[0]?.exists) peerPn = norm(results[0].jid);
        } catch {
            console.warn('[PollAddressing] onWhatsApp falhou, usando JID cru:', peerPn);
        }
        const chatJid = poll.pollChatJid ? norm(poll.pollChatJid) : null;
        const peerLid = chatJid?.endsWith('@lid') ? chatJid : await asLid(peerPn);

        const lidAttempt: PollVoteAddressing | null = peerLid && ourLid
            ? {
                mode: 'lid',
                relayJid: peerLid,
                voterJid: ourLid,
                creatorJid: poll.pollCreatorFromMe ? ourLid : peerLid,
            }
            : null;
        const pnAttempt: PollVoteAddressing | null = ourPn
            ? {
                mode: 'pn',
                relayJid: peerPn,
                voterJid: ourPn,
                creatorJid: poll.pollCreatorFromMe ? ourPn : peerPn,
            }
            : null;

        // Ordem = palpite do endereçamento do chat (só afeta qual voto grava no
        // painel); ambas as formas vão pro WhatsApp de todo modo.
        const chatIsPn = chatJid?.endsWith('@s.whatsapp.net') === true;
        const ordered = chatIsPn ? [pnAttempt, lidAttempt] : [lidAttempt, pnAttempt];
        const attempts = ordered.filter((a): a is PollVoteAddressing => a !== null);
        if (attempts.length === 0) throw new Error('Own JID unavailable');
        return attempts;
    }

    /**
     * Voto do PAINEL numa enquete: espelho exato do decryptPollVote do Baileys
     * (HMAC de derivação + AES-256-GCM com AAD "pollMsgId\0voterJid"), relayado
     * como pollUpdateMessage. selectedOptions = nomes; [] retira o voto.
     */
    async votePoll(
        phoneNumberId: string,
        to: string,
        poll: {
            pollMsgId: string;
            pollCreatorFromMe: boolean;
            /** JID do criador quando a enquete é do contato/participante. */
            pollCreatorJid?: string | null;
            /** remoteJid do chat da enquete (metadata.poll.chat_jid), se conhecido. */
            pollChatJid?: string | null;
            /** metadata.poll.message_secret (base64). */
            messageSecretB64: string;
        },
        selectedOptions: string[]
    ): Promise<{ success: boolean; voterJid?: string; error?: string }> {
        const session = this.sessions.get(phoneNumberId);
        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }
        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            const attempts = await this.resolvePollAddressing(session, to, poll);
            const secret = Buffer.from(poll.messageSecretB64, 'base64');
            const sent: PollVoteAddressing[] = [];
            let lastError: string | null = null;
            for (const attempt of attempts) {
                const { mode, relayJid, voterJid, creatorJid: pollCreatorJid } = attempt;
                let messageId: string;
                try {
                    ({ messageId } = await this.clientOf(session).votePoll(relayJid, {
                        pollKey: { id: poll.pollMsgId, chatJid: relayJid, fromMe: poll.pollCreatorFromMe },
                        pollSecret: secret,
                        voterJid,
                        creatorJid: pollCreatorJid,
                        selectedOptions,
                    }));
                } catch (voteError) {
                    lastError = voteError instanceof Error ? voteError.message : 'unknown';
                    continue;
                }
                sent.push(attempt);
                void this.debugLog(phoneNumberId, 'poll_vote_out', relayJid, {
                    mode,
                    relay_jid: relayJid,
                    voter_jid: voterJid,
                    creator_jid: pollCreatorJid,
                    creator_from_me: poll.pollCreatorFromMe,
                    chat_jid_hint: poll.pollChatJid ?? null,
                    update_msg_id: messageId,
                    attempt_of: attempts.length,
                    selected: selectedOptions,
                }, poll.pollMsgId);
            }
            if (sent.length === 0) {
                return { success: false, error: lastError ?? 'Vote relay failed' };
            }
            // O painel grava o voto sob a identidade da primeira forma enviada.
            return { success: true, voterJid: sent[0]!.voterJid };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[VotePoll] Error voting on poll:', error);
            return { success: false, error: errMsg };
        }
    }

    /**
     * Confirmação de leitura (tique azul no aparelho do contato).
     * keys: wamids inbound; participant obrigatório em grupo, senão o WhatsApp
     * ignora o recibo. Redundância é inofensiva — sem idempotência própria.
     */
    async markMessagesRead(
        phoneNumberId: string,
        jid: string,
        keys: Array<{ id: string; participant?: string | null }>
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);
        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }
        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            await this.clientOf(session).markRead(keys.map((key) => ({
                chatJid: jid,
                id: key.id,
                fromMe: false,
                participantJid: key.participant ?? undefined,
            })));
            console.log(`[MarkRead] ${keys.length} recibo(s) de leitura enviados para ${jid}`);
            return { success: true };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[MarkRead] Error sending read receipts:', error);
            return { success: false, error: errMsg };
        }
    }

    // Delete a message (for QR connections only)
    async deleteMessage(
        phoneNumberId: string,
        to: string,
        messageId: string,
        fromMe: boolean = true
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            const validJid = await this.resolveJid(session, to);
            console.log('[DeleteMessage] Using resolved JID:', validJid);

            // Build delete key - per Baileys docs: { delete: msg.key }
            // For groups, add participant to identify who sent it
            const deleteKey: any = {
                remoteJid: validJid,
                id: messageId,
                fromMe: fromMe,
            };

            // Only add participant for GROUP messages (required to identify sender)
            if (to.includes('@g.us')) {
                // For groups, get own JID and strip device suffix
                const ownJid = session.client?.me()?.jid;
                if (fromMe && ownJid) {
                    deleteKey.participant = ownJid;
                }
            }

            console.log('[DeleteMessage] Deleting message with key:', JSON.stringify(deleteKey));

            const sent = await this.clientOf(session).send(validJid, {
                type: 'revoke',
                revoke: { targetKey: { id: messageId, chatJid: validJid, fromMe, participantJid: deleteKey.participant } },
            });
            const result = sent.raw as RawSentMessage | undefined;

            console.log('[DeleteMessage] sendMessage result:', JSON.stringify(result, null, 2));

            if (result?.status) {
                console.log('[DeleteMessage] Status:', result.status);
            }

            console.log('[DeleteMessage] Message deleted successfully');
            return { success: true };
        } catch (error) {
            console.error('[DeleteMessage] Error deleting message:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    // Edit a message (for QR connections only)
    async editMessage(
        phoneNumberId: string,
        to: string,
        messageId: string,
        newContent: string,
        messageType?: string
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        // Map message_type to Baileys protobuf media field name
        const captionMediaField: Record<string, 'imageMessage' | 'videoMessage' | 'documentMessage'> = {
            image: 'imageMessage',
            video: 'videoMessage',
            document: 'documentMessage',
        };
        const isCaptionEdit = !!(messageType && captionMediaField[messageType]);
        const isUnsupportedMediaEdit = messageType === 'audio' || messageType === 'sticker';

        if (isUnsupportedMediaEdit) {
            return { success: false, error: 'This media type does not support caption editing' };
        }

        try {
            const validJid = await this.resolveJid(session, to);
            console.log('[EditMessage] Using resolved JID:', validJid);

            // Build edit key - per Baileys docs: { edit: response.key }
            const editKey: any = {
                remoteJid: validJid,
                id: messageId,
                fromMe: true, // Can only edit your own messages
            };

            // Only add participant for GROUP messages (required to identify sender)
            if (to.includes('@g.us')) {
                const ownJid = session.client?.me()?.jid;
                if (ownJid) {
                    editKey.participant = ownJid;
                }
            }

            console.log('[EditMessage] Editing message with key:', JSON.stringify(editKey));
            console.log('[EditMessage] New content:', newContent);
            console.log('[EditMessage] Message type:', messageType, '| caption edit:', isCaptionEdit);

            if (isCaptionEdit) {
                // Caption edit: build protocolMessage manually so Baileys does not try
                // to re-upload media via prepareWAMessageMedia (which throws "Invalid media type").
                const captionOf = captionMediaField[messageType!].replace('Message', '') as 'image' | 'video' | 'document';
                await this.clientOf(session).send(validJid, {
                    type: 'edit',
                    edit: { targetKey: { id: messageId, chatJid: validJid, fromMe: true, participantJid: editKey.participant }, newText: newContent, captionOf },
                });
                return { success: true };
            }

            // Plain text edit
            const sent = await this.clientOf(session).send(validJid, {
                type: 'edit',
                edit: { targetKey: { id: messageId, chatJid: validJid, fromMe: true, participantJid: editKey.participant }, newText: newContent },
            });
            const result = sent.raw as RawSentMessage | undefined;
            console.log('[EditMessage] sendMessage result:', JSON.stringify(result, null, 2));

            if (result?.status) {
                console.log('[EditMessage] Status:', result.status);
            }

            console.log('[EditMessage] Message edited successfully');
            return { success: true };
        } catch (error) {
            console.error('[EditMessage] Error editing message:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    // Send a reaction to a message (for QR connections only)
    async sendReaction(
        phoneNumberId: string,
        to: string,
        messageId: string,
        emoji: string, // Empty string to remove reaction
        fromMe: boolean = false,
        participant?: string // JID of who sent the original message (for groups)
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            const validJid = await this.resolveJid(session, to);
            console.log('[SendReaction] Using resolved JID:', validJid);

            // Build reaction key
            const reactionKey: any = {
                remoteJid: validJid,
                id: messageId,
                fromMe: fromMe,
            };

            // For groups, add participant to identify who sent the original message
            if (to.includes('@g.us')) {
                if (fromMe) {
                    // Our own message - use our JID
                    const ownJid = session.client?.me()?.jid;
                    if (ownJid) {
                        reactionKey.participant = ownJid;
                    }
                } else if (participant) {
                    // Someone else's message - use provided participant JID
                    reactionKey.participant = participant;
                }
            }

            console.log('[SendReaction] Reacting to message with key:', JSON.stringify(reactionKey));
            console.log('[SendReaction] Emoji:', emoji || '(removing reaction)');

            await this.clientOf(session).send(validJid, {
                type: 'reaction',
                reaction: { targetKey: { id: messageId, chatJid: validJid, fromMe, participantJid: reactionKey.participant }, emoji },
            });

            console.log('[SendReaction] Reaction sent successfully');
            return { success: true };
        } catch (error) {
            console.error('[SendReaction] Error sending reaction:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Envia o chatstate de "digitando"/"gravando" para um contato ou grupo.
     *
     * ORTOGONAL ao toggle keep_device_notifications, e isso é garantia do Baileys,
     * não coincidência: sendPresenceUpdate tem dois ramos (Socket/chats.ts).
     * 'available'/'unavailable' emitem um nó <presence> GLOBAL; qualquer outro
     * estado cai no else e emite um <chatstate> endereçado a um JID. Ou seja,
     * 'composing' não nos marca online e não interfere nas notificações do
     * celular — não amarre este método ao toggle.
     *
     * O estado expira sozinho em ~10s do lado do WhatsApp. Quem refresca é o
     * cliente (ver useTypingPresence no front), de propósito: um timer aqui teria
     * que ser limpo nos seis caminhos de teardown que já cuidam do presenceInterval.
     *
     * Best-effort por natureza: NÃO chama logMessageEvent (grava no banco, e isto
     * dispara a cada poucos segundos por atendente digitando).
     */
    async sendChatState(
        phoneNumberId: string,
        to: string,
        state: 'composing' | 'recording' | 'paused'
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        // getSocketReadyState é ADVISORY, não gate: no Baileys 7 o socket.ws é um
        // wrapper (WebSocketClient) sem readyState, então o @ts-ignore devolve -1
        // mesmo com a sessão sã — sendMessage só loga e segue por isso mesmo.
        // Bloquear aqui recusava 100% dos chatstates ("Socket not open") numa
        // sessão que enviava mensagens normalmente.
        const socketState = this.getSocketReadyState(session);
        if (socketState !== 1) {
            console.debug(`[ChatState] socket readyState=${socketState} (advisory) for ${phoneNumberId}`);
        }

        try {
            const validJid = await this.resolveJidCached(session, to);
            await this.clientOf(session).sendChatState(validJid, state);
            return { success: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.debug(`[ChatState] ${state} -> ${to} failed for ${phoneNumberId}: ${message}`);
            return { success: false, error: message };
        }
    }

    /**
     * Assina a presença de um chat. O WhatsApp não empurra presença de quem você
     * não assinou, então sem isto o presence.update simplesmente nunca dispara.
     *
     * NÃO sacrifica as notificações do celular: presenceSubscribe emite um nó
     * <presence type="subscribe"> endereçado ao JID (Socket/chats.ts), não o
     * <presence> global de available/unavailable. É ortogonal ao toggle
     * keep_device_notifications, igual ao sendChatState.
     */
    async subscribeToPresence(
        phoneNumberId: string,
        to: string
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) return { success: false, error: 'Session not found' };
        if (session.status !== 'connected') return { success: false, error: 'Session not connected' };

        try {
            const validJid = await this.resolveJidCached(session, to);
            await this.clientOf(session).subscribePresence(validJid);
            await this.seedLidForPresence(session, validJid);
            console.log(`[Presence] subscribed phone=${phoneNumberId} jid=${validJid}`);
            return { success: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.debug(`[Presence] subscribe ${to} failed for ${phoneNumberId}: ${message}`);
            return { success: false, error: message };
        }
    }

    /**
     * resolveJid() com memoização por sessão. Só para o caminho de presença: o
     * chatstate refresca a cada ~8s enquanto o atendente digita, e resolveJid()
     * faz onWhatsApp() na rede. O resolveJid() original fica intocado para não
     * mudar o comportamento dos envios de mensagem.
     */
    private async resolveJidCached(session: Session, to: string): Promise<string> {
        if (!session.presenceJidCache) {
            session.presenceJidCache = new Map();
        }

        const cached = session.presenceJidCache.get(to);
        if (cached) return cached;

        const resolved = await this.resolveJid(session, to);

        // Teto pequeno: são as conversas abertas no momento, não o catálogo todo.
        if (session.presenceJidCache.size >= 200) {
            const oldest = session.presenceJidCache.keys().next().value;
            if (oldest !== undefined) session.presenceJidCache.delete(oldest);
        }
        session.presenceJidCache.set(to, resolved);

        return resolved;
    }

    // Get list of groups for a session
    async getGroups(phoneNumberId: string): Promise<{ success: boolean; groups?: Array<{ jid: string; subject: string; participants: number }>; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            // Fetch all groups the user is participating in
            const groups = await this.clientOf(session).listGroups();
            const groupList = groups.map((group) => ({
                jid: group.jid,
                subject: group.subject || group.jid.replace('@g.us', ''),
                participants: group.participants.length,
            }));

            console.log(`[GetGroups] Found ${groupList.length} groups for ${phoneNumberId}`);

            return {
                success: true,
                groups: groupList
            };
        } catch (error) {
            console.error('Error fetching groups:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }



    // Helper to resolve the correct JID (handling Brazilian number variations)
    private async resolveJid(session: Session, to: string): Promise<string> {
        // Group JID - use as-is
        if (to.includes('@g.us')) {
            return to;
        }

        // Individual contact - process phone number
        const cleanNumber = to.replace(/\D/g, '');

        // Use EXACT number — do NOT generate variations for outbound.
        // Both 551133330001 and 5511933330001 can be different people.
        let validJid = `${cleanNumber}@s.whatsapp.net`; // Default

        // If session is connected, verify the exact number
        if (session.client && session.status === 'connected') {
            validJid = await this.resolveOutboundJid(session, cleanNumber, 'ResolveJid');
        }

        return validJid;
    }

    // Helper function to generate Brazilian phone number variations
    private getBrazilianPhoneVariations(phone: string): string[] {
        const variations: string[] = [phone];

        // Only process Brazilian numbers (starting with 55)
        if (!phone.startsWith('55')) {
            return variations;
        }

        const withoutCountry = phone.substring(2); // Remove 55

        if (withoutCountry.length >= 10) {
            const ddd = withoutCountry.substring(0, 2);
            const localNumber = withoutCountry.substring(2);

            if (localNumber.length === 9 && localNumber.startsWith('9')) {
                // Has 9, add version without
                const without9 = '55' + ddd + localNumber.substring(1);
                variations.push(without9);
            } else if (localNumber.length === 8) {
                // No 9, add version with
                const with9 = '55' + ddd + '9' + localNumber;
                variations.push(with9);
            }
        }

        console.log('[SendMessage] Generated variations for', phone, ':', variations);
        return variations;
    }

    // ============================================
    // GROUP MANAGEMENT METHODS
    // ============================================

    /**
     * URL guardada da foto do grupo — a do Storage, não a viva da CDN do WhatsApp.
     *
     * Antes esta função consultava o WhatsApp (até 10s) e devolvia a URL do
     * `pps.whatsapp.net`, que EXPIRA e nunca era persistida, correndo contra um teto
     * de 2,5s: perdida a corrida, o painel abria com o ícone e só a segunda abertura
     * mostrava a foto. Agora é uma leitura indexada no banco (~10ms) que termina
     * muito antes do `groupMetadata`, e a foto que aparece no painel é a MESMA que
     * aparece na lista de conversas. Faltando ou vencida, enfileira e devolve o que
     * houver — a próxima abertura já pega.
     */
    private async getStoredGroupPictureUrl(
        phoneNumberId: string,
        groupJid: string
    ): Promise<string | null> {
        const key = this.avatarKey(phoneNumberId, groupJid);
        const cached = this.groupAvatarUrlCache.get<string | null>(key);
        if (cached !== undefined) return cached;

        const conv = await this.resolveConversationForAvatar(phoneNumberId, groupJid, true);

        if (!conv || !this.isAvatarFresh(conv)) {
            this.enqueueAvatarFetch(phoneNumberId, groupJid, { quality: 'image' });
        }
        if (!conv) return null;

        this.cacheSet(this.groupAvatarUrlCache, key, conv.avatarUrl);
        return conv.avatarUrl;
    }

    /**
     * Dígitos do telefone a partir do que o Baileys chama de PN. Pode chegar como
     * JID com sufixo de device (`5511999999999:0@s.whatsapp.net`), como JID limpo,
     * ou já só como dígitos — formato que o lidPhoneCache gravava antes. `@lid` não
     * é telefone e sai como undefined.
     */
    private pnDigits(value?: string | null): string | undefined {
        if (!value) return undefined;
        if (value.endsWith('@lid')) return undefined;
        const user = value.includes('@') ? normalizeJidUser(value).split('@')[0] : value;
        return /^\d+$/.test(user) ? user : undefined;
    }

    /**
     * Telefone de LIDs pelo store do próprio Baileys: LRU + os arquivos
     * lid-mapping-*.json da pasta da sessão, que o Baileys alimenta sozinho com o
     * participantAlt de toda mensagem recebida e que sobrevive a restart — ao
     * contrário do lidPhoneCache, que é memória pura com 24h de TTL.
     *
     * Consulta local: getPNsForLIDs não tem fallback de rede (o sentido inverso,
     * PN→LID, tem). Falhar aqui não pode derrubar a listagem do grupo.
     */
    private async lookupPnsForLids(session: Session, lids: string[]): Promise<Map<string, string>> {
        const resolved = new Map<string, string>();
        if (lids.length === 0 || !session.client) return resolved;
        try {
            const pairs = await session.client.lookupPnsForLids(lids);
            for (const [lid, pn] of pairs) {
                const digits = this.pnDigits(pn);
                if (digits) resolved.set(lid, digits);
            }
        } catch (error) {
            console.warn('[LID] lookup falhou:', error instanceof Error ? error.message : error);
        }
        return resolved;
    }

    /**
     * LID → telefone. Ordem: cache do processo, store da lib (sem tráfego) e, por
     * último, o caminho inverso pelo servidor: `candidates` são telefones que o
     * chamador suspeita serem os donos dos LIDs (as conversas 1:1 da mesma linha);
     * `lookup()` devolve o LID de cada telefone e casamos com os pendentes. É um
     * IQ por lote de 50 — sob demanda, teto de 500 candidatos por chamada, nunca
     * automático: consulta de existência em série é o que o anti-abuso vigia.
     */
    async resolveLids(
        phoneNumberId: string,
        lids: string[],
        candidates: string[] = []
    ): Promise<{ success: boolean; mappings?: Array<{ lid: string; phone: string }>; error?: string; reverse?: { candidates: number; matched: number } }> {
        const session = this.sessions.get(phoneNumberId);
        if (!session?.client) return { success: false, error: 'Session not found' };
        if (session.status !== 'connected') return { success: false, error: 'Session not connected' };

        const mappings: Array<{ lid: string; phone: string }> = [];
        const pending = new Set<string>();
        for (const lid of new Set(lids.map(l => String(l).replace('@lid', '').trim()).filter(Boolean))) {
            const cached = this.lidPhoneCache.get<string>(lid);
            if (cached) mappings.push({ lid, phone: cached });
            else pending.add(lid);
        }
        const resolved = await this.lookupPnsForLids(session, [...pending]);
        for (const [lid, phone] of resolved) {
            this.cacheSet(this.lidPhoneCache, lid, phone);
            mappings.push({ lid, phone });
            pending.delete(lid);
        }

        let reverse: { candidates: number; matched: number } | undefined;
        const digitsList = [...new Set(candidates.map((c) => String(c).replace(/\D/g, '')).filter((d) => d.length >= 8))].slice(0, 500);
        if (pending.size > 0 && digitsList.length > 0) {
            let matched = 0;
            for (let i = 0; i < digitsList.length && pending.size > 0; i += 50) {
                const chunk = digitsList.slice(i, i + 50);
                let results: Awaited<ReturnType<WhatsAppClient['lookup']>> = [];
                try {
                    results = await session.client.lookup(chunk);
                } catch (error) {
                    console.warn('[LID] lookup reverso falhou:', error instanceof Error ? error.message : error);
                    break;
                }
                for (const r of results) {
                    const lidId = r.lid ? String(r.lid).split('@')[0].split(':')[0] : '';
                    const phone = this.pnDigits(r.jid);
                    if (!lidId || !phone || !pending.has(lidId)) continue;
                    this.cacheSet(this.lidPhoneCache, lidId, phone);
                    mappings.push({ lid: lidId, phone });
                    pending.delete(lidId);
                    matched++;
                }
            }
            reverse = { candidates: digitsList.length, matched };
            void this.debugLog(phoneNumberId, 'lid_reverse_lookup', 'system', {
                requested: lids.length, candidates: digitsList.length, matched, still_pending: pending.size,
            });
        }
        return { success: true, mappings, reverse };
    }

    async getGroupMetadata(
        phoneNumberId: string,
        groupJid: string,
        options: { includePicture?: boolean } = {}
    ): Promise<{
        success: boolean;
        group?: {
            jid: string;
            subject: string;
            description?: string;
            owner?: string;
            pictureUrl: string | null;
            announce: boolean;
            restrict: boolean;
            memberAddMode: boolean;
            joinApprovalMode: boolean;
            ephemeralDuration: number;
            /** Restrições impostas pelo WhatsApp ao grupo (só libs que entregam; ausente = desconhecido). */
            suspended?: boolean;
            appealStatus?: string;
            growthLockedUntil?: string;
            participants: Array<{
                id: string;
                phone: string;
                jid?: string;
                name?: string;
                isAdmin: boolean;
                isSuperAdmin: boolean;
                isLid?: boolean; // True if this is a LID (no phone available)
            }>;
            /**
             * A própria linha dentro do grupo (null = não achada na lista). O front
             * só libera "Adicionar" com `me.isAdmin`: adicionar sem ser admin derruba
             * a sessão (401 <conflict>). Desde a 2.5.6.
             */
            me: { id: string; isAdmin: boolean; isSuperAdmin: boolean } | null;
        };
        error?: string;
    }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            // Foto e metadata em paralelo. A foto agora é uma leitura no banco, não
            // mais uma consulta de até 10s ao WhatsApp — mas o paralelo continua de
            // graça e mantém o padrão. `includePicture: false` (o `?picture=0` do
            // autocomplete de menção) segue dispensando a consulta por inteiro.
            const picturePromise = options.includePicture === false
                ? Promise.resolve(null)
                : this.getStoredGroupPictureUrl(phoneNumberId, groupJid);

            const client = this.clientOf(session);
            const meta = await client.getGroup(groupJid);
            const growthLocked = (meta.growthLockedUntil ?? 0) > Date.now();
            if (meta.suspended || growthLocked) {
                // Sinal antecipado de penalidade no grupo (antes do 401/403 da sessão).
                void this.debugLog(phoneNumberId, 'group_restricted', groupJid, {
                    subject: meta.subject,
                    suspended: meta.suspended ?? null,
                    appeal_status: meta.appealStatus ?? null,
                    growth_locked_until: meta.growthLockedUntil ? new Date(meta.growthLockedUntil).toISOString() : null,
                });
            }
            const pendingLids = meta.participants
                .filter((p) => p.jid.endsWith('@lid') && !p.phoneJid)
                .map((p) => p.jid);
            const lidStorePhones = await this.lookupPnsForLids(session, pendingLids);
            const newMappings: Array<{ lid: string; pn: string }> = [];
            const participants = meta.participants.map((p) => {
                const id = p.jid;
                const isLid = id.endsWith('@lid');
                let phone: string;
                let name: string | undefined;
                let resolved = false;
                if (isLid) {
                    const lidId = id.replace('@lid', '');
                    const fromMetadata = this.pnDigits(p.phoneJid);
                    const fromStore = lidStorePhones.get(id);
                    const cachedPhone = this.pnDigits(this.lidPhoneCache.get<string>(lidId));
                    const resolvedPhone = fromMetadata || fromStore || cachedPhone;
                    if (resolvedPhone) {
                        phone = resolvedPhone;
                        resolved = true;
                        if (resolvedPhone !== cachedPhone) {
                            this.cacheSet(this.lidPhoneCache, lidId, resolvedPhone);
                        }
                        if (fromMetadata && !fromStore && p.phoneJid) {
                            newMappings.push({ lid: id, pn: p.phoneJid });
                        }
                    } else {
                        phone = lidId;
                    }
                    name = this.lidNameCache.get<string>(lidId) || p.name || undefined;
                } else {
                    phone = id.replace('@s.whatsapp.net', '');
                    name = p.name || undefined;
                }
                const mentionJid = p.phoneJid || (isLid ? undefined : id);
                return {
                    id,
                    phone,
                    jid: mentionJid, // JID real para menções (@s.whatsapp.net)
                    name,
                    isAdmin: p.role === 'admin' || p.role === 'superadmin',
                    isSuperAdmin: p.role === 'superadmin',
                    isLid: isLid && !resolved, // só marca LID se não resolveu
                };
            });
            if (newMappings.length > 0) {
                // Semeia o store da lib: próximos eventos desse LID já chegam com telefone.
                void client.storeLidMappings(newMappings).catch((error: unknown) => {
                    console.warn('[LID] storeLidMappings falhou:', error instanceof Error ? error.message : error);
                });
            }
            const self = findSelfParticipant(meta.participants, client.me());
            const pictureUrl = await picturePromise;
            return {
                success: true,
                group: {
                    jid: meta.jid,
                    subject: meta.subject,
                    description: meta.description || undefined,
                    owner: meta.ownerJid?.replace('@s.whatsapp.net', '').replace('@lid', ''),
                    pictureUrl,
                    announce: meta.announce,
                    restrict: meta.restrict,
                    memberAddMode: meta.memberAddMode === 'all_member_add',
                    joinApprovalMode: meta.joinApprovalMode,
                    ephemeralDuration: meta.ephemeralDuration ?? 0,
                    suspended: meta.suspended,
                    appealStatus: meta.appealStatus,
                    growthLockedUntil: growthLocked && meta.growthLockedUntil ? new Date(meta.growthLockedUntil).toISOString() : undefined,
                    participants,
                    me: self
                        ? { id: self.jid, isAdmin: isGroupAdminRole(self.role), isSuperAdmin: self.role === 'superadmin' }
                        : null,
                },
            };
        } catch (error) {
            console.error('Error fetching group metadata:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    async createGroup(
        phoneNumberId: string,
        name: string,
        participants: string[],
        settings?: GroupCreateSettings
    ): Promise<{ success: boolean; groupJid?: string; error?: string; settingsErrors?: Record<string, string> }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        let groupJid: string;
        try {
            // Telefone → JID que o WhatsApp reconhece (9º dígito etc.), como no envio de mensagem.
            const participantJids = await toParticipantJids(participants, (digits) =>
                this.resolveOutboundJid(session, digits, 'CreateGroup')
            );

            const result = await this.clientOf(session).createGroup(name, participantJids);
            groupJid = result.jid;

            console.log(`[CreateGroup] Created group: ${groupJid}`);
        } catch (error) {
            console.error('Error creating group:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }

        // Group exists at this point — a failed setting is reported per-key, not a hard failure
        const settingsErrors: Record<string, string> = {};
        if (settings) {
            if (settings.announce !== undefined) {
                const r = await this.updateGroupSetting(phoneNumberId, groupJid, settings.announce ? 'announcement' : 'not_announcement');
                if (!r.success) settingsErrors.announce = r.error ?? 'Unknown error';
            }
            if (settings.restrict !== undefined) {
                const r = await this.updateGroupSetting(phoneNumberId, groupJid, settings.restrict ? 'locked' : 'unlocked');
                if (!r.success) settingsErrors.restrict = r.error ?? 'Unknown error';
            }
            if (settings.memberAddMode !== undefined) {
                const r = await this.updateGroupMemberAddMode(phoneNumberId, groupJid, settings.memberAddMode);
                if (!r.success) settingsErrors.memberAddMode = r.error ?? 'Unknown error';
            }
            if (settings.joinApprovalMode !== undefined) {
                const r = await this.updateGroupJoinApprovalMode(phoneNumberId, groupJid, settings.joinApprovalMode);
                if (!r.success) settingsErrors.joinApprovalMode = r.error ?? 'Unknown error';
            }
            if (settings.ephemeralDuration !== undefined) {
                const r = await this.updateGroupEphemeral(phoneNumberId, groupJid, settings.ephemeralDuration);
                if (!r.success) settingsErrors.ephemeralDuration = r.error ?? 'Unknown error';
            }
        }

        return {
            success: true,
            groupJid,
            ...(Object.keys(settingsErrors).length > 0 ? { settingsErrors } : {}),
        };
    }

    async addGroupParticipants(
        phoneNumberId: string,
        groupJid: string,
        participants: string[]
    ): Promise<{
        success: boolean;
        error?: string;
        details?: Record<string, string>;
        inviteRequired?: Array<{ phone: string; jid: string; code: string; expiration: number }>;
        /** Recusa nossa, antes de falar com o WhatsApp (a rota devolve 403). */
        code?: GroupAddBlock['code'];
    }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            // Só admin adiciona (ou membro, no grupo "todos adicionam"), e só em grupo sem
            // restrição do WhatsApp. Adicionar sem permissão é o que o anti-abuso pune com
            // <stream:error code="401"><conflict/>: a sessão cai e não volta sozinha.
            // A consulta extra ao metadata custa um iq; a queda custava horas.
            // Decisão em lib/groupSelf.ts.
            const client = this.clientOf(session);
            const meta = await client.getGroup(groupJid);
            const block = checkCanAddParticipants(meta, client.me());
            if (block) {
                void this.debugLog(phoneNumberId, 'group_add_blocked', groupJid, {
                    reason: block.reason,
                    requested: participants.length,
                    subject: meta.subject,
                });
                return { success: false, code: block.code, error: block.error };
            }

            // Telefone → JID que o WhatsApp reconhece, pelo mesmo lookup do envio de mensagem.
            // Cru, o celular que está no WhatsApp sem o 9º dígito voltava 451 (ver lib/groupAdd.ts).
            const participantJids = await toParticipantJids(participants, (digits) =>
                this.resolveOutboundJid(session, digits, 'AddParticipants')
            );

            console.log(`[AddParticipants] Input: ${JSON.stringify(participants)}`);
            console.log(`[AddParticipants] JIDs: ${JSON.stringify(participantJids)}`);

            const result = await client.updateGroupParticipants(groupJid, participantJids, 'add');
            const failures = result.filter((r) => r.status !== '200');
            if (failures.length > 0) {
                const errorDetails: Record<string, string> = {};
                const inviteRequired: Array<{ phone: string; jid: string; code: string; expiration: number }> = [];
                for (const f of failures) {
                    // LID sem telefone: o servidor às vezes devolve o par em phone_number;
                    // com um único participante, o pedido original já diz quem é.
                    const pnJid: string | undefined =
                        f.jid.endsWith('@s.whatsapp.net') ? f.jid
                        : f.phoneJid
                        ?? (participantJids.length === 1 ? participantJids[0] : undefined);
                    const phone = (pnJid || f.jid)?.replace('@s.whatsapp.net', '').replace('@lid', '') || 'unknown';
                    // 403 com add_request = privacidade do contato; o convite vai por DM.
                    if (f.status === '403' && f.inviteCode && pnJid) {
                        inviteRequired.push({
                            phone,
                            jid: pnJid,
                            code: f.inviteCode,
                            expiration: f.inviteExpiration ?? 0,
                        });
                        continue;
                    }
                    errorDetails[phone] = groupAddRefusalMessage(f.status);
                    console.log(`[AddParticipants] ${phone} recusado pelo WhatsApp com código ${f.status}`);
                }

                console.log(`[AddParticipants] Failures: ${JSON.stringify(errorDetails)}, inviteRequired: ${inviteRequired.length}`);

                // If every participant truly failed (invite-required doesn't count as failure), return error
                const realFailures = Object.keys(errorDetails).length;
                if (realFailures === result.length) {
                    return {
                        success: false,
                        error: joinGroupAddRefusals(Object.values(errorDetails)),
                        details: errorDetails
                    };
                }

                // Added, invite-pending, or a mix — real failures reported in details
                return {
                    success: true,
                    details: realFailures > 0 ? errorDetails : undefined,
                    inviteRequired: inviteRequired.length > 0 ? inviteRequired : undefined
                };
            }

            console.log(`[AddParticipants] Successfully added ${participants.length} to ${groupJid}`);
            return { success: true };
        } catch (error) {
            console.error('[AddParticipants] Error:', error);
            return {
                success: false,
                error: this.getBaileysThrownMessage(error),
            };
        }
    }

    /**
     * Traduz o erro LANÇADO por uma query do Baileys. O Boom criado por
     * assertNodeErrorFree usa o texto cru do servidor como mensagem
     * ("item-not-found", "forbidden"...) e guarda o código em `data`, não em
     * `output.statusCode` — por isso getBaileysErrorMessage() não serve aqui.
     */
    private getBaileysThrownMessage(error: unknown): string {
        if (!(error instanceof Error)) return 'Unknown error';

        // Checagem estrutural em vez de instanceof: o Boom vem do @hapi/boom do
        // Baileys, que pode ser outra cópia do módulo e reprovaria no instanceof.
        const boom = error as { isBoom?: boolean; data?: unknown };
        const code = error instanceof WhatsAppClientError
            ? error.statusCode
            : boom.isBoom === true ? Number(boom.data) : undefined;
        const text = error.message.toLowerCase();

        if (code === 404 || text.includes('item-not-found')) {
            return 'Convite expirado ou grupo não encontrado — tente adicionar novamente';
        }
        if (code === 403 || text.includes('forbidden')) {
            return 'Sem permissão para essa ação no grupo';
        }
        if (code === 401 || text.includes('not-authorized')) {
            return 'Sessão sem autorização — reconecte o número';
        }

        return error.message;
    }

    private getBaileysStatusMessage(status: string | number): string {
        const statusMap: Record<string, string> = {
            '200': 'Sucesso',
            '403': 'Sem permissão (você não é admin)',
            '408': 'Número não existe no WhatsApp',
            '409': 'Já é participante do grupo',
            '500': 'Erro interno do WhatsApp',
        };
        return statusMap[String(status)] || `Erro ${status}`;
    }

    async sendGroupInviteMessage(
        phoneNumberId: string,
        groupJid: string,
        toJid: string,
        code: string,
        expiration: number,
        text: string
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        const reachoutBlock = await this.checkReachoutLock(session, toJid, 'send_group_invite');
        if (reachoutBlock) return { success: false, error: reachoutBlock };
        const gateBlock = await this.acquireSendSlot(session, toJid, 'send_group_invite');
        if (gateBlock) return { success: false, error: gateBlock };

        try {
            let subject = '';
            try {
                const meta = await this.clientOf(session).getGroup(groupJid);
                subject = meta.subject || '';
            } catch {
                // subject is cosmetic on the invite card; send without it
            }

            // O Baileys anexa a foto do grupo como thumbnail do card de convite e NÃO
            // trata o erro (Utils/messages.js): em grupo sem foto o IQ w:profile:picture
            // volta 404 e o send inteiro estoura com "item-not-found". O thumbnail é
            // cosmético, então degradamos em vez de perder o convite.
            // `getProfilePicUrl` existe em MessageContentGenerationOptions, mas não na
            // assinatura pública de sendMessage — o Baileys espalha `...options` por cima
            // dos defaults, então a sobrescrita vale.
            await this.clientOf(session).send(toJid, {
                type: 'group_invite',
                invite: { groupJid, groupName: subject, caption: text, inviteCode: code, inviteExpiration: expiration },
            });

            console.log(`[SendGroupInvite] Invite for ${groupJid} sent to ${toJid}`);
            return { success: true };
        } catch (error) {
            console.error('[SendGroupInvite] Error:', error);
            return {
                success: false,
                error: this.getBaileysThrownMessage(error),
            };
        }
    }

    async removeGroupParticipants(
        phoneNumberId: string,
        groupJid: string,
        participants: string[]
    ): Promise<{ success: boolean; error?: string; details?: Record<string, string> }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            // For removing, we need the exact JID format (could be @s.whatsapp.net or @lid)
            // Frontend should pass the full participant.id from getGroupMetadata
            const participantJids = participants.map((p) => {
                if (p.includes('@')) return p;
                // Fallback: assume phone number format
                return `${p}@s.whatsapp.net`;
            });

            console.log(`[RemoveParticipants] Input: ${JSON.stringify(participants)}`);
            console.log(`[RemoveParticipants] JIDs: ${JSON.stringify(participantJids)}`);

            const result = await this.clientOf(session).updateGroupParticipants(groupJid, participantJids, 'remove');

            console.log(`[RemoveParticipants] Baileys result: ${JSON.stringify(result)}`);

            // Check for failures
            const failures = result.filter((r) => r.status !== '200');

            if (failures.length > 0) {
                const errorDetails: Record<string, string> = {};
                failures.forEach((f) => {
                    const phone = f.jid?.replace('@s.whatsapp.net', '').replace('@lid', '') || 'unknown';
                    errorDetails[phone] = this.getBaileysStatusMessage(f.status);
                });

                console.log(`[RemoveParticipants] Failures: ${JSON.stringify(errorDetails)}`);

                if (failures.length === result.length) {
                    return {
                        success: false,
                        error: Object.values(errorDetails).join(', '),
                        details: errorDetails
                    };
                }

                return { success: true, details: errorDetails };
            }

            console.log(`[RemoveParticipants] Successfully removed ${participants.length} from ${groupJid}`);
            return { success: true };
        } catch (error) {
            console.error('[RemoveParticipants] Error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    async promoteGroupParticipants(
        phoneNumberId: string,
        groupJid: string,
        participants: string[]
    ): Promise<{ success: boolean; error?: string; details?: Record<string, string> }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            const participantJids = participants.map((p) => {
                if (p.includes('@')) return p;
                return `${p}@s.whatsapp.net`;
            });

            console.log(`[PromoteParticipants] Input: ${JSON.stringify(participants)}`);
            console.log(`[PromoteParticipants] JIDs: ${JSON.stringify(participantJids)}`);

            const result = await this.clientOf(session).updateGroupParticipants(groupJid, participantJids, 'promote');

            console.log(`[PromoteParticipants] Baileys result: ${JSON.stringify(result)}`);

            const failures = result.filter((r) => r.status !== '200');

            if (failures.length > 0) {
                const errorDetails: Record<string, string> = {};
                failures.forEach((f) => {
                    const phone = f.jid?.replace('@s.whatsapp.net', '').replace('@lid', '') || 'unknown';
                    errorDetails[phone] = this.getBaileysStatusMessage(f.status);
                });

                if (failures.length === result.length) {
                    return { success: false, error: Object.values(errorDetails).join(', '), details: errorDetails };
                }
                return { success: true, details: errorDetails };
            }

            console.log(`[PromoteParticipants] Successfully promoted ${participants.length} in ${groupJid}`);
            return { success: true };
        } catch (error) {
            console.error('[PromoteParticipants] Error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    async demoteGroupParticipants(
        phoneNumberId: string,
        groupJid: string,
        participants: string[]
    ): Promise<{ success: boolean; error?: string; details?: Record<string, string> }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            const participantJids = participants.map((p) => {
                if (p.includes('@')) return p;
                return `${p}@s.whatsapp.net`;
            });

            console.log(`[DemoteParticipants] Input: ${JSON.stringify(participants)}`);
            console.log(`[DemoteParticipants] JIDs: ${JSON.stringify(participantJids)}`);

            const result = await this.clientOf(session).updateGroupParticipants(groupJid, participantJids, 'demote');

            console.log(`[DemoteParticipants] Baileys result: ${JSON.stringify(result)}`);

            const failures = result.filter((r) => r.status !== '200');

            if (failures.length > 0) {
                const errorDetails: Record<string, string> = {};
                failures.forEach((f) => {
                    const phone = f.jid?.replace('@s.whatsapp.net', '').replace('@lid', '') || 'unknown';
                    errorDetails[phone] = this.getBaileysStatusMessage(f.status);
                });

                if (failures.length === result.length) {
                    return { success: false, error: Object.values(errorDetails).join(', '), details: errorDetails };
                }
                return { success: true, details: errorDetails };
            }

            console.log(`[DemoteParticipants] Successfully demoted ${participants.length} in ${groupJid}`);
            return { success: true };
        } catch (error) {
            console.error('[DemoteParticipants] Error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    async updateGroupSubject(
        phoneNumberId: string,
        groupJid: string,
        subject: string
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            await this.clientOf(session).updateGroupSubject(groupJid, subject);

            console.log(`[UpdateGroupSubject] Updated subject for ${groupJid}: ${subject}`);

            // O aparelho que troca o nome pode não receber o aviso do WhatsApp: avisa o Echo
            // aqui. Se o aviso chegar também, cai no mesmo event_id (duplicata na edge).
            const me = session.client.me();
            void this.handleGroupSubjectUpdate(phoneNumberId, {
                groupJid,
                subject,
                author: me ? { jid: me.jid, phoneJid: me.phone ? `${me.phone}@s.whatsapp.net` : undefined, name: me.name } : undefined,
            }).catch((err) => console.error('[UpdateGroupSubject] aviso ao Echo falhou:', err));

            return { success: true };
        } catch (error) {
            console.error('Error updating group subject:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    async leaveGroup(
        phoneNumberId: string,
        groupJid: string
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            await this.clientOf(session).leaveGroup(groupJid);

            console.log(`[LeaveGroup] Left group ${groupJid}`);

            return { success: true };
        } catch (error) {
            console.error('Error leaving group:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    // ============================================
    // GROUP SETTINGS & INVITE METHODS
    // ============================================

    async updateGroupSetting(
        phoneNumberId: string,
        groupJid: string,
        setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked'
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            await this.clientOf(session).updateGroupSetting(groupJid, setting);
            this.groupMetadataCache.del(groupJid);
            this.groupMetaFullCache.del(groupJid);

            console.log(`[UpdateGroupSetting] ${groupJid}: ${setting}`);

            return { success: true };
        } catch (error) {
            console.error('[UpdateGroupSetting] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    async updateGroupMemberAddMode(
        phoneNumberId: string,
        groupJid: string,
        mode: 'admin_add' | 'all_member_add'
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            await this.clientOf(session).updateGroupMemberAddMode(groupJid, mode);
            this.groupMetadataCache.del(groupJid);
            this.groupMetaFullCache.del(groupJid);

            console.log(`[UpdateGroupMemberAddMode] ${groupJid}: ${mode}`);

            return { success: true };
        } catch (error) {
            console.error('[UpdateGroupMemberAddMode] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    async updateGroupJoinApprovalMode(
        phoneNumberId: string,
        groupJid: string,
        mode: 'on' | 'off'
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            await this.clientOf(session).updateGroupJoinApprovalMode(groupJid, mode === 'on');
            this.groupMetadataCache.del(groupJid);
            this.groupMetaFullCache.del(groupJid);

            console.log(`[UpdateGroupJoinApprovalMode] ${groupJid}: ${mode}`);

            return { success: true };
        } catch (error) {
            console.error('[UpdateGroupJoinApprovalMode] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    async updateGroupEphemeral(
        phoneNumberId: string,
        groupJid: string,
        expirationSeconds: number
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            await this.clientOf(session).updateGroupEphemeral(groupJid, expirationSeconds);
            this.groupMetadataCache.del(groupJid);
            this.groupMetaFullCache.del(groupJid);

            console.log(`[UpdateGroupEphemeral] ${groupJid}: ${expirationSeconds}s`);

            return { success: true };
        } catch (error) {
            console.error('[UpdateGroupEphemeral] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    async getGroupInviteCode(
        phoneNumberId: string,
        groupJid: string
    ): Promise<{ success: boolean; code?: string; inviteUrl?: string; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            const code = await this.clientOf(session).getGroupInviteCode(groupJid);

            if (!code) {
                return { success: false, error: 'Invite code not available' };
            }

            return { success: true, code, inviteUrl: `https://chat.whatsapp.com/${code}` };
        } catch (error) {
            console.error('[GetGroupInviteCode] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    async revokeGroupInviteCode(
        phoneNumberId: string,
        groupJid: string
    ): Promise<{ success: boolean; code?: string; inviteUrl?: string; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            const code = await this.clientOf(session).revokeGroupInviteCode(groupJid);

            if (!code) {
                return { success: false, error: 'Invite code not available' };
            }

            console.log(`[RevokeGroupInviteCode] Revoked invite for ${groupJid}`);

            return { success: true, code, inviteUrl: `https://chat.whatsapp.com/${code}` };
        } catch (error) {
            console.error('[RevokeGroupInviteCode] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    async acceptGroupInvite(
        phoneNumberId: string,
        code: string
    ): Promise<{ success: boolean; groupJid?: string; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            // Accept both the bare code and the full https://chat.whatsapp.com/<code> URL
            const inviteCode = code.trim().split('/').pop() || code.trim();

            const groupJid = await this.clientOf(session).acceptGroupInvite(inviteCode);

            if (!groupJid) {
                return { success: false, error: 'Failed to join group' };
            }

            console.log(`[AcceptGroupInvite] Joined group ${groupJid}`);

            return { success: true, groupJid };
        } catch (error) {
            console.error('[AcceptGroupInvite] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    async getGroupInviteInfo(
        phoneNumberId: string,
        code: string
    ): Promise<{
        success: boolean;
        group?: {
            jid: string;
            subject: string;
            description?: string;
            owner?: string;
            size?: number;
            creation?: number;
        };
        error?: string;
    }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            const inviteCode = code.trim().split('/').pop() || code.trim();

            const info = await this.clientOf(session).getGroupInviteInfo(inviteCode);

            return {
                success: true,
                group: {
                    jid: info.jid,
                    subject: info.subject,
                    description: info.description || undefined,
                    owner: info.ownerJid?.replace('@s.whatsapp.net', '').replace('@lid', ''),
                    size: info.size,
                    creation: info.creation,
                },
            };
        } catch (error) {
            console.error('[GetGroupInviteInfo] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    async getGroupJoinRequests(
        phoneNumberId: string,
        groupJid: string
    ): Promise<{ success: boolean; requests?: Array<Record<string, string>>; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            const list = await this.clientOf(session).listGroupJoinRequests(groupJid);
            // Shape legado que o GroupInfoPanel do front lê (jid, request_method, request_time).
            const requests = list.map((r) => {
                const row: Record<string, string> = { jid: r.jid };
                if (r.phoneJid) row.phone_number = r.phoneJid;
                if (r.requestMethod) row.request_method = r.requestMethod;
                if (r.requestTime !== undefined) row.request_time = String(r.requestTime);
                return row;
            });
            return { success: true, requests };
        } catch (error) {
            console.error('[GetGroupJoinRequests] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    async updateGroupJoinRequests(
        phoneNumberId: string,
        groupJid: string,
        participants: string[],
        action: 'approve' | 'reject'
    ): Promise<{ success: boolean; error?: string; details?: Record<string, string> }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            const participantJids = participants.map((p) => {
                if (p.includes('@')) return p;
                return `${p}@s.whatsapp.net`;
            });

            console.log(`[UpdateGroupJoinRequests] ${action} in ${groupJid}: ${JSON.stringify(participantJids)}`);

            const result = await this.clientOf(session).updateGroupJoinRequests(groupJid, participantJids, action);

            const failures = result.filter((r) => r.status !== '200');

            if (failures.length > 0) {
                const errorDetails: Record<string, string> = {};
                failures.forEach((f) => {
                    const phone = f.jid?.replace('@s.whatsapp.net', '').replace('@lid', '') || 'unknown';
                    errorDetails[phone] = this.getBaileysStatusMessage(f.status);
                });

                console.log(`[UpdateGroupJoinRequests] Failures: ${JSON.stringify(errorDetails)}`);

                if (failures.length === result.length) {
                    return { success: false, error: Object.values(errorDetails).join(', '), details: errorDetails };
                }

                return { success: true, details: errorDetails };
            }

            console.log(`[UpdateGroupJoinRequests] ${action} applied to ${participants.length} request(s) in ${groupJid}`);
            return { success: true };
        } catch (error) {
            console.error('[UpdateGroupJoinRequests] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    // ============================================
    // PROFILE & PICTURE METHODS
    // ============================================

    // Baileys throws Boom errors — surface the mapped status (e.g. 403 = not admin) when present
    private getBaileysErrorMessage(error: unknown): string {
        const statusCode = error instanceof WhatsAppClientError
            ? error.statusCode
            : (error as { output?: { statusCode?: number } })?.output?.statusCode;
        if (statusCode) {
            return this.getBaileysStatusMessage(statusCode);
        }
        return error instanceof Error ? error.message : 'Unknown error';
    }

    // Same Baileys call for own profile and groups — only the target JID differs
    private async setProfilePicture(
        phoneNumberId: string,
        targetJid: string,
        image: Buffer
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            const client = this.clientOf(session);
            if (targetJid.endsWith('@g.us')) await client.updateGroupPicture(targetJid, image);
            else await client.updateOwnPicture(image);
            // Cache de foto não pode sobreviver à troca (vale para grupo e perfil próprio)
            this.invalidateAvatarCaches(phoneNumberId, targetJid);

            console.log(`[UpdatePicture] Updated picture for ${targetJid}`);

            // Escreve de volta o MESMO buffer que acabou de subir: zero consulta extra
            // ao WhatsApp. Sem isto, o painel mostrava a foto nova e a lista de
            // conversas seguia com a antiga até a próxima revalidação. Vale só para
            // grupo — perfil próprio não tem conversa correspondente.
            // Ressalva conhecida: o WhatsApp reprocessa/corta a imagem do lado dele,
            // então guardamos a ENVIADA, não a canônica.
            if (targetJid.endsWith('@g.us')) {
                const conv = await this.resolveConversationForAvatar(phoneNumberId, targetJid, true);
                if (conv) {
                    const stored = await this.storeAvatarBuffer(phoneNumberId, targetJid, image);
                    if (stored && await this.linkAvatarToConversation(conv.id, stored, conv.avatarUrl)) {
                        this.rememberAvatarAttempt(phoneNumberId, targetJid, 'ok');
                        this.cacheSet(this.groupAvatarUrlCache, this.avatarKey(phoneNumberId, targetJid), stored);
                    }
                } else {
                    // Grupo recém-criado: a conversa ainda está sendo criada pela edge.
                    this.enqueueAvatarFetch(phoneNumberId, targetJid, { quality: 'image', force: true });
                }
            }

            return { success: true };
        } catch (error) {
            console.error('[UpdatePicture] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    async updateOwnProfilePicture(
        phoneNumberId: string,
        image: Buffer
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        const ownJid = session.client?.me()?.jid;
        if (!ownJid) {
            return { success: false, error: 'Own JID not available' };
        }

        return this.setProfilePicture(phoneNumberId, ownJid, image);
    }

    async updateGroupPicture(
        phoneNumberId: string,
        groupJid: string,
        image: Buffer
    ): Promise<{ success: boolean; error?: string }> {
        return this.setProfilePicture(phoneNumberId, groupJid, image);
    }

    async updateOwnProfileName(
        phoneNumberId: string,
        name: string
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            await this.clientOf(session).updateOwnName(name);

            console.log(`[UpdateProfileName] Updated profile name for ${phoneNumberId}: ${name}`);

            return { success: true };
        } catch (error) {
            console.error('[UpdateProfileName] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    async updateGroupDescription(
        phoneNumberId: string,
        groupJid: string,
        description: string
    ): Promise<{ success: boolean; error?: string }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        try {
            await this.clientOf(session).updateGroupDescription(groupJid, description);

            console.log(`[UpdateGroupDescription] Updated description for ${groupJid}`);

            return { success: true };
        } catch (error) {
            console.error('[UpdateGroupDescription] Error:', error);
            return { success: false, error: this.getBaileysErrorMessage(error) };
        }
    }

    async getOwnProfile(
        phoneNumberId: string
    ): Promise<{
        success: boolean;
        profile?: { name?: string; pictureUrl: string | null };
        error?: string;
    }> {
        const session = this.sessions.get(phoneNumberId);

        if (!session?.client) {
            return { success: false, error: 'Session not found' };
        }

        if (session.status !== 'connected') {
            return { success: false, error: 'Session not connected' };
        }

        const ownJid = session.client?.me()?.jid;
        if (!ownJid) {
            return { success: false, error: 'Own JID not available' };
        }

        // No picture set (or fetch failed) is a valid state — return null, not an error.
        // Vai como data URL: a URL do CDN do WhatsApp não abre no Echo (ver ownPictureDataUrl).
        let pictureUrl: string | null = null;
        try {
            const remoteUrl = await this.clientOf(session).getProfilePictureUrl(ownJid, 'image');
            pictureUrl = await ownPictureDataUrl(remoteUrl, (url) => this.downloadAvatar(url));
        } catch {
            pictureUrl = null;
        }

        return {
            success: true,
            profile: {
                name: session.client?.me()?.name,
                pictureUrl,
            },
        };
    }
}

