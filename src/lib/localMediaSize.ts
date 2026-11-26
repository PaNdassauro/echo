/**
 * Tamanho real de imagem/vídeo medido no navegador.
 *
 * A medida é feita no momento em que o arquivo é escolhido: assim a bolha de
 * envio pendente e a mensagem real nascem com a mesma caixa final, sem altura
 * que muda depois.
 */
import type { MediaSize } from "@/lib/mediaSizeCache";

const measured = new WeakMap<File, MediaSize>();

/** Tamanho já medido para o arquivo, se houver. */
export function localMediaSize(file: File): MediaSize | undefined {
  return measured.get(file);
}

/** Mede a mídia a partir do object URL. Nunca rejeita nem lança: devolve null na falha. */
export function measureLocalMedia(
  file: File,
  objectUrl: string,
  timeoutMs = 1500,
): Promise<MediaSize | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let release: (() => void) | undefined;

    const done = (size: MediaSize | null) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        release?.();
      } catch {
        // Liberar o elemento é só limpeza.
      }
      if (size && size.width > 0 && size.height > 0) {
        measured.set(file, size);
        resolve(size);
        return;
      }
      console.warn("[localMediaSize] não foi possível medir", file.name);
      resolve(null);
    };

    try {
      if (file.type.startsWith("image/")) {
        const img = new Image();
        img.onload = () =>
          done({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => done(null);
        timer = setTimeout(() => done(null), timeoutMs);
        img.src = objectUrl;
      } else if (file.type.startsWith("video/")) {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.muted = true;
        release = () => {
          v.removeAttribute("src");
          v.load();
        };
        v.onloadedmetadata = () =>
          done({ width: v.videoWidth, height: v.videoHeight });
        v.onerror = () => done(null);
        timer = setTimeout(() => done(null), timeoutMs);
        v.src = objectUrl;
      } else {
        resolve(null);
      }
    } catch {
      done(null);
    }
  });
}
