// Utilitários puros para a feature de figurinhas (stickers).
//
// A spec da Meta para sticker é webp 512x512, ≤100KB estático / ≤500KB
// animado. Imagem ESTÁTICA é convertida aqui mesmo, via canvas (instantâneo,
// zero dependências). GIF/webp animado NÃO passa por canvas — canvas captura
// um frame só e mataria a animação — e vai para o endpoint /sticker/convert
// do qr-service (sharp), assim como browsers sem encoder webp (Safari < 17).

export const STICKER_SIZE = 512;
export const STICKER_STATIC_MAX_BYTES = 100 * 1024;
export const STICKER_ANIMATED_MAX_BYTES = 500 * 1024;

/** Hash SHA-256 em hex minúsculo — identidade/dedup do sticker por conteúdo. */
export async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Detecta webp ANIMADO pelo container RIFF: chunk VP8X com o bit de animação
 * (0x02) ou fourcc ANIM. Não decodifica a imagem — só lê o header.
 */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));

  if (bytes.length < 21) return false;
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return false;

  if (ascii(12, 4) === "VP8X" && (bytes[20] & 0x02) !== 0) return true;

  // Cinto e suspensório: alguns encoders setam flags fora do padrão; a
  // presença do chunk ANIM é definitiva.
  const limit = Math.min(bytes.length - 4, 256);
  for (let i = 12; i < limit; i++) {
    if (
      bytes[i] === 0x41 && // A
      bytes[i + 1] === 0x4e && // N
      bytes[i + 2] === 0x49 && // I
      bytes[i + 3] === 0x4d // M
    ) {
      return true;
    }
  }
  return false;
}

let webpEncodeSupport: boolean | null = null;

/** Safari < 17 não codifica webp via canvas — quem chamar decide o fallback. */
export function canEncodeWebp(): boolean {
  if (webpEncodeSupport === null) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      webpEncodeSupport = canvas
        .toDataURL("image/webp")
        .startsWith("data:image/webp");
    } catch {
      webpEncodeSupport = false;
    }
  }
  return webpEncodeSupport;
}

export async function getImageDimensions(
  blob: Blob,
): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(blob);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  } catch {
    // Fallback via <img> para formatos que o createImageBitmap local não decodifica.
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Não foi possível ler as dimensões da imagem"));
      };
      img.src = url;
    });
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/webp", quality);
  });
}

/**
 * Converte imagem estática em sticker webp 512x512 (contain, fundo
 * transparente), com qualidade adaptativa até caber em 100KB.
 * Lança se o browser não codifica webp ou se nem a qualidade mínima cabe.
 */
export async function imageToStickerWebp(source: Blob): Promise<Blob> {
  if (!canEncodeWebp()) {
    throw new Error("browser-cannot-encode-webp");
  }

  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = STICKER_SIZE;
    canvas.height = STICKER_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Não foi possível criar o canvas de conversão");
    }

    const scale = Math.min(
      STICKER_SIZE / bitmap.width,
      STICKER_SIZE / bitmap.height,
    );
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;

    ctx.clearRect(0, 0, STICKER_SIZE, STICKER_SIZE);
    ctx.drawImage(
      bitmap,
      (STICKER_SIZE - width) / 2,
      (STICKER_SIZE - height) / 2,
      width,
      height,
    );

    for (const quality of [0.92, 0.8, 0.65, 0.5]) {
      const blob = await canvasToBlob(canvas, quality);
      if (
        blob &&
        blob.type === "image/webp" &&
        blob.size <= STICKER_STATIC_MAX_BYTES
      ) {
        return blob;
      }
    }
    throw new Error("Imagem complexa demais para virar figurinha (>100KB)");
  } finally {
    bitmap.close();
  }
}
