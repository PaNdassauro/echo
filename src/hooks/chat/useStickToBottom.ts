import { useCallback, useEffect, useRef } from "react";

/** Distância do fim REAL (DOM) que ainda conta como "no fim". */
const BOTTOM_EPSILON_PX = 2;
/**
 * Depois de um gesto PARA CIMA (roda, toque, tecla), por quanto tempo os
 * eventos de scroll contam como do usuário (inércia do trackpad).
 */
const UP_INTENT_MS = 600;
/** Teclas que sobem o próprio scroller quando ele está focado. */
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
/** Teclas que descem o scroller: intenção de chegar ao fim. */
const DOWN_KEYS = new Set(["ArrowDown", "PageDown", "End"]);
/** Folga do ponteiro para "não subiu" ao soltar (tremida da mão). */
const POINTER_SLOP_PX = 2;
/**
 * Depois de um scrollToEnd suave, por quanto tempo o crescimento do conteúdo
 * (imagem chegando, rodapé) reaponta o scroll suave para o scrollHeight novo,
 * em vez de saltar: o destino da animação ficou velho.
 */
const SEEK_RETARGET_MS = 1500;
/**
 * Depois de um unpin() (navegação programática: divisor de não lidas, citação,
 * busca), por quanto tempo um scroll que chega ao fim NÃO gruda. Evita que o
 * posicionamento inicial do Virtuoso ou uma nova tentativa, caindo no fim no
 * meio do caminho, sejam revertidos pelo ramo de reversão.
 */
const NAV_GRACE_MS = 1500;
/**
 * Até quantas telas de distância o "ir ao fim" ainda vale a pena ser suave.
 * De mais longe vai direto: numa lista virtualizada o scrollHeight cresce
 * enquanto as linhas são medidas, e uma animação suave perseguindo esse alvo
 * nunca chega (ficava a ~12 mil px do fim depois de 3 s). WhatsApp Web e
 * Telegram também saltam quando o fim está longe.
 */
const SMOOTH_MAX_VIEWPORTS = 3;

/**
 * Este hook é a ÚNICA autoridade do fim da lista: o Virtuoso roda com
 * followOutput desligado e nenhum componente usa scrollIntoView.
 *
 * Mantém a lista grudada no fim REAL do scroller (scrollHeight do DOM), não
 * no "último item" que o Virtuoso calcula com alturas em cache.
 *
 * Por quê: a lista é virtualizada e as bolhas mudam de altura depois de
 * montar (imagem carregando, bolha remontando ao voltar para a tela). Todo
 * scroll por índice (scrollToIndex, followOutput, autoscrollToBottom) mira a
 * altura antiga e para no meio da última bolha; e o limiar de 100px do
 * atBottom do Virtuoso faz ele nem tentar quando falta pouco. Com a última
 * mensagem sendo imagem, quem arrastava até o fim voltava para o meio dela.
 *
 * Regra: quem chega ao fim real fica grudado. Enquanto grudado, se o conteúdo
 * cresce ou algo que não é o usuário move a lista para cima, volta ao fim.
 * Só gesto PARA CIMA solta (roda, tecla, dedo descendo), ou `unpin()` (ir até
 * uma citação, ao divisor de não lidas, à busca). Gesto para baixo não solta:
 * era o que deixava o puxão logo depois de rolar até o fim passar.
 *
 * Ponteiro pressionado (arraste da barra): ninguém corrige durante o arraste,
 * para não brigar com a mão. Ao soltar, se chegou ao fim durante o arraste (ou
 * já estava nele) e o ponteiro não subiu no total, volta ao fim. Não depende de
 * pointermove durante o arraste da barra nativa.
 */
export function useStickToBottom(scroller: HTMLElement | null) {
  const pinnedRef = useRef(true);
  const seekRef = useRef<{ smooth: boolean; until: number; target: number } | null>(null);
  const navUntilRef = useRef(0);
  // Reavaliação do "estou no fim" quando a janela de navegação fecha (ver unpin).
  const settleRef = useRef<(() => void) | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!scroller) return;
    pinnedRef.current = true;
    let lastTop = scroller.scrollTop;
    let upIntentUntil = 0;
    // Ponteiro pressionado: posição inicial e se o fim foi alcançado no arraste.
    let held: { startY: number; reachedEnd: boolean } | null = null;

    const distance = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    const toEnd = () => {
      scroller.scrollTop = scroller.scrollHeight;
      lastTop = scroller.scrollTop;
    };
    const upIntent = () => performance.now() < upIntentUntil;
    const markUpIntent = () => {
      upIntentUntil = performance.now() + UP_INTENT_MS;
    };

    // Navegação programática que termina no fim real (alvo travado no máximo) não
    // emite scroll: sem esta reavaliação a lista ficaria no fim, mas solta, e
    // nada a seguiria (followOutput está desligado).
    const settle = () => {
      if (held || pinnedRef.current) return;
      if (performance.now() < navUntilRef.current) return;
      if (distance() <= BOTTOM_EPSILON_PX) {
        pinnedRef.current = true;
        seekRef.current = null;
      }
    };
    settleRef.current = settle;

    // Intenção de ir ao fim: encerra a janela de navegação, para a chegada do próprio usuário gruda.
    const clearNavGrace = () => {
      navUntilRef.current = 0;
      settle();
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // ctrl+roda é pinça de zoom, não rolagem
      if (e.deltaY < 0) markUpIntent();
      else if (e.deltaY > 0) clearNavGrace();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey)) markUpIntent();
      else if (DOWN_KEYS.has(e.key)) clearNavGrace();
    };
    // Dedo descendo = conteúdo subindo.
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (y === undefined) return;
      if (touchY !== null && y > touchY) markUpIntent();
      else if (touchY !== null && y < touchY) clearNavGrace(); // dedo subindo = conteúdo descendo
      touchY = y;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") return; // toque é tratado pelos touch*
      held = { startY: e.clientY, reachedEnd: pinnedRef.current };
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!held) return;
      const { startY, reachedEnd } = held;
      held = null;
      const wentUp = e.type === "pointerup" && e.clientY < startY - POINTER_SLOP_PX;
      if (reachedEnd && !wentUp) {
        pinnedRef.current = true;
        if (distance() > BOTTOM_EPSILON_PX) toEnd();
      }
    };
    // pointerup perdido (soltou fora da janela): botão já solto = arraste acabou.
    const onPointerMove = (e: PointerEvent) => {
      if (held && e.buttons === 0) onPointerUp(e);
    };
    const onBlur = () => {
      held = null;
    };

    const onScroll = () => {
      const top = scroller.scrollTop;
      if (distance() <= BOTTOM_EPSILON_PX) {
        // Dentro da janela de navegação (depois de unpin) chegar ao fim não gruda.
        if (performance.now() >= navUntilRef.current) pinnedRef.current = true;
        seekRef.current = null;
        if (held) held.reachedEnd = true;
      } else if (top < lastTop) {
        if (upIntent()) {
          pinnedRef.current = false;
          seekRef.current = null;
        } else if (held) {
          // Arrastando: decide ao soltar.
          pinnedRef.current = false;
        } else if (pinnedRef.current) {
          // Subiu sem gesto para cima: correção do Virtuoso ou scroll por
          // índice com altura velha. Volta ao fim real.
          toEnd();
          return;
        }
      }
      // Seek suave em andamento: a animação continua viva enquanto há scroll, e só
      // reaponta quando está perto do destino velho (reapontar a cada crescimento
      // reinicia a curva do navegador e a viagem engatinha).
      const seek = seekRef.current;
      if (seek && seek.smooth && pinnedRef.current && performance.now() < seek.until) {
        seek.until = performance.now() + SEEK_RETARGET_MS;
        retarget(seek);
      }
      lastTop = top;
    };

    const retarget = (seek: { target: number }) => {
      if (seek.target - scroller.scrollTop > scroller.clientHeight) return;
      if (scroller.scrollHeight <= seek.target) return;
      seek.target = scroller.scrollHeight;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    };

    // Conteúdo mudou de altura (imagem carregou, bolha remontou, rodapé de
    // envio/digitando): quem estava grudado continua no fim.
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (held || !pinnedRef.current || distance() <= BOTTOM_EPSILON_PX) return;
            const seek = seekRef.current;
            if (seek && seek.smooth && performance.now() < seek.until) {
              retarget(seek);
            } else {
              toEnd();
            }
          });
    resizeObserver?.observe(scroller);
    // Viewport do Virtuoso > [header, lista, footer]: a altura do conteúdo.
    const viewport = scroller.firstElementChild;
    // border-box: a List do Virtuoso é border-box e guarda as estimativas das linhas
    // não renderizadas em paddingTop/paddingBottom; content-box não enxerga padding.
    if (viewport) {
      Array.from(viewport.children).forEach((child) => resizeObserver?.observe(child, { box: "border-box" }));
    }

    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    scroller.addEventListener("pointerdown", onPointerDown);
    scroller.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("blur", onBlur);
    return () => {
      settleRef.current = null;
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
      resizeObserver?.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onBlur);
    };
  }, [scroller]);

  /** Scroll programático para fora do fim (citação, divisor, busca): solta antes. */
  const unpin = useCallback(() => {
    pinnedRef.current = false;
    navUntilRef.current = performance.now() + NAV_GRACE_MS;
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      settleRef.current?.();
    }, NAV_GRACE_MS + 1);
  }, []);

  /**
   * Vai até o fim real. É uma intenção: gruda na hora (e encerra a janela de
   * navegação), então o crescimento depois da chamada (digitando, imagem
   * chegando) é seguido; no modo suave, o destino é reapontado a cada
   * crescimento durante SEEK_RETARGET_MS. Suave só até SMOOTH_MAX_VIEWPORTS
   * telas do fim; de mais longe vai direto.
   */
  const scrollToEnd = useCallback(
    (behavior: "auto" | "smooth") => {
      if (!scroller) return;
      const far =
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > SMOOTH_MAX_VIEWPORTS * scroller.clientHeight;
      const mode: "auto" | "smooth" = behavior === "smooth" && !far ? "smooth" : "auto";
      pinnedRef.current = true;
      navUntilRef.current = 0;
      seekRef.current = {
        smooth: mode === "smooth",
        until: performance.now() + SEEK_RETARGET_MS,
        target: scroller.scrollHeight,
      };
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: mode });
    },
    [scroller],
  );

  return { unpin, scrollToEnd };
}
