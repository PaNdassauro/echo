// "Sugerir cores pela imagem": tira principal, fundo, bolha e base da imagem de fundo.
// Lib pura sobre RGBA (o canvas que reduz a imagem fica em wallpaperRender.ts). O
// resultado ainda passa por deriveCustomTheme, que garante o contraste.
import { hexToRgb, hslToRgb, relativeLuminance, rgbToHex, rgbToHsl, type Rgb } from "@/lib/colorContrast";
import { DEFAULT_CUSTOM_THEME, type CustomThemeBase } from "@/lib/customTheme";

export interface SuggestedColors {
  primary: string;
  background: string;
  bubble: string;
  base: CustomThemeBase;
}

/** Lado da miniatura amostrada: ~4 mil pixels bastam para a paleta. */
export const PALETTE_SAMPLE_SIDE = 64;

// Abaixo disso a imagem é escura o bastante para pedir base escura (luminância relativa média).
const DARK_BASE_MAX_Y = 0.2;
// Abaixo dessa saturação (0–100) a cor mais viva ainda é cinza: não serve de principal.
const MIN_PRIMARY_SATURATION = 18;
// Cor com menos de 0,5% da imagem é ruído para a principal.
const MIN_PRIMARY_SHARE = 0.005;

interface Bucket {
  r: number;
  g: number;
  b: number;
  count: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const hex = (h: number, s: number, l: number) => rgbToHex(hslToRgb(h, s, l));

/** Agrupa os pixels opacos em caixas de 4 bits por canal (média de cada caixa). */
function bucketize(data: Uint8ClampedArray): { buckets: Bucket[]; total: number; meanY: number } {
  const map = new Map<number, Bucket>();
  let total = 0;
  let sumY = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = map.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
    } else {
      map.set(key, { r, g, b, count: 1 });
    }
    total += 1;
    sumY += relativeLuminance([r / 255, g / 255, b / 255]);
  }
  return { buckets: [...map.values()], total, meanY: total ? sumY / total : 0 };
}

const meanRgb = (bucket: Bucket): Rgb => [
  bucket.r / bucket.count / 255,
  bucket.g / bucket.count / 255,
  bucket.b / bucket.count / 255,
];

/** null quando não há pixel opaco. */
export function suggestColorsFromPixels(data: Uint8ClampedArray): SuggestedColors | null {
  const { buckets, total, meanY } = bucketize(data);
  if (total === 0) return null;
  const base: CustomThemeBase = meanY < DARK_BASE_MAX_Y ? "dark" : "light";
  const dark = base === "dark";

  // Fundo: a cor que mais aparece, levada à faixa da base e com pouca saturação.
  const dominant = buckets.reduce((best, bucket) => (bucket.count > best.count ? bucket : best));
  const [dh, ds] = rgbToHsl(meanRgb(dominant));
  const background = hex(dh, Math.min(ds, 30), dark ? 9 : 96);

  // Principal: a cor mais viva que ocupa uma parte visível da imagem.
  let primaryHsl: [number, number, number] | null = null;
  let bestScore = 0;
  for (const bucket of buckets) {
    const share = bucket.count / total;
    if (share < MIN_PRIMARY_SHARE) continue;
    const [h, s, l] = rgbToHsl(meanRgb(bucket));
    if (s < MIN_PRIMARY_SATURATION) continue;
    // Viva, de tom médio (nem quase branca nem quase preta) e presente.
    const score = (s / 100) * (1 - Math.abs(l - 50) / 50) * Math.sqrt(share);
    if (score > bestScore) {
      bestScore = score;
      primaryHsl = [h, s, l];
    }
  }

  // Imagem sem cor viva (preto e branco, sépia clara…): fica a principal padrão.
  const [ph, ps, pl] = primaryHsl ?? rgbToHsl(hexToRgb(DEFAULT_CUSTOM_THEME.primary));
  const primary = hex(ph, Math.max(ps, 45), dark ? clamp(pl, 55, 72) : clamp(pl, 32, 50));
  const bubble = dark ? hex(ph, Math.min(ps, 45), 28) : hex(ph, Math.min(ps, 70), 90);

  return { primary, background, bubble, base };
}
