import { describe, expect, it } from "vitest";

import { blendOver, contrastRatio, hslTokenToRgb, rgbToHsl, hexToRgb } from "@/lib/colorContrast";
import {
  CUSTOM_HIGH_CONTRAST_TOKEN_NAMES,
  CUSTOM_THEME_CONTRAST_SELECTOR,
  CUSTOM_THEME_SELECTOR,
  CUSTOM_THEME_TOKEN_NAMES,
  DEFAULT_CUSTOM_BACKGROUND,
  DEFAULT_CUSTOM_THEME,
  backgroundFitsBase,
  buildCustomThemeCss,
  deriveCustomTheme,
  hexColorSchema,
  normalizeHex,
  parseCustomThemeInput,
  type CustomThemeBase,
  type CustomThemeInput,
} from "@/lib/customTheme";

const cr = (t: Record<string, string>, fg: string, bg: string) =>
  contrastRatio(hslTokenToRgb(t[fg]), hslTokenToRgb(t[bg]));

describe("hex e schema", () => {
  it("normaliza", () => {
    expect(hexColorSchema.parse("#ABC")).toBe("#aabbcc");
    expect(hexColorSchema.parse(" #4F46E5 ")).toBe("#4f46e5");
    expect(hexColorSchema.parse("4f46e5")).toBe("#4f46e5");
    expect(normalizeHex("#FFF")).toBe("#ffffff");
  });
  it("rejeita inválidos", () => {
    for (const bad of ["", "#abcd", "#ggg", "red", "#1234567"]) {
      expect(hexColorSchema.safeParse(bad).success).toBe(false);
      expect(normalizeHex(bad)).toBeNull();
    }
  });
  it("parseCustomThemeInput", () => {
    expect(parseCustomThemeInput(null)).toBeNull();
    expect(parseCustomThemeInput("{")).toBeNull();
    expect(parseCustomThemeInput(JSON.stringify({ primary: "#fff", background: "#fff", bubble: "#fff" }))).toBeNull();
    expect(
      parseCustomThemeInput(JSON.stringify({ primary: "#fff", background: "#fff", bubble: "#fff", base: "azul" })),
    ).toBeNull();
    expect(
      parseCustomThemeInput(JSON.stringify({ primary: "#ABC", background: "#fff", bubble: "#000", base: "dark" })),
    ).toEqual({ primary: "#aabbcc", background: "#ffffff", bubble: "#000000", base: "dark" });
  });
});

describe("padrões", () => {
  it("derivam sem ajuste", () => {
    expect(deriveCustomTheme(DEFAULT_CUSTOM_THEME).adjusted).toEqual({ primary: false, background: false, bubble: false });
    const dark = deriveCustomTheme({ ...DEFAULT_CUSTOM_THEME, base: "dark", background: DEFAULT_CUSTOM_BACKGROUND.dark });
    expect(dark.adjusted.background).toBe(false);
    expect(backgroundFitsBase(DEFAULT_CUSTOM_BACKGROUND.dark, "dark")).toBe(true);
    expect(backgroundFitsBase(DEFAULT_CUSTOM_BACKGROUND.light, "dark")).toBe(false);
  });
});

const CORES = ["#000", "#fff", "#ff0", "#00f", "#808080", "#777777", "#f00", "#0f0", "#123456", "#f8fafc"].map(
  (c) => normalizeHex(c) as string,
);

function casos(base: CustomThemeBase): CustomThemeInput[] {
  const out: CustomThemeInput[] = [];
  for (const background of CORES) {
    for (const primary of CORES) out.push({ base, background, primary, bubble: primary });
    for (const bubble of CORES) out.push({ base, background, primary: "#4f46e5", bubble });
    out.push({ base, background, primary: background, bubble: background });
  }
  return out;
}

const AA: [string, string][] = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "popover"],
  ["muted-foreground", "sidebar-background"],
  ["primary-foreground", "primary"],
  ["accent-foreground", "accent"],
  ["primary", "background"],
  ["primary", "card"],
  ["primary", "popover"],
  ["destructive-foreground", "destructive"],
  ["success-foreground", "success"],
  ["warning-foreground", "warning"],
  ["info-foreground", "info"],
  ["destructive", "card"],
  ["success", "card"],
  ["warning", "card"],
  ["info", "card"],
  ["sidebar-foreground", "sidebar-background"],
  ["sidebar-primary-foreground", "sidebar-primary"],
  ["sidebar-accent-foreground", "sidebar-accent"],
  ["sidebar-primary", "sidebar-background"],
  ["chat-bubble-user-foreground", "chat-bubble-user"],
  ["chat-bubble-contact-foreground", "chat-bubble-contact"],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i): [string, string] => [`group-sender-${i}`, "chat-bubble-contact"]),
];
const BODY: [string, string][] = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["foreground", "muted"],
  ["foreground", "secondary"],
  ["foreground", "popover"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["sidebar-foreground", "sidebar-background"],
  ["chat-bubble-contact-foreground", "chat-bubble-contact"],
];
const HC: [string, string, number][] = [
  ...["background", "card", "muted", "popover", "sidebar-background"].map((s): [string, string, number] => [
    "muted-foreground",
    s,
    7,
  ]),
  ["foreground", "background", 7],
  ["foreground", "card", 7],
  ["card-foreground", "card", 7],
  ["popover-foreground", "popover", 7],
  ["sidebar-foreground", "sidebar-background", 7],
  ["border", "background", 3],
  ["border", "card", 3],
  ["input", "background", 3],
  ["input", "card", 3],
  ["sidebar-border", "sidebar-background", 3],
  ["ring", "background", 3],
  ["sidebar-ring", "sidebar-background", 3],
  ["chat-bubble-user-foreground", "chat-bubble-user", 7],
  ["chat-bubble-contact-foreground", "chat-bubble-contact", 7],
  ["primary-foreground", "primary", 4.5],
];

describe.each(["light", "dark"] as const)("propriedade de contraste (%s)", (base) => {
  // Varredura de ~210 combinações por base (~1,5 s sozinha). Com a suíte inteira
  // em paralelo passava dos 5 s padrão: o limite é desta varredura, não do código.
  it("todos os casos legíveis", { timeout: 20_000 }, () => {
    for (const input of casos(base)) {
      const d = deriveCustomTheme(input);
      const t = d.tokens;
      const ctx = JSON.stringify(input);
      for (const name of CUSTOM_THEME_TOKEN_NAMES) {
        expect(t[name], `${ctx} ${name}`).toBeDefined();
        expect(() => hslTokenToRgb(t[name])).not.toThrow();
      }
      for (const [fg, bg] of AA) expect(cr(t, fg, bg), `${ctx} ${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const [fg, bg] of BODY) expect(cr(t, fg, bg), `${ctx} ${fg}/${bg}`).toBeGreaterThanOrEqual(7);
      for (const name of ["destructive", "success", "warning"]) {
        for (const backdrop of ["card", "background"]) {
          for (const a of [0.1, 0.15]) {
            const x = hslTokenToRgb(t[name]);
            const tint = blendOver(x, hslTokenToRgb(t[backdrop]), a);
            expect(contrastRatio(x, tint), `${ctx} selo ${name}/${backdrop}/${a}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
      // linha selecionada (bg-accent/10–15): texto secundário e --primary legíveis
      for (const backdrop of ["card", "background"]) {
        for (const a of [0.1, 0.15]) {
          const tint = blendOver(hslTokenToRgb(t.primary), hslTokenToRgb(t[backdrop]), a);
          for (const name of ["muted-foreground", "primary"]) {
            expect(contrastRatio(hslTokenToRgb(t[name]), tint), `${ctx} linha ${name}/${backdrop}/${a}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
      // hora das bolhas (foreground a 70%)
      for (const [fg, bg] of [
        ["chat-bubble-user-foreground", "chat-bubble-user"],
        ["chat-bubble-contact-foreground", "chat-bubble-contact"],
      ]) {
        const back = hslTokenToRgb(t[bg]);
        const time = blendOver(hslTokenToRgb(t[fg]), back, 0.7);
        expect(contrastRatio(time, back), `${ctx} hora ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(cr(t, "border", "background"), ctx).toBeGreaterThanOrEqual(1.15);
      expect(cr(t, "border", "card"), ctx).toBeGreaterThanOrEqual(1.15);

      const resolved = { ...t, ...d.highContrastTokens };
      for (const [fg, bg, min] of HC) expect(cr(resolved, fg, bg), `${ctx} HC ${fg}/${bg}`).toBeGreaterThanOrEqual(min);

      expect(d.dark).toBe(base === "dark");
      expect(Object.keys(d.highContrastTokens)).toEqual([...CUSTOM_HIGH_CONTRAST_TOKEN_NAMES]);
    }
  });
});

describe("flags de ajuste", () => {
  const base: CustomThemeInput = DEFAULT_CUSTOM_THEME;
  it("fundo fora da faixa", () => {
    expect(deriveCustomTheme({ ...base, background: "#000000" }).adjusted.background).toBe(true);
    expect(deriveCustomTheme({ ...base, base: "dark", background: "#ffffff" }).adjusted.background).toBe(true);
  });
  it("principal ilegível mantém o matiz", () => {
    const d = deriveCustomTheme({ ...base, primary: "#ffff00" });
    expect(d.adjusted.primary).toBe(true);
    expect(d.effective.primary).not.toBe("#ffff00");
    const dh = Math.abs(rgbToHsl(hexToRgb(d.effective.primary))[0] - 60);
    expect(dh).toBeLessThanOrEqual(1);
  });
  it("bolha cinza média é ajustada para a hora (texto a 70%) também ficar ≥4,5", () => {
    const d = deriveCustomTheme({ ...base, bubble: "#808080" });
    expect(cr(d.tokens, "chat-bubble-user-foreground", "chat-bubble-user")).toBeGreaterThanOrEqual(4.5);
    expect(d.adjusted.bubble).toBe(true);
  });
});

describe("determinismo e CSS", () => {
  it("é determinística", () => {
    expect(deriveCustomTheme(DEFAULT_CUSTOM_THEME)).toEqual(deriveCustomTheme(DEFAULT_CUSTOM_THEME));
  });
  it.each(["light", "dark"] as const)("buildCustomThemeCss (%s)", (b) => {
    const d = deriveCustomTheme({ ...DEFAULT_CUSTOM_THEME, base: b, background: DEFAULT_CUSTOM_BACKGROUND[b] });
    const css = buildCustomThemeCss(d);
    expect(css.startsWith(`${CUSTOM_THEME_SELECTOR}{`)).toBe(true);
    expect(css).toContain(CUSTOM_THEME_CONTRAST_SELECTOR);
    const [first, second] = css.split("\n");
    for (const name of CUSTOM_THEME_TOKEN_NAMES) expect(first).toContain(`--${name}:${d.tokens[name]}`);
    expect(first).not.toContain("!important");
    const decls = second.slice(second.indexOf("{") + 1, second.lastIndexOf("}")).split(";");
    expect(decls).toHaveLength(CUSTOM_HIGH_CONTRAST_TOKEN_NAMES.length);
    for (const decl of decls) expect(decl.endsWith("!important")).toBe(true);
    expect(first.includes("color-scheme:dark")).toBe(b === "dark");
    expect(first.includes("color-scheme:light")).toBe(b === "light");
    expect(css).not.toContain("url(");
    expect(css).not.toContain("</");
  });
});
