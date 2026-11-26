import { z } from "zod";

/**
 * Preferências de acessibilidade, por usuário, neste navegador (mesmo modelo
 * do tema em useLocalTheme): preferência de leitura, não credencial.
 *
 * Contrato com o CSS (tudo no <html>):
 * - `style.fontSize`            → tamanho do texto do app (todo o Tailwind é rem)
 * - `--message-text-scale`      → multiplicador do texto das bolhas (utilitários
 *                                 `text-message` / `text-message-xs`)
 * - `data-motion="reduce"`      → força o modo sem movimento (index.css, variante
 *                                 `motion-reduce:` e `prefersReducedMotion()`)
 * - `data-contrast="more"`      → tokens de alto contraste (index.css)
 */

export const TEXT_SIZES = ["sm", "md", "lg", "xl"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/** Escala do texto do app inteiro (font-size do <html>). */
export const APP_TEXT_SCALE: Record<TextSize, number> = { sm: 0.9, md: 1, lg: 1.125, xl: 1.25 };
/** Escala só do texto das mensagens, por cima da do app. */
export const MESSAGE_TEXT_SCALE: Record<TextSize, number> = { sm: 0.9, md: 1, lg: 1.15, xl: 1.3 };

const textSizeSchema = z.enum(TEXT_SIZES);

/** `.catch` por campo: um campo corrompido volta ao padrão sem derrubar os outros. */
const a11yPrefsSchema = z.object({
  appTextSize: textSizeSchema.catch("md"),
  messageTextSize: textSizeSchema.catch("md"),
  reduceMotion: z.boolean().catch(false),
  highContrast: z.boolean().catch(false),
});

export type A11yPrefs = z.infer<typeof a11yPrefsSchema>;

export const DEFAULT_A11Y_PREFS: A11yPrefs = {
  appTextSize: "md",
  messageTextSize: "md",
  reduceMotion: false,
  highContrast: false,
};

const STORAGE_PREFIX = "echo_a11y_";
/** Última preferência aplicada, lida no boot antes de a sessão existir. */
export const LAST_A11Y_STORAGE_KEY = "echo_a11y_last";
/** Disparado no window a cada aplicação (ex.: MotionConfig acompanha). */
export const A11Y_CHANGE_EVENT = "echo-a11y-change";

export const getA11yStorageKey = (userId: string) => `${STORAGE_PREFIX}${userId}`;

export function parseA11yPrefs(raw: string | null): A11yPrefs {
  if (!raw) return DEFAULT_A11Y_PREFS;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_A11Y_PREFS;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return DEFAULT_A11Y_PREFS;
  return a11yPrefsSchema.parse(data);
}

/** Sem userId (sessão ainda não resolvida), lê a última aplicada. */
export function readA11yPrefs(userId: string | null): A11yPrefs {
  try {
    return parseA11yPrefs(localStorage.getItem(userId ? getA11yStorageKey(userId) : LAST_A11Y_STORAGE_KEY));
  } catch {
    return DEFAULT_A11Y_PREFS;
  }
}

export function persistA11yPrefs(userId: string | null, prefs: A11yPrefs): void {
  try {
    const raw = JSON.stringify(prefs);
    if (userId) localStorage.setItem(getA11yStorageKey(userId), raw);
    localStorage.setItem(LAST_A11Y_STORAGE_KEY, raw);
  } catch {
    /* modo privado / storage cheio — a preferência ainda se aplica nesta aba */
  }
}

export function applyA11yPrefs(prefs: A11yPrefs, root: HTMLElement = document.documentElement): void {
  const appScale = APP_TEXT_SCALE[prefs.appTextSize];
  if (appScale === 1) root.style.removeProperty("font-size");
  else root.style.fontSize = `${appScale * 100}%`;

  const messageScale = MESSAGE_TEXT_SCALE[prefs.messageTextSize];
  if (messageScale === 1) root.style.removeProperty("--message-text-scale");
  else root.style.setProperty("--message-text-scale", String(messageScale));

  if (prefs.reduceMotion) root.dataset.motion = "reduce";
  else delete root.dataset.motion;

  if (prefs.highContrast) root.dataset.contrast = "more";
  else delete root.dataset.contrast;

  window.dispatchEvent(new Event(A11Y_CHANGE_EVENT));
}

/**
 * Movimento reduzido valendo agora: pedido do sistema OU forçado nas
 * preferências. Para checks em JS (o CSS e a variante `motion-reduce:` já
 * cobrem os dois casos sozinhos).
 */
export function prefersReducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.motion === "reduce") return true;
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/** `behavior` para scrollIntoView/scrollTo: instantâneo com movimento reduzido. */
export const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? "auto" : "smooth");
