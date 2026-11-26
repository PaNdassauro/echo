import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CUSTOM_THEME_BOOT_STORAGE_KEY,
  LAST_CUSTOM_THEME_STORAGE_KEY,
  LAST_THEME_STORAGE_KEY,
  applyAppThemePreset,
  getCurrentAppThemePreset,
  getCustomThemeStorageKey,
  getThemeStorageKey,
  useLocalTheme,
} from "@/hooks/useLocalTheme";
import { usePhoneTheme } from "@/hooks/usePhoneTheme";
import { DEFAULT_CUSTOM_THEME, parseCustomThemeInput, type CustomThemeInput } from "@/lib/customTheme";

const STYLE_ID = "echo-custom-theme";
const root = document.documentElement;
const styles = () => document.querySelectorAll(`#${STYLE_ID}`);
const DARK_INPUT: CustomThemeInput = { primary: "#3b82f6", background: "#0f172a", bubble: "#1e40af", base: "dark" };

const reset = () => {
  localStorage.clear();
  delete root.dataset.appTheme;
  root.classList.remove("dark");
  root.removeAttribute("style");
  document.getElementById(STYLE_ID)?.remove();
};

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

describe("applyAppThemePreset: custom", () => {
  it("aplica o tema claro com um único <style> e persiste", () => {
    applyAppThemePreset("custom", DEFAULT_CUSTOM_THEME);
    applyAppThemePreset("custom", DEFAULT_CUSTOM_THEME);
    expect(root.dataset.appTheme).toBe("custom");
    expect(styles()).toHaveLength(1);
    expect(styles()[0].textContent).toContain('html:root[data-app-theme="custom"]');
    expect(root.classList.contains("dark")).toBe(DEFAULT_CUSTOM_THEME.base === "dark");
    expect(localStorage.getItem(LAST_THEME_STORAGE_KEY)).toBe("custom");
    expect(parseCustomThemeInput(localStorage.getItem(LAST_CUSTOM_THEME_STORAGE_KEY))).not.toBeNull();
    const boot = JSON.parse(localStorage.getItem(CUSTOM_THEME_BOOT_STORAGE_KEY) ?? "null") as {
      css: unknown;
      dark: unknown;
      themeColor: unknown;
    };
    expect(typeof boot.css).toBe("string");
    expect(typeof boot.dark).toBe("boolean");
    expect(String(boot.themeColor)).toMatch(/^hsl\(/);
  });

  it("base escura liga .dark", () => {
    applyAppThemePreset("custom", DARK_INPUT);
    expect(root.classList.contains("dark")).toBe(true);
  });

  it("custom -> breu remove o style e mantém .dark; -> lavanda tira .dark", () => {
    applyAppThemePreset("custom", DARK_INPUT);
    applyAppThemePreset("breu");
    expect(styles()).toHaveLength(0);
    expect(root.classList.contains("dark")).toBe(true);
    applyAppThemePreset("lavanda");
    expect(root.classList.contains("dark")).toBe(false);
  });

  it("limpa o inline do número ao sair do echo, mas não no echo", () => {
    root.style.setProperty("--primary", "1 2% 3%");
    root.style.setProperty("--phone-theme-hue", "200");
    applyAppThemePreset("echo");
    expect(root.style.getPropertyValue("--primary")).toBe("1 2% 3%");
    applyAppThemePreset("custom", DEFAULT_CUSTOM_THEME);
    expect(root.style.getPropertyValue("--primary")).toBe("");
    expect(root.style.getPropertyValue("--phone-theme-hue")).toBe("200");
  });

  it("getCurrentAppThemePreset reconhece custom", () => {
    applyAppThemePreset("custom", DEFAULT_CUSTOM_THEME);
    expect(getCurrentAppThemePreset()).toBe("custom");
  });

  it("custom sem entrada vira echo", () => {
    applyAppThemePreset("custom");
    expect(root.dataset.appTheme).toBe("echo");
  });

  it("usePhoneTheme não grava --primary inline sob custom", () => {
    applyAppThemePreset("custom", DEFAULT_CUSTOM_THEME);
    renderHook(() => usePhoneTheme(200));
    expect(root.style.getPropertyValue("--primary")).toBe("");
    expect(root.style.getPropertyValue("--phone-theme-hue")).toBe("200");
  });
});

describe("useLocalTheme: custom", () => {
  it("carrega o custom salvo do usuário", () => {
    localStorage.setItem(getThemeStorageKey("u1"), "custom");
    localStorage.setItem(getCustomThemeStorageKey("u1"), JSON.stringify(DARK_INPUT));
    const { result } = renderHook(() => useLocalTheme("u1"));
    expect(result.current.themePreset).toBe("custom");
    expect(result.current.customTheme).toEqual(DARK_INPUT);
    expect(styles()).toHaveLength(1);
  });

  it("entrada inválida cai para echo", () => {
    localStorage.setItem(getThemeStorageKey("u1"), "custom");
    localStorage.setItem(getCustomThemeStorageKey("u1"), "{");
    const { result } = renderHook(() => useLocalTheme("u1"));
    expect(result.current.themePreset).toBe("echo");
    expect(styles()).toHaveLength(0);
  });

  it("setCustomTheme grava as duas chaves e aplica", () => {
    const { result } = renderHook(() => useLocalTheme("u1"));
    act(() => {
      void result.current.setCustomTheme(DARK_INPUT);
    });
    expect(localStorage.getItem(getThemeStorageKey("u1"))).toBe("custom");
    expect(parseCustomThemeInput(localStorage.getItem(getCustomThemeStorageKey("u1")))).toEqual(DARK_INPUT);
    expect(result.current.themePreset).toBe("custom");
    expect(root.dataset.appTheme).toBe("custom");
    expect(root.classList.contains("dark")).toBe(true);
  });

  it("setThemePreset('custom') sem salvo usa o padrão", () => {
    const { result } = renderHook(() => useLocalTheme("u1"));
    act(() => result.current.setThemePreset("custom"));
    expect(result.current.customTheme).toEqual(DEFAULT_CUSTOM_THEME);
    expect(root.dataset.appTheme).toBe("custom");
  });
});
