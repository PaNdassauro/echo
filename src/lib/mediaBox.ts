/**
 * Caixa de mídia (imagem, figurinha, vídeo) de uma bolha.
 *
 * Fonte única da geometria: a caixa é função pura de dados conhecidos na
 * montagem (metadata.media, cache da aba ou um letterbox fixo) e nunca muda
 * depois. Carregar bytes, loadedmetadata, erro ou remontagem não mexem na altura.
 *
 * PAR: o `MediaDimensionsSchema` daqui precisa ser idêntico ao de
 * supabase/functions/_shared/media-probe.ts (a cópia da edge é o par). Mudou um,
 * muda o outro. `thumb` é a miniatura (base64 JPEG/WebP, sem prefixo data:) que a
 * bolha borra dentro da caixa antes de a imagem chegar.
 */
import { z } from "zod";
import { fitWithin, knownMediaSize, type MediaSize } from "@/lib/mediaSizeCache";

export const MediaDimensionsSchema = z.object({
  width: z.number().int().min(1).max(65535),
  height: z.number().int().min(1).max(65535),
  seconds: z.number().finite().nonnegative().max(86400).optional(),
  source: z.enum(["bytes", "proto", "client"]).optional(),
  thumb: z.string().max(12000).optional(),
  thumbSource: z.string().max(32).optional(),
  /** ThumbHash (base64, ~28 chars) gerado na ingestão: miniatura borrada instantânea, sem rede. Par de _shared/media-probe.ts. */
  thumbhash: z.string().regex(/^[A-Za-z0-9+/=]{8,64}$/).optional(),
});

export type MediaDimensions = z.infer<typeof MediaDimensionsSchema>;

const MetadataMediaSchema = z.object({ media: MediaDimensionsSchema });

/** Lê `metadata.media` do jsonb sem confiar nele. Nunca lança. */
export function parseMediaDimensions(metadata: unknown): MediaDimensions | undefined {
  const parsed = MetadataMediaSchema.safeParse(metadata);
  return parsed.success ? parsed.data.media : undefined;
}

/** Dica de tamanho enviada pelo cliente em FormData (vem como string). */
export const MediaHintSchema = z.object({
  width: z.coerce.number().int().min(1).max(65535),
  height: z.coerce.number().int().min(1).max(65535),
});

export type BoxedMediaKind = "image" | "sticker" | "video";

export function boxedMediaKind(messageType: string | null | undefined): BoxedMediaKind | null {
  return messageType === "image" || messageType === "sticker" || messageType === "video" ? messageType : null;
}

export interface MediaBox {
  width: number;
  height: number;
  fit: "cover" | "contain";
  source: "metadata" | "cache" | "fallback" | "fixed";
}

/** Teto de lado da imagem exibida. Nunca amplia além do tamanho natural. */
export const IMAGE_MAX_PX = 300;
/** Teto de lado do vídeo exibido. */
export const VIDEO_MAX_PX = 300;
/** Lado mínimo: proporção extrema (3000x100) não vira uma faixa invisível. */
export const MIN_SIDE_PX = 40;
/** Figurinha: caixa fixa, sempre quadrada, independe do arquivo. */
export const STICKER_BOX = { width: 160, height: 160 } as const;
/** Imagem sem tamanho conhecido: letterbox FIXO (contain), nunca uma caixa que cresce no load. */
export const IMAGE_FALLBACK = { width: 240, height: 240 } as const;
/** Vídeo sem tamanho conhecido: letterbox 16:9 FIXO, nunca uma caixa que muda no loadedmetadata. */
export const VIDEO_FALLBACK = { width: 300, height: 169 } as const;

export function mediaBoxForSize(
  kind: BoxedMediaKind,
  size?: MediaSize,
  source: "metadata" | "cache" = "metadata",
): MediaBox {
  if (kind === "sticker") return { ...STICKER_BOX, fit: "contain", source: "fixed" };
  if (kind === "image") {
    if (!size) return { ...IMAGE_FALLBACK, fit: "contain", source: "fallback" };
    const f = fitWithin(size, IMAGE_MAX_PX);
    return { width: Math.max(MIN_SIDE_PX, f.width), height: Math.max(MIN_SIDE_PX, f.height), fit: "cover", source };
  }
  if (!size) return { ...VIDEO_FALLBACK, fit: "contain", source: "fallback" };
  const f = fitWithin(size, VIDEO_MAX_PX);
  return { width: Math.max(MIN_SIDE_PX, f.width), height: Math.max(MIN_SIDE_PX, f.height), fit: "contain", source };
}

/** Ordem: metadata.media, depois o cache desta aba, depois o letterbox fixo. */
export function resolveMediaBox(args: {
  kind: BoxedMediaKind;
  url: string | null | undefined;
  metadata: unknown;
}): MediaBox {
  if (args.kind === "sticker") return mediaBoxForSize("sticker");
  const dims = parseMediaDimensions(args.metadata);
  if (dims) return mediaBoxForSize(args.kind, { width: dims.width, height: dims.height }, "metadata");
  const cached = knownMediaSize(args.url);
  if (cached) return mediaBoxForSize(args.kind, cached, "cache");
  return mediaBoxForSize(args.kind);
}

export interface MediaBoxLocks {
  get(key: string, compute: () => MediaBox): MediaBox;
  size(): number;
}

/** Trava por chave: a primeira decisão vale para sempre (mesmo objeto). */
export function createMediaBoxLocks(): MediaBoxLocks {
  const map = new Map<string, MediaBox>();
  return {
    get(key, compute) {
      const hit = map.get(key);
      if (hit) return hit;
      const box = compute();
      map.set(key, box);
      return box;
    },
    size: () => map.size,
  };
}

export { fitWithin };
