// Processamento da imagem de fundo no navegador (canvas). O desfoque e o dither são
// "assados" na imagem: no scroller da conversa um `filter` desfocaria as mensagens, e
// imagem estática não repinta a cada rolagem. Encaixe e véu ficam no CSS.
import {
  ditherLevels,
  effectScale,
  orderedDither,
  type WallpaperEffects,
} from "@/lib/customWallpaper";

/** Lado maior da imagem guardada. */
export const WALLPAPER_MAX_SIDE = 2560;
/** Lado maior da prévia ao vivo nas Configurações. */
export const WALLPAPER_PREVIEW_SIDE = 720;

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D indisponível neste navegador.");
  return ctx;
}

async function decodeBlob(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch (error) {
      // Alguns formatos (ex.: AVIF em navegadores antigos) só decodificam via <img>.
      console.warn("[wallpaper] createImageBitmap falhou; tentando <img>", error);
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decodifica e reduz para caber em `maxSide` (nunca amplia). */
export async function decodeToCanvas(blob: Blob, maxSide: number): Promise<HTMLCanvasElement> {
  const image = await decodeBlob(blob);
  const width = "naturalWidth" in image ? image.naturalWidth : image.width;
  const height = "naturalHeight" in image ? image.naturalHeight : image.height;
  if (!width || !height) throw new Error("Não foi possível ler a imagem.");
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = context2d(canvas);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  if ("close" in image) image.close();
  return canvas;
}

let filterSupport: boolean | null = null;
function supportsCanvasFilter(ctx: CanvasRenderingContext2D): boolean {
  if (filterSupport === null) {
    const previous = ctx.filter;
    ctx.filter = "blur(1px)";
    filterSupport = ctx.filter === "blur(1px)";
    ctx.filter = previous ?? "none";
  }
  return filterSupport;
}

function blurInto(source: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const { width, height } = source;
  const out = createCanvas(width, height);
  const ctx = context2d(out);
  // Desenha com sobra nas bordas: sem isso o desfoque puxa transparência para dentro.
  const pad = radius * 2;
  if (supportsCanvasFilter(ctx)) {
    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(source, -pad, -pad, width + pad * 2, height + pad * 2);
    ctx.filter = "none";
    return out;
  }
  // Safari sem ctx.filter: reduzir e ampliar com suavização aproxima o desfoque.
  const factor = Math.max(1, radius / 2);
  const small = createCanvas(width / factor, height / factor);
  const smallCtx = context2d(small);
  smallCtx.imageSmoothingQuality = "high";
  smallCtx.drawImage(source, -pad / factor, -pad / factor, small.width + (pad * 2) / factor, small.height + (pad * 2) / factor);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small, 0, 0, width, height);
  return out;
}

function ditherInto(source: HTMLCanvasElement, levels: number, dotSize: number): HTMLCanvasElement {
  const { width, height } = source;
  const dot = Math.max(1, Math.round(dotSize));
  const small = createCanvas(width / dot, height / dot);
  const smallCtx = context2d(small);
  smallCtx.imageSmoothingQuality = "high";
  smallCtx.drawImage(source, 0, 0, small.width, small.height);
  const pixels = smallCtx.getImageData(0, 0, small.width, small.height);
  orderedDither(pixels.data, small.width, small.height, levels);
  smallCtx.putImageData(pixels, 0, 0);

  const out = createCanvas(width, height);
  const ctx = context2d(out);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, width, height);
  return out;
}

/** Aplica desfoque e dither, na escala da imagem (efeitos medidos em REFERENCE_SIDE px). */
export function applyWallpaperEffects(source: HTMLCanvasElement, effects: WallpaperEffects): HTMLCanvasElement {
  const scale = effectScale(Math.max(source.width, source.height));
  let canvas = source;
  if (effects.blur > 0) canvas = blurInto(canvas, Math.max(0.5, effects.blur * scale));
  const levels = ditherLevels(effects.dither);
  if (levels !== null) canvas = ditherInto(canvas, levels, effects.ditherSize * scale);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * PNG quando há dither (poucas cores comprimem bem e o JPEG borraria o padrão);
 * senão WebP, ou JPEG onde o navegador não codifica WebP (Safari devolve PNG).
 */
export async function encodeCanvas(canvas: HTMLCanvasElement, lossless: boolean): Promise<Blob> {
  if (lossless) {
    const png = await toBlob(canvas, "image/png");
    if (png) return png;
  } else {
    const webp = await toBlob(canvas, "image/webp", 0.9);
    if (webp?.type === "image/webp") return webp;
    const jpeg = await toBlob(canvas, "image/jpeg", 0.9);
    if (jpeg) return jpeg;
  }
  throw new Error("Não foi possível gerar a imagem de fundo.");
}

/** Arquivo escolhido → imagem guardada (reduzida a WALLPAPER_MAX_SIDE). */
export async function normalizeWallpaperFile(file: Blob): Promise<Blob> {
  const canvas = await decodeToCanvas(file, WALLPAPER_MAX_SIDE);
  return encodeCanvas(canvas, false);
}

/** Imagem guardada + efeitos → imagem final que vai para o fundo das conversas. */
export async function renderWallpaper(original: Blob, effects: WallpaperEffects): Promise<Blob> {
  const dithered = ditherLevels(effects.dither) !== null;
  if (effects.blur <= 0 && !dithered) return original;
  const source = await decodeToCanvas(original, WALLPAPER_MAX_SIDE);
  return encodeCanvas(applyWallpaperEffects(source, effects), dithered);
}

/** RGBA da imagem reduzida a `side` px (amostra para a sugestão de cores). */
export async function samplePixels(blob: Blob, side: number): Promise<Uint8ClampedArray> {
  const canvas = await decodeToCanvas(blob, side);
  return context2d(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
}
