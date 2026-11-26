// Sonda de dimensões de mídia por bytes: lê só o começo do arquivo (Range) e
// usa o parser puro. Nunca lança e nunca grava em qr_message_log/failure-log:
// esses alimentam o e-mail de alerta de falhas.
import { z } from 'https://esm.sh/zod@3.23.8';
import { parseMediaHeader, type ParseState } from './media-dimensions.ts';
import { decode as decodeJpeg } from 'https://esm.sh/jpeg-js@0.4.4';
import { rgbaToThumbHash } from 'https://esm.sh/thumbhash@0.1.1';
import { caminhoDoAnexoNosso, paraUrlInterna } from './url-publica.ts';

export type ByteReader = (offset: number, length: number) => Promise<Uint8Array | null>;

export function bufferReader(buf: Uint8Array): ByteReader {
  return (offset, length) => {
    if (offset < 0 || offset >= buf.length) return Promise.resolve(null);
    return Promise.resolve(buf.slice(offset, offset + length));
  };
}

export function blobReader(blob: Blob): ByteReader {
  return async (offset, length) => {
    try {
      if (offset < 0 || offset >= blob.size) return null;
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    } catch {
      return null;
    }
  };
}

export function rangeReader(
  url: string,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): ByteReader {
  const doFetch = opts?.fetchImpl ?? fetch;
  return async (offset, length) => {
    try {
      const res = await doFetch(url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        signal: opts?.signal,
      });
      if (res.status === 206) {
        const range = res.headers.get('content-range') ?? '';
        if (!range.toLowerCase().startsWith(`bytes ${offset}-`)) {
          await res.body?.cancel();
          return null;
        }
        return new Uint8Array(await res.arrayBuffer());
      }
      if (res.status === 200 && offset === 0) {
        // o servidor ignorou o Range: lê só o começo e fecha o fluxo
        if (!res.body) return null;
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (total < length) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          chunks.push(value);
          total += value.length;
        }
        await reader.cancel();
        const out = new Uint8Array(Math.min(total, length));
        let at = 0;
        for (const c of chunks) {
          if (at >= out.length) break;
          const part = c.subarray(0, out.length - at);
          out.set(part, at);
          at += part.length;
        }
        return out;
      }
      await res.body?.cancel();
      return null;
    } catch {
      return null;
    }
  };
}

// par de src/lib/mediaBox.ts — mudar nos dois (o front aceita `thumbhash` e `thumb`)
export const MediaDimensionsSchema = z.object({
  width: z.number().int().min(1).max(65535),
  height: z.number().int().min(1).max(65535),
  seconds: z.number().finite().nonnegative().max(86400).optional(),
  source: z.enum(['bytes', 'proto', 'client']).optional(),
  // ThumbHash em base64 (~28 caracteres): prévia borrada na proporção certa
  thumbhash: z.string().regex(/^[A-Za-z0-9+/=]{8,64}$/).optional(),
  // Miniatura JPEG do proto do WhatsApp (jpegThumbnail) em base64, sem prefixo data:.
  // Par de src/lib/mediaBox.ts (max 12000): mudar nos dois.
  thumb: z.string().regex(/^[A-Za-z0-9+/=]+$/).max(12000).optional(),
});

export type MediaDims = { width: number; height: number; seconds?: number; thumbhash?: string; thumb?: string };

type ProbeOpts = {
  firstBytes?: number;
  stepBytes?: number;
  maxSteps?: number;
  maxTotal?: number;
  timeoutMs?: number;
};

async function probeLoop(read: ByteReader, opts?: ProbeOpts): Promise<MediaDims | null> {
  const firstBytes = opts?.firstBytes ?? 65536;
  const stepBytes = opts?.stepBytes ?? 65536;
  const maxSteps = opts?.maxSteps ?? 4;
  const maxTotal = opts?.maxTotal ?? 262144;

  let total = 0;
  let offset = 0;
  let length = firstBytes;
  let state: ParseState;
  for (let step = 0; step < maxSteps; step++) {
    length = Math.min(length, maxTotal - total);
    if (length <= 0) {
      console.warn('[MediaDims]', 'limite de bytes atingido');
      return null;
    }
    const bytes = await read(offset, length);
    if (!bytes || bytes.length === 0) {
      console.warn('[MediaDims]', 'leitura sem bytes');
      return null;
    }
    total += bytes.length;
    const r = parseMediaHeader(bytes, offset, state);
    if (r.kind === 'ok') {
      return {
        width: r.width,
        height: r.height,
        ...(r.seconds ? { seconds: r.seconds } : {}),
      };
    }
    if (r.kind === 'unknown') {
      console.warn('[MediaDims]', r.reason);
      return null;
    }
    offset = r.offset;
    length = Math.min(r.length, stepBytes);
    state = r.state;
  }
  console.warn('[MediaDims]', 'limite de passos atingido');
  return null;
}

export async function probeMediaDimensions(read: ByteReader, opts?: ProbeOpts): Promise<MediaDims | null> {
  const timeoutMs = opts?.timeoutMs ?? 1500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        console.warn('[MediaDims]', 'tempo esgotado');
        resolve(null);
      }, timeoutMs);
    });
    return await Promise.race([probeLoop(read, opts), timeout]);
  } catch (e) {
    console.warn('[MediaDims]', e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function probeUrlDimensions(
  url: string,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<MediaDims | null> {
  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? 1500;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A URL gravada é a pública: o servidor busca pela base interna (anexo nosso; outra URL fica como está).
    const read = rangeReader(paraUrlInterna(url), { fetchImpl: opts?.fetchImpl, signal: controller.signal });
    return await probeMediaDimensions(read, { timeoutMs });
  } finally {
    clearTimeout(timer);
  }
}

export function withMediaDims(
  metadata: Record<string, unknown> | null | undefined,
  dims: MediaDims | null | undefined,
  source: 'bytes' | 'proto' | 'client',
): Record<string, unknown> | null | undefined {
  if (!dims) return metadata;
  if (MediaDimensionsSchema.safeParse(metadata?.media).success) return metadata;
  const { width, height, seconds, thumbhash, thumb } = dims;
  return {
    ...(metadata ?? {}),
    media: { width, height, ...(seconds ? { seconds } : {}), ...(thumbhash ? { thumbhash } : {}), ...(thumb ? { thumb } : {}), source },
  };
}

/**
 * Junta o thumbhash ao `media` já gravado. Nunca cria `media` sem width/height:
 * thumbhash sem dimensões não serve para nada (a caixa não é reservada).
 */
export function withThumbHash(
  metadata: Record<string, unknown> | null | undefined,
  thumbhash: string | null | undefined,
): Record<string, unknown> | null | undefined {
  if (!thumbhash) return metadata;
  const existing = MediaDimensionsSchema.safeParse(metadata?.media);
  if (!existing.success) return metadata;
  if (!MediaDimensionsSchema.shape.thumbhash.safeParse(thumbhash).success) return metadata;
  return { ...(metadata ?? {}), media: { ...(metadata?.media as Record<string, unknown>), thumbhash } };
}

const THUMB_PATH_RE = /\.(jpe?g|png|webp)$/i;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** `ECHO_IMAGE_TRANSFORM=false`: o Storage não tem transformação de imagem (sem imgproxy). Qualquer outro valor = ligada. */
function transformacaoDesligada(): boolean {
  return (Deno.env.get('ECHO_IMAGE_TRANSFORM') ?? '').trim().toLowerCase() === 'false';
}

/**
 * ThumbHash de uma imagem própria no Storage, via transformação (32px JPEG).
 * `supabaseUrl` é a base INTERNA do Storage (SUPABASE_URL): é de lá que o servidor busca a derivada, qualquer que
 * seja a base (pública ou interna) da `mediaUrl` gravada. Sem imgproxy (docker) a transformação responde 404 e o
 * resultado é null, como em qualquer outra falha; `ECHO_IMAGE_TRANSFORM=false` (o compose define, par do
 * `transformacaoImagem=false` do front) nem faz o pedido. Ausente = ligado, que é o caminho da Cloud.
 * Nunca lança: qualquer falha vira null e a mensagem segue sem prévia.
 */
export async function thumbHashFromUrl(
  mediaUrl: string,
  supabaseUrl: string,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<string | null> {
  if (transformacaoDesligada()) return null;
  if (!supabaseUrl) return null;
  const caminho = caminhoDoAnexoNosso(mediaUrl);
  if (!caminho || !THUMB_PATH_RE.test(caminho)) return null;
  const base = supabaseUrl.replace(/\/$/, '');
  const path = caminho.split('/').map(encodeURIComponent).join('/');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 1500);
  try {
    const doFetch = opts?.fetchImpl ?? fetch;
    const res = await doFetch(
      `${base}/storage/v1/render/image/public/attachments/${path}?width=32&height=32&resize=contain&quality=60`,
      { signal: controller.signal },
    );
    if (!res.ok) {
      await res.body?.cancel();
      console.warn('[MediaDims] thumbhash: transformação respondeu', res.status);
      return null;
    }
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!type.startsWith('image/jpeg') && !type.startsWith('image/jpg')) {
      await res.body?.cancel();
      console.warn('[MediaDims] thumbhash: tipo inesperado', type);
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const img = decodeJpeg(bytes, { useTArray: true });
    if (!img.width || !img.height || img.width > 100 || img.height > 100) {
      console.warn('[MediaDims] thumbhash: dimensões fora do limite', img.width, img.height);
      return null;
    }
    const hash = rgbaToThumbHash(img.width, img.height, img.data);
    const b64 = toBase64(hash);
    return MediaDimensionsSchema.shape.thumbhash.safeParse(b64).success ? b64 : null;
  } catch (e) {
    console.warn('[MediaDims] thumbhash falhou:', e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}
