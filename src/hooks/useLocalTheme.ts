import { useCallback, useEffect, useState } from "react";
import {
  CUSTOM_THEME_STYLE_ID,
  DEFAULT_CUSTOM_THEME,
  buildCustomThemeCss,
  deriveCustomTheme,
  parseCustomThemeInput,
  type CustomThemeInput,
} from "@/lib/customTheme";
import { applyCustomWallpaper, type WallpaperApplyResult } from "@/lib/wallpaperApply";

// Preset novo mexe em 4 lugares, e o themePresets.test.ts confere a sincronia:
// esta lista, o bloco [data-app-theme] do src/index.css, o script anti-flash do
// index.html (+ o sha256 dele na CSP: Caddyfile do gateway e vercel.json) e o THEME_PRESETS do ThemeSettings.
export const APP_THEME_PRESETS = [
  "echo",
  "whatsapp",
  "midnight",
  "dracula",
  "barbie",
  "lavanda",
  "nord",
  "breu",
] as const;

export type AppThemePreset = (typeof APP_THEME_PRESETS)[number];

// Tema personalizado (hex escolhido pelo usuário). NÃO é um preset de CSS: não entra
// em APP_THEME_PRESETS/DARK_PRESETS (os testes de sincronia dependem disso). A paleta
// derivada vira um <style id="echo-custom-theme"> gerado em runtime.
export const CUSTOM_THEME = "custom" as const;
export type AppTheme = AppThemePreset | typeof CUSTOM_THEME;

const THEME_STORAGE_PREFIX = "echo_theme_preset_";
const THEME_EVENT = "echo-theme-change";

// Presets escuros recebem a classe `dark` no <html>, ativando os utilitários
// dark:* do Tailwind (antes disso a classe nunca era aplicada e dark: era código morto).
export const DARK_PRESETS: ReadonlySet<AppThemePreset> = new Set(["midnight", "dracula", "nord", "breu"]);

// Última escolha de tema sem userId — lida pelo script anti-flash do index.html
// antes do primeiro paint e usada como fallback enquanto a sessão carrega.
export const LAST_THEME_STORAGE_KEY = "echo_theme_preset_last";

// As paletas dos presets vivem em src/index.css como blocos [data-app-theme="..."],
// para o tema poder ser aplicado antes do primeiro paint só com o atributo.

export function getThemeStorageKey(userId: string) {
  return `${THEME_STORAGE_PREFIX}${userId}`;
}

export const getCustomThemeStorageKey = (userId: string) => `echo_theme_custom_${userId}`;
// JSON do CustomThemeInput da última aplicação (fallback sem userId).
export const LAST_CUSTOM_THEME_STORAGE_KEY = "echo_theme_custom_last";
// Snapshot {dark, themeColor, css} lido pelo script anti-flash do index.html.
export const CUSTOM_THEME_BOOT_STORAGE_KEY = "echo_theme_custom_boot";

// Tokens que o usePhoneTheme grava inline no <html> (só no preset echo). Inline vence
// qualquer seletor, então precisa ser limpo ao sair do echo. Sem --phone-theme-*.
export const PHONE_THEME_INLINE_TOKENS: readonly string[] = [
  "--primary",
  "--accent",
  "--ring",
  "--foreground",
  "--card-foreground",
  "--popover-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--border",
  "--input",
  "--sidebar-background",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
  "--chat-bubble-user",
  "--chat-bubble-contact-foreground",
];

export function clearPhoneThemeInlineTokens(root: HTMLElement = document.documentElement): void {
  for (const token of PHONE_THEME_INLINE_TOKENS) root.style.removeProperty(token);
}

function parseThemePreset(value: string | null): AppThemePreset {
  return APP_THEME_PRESETS.find((preset) => preset === value) ?? "echo";
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage indisponível (ex.: modo privado) — o tema ainda se aplica.
  }
}

/** Preset estático válido; "custom" só com entrada válida; o resto cai para echo. */
function parseTheme(rawPreset: string | null, rawCustom: string | null): AppTheme {
  if (rawPreset === CUSTOM_THEME) {
    return parseCustomThemeInput(rawCustom) ? CUSTOM_THEME : "echo";
  }
  return parseThemePreset(rawPreset);
}

/**
 * Troca de tema sem "borrão": ~120 elementos têm transition-colors e cada um
 * esmaeceria para a nova paleta no seu próprio ritmo. Desliga toda transição,
 * força um reflow para o navegador aplicar o estado final de uma vez, e
 * devolve as transições no frame seguinte.
 */
function withTransitionsSuppressed(root: HTMLElement, apply: () => void) {
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none !important}";
  document.head.appendChild(style);
  apply();
  void root.offsetHeight; // reflow síncrono com as transições ainda desligadas
  requestAnimationFrame(() => style.remove());
}

/** Aplica na hora as cores; a imagem de fundo (IndexedDB) chega quando a promessa resolver. */
export function applyAppThemePreset(preset: AppTheme, custom?: CustomThemeInput | null): Promise<WallpaperApplyResult> {
  const root = document.documentElement;
  // Defesa: "custom" sem entrada não tem paleta para derivar.
  const target: AppTheme = preset === CUSTOM_THEME && !custom ? "echo" : preset;
  const derived = target === CUSTOM_THEME && custom ? deriveCustomTheme(custom) : null;
  const customCss = derived ? buildCustomThemeCss(derived) : null;

  const apply = () => {
    root.dataset.appTheme = target;
    const existing = document.getElementById(CUSTOM_THEME_STYLE_ID);
    if (derived && customCss !== null) {
      // Reaproveita o <style> criado pelo anti-flash do index.html, se houver.
      const style = existing ?? document.createElement("style");
      style.id = CUSTOM_THEME_STYLE_ID;
      style.textContent = customCss;
      if (!existing) document.head.appendChild(style);
      root.classList.toggle("dark", derived.dark);
    } else {
      existing?.remove();
      root.classList.toggle("dark", DARK_PRESETS.has(target as AppThemePreset));
    }
    // Inline do número (só vale no echo) venceria o preset/custom novo.
    if (target !== "echo") clearPhoneThemeInlineTokens(root);
  };
  // No custom a entrada pode mudar com o mesmo preset: sempre suprime transições.
  if (root.dataset.appTheme !== target || target === CUSTOM_THEME) {
    withTransitionsSuppressed(root, apply);
  } else {
    apply();
  }

  writeStorage(LAST_THEME_STORAGE_KEY, target);
  if (derived && custom && customCss !== null) {
    writeStorage(LAST_CUSTOM_THEME_STORAGE_KEY, JSON.stringify(custom));
    writeStorage(
      CUSTOM_THEME_BOOT_STORAGE_KEY,
      JSON.stringify({ dark: derived.dark, themeColor: `hsl(${derived.tokens.background})`, css: customCss }),
    );
  }

  // A barra do navegador/PWA acompanha o fundo do tema.
  const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColorMeta) {
    if (derived) {
      themeColorMeta.content = `hsl(${derived.tokens.background})`;
    } else {
      const background = getComputedStyle(root).getPropertyValue("--background").trim();
      if (background) themeColorMeta.content = `hsl(${background})`;
    }
  }

  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { preset: target } }));

  return applyCustomWallpaper(derived ? custom?.wallpaper : null);
}

export function getCurrentAppThemePreset(): AppTheme {
  const value = document.documentElement.dataset.appTheme ?? null;
  return value === CUSTOM_THEME ? CUSTOM_THEME : parseThemePreset(value);
}

export function useLocalTheme(userId: string | null) {
  const [themePreset, setThemePresetState] = useState<AppTheme>("echo");
  const [customTheme, setCustomThemeState] = useState<CustomThemeInput | null>(null);

  useEffect(() => {
    // Sem sessão resolvida ainda: manter o último tema aplicado (anti-flash)
    // em vez de resetar para o padrão e piscar na abertura do app.
    const presetKey = userId ? getThemeStorageKey(userId) : LAST_THEME_STORAGE_KEY;
    const customKey = userId ? getCustomThemeStorageKey(userId) : LAST_CUSTOM_THEME_STORAGE_KEY;
    const rawCustom = readStorage(customKey);
    const stored = parseTheme(readStorage(presetKey), rawCustom);
    const input = parseCustomThemeInput(rawCustom);
    setThemePresetState(stored);
    setCustomThemeState(input);
    void applyAppThemePreset(stored, input);
  }, [userId]);

  const setThemePreset = useCallback(
    (next: AppTheme) => {
      if (userId) writeStorage(getThemeStorageKey(userId), next);
      if (next === CUSTOM_THEME) {
        const input = customTheme ?? DEFAULT_CUSTOM_THEME;
        if (userId) writeStorage(getCustomThemeStorageKey(userId), JSON.stringify(input));
        setCustomThemeState(input);
        setThemePresetState(CUSTOM_THEME);
        void applyAppThemePreset(CUSTOM_THEME, input);
        return;
      }
      setThemePresetState(next);
      void applyAppThemePreset(next);
    },
    [userId, customTheme],
  );

  const setCustomTheme = useCallback(
    (input: CustomThemeInput) => {
      if (userId) {
        writeStorage(getCustomThemeStorageKey(userId), JSON.stringify(input));
        writeStorage(getThemeStorageKey(userId), CUSTOM_THEME);
      }
      setCustomThemeState(input);
      setThemePresetState(CUSTOM_THEME);
      return applyAppThemePreset(CUSTOM_THEME, input);
    },
    [userId],
  );

  return { themePreset, setThemePreset, customTheme, setCustomTheme };
}
