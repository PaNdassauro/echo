/**
 * Dimensões e miniatura da mídia recebida, para o webhook do Echo gravar em
 * messages.metadata.media (o chat reserva a caixa exata e mostra a miniatura
 * borrada antes do download). Imagem e vídeo; figurinha só carrega a miniatura
 * (PNG) se vier com largura/altura. Áudio e documento não têm caixa.
 *
 * Par do `MediaDimensionsSchema` em `supabase/functions/_shared/media-probe.ts`
 * (na raiz deste repositório, fora de qr-service/): largura/altura inteiras entre 1 e 65535, `seconds` só quando > 0,
 * `thumb` em base64 (sem prefixo data:) com no máximo 12000 caracteres.
 */

/** 9000 bytes crus = 12000 caracteres em base64: o teto do schema do Echo. */
export const MAX_THUMB_BYTES = 9000;

export interface MediaDimsMeta {
    width: number;
    height: number;
    seconds?: number;
    source: 'proto';
    thumb?: string;
    thumbMime?: 'image/png';
}

export function mediaDimsMeta(m: {
    kind: string;
    width?: number;
    height?: number;
    seconds?: number;
    thumbnail?: Buffer;
}): MediaDimsMeta | undefined {
    if (m.kind !== 'image' && m.kind !== 'video' && m.kind !== 'sticker') return undefined;
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
    if (!ok(m.width) || !ok(m.height)) return undefined;
    const seconds = typeof m.seconds === 'number' && Number.isFinite(m.seconds) && m.seconds > 0 ? m.seconds : undefined;
    const t = m.thumbnail;
    const hasThumb = Buffer.isBuffer(t) && t.length > 0 && t.length <= MAX_THUMB_BYTES;
    return {
        width: m.width,
        height: m.height,
        ...(seconds !== undefined ? { seconds } : {}),
        source: 'proto',
        ...(hasThumb ? { thumb: t.toString('base64') } : {}),
        ...(hasThumb && m.kind === 'sticker' ? { thumbMime: 'image/png' as const } : {}),
    };
}
