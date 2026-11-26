import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { APP_THEME_PRESETS, DARK_PRESETS, type AppThemePreset } from "@/hooks/useLocalTheme";
import { blendOver, contrastRatio, hslTokenToRgb, type Rgb } from "@/lib/colorContrast";

// Régua do "Alto contraste" (data-contrast="more" no <html>): resolve os tokens
// como o navegador faria (preset + overrides de contraste) e mede WCAG 2.x.

// Caminho por variável: com literal, o Vite reescreve `new URL("…", import.meta.url)` como asset.
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const indexCss = read("../index.css");

type Tokens = Record<string, string>;

function parseTokens(body: string): Tokens {
  const tokens: Tokens = {};
  for (const [, name, value] of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    tokens[name] = value.replace(/\s*!important\s*$/, "").trim();
  }
  return tokens;
}

function blockBody(selector: RegExp): string | null {
  const match = indexCss.match(selector);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  return indexCss.slice(start, indexCss.indexOf("}", start));
}

function cssBlock(selector: RegExp): Tokens {
  const body = blockBody(selector);
  if (body === null) throw new Error(`Bloco não encontrado: ${selector}`);
  return parseTokens(body);
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ruleStart = (selector: string) => new RegExp(`(?:^|\\n)${escape(selector)}\\s*\\{`);

const CONTRAST_LIGHT = ':root[data-contrast="more"]';
const CONTRAST_DARK = ':root.dark[data-contrast="more"]';
const contrastPresetSelector = (preset: string) => `${CONTRAST_LIGHT}[data-app-theme="${preset}"]`;

/** Mesma herança do themePresets.test.ts: :root → .dark → bloco do preset. */
function presetTokens(preset: AppThemePreset): Tokens {
  return {
    ...cssBlock(/:root\s*\{/),
    ...(DARK_PRESETS.has(preset) ? cssBlock(/\n\s*\.dark\s*\{/) : {}),
    ...(preset === "echo" ? {} : cssBlock(new RegExp(`\\n\\s*\\[data-app-theme="${preset}"\\]\\s*\\{`))),
  };
}

/** Overrides na ordem da cascata: genérico claro → genérico escuro → bloco do preset. */
function contrastOverrides(preset: AppThemePreset): Tokens {
  const own = blockBody(ruleStart(contrastPresetSelector(preset)));
  return {
    ...cssBlock(ruleStart(CONTRAST_LIGHT)),
    ...(DARK_PRESETS.has(preset) ? cssBlock(ruleStart(CONTRAST_DARK)) : {}),
    ...(own === null ? {} : parseTokens(own)),
  };
}

/** O echo usa o matiz do número (--phone-theme-hue, gravado inline pelo usePhoneTheme). */
function withHue(tokens: Tokens, hue: number): Tokens {
  return Object.fromEntries(
    Object.entries(tokens).map(([name, value]) => [
      name,
      value.replace(/var\(--phone-theme-hue,\s*(\d+)\)/, () => String(hue)),
    ]),
  );
}

const GOALS: Array<[fg: string, bg: string, min: number]> = [
  ["muted-foreground", "background", 7],
  ["muted-foreground", "card", 7],
  ["muted-foreground", "muted", 7],
  ["muted-foreground", "popover", 7],
  ["muted-foreground", "sidebar-background", 7],
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

function failures(tokens: Tokens): string[] {
  const rgb = (name: string): Rgb => {
    const value = tokens[name];
    if (!value) throw new Error(`token --${name} ausente`);
    return hslTokenToRgb(value);
  };
  return GOALS.flatMap(([fg, bg, min]) => {
    const ratio = contrastRatio(rgb(fg), rgb(bg));
    return ratio < min ? [`${fg}/${bg}=${ratio.toFixed(2)} (<${min})`] : [];
  });
}

const WHITE: Rgb = [1, 1, 1];

/** Declarações de todas as regras cuja lista de seletores contém `selector` (a última vence). */
function declarations(selector: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [, selectors, body] of indexCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = selectors.replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((part) => part.trim());
    if (!list.includes(selector)) continue;
    for (const [, property, value] of body.matchAll(/(?:^|[\s;])([a-z-]+):\s*([^;]+);/g)) found[property] = value.trim();
  }
  return found;
}

/** Cor `hsl(H S% L% / a)` de uma propriedade, composta sobre `under`; `fallback` = regra herdada. */
function cssColor(selector: string, property: string, under: Rgb, fallback?: string): Rgb {
  const value = declarations(selector)[property] ?? (fallback ? declarations(fallback)[property] : undefined);
  const inner = value?.match(/^hsl\(([^)]+)\)$/)?.[1];
  if (!inner) throw new Error(`${selector} sem ${property} em hsl()`);
  const [hsl, alpha] = inner.split("/").map((part) => part.trim());
  return alpha === undefined ? hslTokenToRgb(hsl) : blendOver(hslTokenToRgb(hsl), under, Number(alpha));
}

const ECHO_HUES = Array.from({ length: 36 }, (_, i) => i * 10);

describe("alto contraste (data-contrast=\"more\")", () => {
  it.each(APP_THEME_PRESETS)("%s bate as metas com o override ativo", (preset) => {
    const resolved = { ...presetTokens(preset), ...contrastOverrides(preset) };
    const hues = preset === "echo" ? ECHO_HUES : [174];
    const found = hues.flatMap((hue) => failures(withHue(resolved, hue)).map((f) => `matiz ${hue}: ${f}`));
    expect(found).toEqual([]);
  });

  it("bloco de preset redefine todas as chaves dos genéricos (nada vaza do echo/midnight)", () => {
    const genericKeys = new Set([
      ...Object.keys(cssBlock(ruleStart(CONTRAST_LIGHT))),
      ...Object.keys(cssBlock(ruleStart(CONTRAST_DARK))),
    ]);
    for (const preset of APP_THEME_PRESETS) {
      const own = blockBody(ruleStart(contrastPresetSelector(preset)));
      if (own === null) continue;
      expect(Object.keys(parseTokens(own)).sort(), preset).toEqual([...genericKeys].sort());
    }
  });

  it("os overrides só existem sob :root[data-contrast=\"more\"] e com !important (vencem o inline do usePhoneTheme)", () => {
    const selectors = [...indexCss.matchAll(/([^{}]*data-contrast[^{}]*)\{([^}]*)\}/g)];
    expect(selectors.length).toBeGreaterThan(0);
    for (const [, selector, body] of selectors) {
      for (const part of selector.replace(/\/\*[\s\S]*?\*\//g, "").split(",")) {
        expect(part.trim()).toMatch(/^:root(\.dark)?\[data-contrast="more"\]/);
      }
      for (const [, , value] of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
        expect(value.trim()).toMatch(/!important$/);
      }
    }
  });

  it("sem data-contrast nada muda: os blocos dos presets não citam contraste e mantêm a borda sutil", () => {
    const baseLayer = indexCss.slice(0, indexCss.indexOf("@layer utilities"));
    expect(baseLayer).not.toContain("data-contrast");
    for (const preset of APP_THEME_PRESETS) {
      const tokens = presetTokens(preset);
      expect(Object.values(tokens).some((value) => value.includes("!important")), preset).toBe(false);
      // A borda padrão é sutil de propósito: o override é que a leva a 3:1.
      const border = contrastRatio(hslTokenToRgb(tokens.border), hslTokenToRgb(tokens.background));
      expect(border, preset).toBeLessThan(3);
    }
  });

  it("whatsapp: texto do cabeçalho fixo da lista passa 7:1 e o seletor de número tem borda visível", () => {
    const header = cssColor('[data-app-theme="whatsapp"] .theme-sidebar-header', "background", WHITE);
    const rule = (selector: string) => `${contrastPresetSelector("whatsapp")} ${selector}`;

    for (const selector of [
      ".theme-sidebar-header .text-muted-foreground",
      ".theme-sidebar-top-button",
      '.theme-sidebar-header [data-sidebar-top-button="true"]',
    ]) {
      expect(contrastRatio(cssColor(rule(selector), "color", header), header), selector).toBeGreaterThanOrEqual(7);
    }

    const selectorBg = cssColor(rule(".theme-phone-selector-trigger"), "background", header);
    for (const selector of [".theme-phone-selector-trigger", ".theme-phone-selector-empty"]) {
      const text = cssColor(rule(selector), "color", selectorBg, '[data-app-theme="whatsapp"] ' + selector);
      expect(contrastRatio(text, selectorBg), selector).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(cssColor(rule(selector), "border-color", header), header), selector).toBeGreaterThanOrEqual(3);
    }
  });
});
