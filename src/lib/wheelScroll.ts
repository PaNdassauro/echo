import { prefersReducedMotion } from "@/lib/accessibilityPrefs";

/**
 * Limitador de velocidade da roda do mouse, no estilo do WhatsApp Web.
 *
 * O WhatsApp Web rola a conversa bem mais devagar que o scroll nativo, o que
 * dá tempo de a mídia carregar antes de entrar na tela. Aqui só o "clique" da
 * roda (notch) é interceptado: trackpad (deltas finos), toque, teclado e
 * scroll programático seguem nativos.
 */

export interface WheelLimiterOptions {
  /** Quanto um clique da roda rola, em px. */
  notchPx?: number;
  /** Teto de velocidade da animação, em px/s. */
  maxPxPerSecond?: number;
  /** Tempo de aproximação do destino (ease-out), em ms. */
  durationMs?: number;
}

const DEFAULT_NOTCH_PX = 100;
const DEFAULT_MAX_PX_PER_SECOND = 1800;
const DEFAULT_DURATION_MS = 140;
/** Delta em pixels a partir do qual um evento (deltaMode 0) conta como clique de roda. */
const NOTCH_MIN_DELTA_PX = 50;
const STOP_DISTANCE_PX = 0.5;
/** Frame longo (aba em segundo plano) não vira salto. */
const MAX_FRAME_MS = 50;
/** Primeiro frame depois do clique (ou relógio parado): anda como um frame de 60 Hz. */
const NOMINAL_FRAME_MS = 16;
/**
 * Piso de velocidade da cauda do ease-out: sem ele a aproximação exponencial
 * levaria ~45 frames para vencer os últimos px e o clique pareceria "arrastar".
 */
const MIN_PX_PER_SECOND = 300;
/**
 * Se o scroller andou mais do que isto além do que o limitador escreveu, outra
 * coisa rolou: a compensação do Virtuoso ao paginar para cima, o
 * useStickToBottom voltando ao fim, teclado, toque, clamp por conteúdo que
 * encolheu. O alvo é reancorado pelo mesmo deslocamento, para o que falta do
 * gesto continuar valendo (largar o alvo perdia cliques a cada paginação).
 * Sem detectar isso o limitador e o hook brigavam frame a frame e a lista
 * parava a 30 px do fim.
 */
const EXTERNAL_MOVE_PX = 1;

const DOM_DELTA_PIXEL = 0;

function isNotch(e: WheelEvent): boolean {
  if (e.ctrlKey) return false; // pinch-zoom do trackpad chega como wheel + ctrl
  if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return false;
  if (e.deltaMode !== DOM_DELTA_PIXEL) return true; // linhas ou páginas: só roda de mouse
  return Math.abs(e.deltaY) >= NOTCH_MIN_DELTA_PX;
}

export function attachWheelLimiter(scroller: HTMLElement, opts: WheelLimiterOptions = {}): () => void {
  const notchPx = opts.notchPx ?? DEFAULT_NOTCH_PX;
  const maxPxPerSecond = opts.maxPxPerSecond ?? DEFAULT_MAX_PX_PER_SECOND;
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;

  let target: number | null = null;
  let raf: number | null = null;
  /** Instante do último frame; null = o próximo frame é o primeiro depois de um clique. */
  let lastTime: number | null = null;
  /** Último scrollTop que o limitador escreveu (null = loop parado). */
  let expected: number | null = null;

  const maxScroll = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const clamp = (v: number) => Math.min(Math.max(v, 0), maxScroll());

  const stop = () => {
    target = null;
    expected = null;
  };

  /** Outra coisa moveu o scroller desde a última escrita: devolve o deslocamento. */
  const driftByOthers = () => (expected === null ? 0 : scroller.scrollTop - expected);

  const frame = () => {
    raf = null; // limpa o handle antes de reagendar
    if (target === null) return;
    const drift = driftByOthers();
    if (Math.abs(drift) > EXTERNAL_MOVE_PX) target += drift;
    // Relógio único (performance.now, não o carimbo do rAF, que é o início do
    // frame e pode vir antes do evento). O primeiro frame depois de um clique
    // anda como um frame nominal: ele chega décimos de ms depois do evento e um
    // passo proporcional a isso arredondaria para zero.
    const now = performance.now();
    const dt = (lastTime === null ? NOMINAL_FRAME_MS : Math.min(Math.max(now - lastTime, 1), MAX_FRAME_MS)) / 1000;
    lastTime = now;

    // A lista cresce (paginação, mídia): o destino é reclampado a cada frame.
    target = clamp(target);
    const current = scroller.scrollTop;
    const diff = target - current;
    if (Math.abs(diff) <= STOP_DISTANCE_PX) return stop();
    // Ease-out: a velocidade cai junto com a distância, entre o piso e o teto.
    const speed = Math.max(MIN_PX_PER_SECOND, Math.min(maxPxPerSecond, Math.abs(diff) / (durationMs / 1000)));
    // Ao menos 1 px por frame: o Chrome arredonda o scroll para pixel inteiro e
    // um passo fracionário viraria "não andou".
    const step = Math.min(Math.abs(diff), Math.max(1, speed * dt));
    scroller.scrollTop = current + Math.sign(diff) * step;
    const after = scroller.scrollTop;
    // Pediu ≥ 1 px e não andou nem meio: limite do navegador. Parar, senão fica em loop.
    if (Math.abs(after - current) < 0.5) return stop();
    expected = after;
    raf = requestAnimationFrame(frame);
  };

  const onWheel = (e: WheelEvent) => {
    if (!isNotch(e)) return;
    e.preventDefault();
    const delta = Math.sign(e.deltaY) * notchPx;

    if (prefersReducedMotion()) {
      scroller.scrollTop = clamp(scroller.scrollTop + delta);
      return;
    }

    if (target === null) {
      // Parado: o alvo parte de onde o scroller está.
      target = scroller.scrollTop;
      expected = null;
      lastTime = null;
    } else {
      const drift = driftByOthers();
      if (Math.abs(drift) > EXTERNAL_MOVE_PX) target += drift;
    }
    target = clamp(target + delta);
    if (raf === null) raf = requestAnimationFrame(frame);
  };

  scroller.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    scroller.removeEventListener("wheel", onWheel);
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    stop();
  };
}
