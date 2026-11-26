import { useCallback, useEffect, useRef, useState } from "react";
import {
  A11Y_CHANGE_EVENT,
  DEFAULT_A11Y_PREFS,
  applyA11yPrefs,
  persistA11yPrefs,
  readA11yPrefs,
  type A11yPrefs,
} from "@/lib/accessibilityPrefs";

/**
 * Preferências de acessibilidade do usuário (mesmo ciclo do useLocalTheme):
 * sem userId mantém a última aplicada; com userId lê e aplica a dele.
 * Montado globalmente no UserThemeMount e de novo na tela de Configurações.
 */
export function useAccessibilityPrefs(userId: string | null) {
  const [prefs, setPrefsState] = useState<A11yPrefs>(() => readA11yPrefs(userId));
  // Ref com o valor mais recente: dois setPrefs seguidos no mesmo tick não se
  // atropelam, e os efeitos (storage, <html>) ficam fora do updater do setState.
  const prefsRef = useRef(prefs);

  useEffect(() => {
    const stored = readA11yPrefs(userId);
    prefsRef.current = stored;
    setPrefsState(stored);
    applyA11yPrefs(stored);
    // Atualiza a "última aplicada" que o main.tsx lê no boot: sem isto, quem
    // entra depois de outro usuário no mesmo navegador herda a dele até a
    // sessão resolver (o anti-flash vira flash).
    if (userId) persistA11yPrefs(null, stored);
  }, [userId]);

  const setPrefs = useCallback(
    (patch: Partial<A11yPrefs>) => {
      const next = { ...prefsRef.current, ...patch };
      prefsRef.current = next;
      persistA11yPrefs(userId, next);
      applyA11yPrefs(next);
      setPrefsState(next);
    },
    [userId],
  );

  const resetPrefs = useCallback(() => setPrefs(DEFAULT_A11Y_PREFS), [setPrefs]);

  return { prefs, setPrefs, resetPrefs };
}

/** Movimento reduzido forçado nas preferências (o do sistema o MotionConfig já lê). */
export function useForcedReducedMotion(): boolean {
  const read = () => document.documentElement.dataset.motion === "reduce";
  const [forced, setForced] = useState(read);

  useEffect(() => {
    const onChange = () => setForced(read());
    window.addEventListener(A11Y_CHANGE_EVENT, onChange);
    onChange();
    return () => window.removeEventListener(A11Y_CHANGE_EVENT, onChange);
  }, []);

  return forced;
}
