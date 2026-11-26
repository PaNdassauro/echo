import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useAccessibilityPrefs, useForcedReducedMotion } from "./useAccessibilityPrefs";
import {
  DEFAULT_A11Y_PREFS,
  LAST_A11Y_STORAGE_KEY,
  applyA11yPrefs,
  getA11yStorageKey,
  parseA11yPrefs,
} from "@/lib/accessibilityPrefs";

afterEach(() => {
  cleanup();
  localStorage.clear();
  applyA11yPrefs(DEFAULT_A11Y_PREFS);
});

describe("useForcedReducedMotion", () => {
  it("acompanha o data-motion do <html> pelo evento de mudança", () => {
    const { result } = renderHook(() => useForcedReducedMotion());
    expect(result.current).toBe(false);

    act(() => applyA11yPrefs({ ...DEFAULT_A11Y_PREFS, reduceMotion: true }));
    expect(result.current).toBe(true);

    act(() => applyA11yPrefs(DEFAULT_A11Y_PREFS));
    expect(result.current).toBe(false);
  });
});

describe("useAccessibilityPrefs", () => {
  it("ao entrar, a preferência do usuário vira a 'última aplicada' do boot", () => {
    // Usuário anterior deixou texto grande e contraste na LAST.
    localStorage.setItem(
      LAST_A11Y_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_A11Y_PREFS, appTextSize: "xl", highContrast: true }),
    );
    renderHook(() => useAccessibilityPrefs("u2"));

    expect(parseA11yPrefs(localStorage.getItem(LAST_A11Y_STORAGE_KEY))).toEqual(DEFAULT_A11Y_PREFS);
    expect(document.documentElement.style.fontSize).toBe("");
    // Não cria a chave por usuário só por ter entrado.
    expect(localStorage.getItem(getA11yStorageKey("u2"))).toBeNull();
  });

  it("sem usuário mantém a última aplicada", () => {
    const last = { ...DEFAULT_A11Y_PREFS, messageTextSize: "lg" as const };
    localStorage.setItem(LAST_A11Y_STORAGE_KEY, JSON.stringify(last));
    const { result } = renderHook(() => useAccessibilityPrefs(null));
    expect(result.current.prefs).toEqual(last);
    expect(parseA11yPrefs(localStorage.getItem(LAST_A11Y_STORAGE_KEY))).toEqual(last);
  });
});
