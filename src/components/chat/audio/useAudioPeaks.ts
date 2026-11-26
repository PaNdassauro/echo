import { useEffect, useState } from "react";

/** Barras da waveform (0..1 cada). */
export const PEAK_BUCKETS = 44;

type PeaksEntry = number[] | "error";

// Cache de sessão + dedup de decodes em voo: cada bolha visível dispararia um
// fetch+decode próprio do MESMO áudio ao remontar no Virtuoso.
const peaksCache = new Map<string, PeaksEntry>();
const inFlight = new Map<string, Promise<PeaksEntry>>();

let sharedCtx: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  sharedCtx = new Ctor();
  return sharedCtx;
}

async function computePeaks(src: string): Promise<PeaksEntry> {
  try {
    const ctx = getAudioContext();
    if (!ctx) return "error";
    const response = await fetch(src);
    if (!response.ok) return "error";
    const buffer = await response.arrayBuffer();
    // Safari pode não decodificar opus-em-ogg — o caller cai na barra chata.
    const decoded = await ctx.decodeAudioData(buffer);
    const channel = decoded.getChannelData(0);
    const bucketSize = Math.max(1, Math.floor(channel.length / PEAK_BUCKETS));
    const peaks: number[] = [];
    for (let i = 0; i < PEAK_BUCKETS; i++) {
      const start = i * bucketSize;
      const end = Math.min(start + bucketSize, channel.length);
      let sum = 0;
      // Amostragem com passo: RMS aproximado sem varrer cada sample de áudios longos
      const step = Math.max(1, Math.floor((end - start) / 200));
      let count = 0;
      for (let j = start; j < end; j += step) {
        sum += channel[j] * channel[j];
        count++;
      }
      peaks.push(count > 0 ? Math.sqrt(sum / count) : 0);
    }
    const max = Math.max(...peaks, 0.001);
    return peaks.map((p) => p / max);
  } catch {
    return "error";
  }
}

/**
 * Picos de amplitude do áudio para a waveform (paridade WhatsApp).
 * null enquanto decodifica ou quando o codec não decodifica (fallback = barra
 * de progresso chata, como antes).
 */
export function useAudioPeaks(src: string | null): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() => {
    const cached = src ? peaksCache.get(src) : undefined;
    return Array.isArray(cached) ? cached : null;
  });

  useEffect(() => {
    if (!src) {
      setPeaks(null);
      return;
    }
    const cached = peaksCache.get(src);
    if (cached) {
      setPeaks(Array.isArray(cached) ? cached : null);
      return;
    }

    let cancelled = false;
    let promise = inFlight.get(src);
    if (!promise) {
      promise = computePeaks(src).then((result) => {
        peaksCache.set(src, result);
        inFlight.delete(src);
        return result;
      });
      inFlight.set(src, promise);
    }
    promise.then((result) => {
      if (!cancelled) setPeaks(Array.isArray(result) ? result : null);
    });

    return () => {
      cancelled = true;
    };
  }, [src]);

  return peaks;
}
