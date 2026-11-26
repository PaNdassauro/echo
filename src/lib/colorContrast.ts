// Contraste WCAG 2.x sobre as cores HSL do design system (tokens "H S% L%").
// Fonte única para o tom acessível do número (usePhoneTheme) e para a régua
// de contraste dos presets de tema (themePresets.test.ts).

export type Rgb = [number, number, number];

export function hslToRgb(h: number, s: number, l: number): Rgb {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

/** Token do index.css ("176 66% 31%") para RGB 0–1. */
export function hslTokenToRgb(token: string): Rgb {
  const [h, s, l] = token.trim().split(/\s+/).map((part) => Number.parseFloat(part));
  if ([h, s, l].some((value) => Number.isNaN(value))) {
    throw new Error(`Token HSL inválido: "${token}"`);
  }
  return hslToRgb(h, s, l);
}

export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Cor `fg` com opacidade `alpha` sobre `bg` (ex.: o selo bg-success/10 sobre o card). */
export function blendOver(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as Rgb;
}

/** "#rrggbb" (já normalizado) → RGB 0–1. */
export function hexToRgb(hex: string): Rgb {
  const value = hex.replace(/^#/, "");
  return [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16) / 255) as Rgb;
}

/** RGB 0–1 → "#rrggbb" minúsculo. */
export function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) => Math.min(255, Math.max(0, Math.round(v * 255))).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** RGB 0–1 → [h 0–360, s 0–100, l 0–100] (cinza: h=0, s=0). */
export function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}
