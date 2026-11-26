/**
 * Upload resumível (TUS 1.0) para o Supabase Storage, lendo de um arquivo em disco.
 *
 * O `storage.upload()` do supabase-js manda o arquivo inteiro numa request: com
 * mídia de centenas de MB ele segura tudo na memória e cai com `fetch failed`
 * (arquivos de dezenas a centenas de MB falharam assim). Aqui o arquivo sobe em pedaços de
 * 6 MB, e cada pedaço que falha é retomado do offset que o servidor confirma
 * (HEAD), sem reenviar o que já entrou.
 *
 * Contrato do Supabase: https://supabase.com/docs/guides/storage/uploads/resumable-uploads
 * — o pedaço tem que ser 6 MB (exceto o último), e a URL do upload vale 24 h.
 */
import { open } from 'node:fs/promises';

/** Tamanho de pedaço exigido pelo Supabase. */
export const SUPABASE_TUS_CHUNK_BYTES = 6 * 1024 * 1024;

const TUS_VERSION = '1.0.0';

export interface ResumableUploadOptions {
    /** `${SUPABASE_URL}/storage/v1/upload/resumable` */
    endpoint: string;
    /** Chave de serviço: vai em `Authorization` e em `apikey` (a `sb_secret_` exige os dois). */
    apiKey: string;
    bucket: string;
    objectName: string;
    contentType: string;
    filePath: string;
    size: number;
    upsert?: boolean;
    chunkSize?: number;
    /** Espera antes de cada nova tentativa do mesmo pedaço; o tamanho da lista é o número de novas tentativas. */
    retryDelaysMs?: number[];
    requestTimeoutMs?: number;
    fetchImpl?: typeof fetch;
}

export class ResumableUploadError extends Error {
    constructor(message: string, readonly status?: number, cause?: unknown) {
        super(message, { cause });
        this.name = 'ResumableUploadError';
    }
}

/** 4xx que não muda tentando de novo (mime recusado, arquivo acima do limite, sem permissão). */
function isPermanent(status: number): boolean {
    return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 423 && status !== 429;
}

function encodeMetadata(fields: Record<string, string>): string {
    return Object.entries(fields)
        .map(([k, v]) => `${k} ${Buffer.from(v, 'utf8').toString('base64')}`)
        .join(',');
}

async function bodyText(res: Response): Promise<string> {
    try {
        return (await res.text()).slice(0, 300);
    } catch {
        return '';
    }
}

/**
 * Resolve o `Location` da criação contra o `endpoint` e, se ele vier com outra origem
 * (esquema, host ou porta), reescreve para a do `endpoint`, mantendo caminho e query.
 * O storage-api monta o `Location` com o Host que viu (ou `STORAGE_PUBLIC_URL`): atrás do
 * gateway, o endereço PÚBLICO, que o servidor nem sempre alcança (no Docker o serviço fala
 * pela URL interna), e a chave de serviço do cabeçalho não pode ir para outro host.
 */
export function alinharLocation(location: string, endpoint: string): string {
    const base = new URL(endpoint);
    const alvo = new URL(location, base);
    if (alvo.origin !== base.origin) {
        alvo.protocol = base.protocol;
        alvo.host = base.host;
    }
    return alvo.toString();
}

export async function uploadFileResumable(opts: ResumableUploadOptions): Promise<void> {
    const doFetch = opts.fetchImpl ?? fetch;
    const chunkSize = opts.chunkSize ?? SUPABASE_TUS_CHUNK_BYTES;
    const retryDelays = opts.retryDelaysMs ?? [1_000, 3_000, 5_000, 10_000, 20_000];
    const timeoutMs = opts.requestTimeoutMs ?? 120_000;
    const auth = { authorization: `Bearer ${opts.apiKey}`, apikey: opts.apiKey, 'tus-resumable': TUS_VERSION };

    const request = (url: string, init: RequestInit) =>
        doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

    // --- criação ---
    const created = await request(opts.endpoint, {
        method: 'POST',
        headers: {
            ...auth,
            'upload-length': String(opts.size),
            'upload-metadata': encodeMetadata({
                bucketName: opts.bucket,
                objectName: opts.objectName,
                contentType: opts.contentType,
                cacheControl: '3600',
            }),
            'x-upsert': opts.upsert ? 'true' : 'false',
        },
    }).catch((error: unknown) => {
        throw new ResumableUploadError(`criação do upload falhou: ${(error as Error)?.message ?? error}`, undefined, error);
    });
    if (created.status !== 201) {
        throw new ResumableUploadError(`criação do upload: HTTP ${created.status} ${await bodyText(created)}`, created.status);
    }
    const location = created.headers.get('location');
    if (!location) throw new ResumableUploadError('criação do upload sem Location');
    const uploadUrl = alinharLocation(location, opts.endpoint);

    // --- pedaços ---
    const file = await open(opts.filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(opts.size, 1)));
        let offset = 0;
        let failures = 0;
        while (offset < opts.size) {
            const length = Math.min(chunkSize, opts.size - offset);
            const { bytesRead } = await file.read(buffer, 0, length, offset);
            if (bytesRead !== length) {
                throw new ResumableUploadError(`arquivo encurtou: leu ${bytesRead} de ${length} bytes no offset ${offset}`);
            }
            let status: number | undefined;
            let reason: string;
            try {
                const res = await request(uploadUrl, {
                    method: 'PATCH',
                    headers: {
                        ...auth,
                        'upload-offset': String(offset),
                        'content-type': 'application/offset+octet-stream',
                    },
                    body: buffer.subarray(0, length),
                });
                if (res.status === 204) {
                    const next = Number(res.headers.get('upload-offset'));
                    offset = Number.isFinite(next) && next > offset ? next : offset + length;
                    failures = 0;
                    continue;
                }
                status = res.status;
                reason = `HTTP ${res.status} ${await bodyText(res)}`;
            } catch (error) {
                reason = (error as Error)?.message ?? String(error);
            }

            if (status !== undefined && isPermanent(status)) {
                throw new ResumableUploadError(`pedaço no offset ${offset}: ${reason}`, status);
            }
            if (failures >= retryDelays.length) {
                throw new ResumableUploadError(`pedaço no offset ${offset} falhou ${failures + 1}x: ${reason}`, status);
            }
            await new Promise((resolve) => setTimeout(resolve, retryDelays[failures]));
            failures++;
            // A resposta pode ter se perdido depois de o servidor gravar o pedaço:
            // o offset certo é o que ele confirma, não o que achamos.
            offset = await serverOffset(request, uploadUrl, auth, offset);
        }
    } finally {
        await file.close();
    }
}

async function serverOffset(
    request: (url: string, init: RequestInit) => Promise<Response>,
    uploadUrl: string,
    auth: Record<string, string>,
    fallback: number,
): Promise<number> {
    try {
        const res = await request(uploadUrl, { method: 'HEAD', headers: { ...auth, 'cache-control': 'no-store' } });
        if (res.status === 404 || res.status === 410) {
            throw new ResumableUploadError(`upload expirou no servidor (HTTP ${res.status})`, res.status);
        }
        const value = Number(res.headers.get('upload-offset'));
        return res.ok && Number.isFinite(value) ? value : fallback;
    } catch (error) {
        if (error instanceof ResumableUploadError) throw error;
        return fallback;
    }
}
