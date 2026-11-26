import { memo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { MediaBox } from "@/lib/mediaBox";

/**
 * Moldura de altura fixa para imagem, figurinha e vídeo.
 *
 * A proporção vem de um espaçador com padding-top em % em vez de `aspect-ratio`:
 * funciona no Safari e no WebView Android antigos e encolhe junto com o
 * `maxWidth: 100%` num celular de 360 px.
 *
 * Todo filho precisa ser `absolute inset-0`: assim nenhum (img, video, erro)
 * contribui com tamanho intrínseco antes ou depois do load.
 */
export const MediaFrame = memo(function MediaFrame({
  box,
  className,
  children,
}: {
  box: MediaBox;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-media-box={`${box.width}x${box.height}`}
      data-media-source={box.source}
      className={cn("relative overflow-hidden", className)}
      style={{ width: box.width, maxWidth: "100%" }}
    >
      <div aria-hidden="true" style={{ paddingTop: `${(box.height / box.width) * 100}%` }} />
      {children}
    </div>
  );
});
