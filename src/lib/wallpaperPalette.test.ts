import { describe, expect, it } from "vitest";

import { hexToRgb, rgbToHsl } from "@/lib/colorContrast";
import { DEFAULT_CUSTOM_THEME, deriveCustomTheme } from "@/lib/customTheme";
import { suggestColorsFromPixels } from "@/lib/wallpaperPalette";

/** Imagem de `count` pixels por cor, na ordem dada. */
function pixels(parts: { rgb: [number, number, number]; count: number; alpha?: number }[]): Uint8ClampedArray {
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  const data = new Uint8ClampedArray(total * 4);
  let i = 0;
  for (const part of parts) {
    for (let n = 0; n < part.count; n++, i += 4) data.set([...part.rgb, part.alpha ?? 255], i);
  }
  return data;
}

const hue = (hex: string) => rgbToHsl(hexToRgb(hex))[0];
const lightness = (hex: string) => rgbToHsl(hexToRgb(hex))[2];

describe("suggestColorsFromPixels", () => {
  it("praia clara: base clara, fundo do tom dominante e principal na cor viva", () => {
    const colors = suggestColorsFromPixels(
      pixels([
        { rgb: [235, 215, 180], count: 3000 }, // areia
        { rgb: [20, 130, 200], count: 900 }, // mar
        { rgb: [200, 200, 200], count: 100 },
      ]),
    );
    expect(colors?.base).toBe("light");
    expect(lightness(colors!.background)).toBeGreaterThan(90);
    expect(Math.abs(hue(colors!.background) - rgbToHsl([235 / 255, 215 / 255, 180 / 255])[0])).toBeLessThan(15);
    expect(Math.abs(hue(colors!.primary) - rgbToHsl([20 / 255, 130 / 255, 200 / 255])[0])).toBeLessThan(15);
    expect(Math.abs(hue(colors!.bubble) - hue(colors!.primary))).toBeLessThan(2);
    expect(lightness(colors!.bubble)).toBeGreaterThan(80);
  });

  it("noite escura: base escura, fundo escuro e bolha escura", () => {
    const colors = suggestColorsFromPixels(
      pixels([
        { rgb: [10, 12, 30], count: 3000 },
        { rgb: [230, 60, 120], count: 300 },
      ]),
    );
    expect(colors?.base).toBe("dark");
    expect(lightness(colors!.background)).toBeLessThan(15);
    expect(lightness(colors!.bubble)).toBeLessThan(40);
    expect(Math.abs(hue(colors!.primary) - rgbToHsl([230 / 255, 60 / 255, 120 / 255])[0])).toBeLessThan(15);
  });

  it("preto e branco cai na principal padrão; cor de 0,1% é ruído", () => {
    const gray = suggestColorsFromPixels(
      pixels([
        { rgb: [240, 240, 240], count: 2000 },
        { rgb: [60, 60, 60], count: 2000 },
        { rgb: [255, 0, 0], count: 4 },
      ]),
    );
    expect(Math.abs(hue(gray!.primary) - hue(DEFAULT_CUSTOM_THEME.primary))).toBeLessThan(2);
  });

  it("ignora pixel transparente e devolve null sem pixel opaco", () => {
    expect(suggestColorsFromPixels(pixels([{ rgb: [255, 0, 0], count: 50, alpha: 0 }]))).toBeNull();
    expect(suggestColorsFromPixels(new Uint8ClampedArray())).toBeNull();
  });

  it("a sugestão é um tema válido que a derivação aceita", () => {
    const colors = suggestColorsFromPixels(pixels([{ rgb: [250, 250, 120], count: 500 }]))!;
    expect(colors.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(() => deriveCustomTheme(colors)).not.toThrow();
  });
});
