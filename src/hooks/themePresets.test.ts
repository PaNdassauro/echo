import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APP_THEME_PRESETS, DARK_PRESETS, type AppThemePreset } from "@/hooks/useLocalTheme";
import { blendOver, contrastRatio, hslTokenToRgb } from "@/lib/colorContrast";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const indexCss = read("../index.css");
// Os tokens dos presets vivem no @layer base; os utilitários depois dele repetem seletores.
const baseLayerCss = indexCss.slice(0, indexCss.indexOf("@layer utilities"));
const indexHtml = read("../../index.html");
const vercelJson = read("../../vercel.json");
const caddyfile = read("../../docker/gateway/Caddyfile");

type Tokens = Record<string, string>;

function parseTokens(body: string): Tokens {
  const tokens: Tokens = {};
  for (const [, name, value] of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) tokens[name] = value.trim();
  return tokens;
}

/** Corpo do primeiro bloco cujo seletor casa `selector` (o @layer base vem antes dos utilitários). */
function cssBlock(selector: RegExp): Tokens {
  const match = indexCss.match(selector);
  if (!match || match.index === undefined) throw new Error(`Bloco não encontrado: ${selector}`);
  const start = match.index + match[0].length;
  return parseTokens(indexCss.slice(start, indexCss.indexOf("}", start)));
}

const presetSelector = (preset: string) => new RegExp(`\\n\\s*\\[data-app-theme="${preset}"\\]\\s*\\{`);

/** Herança igual à do app: :root → .dark (presets escuros) → bloco do preset. */
function resolvedTokens(preset: AppThemePreset): Tokens {
  return {
    ...cssBlock(/:root\s*\{/),
    ...(DARK_PRESETS.has(preset) ? cssBlock(/\n\s*\.dark\s*\{/) : {}),
    ...(preset === "echo" ? {} : cssBlock(presetSelector(preset))),
  };
}

const TEXT_PAIRS: Array<[string, string]> = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["primary-foreground", "primary"],
  ["accent-foreground", "accent"],
  ["primary", "background"],
  ["primary", "card"],
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
  ...Array.from({ length: 8 }, (_, i): [string, string] => [`group-sender-${i + 1}`, "chat-bubble-contact"]),
];

// Falhas medidas nos presets anteriores a esta régua. Não crescem:
// preset novo entra sem exceção, e corrigir uma destas é só apagar a linha.
const KNOWN_GAPS: Partial<Record<AppThemePreset, string[]>> = {
  echo: [
    "sidebar-primary/sidebar-background",
    "group-sender-2/chat-bubble-contact",
    "group-sender-7/chat-bubble-contact",
  ],
  whatsapp: ["primary/background", "sidebar-primary/sidebar-background", "group-sender-7/chat-bubble-contact"],
  dracula: [
    "muted-foreground/muted",
    "group-sender-1/chat-bubble-contact",
    "group-sender-5/chat-bubble-contact",
  ],
  barbie: ["primary/background", "sidebar-primary/sidebar-background", "group-sender-7/chat-bubble-contact"],
};

function contrastFailures(preset: AppThemePreset): string[] {
  const tokens = resolvedTokens(preset);
  const rgb = (name: string) => {
    const value = tokens[name];
    if (!value) throw new Error(`${preset}: token --${name} ausente`);
    return hslTokenToRgb(value);
  };
  const failures: string[] = [];

  for (const [fg, bg] of TEXT_PAIRS) {
    const ratio = contrastRatio(rgb(fg), rgb(bg));
    if (ratio < 4.5) failures.push(`${fg}/${bg}`);
  }
  // Selos bg-x/10 e bg-x/15 com text-x por cima, sobre o card.
  for (const status of ["destructive", "success", "warning"]) {
    for (const alpha of [0.1, 0.15]) {
      const ratio = contrastRatio(rgb(status), blendOver(rgb(status), rgb("card"), alpha));
      if (ratio < 4.5) failures.push(`${status}/selo-${alpha * 100}`);
    }
  }
  // Borda não é texto: só precisa existir visualmente sobre fundo e card.
  for (const surface of ["background", "card"]) {
    if (contrastRatio(rgb("border"), rgb(surface)) < 1.15) failures.push(`border/${surface}`);
  }

  const known = new Set(KNOWN_GAPS[preset] ?? []);
  return failures.filter((failure) => !known.has(failure));
}

describe("presets de tema", () => {
  it("cada preset (menos echo, que é o :root) tem exatamente um bloco no @layer base", () => {
    const declared = [...baseLayerCss.matchAll(/\n {2}\[data-app-theme="([a-z0-9-]+)"\] \{/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(APP_THEME_PRESETS.filter((preset) => preset !== "echo").sort());
  });

  it.each(APP_THEME_PRESETS)("%s passa na régua de contraste", (preset) => {
    expect(contrastFailures(preset)).toEqual([]);
  });

  it("presets escuros pedem controles nativos escuros (color-scheme)", () => {
    const rule = indexCss.match(/((?:\s*\[data-app-theme="[a-z0-9-]+"\],?)+)\s*\{\s*color-scheme: dark;/);
    const selectors = [...(rule?.[1] ?? "").matchAll(/data-app-theme="([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(selectors.sort()).toEqual([...DARK_PRESETS].sort());
  });
});

describe("script anti-flash do index.html", () => {
  const script = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const objectKeys = (name: string) => {
    const body = script.match(new RegExp(`var ${name} = \\{([\\s\\S]*?)\\};`))?.[1] ?? "";
    return Object.fromEntries([...body.matchAll(/(\w+): "?([^",\n]+)"?/g)].map((m) => [m[1], m[2].trim()]));
  };

  it("conhece o fundo de todo preset, igual ao --background do CSS", () => {
    const themeBg = objectKeys("THEME_BG");
    const expected = Object.fromEntries(
      APP_THEME_PRESETS.map((preset) => [preset, `hsl(${resolvedTokens(preset).background})`]),
    );
    expect(themeBg).toEqual(expected);
  });

  it("liga .dark nos mesmos presets que o useLocalTheme", () => {
    expect(Object.keys(objectKeys("DARK_THEMES")).sort()).toEqual([...DARK_PRESETS].sort());
  });

  it.each([
    ["vercel.json", () => vercelJson],
    ["Caddyfile do gateway", () => caddyfile],
  ])("tem o sha256 liberado no script-src da CSP do %s", (_nome, conteudo) => {
    const hash = createHash("sha256").update(script).digest("base64");
    expect(conteudo()).toContain(`'sha256-${hash}'`);
  });
});

describe("script anti-flash: tema personalizado", () => {
  const script = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const css = 'html:root[data-app-theme="custom"]{--background:220 16% 22%}';
  const run = () => new Function(script)();
  const reset = () => {
    localStorage.clear();
    delete document.documentElement.dataset.appTheme;
    document.documentElement.classList.remove("dark");
    document.getElementById("echo-custom-theme")?.remove();
    document.head.querySelector('meta[name="theme-color"]')?.remove();
  };
  const customStyle = () => document.getElementById("echo-custom-theme");
  const themeColor = () => document.head.querySelector('meta[name="theme-color"]')?.getAttribute("content");

  beforeEach(() => {
    reset();
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = "#18181b";
    document.head.appendChild(meta);
  });
  afterEach(reset);

  it("injeta o CSS do snapshot, liga .dark e acerta a theme-color", () => {
    localStorage.setItem("echo_theme_preset_last", "custom");
    localStorage.setItem("echo_theme_custom_boot", JSON.stringify({ dark: true, themeColor: "hsl(220 16% 22%)", css }));
    run();
    expect(document.documentElement.dataset.appTheme).toBe("custom");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(customStyle()?.textContent).toBe(css);
    expect(themeColor()).toBe("hsl(220 16% 22%)");
  });

  it("base clara não liga .dark", () => {
    localStorage.setItem("echo_theme_preset_last", "custom");
    localStorage.setItem("echo_theme_custom_boot", JSON.stringify({ dark: false, themeColor: "hsl(0 0% 100%)", css }));
    run();
    expect(document.documentElement.dataset.appTheme).toBe("custom");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it.each([
    ["sem snapshot", null],
    ["snapshot corrompido", "{"],
    ["snapshot sem css", JSON.stringify({ dark: true })],
  ])("custom com %s cai para echo", (_nome, boot) => {
    localStorage.setItem("echo_theme_preset_last", "custom");
    if (boot !== null) localStorage.setItem("echo_theme_custom_boot", boot);
    run();
    expect(document.documentElement.dataset.appTheme).toBe("echo");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(customStyle()).toBeNull();
  });

  it("preset estático ignora o snapshot (regressão)", () => {
    localStorage.setItem("echo_theme_preset_last", "breu");
    localStorage.setItem("echo_theme_custom_boot", JSON.stringify({ dark: false, themeColor: "hsl(0 0% 100%)", css }));
    run();
    expect(customStyle()).toBeNull();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(themeColor()).toBe("hsl(0 0% 0%)");
  });
});
