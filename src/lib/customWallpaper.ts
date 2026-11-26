// Imagem de fundo do tema "Personalizado": as opções (encaixe, desfoque, dither, véu)
// vivem no JSON do tema; a imagem em si fica no IndexedDB (wallpaperStore.ts), porque
// não cabe no localStorage. Lib pura: sem DOM, sem storage, sem React.
import { z } from "zod";

export const WALLPAPER_FITS = ["cover", "contain", "tile"] as const;
export type WallpaperFit = (typeof WALLPAPER_FITS)[number];

export const WALLPAPER_LIMITS = {
  tileSize: { min: 80, max: 800, step: 10 },
  blur: { min: 0, max: 40, step: 1 },
  dither: { min: 0, max: 100, step: 1 },
  ditherSize: { min: 1, max: 8, step: 1 },
  veil: { min: 0, max: 90, step: 1 },
  positionX: { min: 0, max: 100, step: 1 },
  positionY: { min: 0, max: 100, step: 1 },
} as const;

const intIn = (key: keyof typeof WALLPAPER_LIMITS) =>
  z.number().int().min(WALLPAPER_LIMITS[key].min).max(WALLPAPER_LIMITS[key].max);

export const customWallpaperSchema = z.object({
  /** Chave do registro no IndexedDB. Muda a cada imagem nova. */
  imageId: z.string().regex(/^[a-z0-9-]{1,64}$/i),
  fit: z.enum(WALLPAPER_FITS),
  /** Largura do bloco no modo mosaico, em px de tela. */
  tileSize: intIn("tileSize"),
  /** Raio do desfoque em px, medido numa imagem de REFERENCE_SIDE px. */
  blur: intIn("blur"),
  /** 0 = desligado; 1–100 = de 16 a 2 níveis por canal. */
  dither: intIn("dither"),
  /** Tamanho do ponto do dither em px, medido numa imagem de REFERENCE_SIDE px. */
  ditherSize: intIn("ditherSize"),
  /** Véu da cor de fundo por cima da imagem, em %. */
  veil: intIn("veil"),
  /** Ponto da imagem que fica à vista no encaixe "Preencher" (background-position, em %). */
  positionX: intIn("positionX").default(50),
  positionY: intIn("positionY").default(50),
});
export type CustomWallpaper = z.infer<typeof customWallpaperSchema>;
export type WallpaperEffects = Pick<CustomWallpaper, "blur" | "dither" | "ditherSize">;

export const DEFAULT_WALLPAPER_OPTIONS: Omit<CustomWallpaper, "imageId"> = {
  fit: "cover",
  tileSize: 240,
  blur: 0,
  dither: 0,
  ditherSize: 2,
  veil: 0,
  positionX: 50,
  positionY: 50,
};

/** Lado maior de referência: desfoque e ponto do dither escalam a partir dele. */
export const REFERENCE_SIDE = 1600;

export const effectScale = (longestSide: number): number => longestSide / REFERENCE_SIDE;

/** Identifica a imagem processada: muda só quando um efeito "assado" na imagem muda. */
export function wallpaperEffectsKey(effects: WallpaperEffects): string {
  // Sem dither, o tamanho do ponto não muda a imagem.
  return ditherLevels(effects.dither) === null
    ? `b${effects.blur}`
    : `b${effects.blur}-d${effects.dither}-s${effects.ditherSize}`;
}

/** Chave da imagem sem efeito nenhum (o que se grava logo ao escolher o arquivo). */
export const PLAIN_EFFECTS_KEY = "b0";

/** Níveis por canal do dither; null = desligado. */
export function ditherLevels(intensity: number): number | null {
  if (intensity <= 0) return null;
  const t = Math.min(100, intensity) / 100;
  return Math.max(2, Math.round(16 - t * 14));
}

// Matriz de Bayer 8x8 (valores 0–63).
const BAYER_8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30,
  54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23,
  61, 29, 53, 21,
];

/** Dither ordenado (Bayer 8x8) em RGBA, no lugar. O alfa não muda. */
export function orderedDither(data: Uint8ClampedArray, width: number, height: number, levels: number): void {
  const steps = levels - 1;
  const stepSize = 255 / steps;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Limiar em (-0,5, 0,5) de um degrau: espalha o erro de quantização no padrão.
      const threshold = ((BAYER_8[(y & 7) * 8 + (x & 7)] + 0.5) / 64 - 0.5) * stepSize;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const level = Math.round((data[i + c] + threshold) / stepSize);
        data[i + c] = Math.min(steps, Math.max(0, level)) * stepSize;
      }
    }
  }
}

export interface WallpaperBackground {
  backgroundImage: string;
  backgroundSize: string;
  backgroundRepeat: string;
  backgroundPosition: string;
}

/**
 * Camadas de fundo prontas para CSS. `veilColor` recebe a opacidade em 0–1 e devolve a
 * cor do véu (no app, `hsl(var(--background) / a)`; na prévia, o token já resolvido).
 * `tileScale` encolhe o bloco do mosaico na prévia.
 */
export function wallpaperBackground(
  wallpaper: Pick<CustomWallpaper, "fit" | "tileSize" | "veil" | "positionX" | "positionY">,
  imageUrl: string,
  veilColor: (alpha: number) => string,
  tileScale = 1,
): WallpaperBackground {
  const image = `url("${imageUrl.replace(/["\\]/g, "")}")`;
  const size =
    wallpaper.fit === "tile" ? `${Math.max(1, Math.round(wallpaper.tileSize * tileScale))}px auto` : wallpaper.fit;
  const repeat = wallpaper.fit === "tile" ? "repeat" : "no-repeat";
  // Só o "Preencher" corta a imagem; nos outros a posição não tem o que mostrar.
  const position = wallpaper.fit === "cover" ? `${wallpaper.positionX}% ${wallpaper.positionY}%` : "center";
  if (wallpaper.veil <= 0) {
    return { backgroundImage: image, backgroundSize: size, backgroundRepeat: repeat, backgroundPosition: position };
  }
  const color = veilColor(Math.round(wallpaper.veil) / 100);
  return {
    backgroundImage: `linear-gradient(${color}, ${color}), ${image}`,
    backgroundSize: `auto, ${size}`,
    backgroundRepeat: `no-repeat, ${repeat}`,
    backgroundPosition: `center, ${position}`,
  };
}

/** Variáveis que o index.css lê em [data-app-theme="custom"] .theme-chat-surface. */
export const WALLPAPER_CSS_VARS = {
  image: "--custom-wallpaper-image",
  size: "--custom-wallpaper-size",
  repeat: "--custom-wallpaper-repeat",
  position: "--custom-wallpaper-position",
} as const;

export function wallpaperCssVars(wallpaper: CustomWallpaper, imageUrl: string): Record<string, string> {
  const bg = wallpaperBackground(wallpaper, imageUrl, (alpha) => `hsl(var(--background) / ${alpha})`);
  return {
    [WALLPAPER_CSS_VARS.image]: bg.backgroundImage,
    [WALLPAPER_CSS_VARS.size]: bg.backgroundSize,
    [WALLPAPER_CSS_VARS.repeat]: bg.backgroundRepeat,
    [WALLPAPER_CSS_VARS.position]: bg.backgroundPosition,
  };
}

export const WALLPAPER_ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"] as const;
export const WALLPAPER_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Mensagem de erro para o arquivo escolhido, ou null se servir. */
export function validateWallpaperFile(file: { type: string; size: number }): string | null {
  if (!(WALLPAPER_ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    return "Use uma imagem JPG, PNG, WebP, GIF ou AVIF.";
  }
  if (file.size > WALLPAPER_MAX_FILE_BYTES) return "A imagem passa de 25 MB. Escolha um arquivo menor.";
  return null;
}

export function newWallpaperImageId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return random.toLowerCase();
}

/**
 * Arrastar a imagem no "Preencher": quanto o background-position (%) anda para um
 * deslocamento do ponteiro em px. Arrastar para a direita mostra mais da esquerda (o %
 * diminui). A prévia é mais larga que a conversa: num eixo sem sobra na prévia, a
 * conversa ainda pode cortar, então a largura (ou altura) inteira da prévia vale 100%.
 */
export function dragPosition(
  start: { x: number; y: number },
  delta: { dx: number; dy: number },
  box: { width: number; height: number },
  image: { width: number; height: number },
): { x: number; y: number } {
  const scale = Math.max(box.width / image.width, box.height / image.height);
  const overflowX = image.width * scale - box.width;
  const overflowY = image.height * scale - box.height;
  const move = (from: number, d: number, overflow: number, side: number) =>
    Math.round(Math.min(100, Math.max(0, from - (d / (overflow < 1 ? side : overflow)) * 100)));
  return {
    x: move(start.x, delta.dx, overflowX, box.width),
    y: move(start.y, delta.dy, overflowY, box.height),
  };
}
