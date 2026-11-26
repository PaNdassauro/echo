import { useCallback, useEffect, useMemo, useState } from "react";
import { ditherLevels, wallpaperEffectsKey, type WallpaperEffects } from "@/lib/customWallpaper";
import { WALLPAPER_PREVIEW_SIDE, applyWallpaperEffects, decodeToCanvas } from "@/lib/wallpaperRender";
import { getWallpaperRecord } from "@/lib/wallpaperStore";

/** Blob URL que se revoga sozinha quando troca ou desmonta. */
function useObjectUrl(): [string | null, (blob: Blob | null) => void] {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  const set = useCallback((blob: Blob | null) => setUrl(blob ? URL.createObjectURL(blob) : null), []);
  return [url, set];
}

/**
 * Prévia ao vivo: decodifica a imagem uma vez em WALLPAPER_PREVIEW_SIDE px e refaz os
 * efeitos no máximo uma vez por frame enquanto o usuário arrasta os controles.
 * Data URL síncrona de propósito: o toBlob do Chromium codifica em tarefa ociosa
 * (~240 ms cada, em fila), e a prévia só aparecia depois de soltar o controle.
 */
export interface WallpaperPreview {
  url: string;
  /** Proporção da imagem (para arrastar no "Preencher"). */
  width: number;
  height: number;
}

export function useWallpaperPreview(image: Blob | null, effects: WallpaperEffects | null): WallpaperPreview | null {
  const [base, setBase] = useState<HTMLCanvasElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    setBase(null);
    if (!image) return;
    let cancelled = false;
    decodeToCanvas(image, WALLPAPER_PREVIEW_SIDE)
      .then((canvas) => {
        if (!cancelled) setBase(canvas);
      })
      .catch((error) => console.error("[wallpaper] prévia: falha ao ler a imagem", error));
    return () => {
      cancelled = true;
    };
  }, [image]);

  const key = effects ? wallpaperEffectsKey(effects) : null;
  useEffect(() => {
    if (!base || !effects) {
      setUrl(null);
      return;
    }
    const frame = requestAnimationFrame(() => {
      try {
        const canvas = applyWallpaperEffects(base, effects);
        // JPEG borraria o padrão do dither.
        const dithered = ditherLevels(effects.dither) !== null;
        setUrl(dithered ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.85));
      } catch (error) {
        console.error("[wallpaper] prévia: falha nos efeitos", error);
      }
    });
    return () => cancelAnimationFrame(frame);
    // `effects` entra pela chave: objeto novo com os mesmos valores não refaz a prévia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, key]);

  return useMemo(() => (url && base ? { url, width: base.width, height: base.height } : null), [url, base]);
}

/** Imagem já processada de um tema salvo (para o cartão "Personalizado"). */
export function useStoredWallpaperUrl(imageId: string | null): string | null {
  const [url, setBlob] = useObjectUrl();
  useEffect(() => {
    setBlob(null);
    if (!imageId) return;
    let cancelled = false;
    void getWallpaperRecord(imageId).then((record) => {
      if (!cancelled) setBlob(record?.processed ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [imageId, setBlob]);
  return url;
}
