import type { Transition } from "framer-motion";

/**
 * Springs canônicos do app (framer-motion) — uma fonte, sem literais soltos.
 *
 * SPRING_SHEET  ζ≈0,95: entrada de painéis/sheets — chega firme, sem bounce.
 * SPRING_SNAP   ζ≈0,87: retorno de gesto (swipe solto) — rápido com um toque
 *               de vida, mas ainda sem oscilar visivelmente.
 */
export const SPRING_SHEET: Transition = { type: "spring", stiffness: 320, damping: 34, mass: 0.9 };
export const SPRING_SNAP: Transition = { type: "spring", stiffness: 420, damping: 34, mass: 0.9 };
