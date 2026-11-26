// Tema "Personalizado": o usuário escolhe 3 cores em hex (principal, fundo e bolha
// enviada) e a base (clara/escura). Todo o resto dos tokens é derivado aqui, sempre
// legível (WCAG 2.x, via colorContrast.ts). Lib pura: sem DOM, sem storage, sem React.
import { z } from "zod";

import {
  blendOver,
  contrastRatio,
  hexToRgb,
  hslTokenToRgb,
  type Rgb,
  relativeLuminance,
  rgbToHex,
  rgbToHsl,
} from "@/lib/colorContrast";
import { customWallpaperSchema } from "@/lib/customWallpaper";

export type CustomThemeBase = "light" | "dark";
export const CUSTOM_THEME_BASES: readonly CustomThemeBase[] = ["light", "dark"];

/** "#RGB" ou "#RRGGBB" (o # é opcional) → "#rrggbb" minúsculo; null se inválido. */
function normalize(value: string): string | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const digits = match[1].toLowerCase();
  const full = digits.length === 3 ? [...digits].map((c) => c + c).join("") : digits;
  return `#${full}`;
}

export function normalizeHex(value: string): string | null {
  return normalize(value);
}

export const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i, "Use #RGB ou #RRGGBB, como #4f46e5.")
  .transform((value) => normalize(value) as string);

export const customThemeInputSchema = z.object({
  primary: hexColorSchema,
  background: hexColorSchema,
  bubble: hexColorSchema,
  base: z.enum(["light", "dark"]),
  /** Imagem de fundo das conversas (opcional; a imagem mora no IndexedDB). */
  wallpaper: customWallpaperSchema.optional(),
});
export type CustomThemeInput = z.infer<typeof customThemeInputSchema>;

/** JSON.parse + safeParse; null em qualquer falha. */
export function parseCustomThemeInput(raw: string | null): CustomThemeInput | null {
  if (raw === null) return null;
  try {
    const result = customThemeInputSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export const DEFAULT_CUSTOM_THEME: CustomThemeInput = {
  primary: "#4f46e5",
  background: "#f8fafc",
  bubble: "#e0e7ff",
  base: "light",
};

/** Fundo padrão de cada base (a UI troca o fundo ao mudar a base quando ele não cabe na faixa). */
export const DEFAULT_CUSTOM_BACKGROUND: Record<CustomThemeBase, string> = {
  light: "#f8fafc",
  dark: "#0f172a",
};

export const CUSTOM_THEME_TOKEN_NAMES: readonly string[] = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "info",
  "info-foreground",
  "border",
  "input",
  "ring",
  "sidebar-background",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "chat-bubble-user",
  "chat-bubble-user-foreground",
  "chat-bubble-contact",
  "chat-bubble-contact-foreground",
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `group-sender-${i}`),
  "chart-1",
];

export const CUSTOM_HIGH_CONTRAST_TOKEN_NAMES = [
  "muted-foreground",
  "border",
  "input",
  "sidebar-border",
  "ring",
  "sidebar-ring",
  "chat-bubble-user",
] as const;

export interface CustomThemeAdjustments {
  primary: boolean;
  background: boolean;
  bubble: boolean;
}

export interface DerivedCustomTheme {
  input: CustomThemeInput;
  dark: boolean;
  /** Nome sem "--" → "H S% L%". */
  tokens: Record<string, string>;
  highContrastTokens: Record<string, string>;
  /** true quando a derivação mexeu na cor escolhida. */
  adjusted: CustomThemeAdjustments;
  /** "#rrggbb" das cores finais. */
  effective: { primary: string; background: string; bubble: string };
}

// ---------------------------------------------------------------------------
// Helpers internos. Todo contraste é medido sobre o token já formatado, para o
// teste e o navegador medirem exatamente o mesmo número.

const clampL = (l: number) => Math.min(100, Math.max(0, l));
const fmt = (h: number, s: number, l: number) =>
  `${Math.round(h)} ${Math.round(s)}% ${Math.round(clampL(l) * 10) / 10}%`;

const WHITE = "0 0% 100%";
const BLACK = "0 0% 0%";

type Direction = "darker" | "lighter";

function parseToken(token: string): [number, number, number] {
  const [h, s, l] = token.trim().split(/\s+/).map((part) => Number.parseFloat(part));
  return [h, s, l];
}

const ratio = (a: string, b: string) => contrastRatio(hslTokenToRgb(a), hslTokenToRgb(b));
const luminance = (token: string) => relativeLuminance(hslTokenToRgb(token));
const minRatio = (token: string, surfaces: readonly string[]) =>
  Math.min(...surfaces.map((surface) => ratio(token, surface)));

/** Contraste do texto a 70% de opacidade (hora das bolhas) sobre a própria bolha. */
const timeRatio = (fg: string, bubble: string) => {
  const back = hslTokenToRgb(bubble);
  return contrastRatio(blendOver(hslTokenToRgb(fg), back, 0.7), back);
};

/** A cor a 10% e 15% sobre cada fundo (linha selecionada, selos). */
const tintOf = (token: string, backdrops: readonly string[]): Rgb[] =>
  backdrops.flatMap((backdrop) =>
    ([0.1, 0.15] as const).map((a) => blendOver(hslTokenToRgb(token), hslTokenToRgb(backdrop), a)),
  );

/** Anda o L de 0,5 em 0,5 até `ok`; no extremo sem passar, devolve preto/branco puro. */
function adjustLightness(
  h: number,
  s: number,
  startL: number,
  dir: Direction,
  ok: (token: string) => boolean,
): { token: string; moved: boolean } {
  const initial = fmt(h, s, startL);
  let l = clampL(startL);
  for (;;) {
    const token = fmt(h, s, l);
    if (ok(token)) return { token, moved: token !== initial };
    if (dir === "darker" ? l <= 0 : l >= 100) {
      const pure = dir === "darker" ? BLACK : WHITE;
      return { token: pure, moved: pure !== initial };
    }
    l = clampL(l + (dir === "darker" ? -0.5 : 0.5));
  }
}

/** Candidato com o maior contraste mínimo sobre as superfícies (empate: o primeiro). */
function pickForeground(surfaces: readonly string[], candidates: readonly string[]): string {
  let best = candidates[0];
  let bestRatio = -1;
  for (const candidate of candidates) {
    const value = minRatio(candidate, surfaces);
    if (value > bestRatio) {
      best = candidate;
      bestRatio = value;
    }
  }
  return best;
}

const LIGHT_BG_MIN_Y = 0.45;
const DARK_BG_MAX_Y = 0.04;
const LIGHT_SURFACE_MIN_Y = 0.4;
const DARK_SURFACE_MAX_Y = 0.09;

function adjustBackground(hex: string, base: CustomThemeBase): { token: string; moved: boolean } {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return base === "light"
    ? adjustLightness(h, s, l, "lighter", (t) => luminance(t) >= LIGHT_BG_MIN_Y)
    : adjustLightness(h, s, l, "darker", (t) => luminance(t) <= DARK_BG_MAX_Y);
}

/** true se o fundo já está na faixa de luminância da base (não seria ajustado). */
export function backgroundFitsBase(hex: string, base: CustomThemeBase): boolean {
  return !adjustBackground(hex, base).moved;
}

/** "H S% L%" → "#rrggbb". */
export function hslTokenToHex(token: string): string {
  return rgbToHex(hslTokenToRgb(token));
}

const STATUS_START: Record<CustomThemeBase, Record<"destructive" | "success" | "warning" | "info", string>> = {
  light: { destructive: "0 84% 39%", success: "142 72% 25%", warning: "35 92% 28%", info: "217 91% 45%" },
  dark: { destructive: "0 84% 77%", success: "142 65% 55%", warning: "43 96% 56%", info: "213 90% 65%" },
};

const GROUP_SENDER_START: Record<CustomThemeBase, readonly string[]> = {
  light: [
    "350 70% 45%",
    "25 75% 40%",
    "150 55% 32%",
    "205 75% 38%",
    "260 60% 50%",
    "320 60% 44%",
    "42 75% 34%",
    "182 55% 32%",
  ],
  dark: [
    "350 85% 72%",
    "25 85% 65%",
    "150 55% 60%",
    "205 80% 68%",
    "260 80% 76%",
    "320 75% 72%",
    "42 80% 62%",
    "182 55% 58%",
  ],
};

const BADGE_ALPHAS = [0.1, 0.15] as const;

export function deriveCustomTheme(input: CustomThemeInput): DerivedCustomTheme {
  const isDark = input.base === "dark";
  const textDir: Direction = isDark ? "lighter" : "darker";
  const surfaceDir: Direction = isDark ? "darker" : "lighter";

  // 1. Fundo
  const bg = adjustBackground(input.background, input.base);
  const [bh, bs, bl] = parseToken(bg.token);
  const ss = Math.min(bs, 40);

  const [ph, ps, pl] = rgbToHsl(hexToRgb(input.primary));

  // 2. Superfícies (com trava de luminância: preto/branco sempre dá ≥7:1 sobre elas)
  const lock = (token: string): string => {
    const [h, s, l] = parseToken(token);
    return isDark
      ? adjustLightness(h, s, l, "darker", (t) => luminance(t) <= DARK_SURFACE_MAX_Y).token
      : adjustLightness(h, s, l, "lighter", (t) => luminance(t) >= LIGHT_SURFACE_MIN_Y).token;
  };
  const card = lock(isDark ? fmt(bh, ss, bl + 3) : fmt(bh, bs, bl + 3));
  const popover = card;
  const muted = lock(isDark ? fmt(bh, ss, bl + 6) : fmt(bh, ss, bl - 3));
  const chatContact = isDark ? muted : card;
  const sidebarBg = lock(isDark ? fmt(bh, bs, bl - 3) : fmt(bh, bs, bl + 2));
  const secondary = lock(fmt(ph, Math.min(ps, 40), isDark ? bl + 6 : bl - 4));
  const sidebarAccent = muted;
  const background = bg.token;
  const surfaces = [background, card, popover, muted, secondary, sidebarBg, sidebarAccent, chatContact];

  // 3. Texto do corpo (≥7:1 em todas as superfícies)
  const foreground = adjustLightness(
    bh,
    isDark ? Math.min(bs, 20) : Math.min(bs, 35),
    isDark ? 95 : 15,
    textDir,
    (t) => minRatio(t, surfaces) >= 7 && timeRatio(t, chatContact) >= 4.5,
  ).token;

  // 3b. Cor principal
  const primarySurfaces = [background, card, popover, sidebarBg];
  const darkFg = fmt(bh, Math.min(bs, 20), 8);
  const primaryFgCandidates = isDark ? [darkFg, WHITE] : [WHITE, darkFg];
  const primaryResult = adjustLightness(
    ph,
    ps,
    pl,
    textDir,
    (t) =>
      minRatio(t, primarySurfaces) >= 4.5 &&
      Math.max(...primaryFgCandidates.map((c) => ratio(c, t))) >= 4.5 &&
      // texto em --primary sobre a própria linha selecionada (bg-accent/10–15)
      tintOf(t, [card, background]).every((tint) => contrastRatio(hslTokenToRgb(t), tint) >= 4.5),
  );
  const primary = primaryResult.token;
  const primaryForeground = pickForeground([primary], primaryFgCandidates);

  // 4. Texto secundário (também legível sobre a linha selecionada: bg-accent/10–15 com accent = primary)
  const primaryTints = tintOf(primary, [card, background]);
  const mutedOk = (t: string, min: number) =>
    minRatio(t, surfaces) >= min && primaryTints.every((tint) => contrastRatio(hslTokenToRgb(t), tint) >= min);
  const mutedStartL = isDark ? 65 : 40;
  const mutedForeground = adjustLightness(bh, Math.min(bs, 15), mutedStartL, textDir, (t) => mutedOk(t, 4.5)).token;

  // 5. Bordas (sutis)
  const borderSurfaces = [background, card, sidebarBg];
  const borderStart = isDark ? bl + 10 : bl - 8;
  const border = adjustLightness(bh, ss, borderStart, textDir, (t) => minRatio(t, borderSurfaces) >= 1.15).token;

  // 7. Bolha enviada
  const [uh, us, ul] = rgbToHsl(hexToRgb(input.bubble));
  const bubbleCandidates = [WHITE, BLACK, fmt(uh, Math.min(us, 30), 10)];
  let bubble = fmt(uh, us, ul);
  const bubbleInitial = bubble;
  let bubbleForeground = pickForeground([bubble], bubbleCandidates);
  // A hora da bolha é o foreground a 70% (text-…/70): também precisa de 4,5:1.
  const bubbleOk = (fg: string, t: string) => ratio(fg, t) >= 4.5 && timeRatio(fg, t) >= 4.5;
  if (!bubbleOk(bubbleForeground, bubble)) {
    const fgIsLight = luminance(bubbleForeground) > luminance(bubble);
    bubble = adjustLightness(
      uh,
      us,
      ul,
      fgIsLight ? "darker" : "lighter",
      (t) => bubbleCandidates.some((c) => bubbleOk(c, t)),
    ).token;
    bubbleForeground = pickForeground([bubble], bubbleCandidates);
  }
  const bubbleMoved = bubble !== bubbleInitial;

  // 8. Status
  const statusFgCandidates = [WHITE, darkFg, "26 83% 14%", BLACK];
  const statusBackdrops = [card, background];
  const status = (name: keyof (typeof STATUS_START)["light"]) => {
    const [h, s, l] = parseToken(STATUS_START[input.base][name]);
    const token = adjustLightness(h, s, l, textDir, (t) => {
      if (minRatio(t, [card, background, popover]) < 4.5) return false;
      const x = hslTokenToRgb(t);
      return statusBackdrops.every((backdrop) =>
        BADGE_ALPHAS.every((a) => contrastRatio(x, blendOver(x, hslTokenToRgb(backdrop), a)) >= 4.5),
      );
    }).token;
    return { token, foreground: pickForeground([token], statusFgCandidates) };
  };
  const destructive = status("destructive");
  const success = status("success");
  const warning = status("warning");
  const info = status("info");

  // 9. Remetentes de grupo
  const groupSenders = GROUP_SENDER_START[input.base].map((start) => {
    const [h, s, l] = parseToken(start);
    return adjustLightness(h, s, l, textDir, (t) => ratio(t, chatContact) >= 4.5).token;
  });

  // 10. Alto contraste
  const hcMuted = adjustLightness(bh, Math.min(bs, 15), mutedStartL, textDir, (t) => mutedOk(t, 7)).token;
  const hcBorder = adjustLightness(bh, ss, borderStart, textDir, (t) => minRatio(t, borderSurfaces) >= 3).token;
  const [hbh, hbs, hbl] = parseToken(bubble);
  const bubbleFgIsLight = luminance(bubbleForeground) > luminance(bubble);
  const hcBubble = adjustLightness(
    hbh,
    hbs,
    hbl,
    bubbleFgIsLight ? "darker" : "lighter",
    (t) => ratio(bubbleForeground, t) >= 7,
  ).token;

  const tokens: Record<string, string> = {
    background,
    foreground,
    card,
    "card-foreground": foreground,
    popover,
    "popover-foreground": foreground,
    primary,
    "primary-foreground": primaryForeground,
    secondary,
    "secondary-foreground": foreground,
    muted,
    "muted-foreground": mutedForeground,
    accent: primary,
    "accent-foreground": primaryForeground,
    destructive: destructive.token,
    "destructive-foreground": destructive.foreground,
    success: success.token,
    "success-foreground": success.foreground,
    warning: warning.token,
    "warning-foreground": warning.foreground,
    info: info.token,
    "info-foreground": info.foreground,
    border,
    input: border,
    ring: primary,
    "sidebar-background": sidebarBg,
    "sidebar-foreground": foreground,
    "sidebar-primary": primary,
    "sidebar-primary-foreground": primaryForeground,
    "sidebar-accent": sidebarAccent,
    "sidebar-accent-foreground": foreground,
    "sidebar-border": border,
    "sidebar-ring": primary,
    "chat-bubble-user": bubble,
    "chat-bubble-user-foreground": bubbleForeground,
    "chat-bubble-contact": chatContact,
    "chat-bubble-contact-foreground": foreground,
    "chart-1": primary,
  };
  groupSenders.forEach((token, i) => {
    tokens[`group-sender-${i + 1}`] = token;
  });

  // Mesma ordem de CUSTOM_THEME_TOKEN_NAMES
  const ordered: Record<string, string> = {};
  for (const name of CUSTOM_THEME_TOKEN_NAMES) ordered[name] = tokens[name];

  return {
    input,
    dark: isDark,
    tokens: ordered,
    highContrastTokens: {
      "muted-foreground": hcMuted,
      border: hcBorder,
      input: hcBorder,
      "sidebar-border": hcBorder,
      ring: primary,
      "sidebar-ring": primary,
      "chat-bubble-user": hcBubble,
    },
    adjusted: { primary: primaryResult.moved, background: bg.moved, bubble: bubbleMoved },
    effective: {
      primary: hslTokenToHex(primary),
      background: hslTokenToHex(background),
      bubble: hslTokenToHex(bubble),
    },
  };
}

export const CUSTOM_THEME_STYLE_ID = "echo-custom-theme";
/** Especificidade (0,2,1): vence todo o `@layer base` do index.css. */
export const CUSTOM_THEME_SELECTOR = 'html:root[data-app-theme="custom"]';
/** Especificidade (0,3,1): vence os blocos genéricos de alto contraste. */
export const CUSTOM_THEME_CONTRAST_SELECTOR = 'html:root[data-contrast="more"][data-app-theme="custom"]';

/** Duas regras, uma por linha. Sem comentários e sem url(). */
export function buildCustomThemeCss(theme: DerivedCustomTheme): string {
  const declarations = CUSTOM_THEME_TOKEN_NAMES.map((name) => `--${name}:${theme.tokens[name]}`);
  declarations.push(`color-scheme:${theme.dark ? "dark" : "light"}`);
  const contrast = CUSTOM_HIGH_CONTRAST_TOKEN_NAMES.map(
    (name) => `--${name}:${theme.highContrastTokens[name]} !important`,
  );
  return `${CUSTOM_THEME_SELECTOR}{${declarations.join(";")}}\n${CUSTOM_THEME_CONTRAST_SELECTOR}{${contrast.join(";")}}`;
}
