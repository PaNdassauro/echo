import { useCallback, useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Download, X, ZoomIn, ZoomOut } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { IconSwap } from "@/components/ui/icon-swap";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel";
import type { ConversationMediaItem } from "./useConversationMedia";
import { mediaDownloadName, toDownloadUrl } from "@/lib/mediaDownload";

interface MediaLightboxProps {
  items: ConversationMediaItem[];
  /** Mensagem clicada — define o slide inicial. null = fechado. */
  initialMessageId: string | null;
  onClose: () => void;
}

/**
 * Lightbox de mídia da conversa (paridade WhatsApp): setas/swipe navegam por
 * todas as imagens/vídeos carregados, zoom 2x por clique, download, contador.
 * Esc fecha só o lightbox — a cascata (seleção → coluna da direita) fica intacta porque o
 * interceptor do ChatArea checa o lightbox PRIMEIRO.
 *
 * Dialog cru do Radix (sem o wrapper ui/dialog): o wrapper injeta um botão de
 * fechar e max-width próprios que brigam com o layout fullscreen.
 */
export function MediaLightbox({ items, initialMessageId, onClose }: MediaLightboxProps) {
  const open = initialMessageId !== null;
  const initialIndex = Math.max(
    0,
    items.findIndex((item) => item.messageId === initialMessageId)
  );

  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(initialIndex);
  const [zoomed, setZoomed] = useState(false);
  const videoRefs = useRef(new Map<number, HTMLVideoElement>());

  // Slide selecionado: atualiza contador, sai do zoom e pausa vídeos fora de cena
  useEffect(() => {
    if (!api) return;
    const onSelect = () => {
      const index = api.selectedScrollSnap();
      setCurrent(index);
      setZoomed(false);
      videoRefs.current.forEach((video, i) => {
        if (i !== index) video.pause();
      });
    };
    onSelect();
    api.on("select", onSelect);
    return () => {
      api.off("select", onSelect);
    };
  }, [api]);

  // Reposiciona no item clicado a cada abertura
  useEffect(() => {
    if (open && api) {
      api.scrollTo(initialIndex, true);
      setCurrent(initialIndex);
      setZoomed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, api, initialMessageId]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) onClose();
    },
    [onClose]
  );

  // Clique fora da mídia fecha (paridade WhatsApp) — um handler delegado no
  // content: só NÃO fecha em cima de mídia, controles e legenda. O swipe do
  // embla não vaza clique (o drag handler dele previne o click pós-arrasto).
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("img, video, button, a, [data-no-close]")) return;
      onClose();
    },
    [onClose]
  );

  if (!open || items.length === 0) return null;

  const item = items[Math.min(current, items.length - 1)];
  const downloadName = mediaDownloadName(item.url, null, item.type);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        {/* Entrada/saída pareadas (saída mais curta), como os outros overlays de ui/ */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm duration-200 ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-150" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col outline-none duration-200 ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-150"
          aria-describedby={undefined}
          onClick={handleBackdropClick}
        >
          <DialogPrimitive.Title className="sr-only">
            Visualizador de mídia da conversa
          </DialogPrimitive.Title>

          {/* Barra superior: contador + ações */}
          <div className="flex items-center justify-between px-4 py-3 shrink-0">
            <span className="text-sm text-muted-foreground tabular-nums">
              {current + 1} de {items.length}
              {item.timestamp && (
                <>
                  <span className="mx-2">·</span>
                  {format(new Date(item.timestamp), "d MMM yyyy, HH:mm", { locale: ptBR })}
                </>
              )}
            </span>
            <div className="flex items-center gap-1">
              {item.type === "image" && (
                <button
                  type="button"
                  onClick={() => setZoomed((z) => !z)}
                  className="p-2 rounded-full hover:bg-muted transition-[background-color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100"
                  title={zoomed ? "Reduzir" : "Ampliar"}
                  aria-label={zoomed ? "Reduzir" : "Ampliar"}
                >
                  <IconSwap
                    active={zoomed ? "out" : "in"}
                    durationMs={150}
                    icons={{ in: <ZoomIn className="w-5 h-5" />, out: <ZoomOut className="w-5 h-5" /> }}
                  />
                </button>
              )}
              <a
                href={toDownloadUrl(item.url, downloadName)}
                target="_blank"
                rel="noopener noreferrer"
                download={downloadName}
                className="p-2 rounded-full hover:bg-muted transition-[background-color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100"
                title="Baixar"
                aria-label="Baixar mídia"
              >
                <Download className="w-5 h-5" />
              </a>
              <DialogPrimitive.Close asChild>
                <button
                  type="button"
                  className="p-2 rounded-full hover:bg-muted transition-[background-color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100"
                  title="Fechar"
                  aria-label="Fechar visualizador"
                >
                  <X className="w-5 h-5" />
                </button>
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* Mídia. [&>div]:h-full: o CarouselContent embrulha o trilho num div
              overflow-hidden SEM altura — sem isso a corrente de h-full quebra
              e a mídia renderiza no tamanho natural, estourando a tela. */}
          <Carousel
            setApi={setApi}
            opts={{ startIndex: initialIndex, loop: false }}
            className="flex-1 min-h-0 px-12 [&>div]:h-full"
          >
            <CarouselContent className="h-full">
              {items.map((mediaItem, index) => (
                <CarouselItem key={mediaItem.messageId} className="h-full">
                  <div className="h-full w-full flex items-center justify-center overflow-auto">
                    {mediaItem.type === "image" ? (
                      <img
                        src={mediaItem.url}
                        alt={mediaItem.caption || "Imagem da conversa"}
                        onClick={() => setZoomed((z) => !z)}
                        className={cn(
                          "select-none outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10",
                          // Zoom = tamanho natural (não transform): o container
                          // overflow-auto ganha scroll de verdade para o pan.
                          zoomed && index === current
                            ? "max-w-none max-h-none m-auto cursor-zoom-out"
                            : "max-h-full max-w-full object-contain cursor-zoom-in"
                        )}
                        draggable={false}
                      />
                    ) : (
                      <video
                        ref={(el) => {
                          if (el) videoRefs.current.set(index, el);
                          else videoRefs.current.delete(index);
                        }}
                        src={mediaItem.url}
                        controls
                        className="max-h-full max-w-full"
                      />
                    )}
                  </div>
                </CarouselItem>
              ))}
            </CarouselContent>
            {items.length > 1 && (
              <>
                <CarouselPrevious className="left-2" />
                <CarouselNext className="right-2" />
              </>
            )}
          </Carousel>

          {/* Legenda */}
          {item.caption && (
            <p data-no-close className="px-6 py-3 text-sm text-center text-muted-foreground line-clamp-2 shrink-0">
              {item.caption}
            </p>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
