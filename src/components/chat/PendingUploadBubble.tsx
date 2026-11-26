import { useEffect, useRef } from "react";
import { FileText, Loader2, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/formatBytes";
import { scrollBehavior } from "@/lib/accessibilityPrefs";
import { IconSwap } from "@/components/ui/icon-swap";
import {
  mediaUploadQueue,
  useConversationUploads,
} from "@/lib/mediaUploadTransport";
import type { UploadItem } from "@/lib/mediaUploadQueue";
import { mediaBoxForSize, type MediaBox } from "@/lib/mediaBox";
import { MediaFrame } from "./bubbles/MediaFrame";

const RING_SIZE = 44;
const RING_STROKE = 3;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const fraction = (item: UploadItem) =>
  item.total > 0 ? Math.min(1, item.loaded / item.total) : 0;

/**
 * Botão redondo com o anel de progresso em volta: X enquanto dá para cancelar,
 * spinner quando o arquivo já está no servidor (enviar não se desfaz mais),
 * seta de "tentar de novo" na falha.
 */
const ProgressAction = ({
  item,
  onMedia,
}: {
  item: UploadItem;
  onMedia: boolean;
}) => {
  const { status } = item;
  const offset = RING_CIRCUMFERENCE * (1 - fraction(item));
  const cancellable = status === "queued" || status === "uploading";
  const label =
    status === "failed"
      ? `Tentar enviar ${item.file.name} de novo`
      : cancellable
        ? `Cancelar envio de ${item.file.name}`
        : `Enviando ${item.file.name}`;

  return (
    <button
      type="button"
      aria-label={label}
      title={
        status === "processing"
          ? "Arquivo já no servidor, enviando ao WhatsApp"
          : undefined
      }
      disabled={status === "processing"}
      onClick={() =>
        status === "failed"
          ? mediaUploadQueue.retry(item.id)
          : mediaUploadQueue.cancel(item.id)
      }
      className={cn(
        "relative grid shrink-0 place-items-center rounded-full active:scale-[0.96] disabled:active:scale-100",
        "transition-[background-color,transform] duration-150 ease-out",
        onMedia
          ? "bg-black/55 text-white hover:bg-black/70"
          : "bg-chat-bubble-user-foreground/10 text-chat-bubble-user-foreground hover:bg-chat-bubble-user-foreground/20",
      )}
      style={{ width: RING_SIZE, height: RING_SIZE }}
    >
      {/* Sempre montado: aparece e some por opacidade em vez de surgir do nada
          ao sair da fila e sumir seco a 100%, quando vira spinner. */}
      <svg
        aria-hidden="true"
        className={cn(
          "absolute inset-0 -rotate-90 transition-opacity duration-150 ease-out-strong",
          status === "uploading" ? "opacity-100" : "opacity-0",
        )}
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth={RING_STROKE}
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          // Voltar a zero (tentar de novo) é salto, não progresso andando para trás.
          className={cn(
            item.loaded > 0 &&
              "transition-[stroke-dashoffset] duration-200 ease-linear",
          )}
        />
      </svg>
      <IconSwap
        active={
          status === "failed" ? "retry" : status === "processing" ? "spin" : "x"
        }
        durationMs={150}
        icons={{
          x: <X className="h-5 w-5" />,
          spin: <Loader2 className="h-5 w-5 animate-spin" />,
          retry: <RotateCw className="h-5 w-5" />,
        }}
      />
    </button>
  );
};

const statusText = (item: UploadItem) => {
  const size = formatBytes(item.total) ?? "";
  switch (item.status) {
    case "queued":
      return `Na fila · ${size}`;
    case "uploading":
      return `${Math.round(fraction(item) * 100)}% · ${formatBytes(item.loaded) ?? "0 B"} de ${size}`;
    case "processing":
      return "Enviando…";
    case "failed":
      return item.error ?? "Não foi enviado";
  }
};

/** Entrada escalonada do lote: 40ms por arquivo, teto de 200ms. */
const STAGGER_MS = 40;
const STAGGER_MAX_MS = 200;

const PendingUploadBubble = ({ item }: { item: UploadItem }) => {
  const isImage = item.file.type.startsWith("image/");
  const isVideo = item.file.type.startsWith("video/");
  const hasPreview = Boolean(item.previewUrl) && (isImage || isVideo);
  const failed = item.status === "failed";
  const box: MediaBox | null = isImage
    ? mediaBoxForSize("image", item.mediaSize)
    : isVideo
      ? mediaBoxForSize("video", item.mediaSize)
      : null;

  return (
    // Mesmo respiro da linha de mensagem (px-4 py-2 no MessageList): na troca
    // pela mensagem real a bolha não pula.
    <div className="flex flex-col items-end px-4 py-2">
      <div
        className={cn(
          "max-w-[85%] sm:max-w-[70%] rounded-2xl px-4 py-2 shadow-sm overflow-hidden",
          "bg-chat-bubble-user text-chat-bubble-user-foreground",
          // backwards: invisível durante o atraso do escalonamento.
          "animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-backwards",
          failed && "border-2 border-destructive",
        )}
        style={{
          animationDuration: "200ms",
          animationTimingFunction: "var(--ease-out-strong)",
          animationDelay: `${Math.min(item.batchIndex * STAGGER_MS, STAGGER_MAX_MS)}ms`,
        }}
      >
        {hasPreview && box ? (
          // Mesma caixa que o MessageBubble desenha para a mensagem real
          // (mediaBoxForSize com o tamanho medido): a troca pendente -> real
          // não muda a altura.
          <MediaFrame
            box={box}
            className="mb-1 rounded-sm outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
          >
            {isImage ? (
              <img
                src={item.previewUrl}
                alt=""
                className="absolute inset-0 h-full w-full object-cover opacity-80"
              />
            ) : (
              <video
                src={item.previewUrl}
                muted
                playsInline
                preload="metadata"
                aria-hidden="true"
                className="absolute inset-0 h-full w-full object-contain bg-black/40 opacity-80"
              />
            )}
            <div className="absolute inset-0 grid place-items-center">
              <ProgressAction item={item} onMedia />
            </div>
          </MediaFrame>
        ) : (
          <div className="flex items-center gap-3 py-1">
            <FileText
              className="h-8 w-8 shrink-0 opacity-70"
              aria-hidden="true"
            />
            <p
              className="min-w-0 flex-1 truncate text-message font-medium"
              title={item.file.name}
            >
              {item.file.name}
            </p>
            <ProgressAction item={item} onMedia={false} />
          </div>
        )}

        {item.caption && (
          <p className="whitespace-pre-wrap break-words text-message">
            {item.caption}
          </p>
        )}

        <div className="mt-1 flex items-center justify-end gap-2">
          <span
            className={cn(
              "text-xs tabular-nums opacity-70",
              failed && "text-destructive opacity-100",
            )}
          >
            {statusText(item)}
          </span>
          {failed && (
            <button
              type="button"
              onClick={() => mediaUploadQueue.cancel(item.id)}
              className="text-xs font-medium underline-offset-2 hover:underline"
            >
              Descartar
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Envios de mídia da conversa ainda em andamento, no rodapé da lista (abaixo da
 * última mensagem). Quando o envio termina, o item sai daqui e a mensagem real
 * chega pelo realtime no lugar dele.
 */
export const PendingUploads = ({
  conversationId,
  onGrow,
}: {
  conversationId: string | null | undefined;
  /** Dentro da lista: pede o fim ao único escritor do scroll (useStickToBottom). Fora dela (conversa vazia) cai no scrollIntoView. */
  onGrow?: () => void;
}) => {
  const items = useConversationUploads(conversationId);
  const rootRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);
  const onGrowRef = useRef(onGrow);
  onGrowRef.current = onGrow;

  // Quem acabou de clicar em Enviar quer ver os arquivos: rola até eles quando
  // a fila cresce (não a cada tick de progresso).
  useEffect(() => {
    if (items.length > prevCount.current) {
      if (onGrowRef.current) onGrowRef.current();
      else
        rootRef.current?.scrollIntoView({
          block: "end",
          behavior: scrollBehavior(),
        });
    }
    prevCount.current = items.length;
  }, [items.length]);

  if (items.length === 0) return null;
  return (
    <div ref={rootRef} aria-label="Envios em andamento" role="group">
      {items.map((item) => (
        <PendingUploadBubble key={item.id} item={item} />
      ))}
    </div>
  );
};
