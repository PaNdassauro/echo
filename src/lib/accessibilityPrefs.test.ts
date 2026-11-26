import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig";
import {
  A11Y_CHANGE_EVENT,
  DEFAULT_A11Y_PREFS,
  LAST_A11Y_STORAGE_KEY,
  applyA11yPrefs,
  getA11yStorageKey,
  parseA11yPrefs,
  persistA11yPrefs,
  prefersReducedMotion,
  readA11yPrefs,
  scrollBehavior,
  type A11yPrefs,
} from "./accessibilityPrefs";

const ALL_ON: A11yPrefs = { appTextSize: "xl", messageTextSize: "lg", reduceMotion: true, highContrast: true };

const root = () => document.documentElement;

/** O jsdom não tem matchMedia: simula o "Reduzir movimento" do sistema. */
function mockSystemReducedMotion(reduce: boolean) {
  const matchMedia = vi.fn((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" ? reduce : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal("matchMedia", matchMedia);
  return matchMedia;
}

function resetRoot() {
  root().removeAttribute("style");
  delete root().dataset.motion;
  delete root().dataset.contrast;
}

beforeEach(resetRoot);

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetRoot();
});

describe("parseA11yPrefs", () => {
  it("devolve o padrão sem valor, com JSON inválido ou com lixo", () => {
    expect(parseA11yPrefs(null)).toEqual(DEFAULT_A11Y_PREFS);
    expect(parseA11yPrefs("")).toEqual(DEFAULT_A11Y_PREFS);
    expect(parseA11yPrefs("{nao é json")).toEqual(DEFAULT_A11Y_PREFS);
    expect(parseA11yPrefs("42")).toEqual(DEFAULT_A11Y_PREFS);
    expect(parseA11yPrefs('"texto"')).toEqual(DEFAULT_A11Y_PREFS);
    expect(parseA11yPrefs("null")).toEqual(DEFAULT_A11Y_PREFS);
  });

  it("devolve o padrão para array", () => {
    expect(parseA11yPrefs("[]")).toEqual(DEFAULT_A11Y_PREFS);
    expect(parseA11yPrefs(JSON.stringify([ALL_ON]))).toEqual(DEFAULT_A11Y_PREFS);
  });

  it("lê um objeto válido inteiro", () => {
    expect(parseA11yPrefs(JSON.stringify(ALL_ON))).toEqual(ALL_ON);
  });

  it("campo corrompido volta ao padrão sem derrubar os outros", () => {
    const raw = JSON.stringify({ appTextSize: "gigante", messageTextSize: "lg", reduceMotion: "sim", highContrast: true });
    expect(parseA11yPrefs(raw)).toEqual({
      appTextSize: "md",
      messageTextSize: "lg",
      reduceMotion: false,
      highContrast: true,
    });
  });

  it("completa campos ausentes e ignora campos extras", () => {
    expect(parseA11yPrefs(JSON.stringify({ reduceMotion: true, extra: 1 }))).toEqual({
      ...DEFAULT_A11Y_PREFS,
      reduceMotion: true,
    });
  });
});

describe("readA11yPrefs / persistA11yPrefs", () => {
  it("grava na chave do usuário e na última aplicada", () => {
    persistA11yPrefs("u1", ALL_ON);
    expect(localStorage.getItem(getA11yStorageKey("u1"))).toBe(JSON.stringify(ALL_ON));
    expect(localStorage.getItem(LAST_A11Y_STORAGE_KEY)).toBe(JSON.stringify(ALL_ON));
    expect(readA11yPrefs("u1")).toEqual(ALL_ON);
  });

  it("separa usuários, e sem userId lê a última aplicada", () => {
    persistA11yPrefs("u1", ALL_ON);
    persistA11yPrefs("u2", DEFAULT_A11Y_PREFS);
    expect(readA11yPrefs("u1")).toEqual(ALL_ON);
    expect(readA11yPrefs("u2")).toEqual(DEFAULT_A11Y_PREFS);
    expect(readA11yPrefs(null)).toEqual(DEFAULT_A11Y_PREFS);
  });

  it("sem userId grava só a última aplicada", () => {
    persistA11yPrefs(null, ALL_ON);
    expect(localStorage.length).toBe(1);
    expect(readA11yPrefs(null)).toEqual(ALL_ON);
    expect(readA11yPrefs("u1")).toEqual(DEFAULT_A11Y_PREFS);
  });

  it("storage que lança não derruba leitura nem gravação", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cheio");
    });
    expect(() => persistA11yPrefs("u1", ALL_ON)).not.toThrow();
    expect(readA11yPrefs("u1")).toEqual(DEFAULT_A11Y_PREFS);
  });
});

describe("applyA11yPrefs", () => {
  it("grava tamanho, escala das mensagens, movimento e contraste no <html>", () => {
    applyA11yPrefs(ALL_ON);
    expect(root().style.fontSize).toBe("125%");
    expect(root().style.getPropertyValue("--message-text-scale")).toBe("1.15");
    expect(root().dataset.motion).toBe("reduce");
    expect(root().dataset.contrast).toBe("more");
  });

  it("de volta ao padrão remove font-size, --message-text-scale e os data-*", () => {
    applyA11yPrefs(ALL_ON);
    applyA11yPrefs(DEFAULT_A11Y_PREFS);
    expect(root().style.fontSize).toBe("");
    expect(root().style.getPropertyValue("--message-text-scale")).toBe("");
    expect(root().hasAttribute("data-motion")).toBe(false);
    expect(root().hasAttribute("data-contrast")).toBe(false);
  });

  it("dispara o evento de mudança a cada aplicação", () => {
    const onChange = vi.fn();
    window.addEventListener(A11Y_CHANGE_EVENT, onChange);
    applyA11yPrefs(ALL_ON);
    applyA11yPrefs(DEFAULT_A11Y_PREFS);
    window.removeEventListener(A11Y_CHANGE_EVENT, onChange);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("prefersReducedMotion / scrollBehavior", () => {
  it("sem pedido do sistema nem preferência: anima e rola suave", () => {
    mockSystemReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe("smooth");
  });

  it("pedido do sistema vale sozinho", () => {
    mockSystemReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(scrollBehavior()).toBe("auto");
  });

  it("preferência forçada vale com o sistema sem pedido", () => {
    mockSystemReducedMotion(false);
    applyA11yPrefs({ ...DEFAULT_A11Y_PREFS, reduceMotion: true });
    expect(prefersReducedMotion()).toBe(true);
    expect(scrollBehavior()).toBe("auto");
    applyA11yPrefs(DEFAULT_A11Y_PREFS);
    expect(scrollBehavior()).toBe("smooth");
  });

  it("sem matchMedia (ambiente antigo) não lança", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
    root().dataset.motion = "reduce";
    expect(prefersReducedMotion()).toBe(true);
  });
});

// Contrato com o tailwind.config.ts: as variantes core de movimento também
// obedecem ao data-motion do <html>. A config intercepta um detalhe interno do
// Tailwind 3.4 (ordem de registro das variantes), então este teste é o alarme
// se uma atualização do Tailwind mudar isso.
describe("variantes motion-reduce/motion-safe do Tailwind", () => {
  async function generate(classes: string) {
    const config = loadConfig(path.resolve(__dirname, "../../tailwind.config.ts"));
    const result = await postcss([
      tailwindcss({ ...config, content: [{ raw: `<div class="${classes}"></div>`, extension: "html" }] }),
    ]).process("@tailwind utilities;", { from: undefined });
    return result.css.replace(/\s+/g, " ");
  }

  it("motion-reduce casa com o sistema OU com data-motion=reduce", async () => {
    const css = await generate("motion-reduce:animate-none");
    expect(css).toContain("@media (prefers-reduced-motion: reduce) { .motion-reduce\\:animate-none { animation: none");
    expect(css).toContain(':root[data-motion="reduce"] .motion-reduce\\:animate-none { animation: none');
  }, 20_000);

  it("motion-safe exige o sistema sem pedido E data-motion não forçado", async () => {
    const css = await generate("motion-safe:animate-spin");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) \{ (@keyframes spin \{.*?\} \} )?:root:not\(\[data-motion="reduce"\]\) \.motion-safe\\:animate-spin \{ animation: spin/,
    );
    expect(css).not.toMatch(/(^|\} )\.motion-safe\\:animate-spin/);
  }, 20_000);

  it("motion-reduce combinado com estado vence o press (active:scale)", async () => {
    const css = await generate("active:scale-[0.96] motion-reduce:active:scale-100");
    const press = css.indexOf(".active\\:scale-\\[0\\.96\\]:active");
    const forced = css.indexOf(':root[data-motion="reduce"] .motion-reduce\\:active\\:scale-100:active');
    expect(press).toBeGreaterThan(-1);
    expect(forced).toBeGreaterThan(press);
  }, 20_000);
});
