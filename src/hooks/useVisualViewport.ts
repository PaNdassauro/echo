import { useEffect, useState } from "react";

/**
 * Altura visível real quando o teclado virtual está aberto.
 *
 * No Android, `interactive-widget=resizes-content` (index.html) faz o layout
 * encolher nativamente. No iOS o layout viewport NÃO encolhe — o teclado cobre
 * o composer — então medimos o visualViewport e devolvemos a altura visível.
 * Retorna null quando nenhum ajuste é necessário (teclado fechado ou diferença
 * irrelevante), para o layout ficar 100% em CSS (dvh) no caso comum.
 */
export function useVisualViewportHeight(enabled: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !window.visualViewport) {
      setHeight(null);
      return;
    }

    const viewport = window.visualViewport;
    const update = () => {
      const diff = window.innerHeight - viewport.height;
      // > 50px = teclado aberto (barras do navegador variam menos que isso)
      setHeight(diff > 50 ? Math.round(viewport.height) : null);
    };

    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    update();

    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [enabled]);

  return height;
}
