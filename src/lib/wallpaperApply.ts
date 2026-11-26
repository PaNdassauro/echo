// Liga a imagem de fundo do tema personalizado no <html>: lê o registro do IndexedDB,
// refaz os efeitos se mudaram, cria a blob URL e grava as variáveis que o index.css
// lê em [data-app-theme="custom"] .theme-chat-surface.
import { WALLPAPER_CSS_VARS, wallpaperCssVars, wallpaperEffectsKey, type CustomWallpaper } from "@/lib/customWallpaper";
import { renderWallpaper } from "@/lib/wallpaperRender";
import { getWallpaperRecord, putWallpaperRecord } from "@/lib/wallpaperStore";

export type WallpaperApplyResult = "applied" | "cleared" | "missing" | "error" | "superseded";

interface AppliedWallpaper {
  imageId: string;
  effectsKey: string;
  url: string;
}

let generation = 0;
let applied: AppliedWallpaper | null = null;
const listeners = new Set<() => void>();

export function subscribeAppliedWallpaper(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Blob URL da imagem em uso no app (null sem imagem). */
export function getAppliedWallpaperUrl(): string | null {
  return applied?.url ?? null;
}

function setApplied(next: AppliedWallpaper | null) {
  const previous = applied;
  applied = next;
  if (previous && previous.url !== next?.url) URL.revokeObjectURL(previous.url);
  listeners.forEach((listener) => listener());
}

function writeVars(root: HTMLElement, vars: Record<string, string> | null) {
  for (const name of Object.values(WALLPAPER_CSS_VARS)) {
    if (vars) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }
}

function clear(root: HTMLElement) {
  writeVars(root, null);
  if (applied) setApplied(null);
}

export async function applyCustomWallpaper(wallpaper: CustomWallpaper | null | undefined): Promise<WallpaperApplyResult> {
  const gen = ++generation;
  const root = document.documentElement;
  if (!wallpaper) {
    clear(root);
    return "cleared";
  }

  const effectsKey = wallpaperEffectsKey(wallpaper);
  // Só mudou encaixe ou véu: a imagem processada continua valendo.
  if (applied && applied.imageId === wallpaper.imageId && applied.effectsKey === effectsKey) {
    writeVars(root, wallpaperCssVars(wallpaper, applied.url));
    return "applied";
  }

  const record = await getWallpaperRecord(wallpaper.imageId);
  if (gen !== generation) return "superseded";
  if (!record) {
    console.warn("[wallpaper] imagem não encontrada neste navegador", wallpaper.imageId);
    clear(root);
    return "missing";
  }

  let processed = record.processed;
  if (record.effectsKey !== effectsKey) {
    try {
      processed = await renderWallpaper(record.original, wallpaper);
    } catch (error) {
      console.error("[wallpaper] falha ao aplicar os efeitos", error);
      if (gen === generation) clear(root);
      return gen === generation ? "error" : "superseded";
    }
    // Guarda mesmo se outra aplicação começou: o trabalho caro não se perde.
    void putWallpaperRecord(wallpaper.imageId, { ...record, processed, effectsKey });
    if (gen !== generation) return "superseded";
  }

  const url = URL.createObjectURL(processed);
  writeVars(root, wallpaperCssVars(wallpaper, url));
  setApplied({ imageId: wallpaper.imageId, effectsKey, url });
  return "applied";
}
