// Envio de mídia ao WhatsApp, comum ao envio do painel (whatsapp-send-media) e
// ao agendamento (scheduled-message-execute). Saiu de dentro do
// whatsapp-send-media quando o agendamento passou a levar arquivo:
// as duas funções mandam o mesmo arquivo do Storage pelos mesmos dois canais e
// não podem divergir (o .html servido como text/plain, o media_url para o
// qr-service, o filename do documento na Cloud API).
//
// Este módulo NÃO grava nada no banco: quem chama grava a linha em `messages`
// (o painel com sent_by do JWT, o agendamento com o created_by e
// metadata.scheduled_message_id).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { qrAuthHeaders } from './qr.ts';
import { assertMediaSize, resolveStoredSize, storageHeadError } from './media-limits.ts';
import { probeUrlDimensions, thumbHashFromUrl, type MediaDims } from './media-probe.ts';
import { paraUrlInterna, urlPublicaDoAnexo } from './url-publica.ts';

export type TipoDeMidia = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/** Tipo de mensagem do WhatsApp pelo mime (o que não é imagem, vídeo ou áudio vai como documento). */
export function tipoPeloMime(mimeType: string): Exclude<TipoDeMidia, 'sticker'> {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
}

/**
 * O Storage do Supabase serve todo .html como text/plain (trava de segurança dele),
 * então o HEAD e a linha antiga do reenvio dizem "texto": o WhatsApp rotulava "txt"
 * e o celular do cliente abria o código no lugar da página.
 */
export function corrigirMimeDeHtml(mediaType: TipoDeMidia, filename: string, mimeType: string): string {
    if (mediaType === 'document' && /\.html?$/i.test(filename) && mimeType.startsWith('text/plain')) {
        return 'text/html';
    }
    return mimeType;
}

/** Caminho de arquivo enviado: só a pasta do próprio usuário, sem subpasta nem `..`. */
export function caminhoDoUsuarioValido(storagePath: string, userId: string): boolean {
    const prefix = `outbound/${userId}/`;
    return storagePath.startsWith(prefix)
        && !storagePath.includes('..')
        && !storagePath.slice(prefix.length).includes('/')
        && storagePath.length > prefix.length;
}

export interface MidiaDoStorage {
    mediaUrl: string;
    mimeType: string;
    mediaType: Exclude<TipoDeMidia, 'sticker'>;
    mediaSizeBytes: number;
    mediaFilename: string;
    /** Dimensões medidas nos bytes (imagem/vídeo), ou null. */
    probedDims: MediaDims | null;
    /** ThumbHash da imagem, calculado em paralelo; nunca rejeita. */
    thumbPromise: Promise<string | null>;
}

/**
 * Confere um arquivo que já está em attachments/<storagePath> e devolve o que o
 * envio precisa. Tamanho e tipo do objeto gravado valem mais que o que o front
 * diz. A sonda de dimensões roda em paralelo ao HEAD (Range de poucos KB, 1,5 s
 * no máximo, nunca lança). O tipo declarado só decide se vale sondar; o mime que
 * vale continua sendo o do HEAD.
 *
 * Lança MediaSendError `storage_object_missing` se o objeto sumiu e
 * `media_too_large` acima do limite.
 */
export async function prepararMidiaDoStorage(
    supabase: SupabaseClient,
    args: {
        storagePath: string;
        filename: string | null;
        mimeHint: string | null;
        /** Tamanho que o front conhece (File.size), último recurso. */
        sizeHint: string | null;
        limitBytes: number;
        /** Base INTERNA do Storage (SUPABASE_URL): de onde sai a busca da derivada do thumbhash. */
        supabaseUrl: string;
        logTag: string;
    },
): Promise<MidiaDoStorage> {
    const { storagePath, mimeHint, logTag } = args;
    // URL pública (a que segue ao canal e fica gravada); o servidor a busca pela base interna (paraUrlInterna).
    const mediaUrl = urlPublicaDoAnexo(storagePath);

    const shouldProbe = !!mimeHint && (mimeHint.startsWith('image/') || mimeHint.startsWith('video/'));
    const thumbPromise = mimeHint?.startsWith('image/')
        ? thumbHashFromUrl(mediaUrl, args.supabaseUrl, { timeoutMs: 1500 })
        : Promise.resolve(null);
    const [head, probedDims] = await Promise.all([
        fetch(paraUrlInterna(mediaUrl), { method: 'HEAD' }),
        shouldProbe ? probeUrlDimensions(mediaUrl, { timeoutMs: 1500 }) : Promise.resolve(null),
    ]);
    if (!head.ok) {
        throw storageHeadError(head.status);
    }
    const mimeType = head.headers.get('content-type') || mimeHint || 'application/octet-stream';
    // Sem content-length o tamanho NÃO é 0 (virava áudio "vazio"): busca no
    // Storage e, por último, no que o front informou.
    const mediaSizeBytes = await resolveStoredSize({
        contentLength: head.headers.get('content-length'),
        listObjectSize: async () => {
            const slash = storagePath.lastIndexOf('/');
            const folder = storagePath.slice(0, slash);
            const name = storagePath.slice(slash + 1);
            const { data, error } = await supabase.storage
                .from('attachments')
                .list(folder, { search: name, limit: 100 });
            if (error) {
                console.warn(`[${logTag}] Listagem do Storage falhou:`, error);
                return null;
            }
            const entry = (data ?? []).find((o: { name: string }) => o.name === name) as
                | { metadata?: { size?: unknown } | null }
                | undefined;
            return entry?.metadata?.size ?? null;
        },
        clientSize: args.sizeHint,
    });
    assertMediaSize(mediaSizeBytes, args.limitBytes);
    const mediaFilename = args.filename || storagePath.split('/').pop() || 'file';
    const mediaType = tipoPeloMime(mimeType);
    if (mediaType === 'audio' && mediaSizeBytes < 256) {
        throw new Error('Arquivo de áudio vazio ou inválido');
    }
    console.log(`[${logTag}] Using pre-uploaded file: ${storagePath} (${mediaSizeBytes} bytes, ${mimeType})`);
    return { mediaUrl, mimeType, mediaType, mediaSizeBytes, mediaFilename, probedDims, thumbPromise };
}

export interface CitacaoDoEnvio {
    whatsappId: string;
    content: string | null;
    fromMe: boolean;
    participant: string | null;
}

export interface EnvioDeMidia {
    connectionType: string | null;
    /** phone_numbers.id (rota do qr-service). */
    phoneDbId: string;
    /** Id da Meta (Cloud API). */
    metaPhoneNumberId: string | null;
    accessToken: string | null | undefined;
    to: string;
    mediaType: TipoDeMidia;
    mediaUrl: string;
    mimeType: string;
    filename: string;
    /** Com buffer vai o arquivo ao qr-service; sem, vai a URL e o serviço baixa. */
    fileBuffer?: ArrayBuffer | null;
    caption?: string | null;
    isPtt?: string | null;
    stickerAnimated?: boolean;
    viewOnce?: boolean;
    isGif?: boolean;
    quoted?: CitacaoDoEnvio | null;
    /**
     * Prazo da chamada ao canal (só o agendamento usa: o painel espera o tempo que
     * for). Estourou = "timed out", e quem chama trata como ambíguo, porque o
     * arquivo pode ter saído.
     */
    timeoutMs?: number;
    logTag: string;
}

/** fetch com prazo opcional; o abort vira erro "<rotulo> timed out after N ms". */
async function fetchComPrazo(url: string, init: RequestInit, timeoutMs: number | undefined, rotulo: string): Promise<Response> {
    if (!timeoutMs) return fetch(url, init);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
        if (controller.signal.aborted) throw new Error(`${rotulo} timed out after ${timeoutMs} ms`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/** Manda a mídia pelo canal da linha e devolve o wamid. Lança em qualquer recusa. */
export async function enviarMidiaAoWhatsApp(envio: EnvioDeMidia): Promise<string> {
    const { mediaType, mediaUrl, mimeType, caption, quoted, logTag } = envio;

    if (envio.connectionType === 'qr') {
        const qrServiceUrl = Deno.env.get('QR_SERVICE_URL');
        if (!qrServiceUrl) {
            throw new Error('QR_SERVICE_URL not configured');
        }

        // Com buffer (upload antigo, figurinha) vai o arquivo; sem buffer (Storage
        // direto, reenvio, agendamento) vai a URL pública e o qr-service baixa: a
        // edge nunca segura mídia grande.
        const qrFormData = new FormData();
        if (envio.fileBuffer) {
            qrFormData.append('file', new Blob([envio.fileBuffer], { type: mimeType }), envio.filename);
        } else {
            qrFormData.append('media_url', mediaUrl);
            qrFormData.append('mime_type', mimeType);
            qrFormData.append('filename', envio.filename);
        }
        qrFormData.append('to', envio.to);
        // Sticker não tem caption no WhatsApp — o gate por mediaType cobre.
        if (caption && mediaType !== 'sticker') {
            qrFormData.append('caption', caption);
        }
        if (envio.isPtt) {
            qrFormData.append('isPtt', envio.isPtt);
        }
        if (mediaType === 'sticker') {
            qrFormData.append('isSticker', 'true');
            qrFormData.append('isAnimated', String(envio.stickerAnimated === true));
        }
        if (envio.viewOnce) {
            qrFormData.append('viewOnce', 'true');
        }
        if (envio.isGif) {
            qrFormData.append('isGif', 'true');
        }
        // Reply em mídia — a rota do qr-service já aceita estes campos.
        if (quoted) {
            qrFormData.append('quotedMessageId', quoted.whatsappId);
            if (quoted.content) qrFormData.append('quotedContent', quoted.content);
            qrFormData.append('quotedFromMe', String(quoted.fromMe));
            if (quoted.participant) qrFormData.append('quotedParticipant', quoted.participant);
        }
        // Quem chama grava a linha com media_url: o qr-service não salva.
        qrFormData.append('skipSave', 'true');

        console.log(`[${logTag}] Sending to QR service: ${qrServiceUrl}/message/send-media/${envio.phoneDbId}`);

        const sendStartTime = Date.now();
        let qrResponse: Response;
        try {
            qrResponse = await fetchComPrazo(`${qrServiceUrl}/message/send-media/${envio.phoneDbId}`, {
                method: 'POST',
                headers: qrAuthHeaders(),
                body: qrFormData,
            }, envio.timeoutMs, 'QR service');
        } catch (fetchErr) {
            const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
            if (/timed out after/.test(message)) throw fetchErr;
            console.error(`[${logTag}] FETCH FAILED (network error):`, {
                error: message,
                phoneNumberId: envio.phoneDbId,
                to: envio.to,
                durationMs: Date.now() - sendStartTime,
            });
            throw new Error(`QR service unreachable: ${message || 'Network error'}`);
        }

        const duration = Date.now() - sendStartTime;
        const contentType = qrResponse.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            throw new Error(`QR service returned invalid response (${qrResponse.status})`);
        }
        const qrData = await qrResponse.json();

        if (!qrResponse.ok) {
            console.error(`[${logTag}] Baileys service error:`, {
                httpStatus: qrResponse.status,
                response: qrData,
                phoneNumberId: envio.phoneDbId,
                to: envio.to,
                mimeType,
                durationMs: duration,
            });
            throw new Error(qrData.error || 'Failed to send media via QR');
        }

        console.log(`[${logTag}] Media sent via QR successfully:`, { messageId: qrData.messageId, durationMs: duration });
        return qrData.messageId || `qr_${Date.now()}`;
    }

    // Business API - send via Meta
    if (!envio.accessToken) {
        throw new Error('WhatsApp credentials not configured for this organization');
    }

    const midia: Record<string, string> = { link: mediaUrl };
    // Legenda em imagem, vídeo e documento; documento leva o nome do arquivo.
    if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
        midia.caption = caption;
    }
    if (mediaType === 'document') {
        midia.filename = envio.filename;
    }
    const messageBody = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: envio.to,
        type: mediaType,
        // Reply em mídia — a Cloud API aceita context em qualquer tipo.
        ...(quoted ? { context: { message_id: quoted.whatsappId } } : {}),
        [mediaType]: midia,
    };

    console.log(`[${logTag}] Sending to WhatsApp:`, JSON.stringify(messageBody));

    const whatsappResponse = await fetchComPrazo(
        `https://graph.facebook.com/v18.0/${envio.metaPhoneNumberId}/messages`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${envio.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(messageBody),
        },
        envio.timeoutMs,
        'WhatsApp API',
    );

    const whatsappData = await whatsappResponse.json();

    if (!whatsappResponse.ok) {
        console.error(`[${logTag}] WhatsApp API error:`, whatsappData);
        throw new Error(whatsappData.error?.message || 'Failed to send media');
    }

    console.log(`[${logTag}] WhatsApp response:`, whatsappData);
    return whatsappData.messages[0].id;
}

/** Texto da bolha de mídia: a legenda, ou o rótulo do tipo. */
export function conteudoDaMidia(mediaType: TipoDeMidia, caption: string | null | undefined): string {
    if (mediaType === 'sticker') return '[Sticker]';
    if (caption) return caption;
    const rotulo = mediaType === 'image' ? 'Imagem' : mediaType === 'video' ? 'Vídeo' : mediaType === 'audio' ? 'Áudio' : 'Documento';
    return `[${rotulo}]`;
}
