import { describe, expect, it } from "vitest";

import { parseCustomThemeInput } from "@/lib/customTheme";
import {
  DEFAULT_WALLPAPER_OPTIONS,
  PLAIN_EFFECTS_KEY,
  WALLPAPER_CSS_VARS,
  customWallpaperSchema,
  ditherLevels,
  dragPosition,
  orderedDither,
  validateWallpaperFile,
  wallpaperBackground,
  wallpaperCssVars,
  wallpaperEffectsKey,
  type CustomWallpaper,
} from "@/lib/customWallpaper";

const wallpaper = (over: Partial<CustomWallpaper> = {}): CustomWallpaper => ({
  ...DEFAULT_WALLPAPER_OPTIONS,
  imageId: "abc-123",
  ...over,
});

const colors = { primary: "#4f46e5", background: "#f8fafc", bubble: "#e0e7ff", base: "light" };

describe("customWallpaper", () => {
  it("tema salvo sem imagem continua válido e com imagem passa pelo schema", () => {
    expect(parseCustomThemeInput(JSON.stringify(colors))).toEqual(colors);
    expect(parseCustomThemeInput(JSON.stringify({ ...colors, wallpaper: wallpaper({ blur: 12 }) }))?.wallpaper).toEqual(
      wallpaper({ blur: 12 }),
    );
  });

  it("recusa valores fora dos limites e id com caracteres de CSS", () => {
    expect(customWallpaperSchema.safeParse(wallpaper({ blur: 41 })).success).toBe(false);
    expect(customWallpaperSchema.safeParse(wallpaper({ veil: -1 })).success).toBe(false);
    expect(customWallpaperSchema.safeParse(wallpaper({ ditherSize: 1.5 })).success).toBe(false);
    expect(customWallpaperSchema.safeParse(wallpaper({ imageId: 'x");background:red' })).success).toBe(false);
    // Tema com imagem inválida cai inteiro (vira echo), como cor inválida.
    expect(parseCustomThemeInput(JSON.stringify({ ...colors, wallpaper: { imageId: "a" } }))).toBeNull();
  });

  it("a chave dos efeitos ignora o tamanho do ponto sem dither e encaixe/véu", () => {
    expect(wallpaperEffectsKey(wallpaper())).toBe(PLAIN_EFFECTS_KEY);
    expect(wallpaperEffectsKey(wallpaper({ ditherSize: 7 }))).toBe(PLAIN_EFFECTS_KEY);
    expect(wallpaperEffectsKey(wallpaper({ fit: "tile", veil: 50 }))).toBe(PLAIN_EFFECTS_KEY);
    expect(wallpaperEffectsKey(wallpaper({ dither: 30, ditherSize: 2 }))).not.toBe(
      wallpaperEffectsKey(wallpaper({ dither: 30, ditherSize: 3 })),
    );
    expect(wallpaperEffectsKey(wallpaper({ blur: 3 }))).not.toBe(PLAIN_EFFECTS_KEY);
  });

  it("níveis do dither: desligado em 0, de 16 a 2", () => {
    expect(ditherLevels(0)).toBeNull();
    expect(ditherLevels(1)).toBe(16);
    expect(ditherLevels(100)).toBe(2);
    expect(ditherLevels(50)).toBe(9);
  });

  it("dither ordenado quantiza cada canal e preserva o alfa", () => {
    const width = 8;
    const height = 8;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([128, 30, 220, 77], i * 4);
    orderedDither(data, width, height, 2);

    const reds = new Set<number>();
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < 3; c++) expect([0, 255]).toContain(data[i * 4 + c]);
      expect(data[i * 4 + 3]).toBe(77);
      reds.add(data[i * 4]);
    }
    // Cinza médio vira padrão misto, não uma cor chapada.
    expect(reds).toEqual(new Set([0, 255]));
    const whiteShare = Array.from({ length: width * height }, (_, i) => data[i * 4]).filter((v) => v === 255).length;
    expect(whiteShare).toBeGreaterThan(24);
    expect(whiteShare).toBeLessThan(40);
  });

  it("fundo: encaixe vira background-size/repeat e o véu vira uma camada por cima", () => {
    const veil = (a: number) => `rgba(0,0,0,${a})`;
    expect(wallpaperBackground(wallpaper(), "blob:x", veil)).toEqual({
      backgroundImage: 'url("blob:x")',
      backgroundSize: "cover",
      backgroundRepeat: "no-repeat",
      backgroundPosition: "50% 50%",
    });
    expect(wallpaperBackground(wallpaper({ fit: "tile", tileSize: 300, veil: 40 }), "blob:x", veil, 0.5)).toEqual({
      backgroundImage: 'linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.4)), url("blob:x")',
      backgroundSize: "auto, 150px auto",
      backgroundRepeat: "no-repeat, repeat",
      backgroundPosition: "center, center",
    });
  });

  it("variáveis do <html> usam a cor de fundo do tema no véu e não deixam a URL fechar a string", () => {
    const vars = wallpaperCssVars(wallpaper({ fit: "contain", veil: 25 }), 'blob:http://x/"a\\b');
    expect(vars[WALLPAPER_CSS_VARS.image]).toBe(
      'linear-gradient(hsl(var(--background) / 0.25), hsl(var(--background) / 0.25)), url("blob:http://x/ab")',
    );
    expect(vars[WALLPAPER_CSS_VARS.size]).toBe("auto, contain");
  });

  it("valida tipo e tamanho do arquivo", () => {
    expect(validateWallpaperFile({ type: "image/png", size: 1000 })).toBeNull();
    expect(validateWallpaperFile({ type: "image/svg+xml", size: 1000 })).toMatch(/JPG, PNG/);
    expect(validateWallpaperFile({ type: "image/jpeg", size: 26 * 1024 * 1024 })).toMatch(/25 MB/);
  });

  it("posição: padrão no centro para tema salvo antes dela e só vale no Preencher", () => {
    const { positionX: _x, positionY: _y, ...old } = wallpaper();
    expect(customWallpaperSchema.parse(old)).toMatchObject({ positionX: 50, positionY: 50 });
    const veil = () => "transparent";
    expect(wallpaperBackground(wallpaper({ positionX: 10, positionY: 90 }), "u", veil).backgroundPosition).toBe("10% 90%");
    expect(wallpaperBackground(wallpaper({ fit: "contain", positionX: 10 }), "u", veil).backgroundPosition).toBe("center");
    expect(wallpaperBackground(wallpaper({ positionX: 0, veil: 30 }), "u", veil).backgroundPosition).toBe("center, 0% 50%");
  });

  it("arrastar para a direita mostra mais da esquerda; eixo sem sobra usa o lado da prévia", () => {
    // Imagem 2:1 num quadro 1:1 de 100 px: sobra 100 px na horizontal, 0 na vertical.
    const box = { width: 100, height: 100 };
    const image = { width: 2000, height: 1000 };
    expect(dragPosition({ x: 50, y: 50 }, { dx: 50, dy: 0 }, box, image)).toEqual({ x: 0, y: 50 });
    // Vertical sem sobra: 25 px de 100 px = 25%.
    expect(dragPosition({ x: 50, y: 50 }, { dx: 0, dy: 25 }, box, image)).toEqual({ x: 50, y: 25 });
    expect(dragPosition({ x: 50, y: 50 }, { dx: -25, dy: 0 }, box, image)).toEqual({ x: 75, y: 50 });
    expect(dragPosition({ x: 90, y: 50 }, { dx: -500, dy: 0 }, box, image)).toEqual({ x: 100, y: 50 });
  });
});
