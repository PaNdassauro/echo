import { useState } from "react";
import { cn } from "@/lib/utils";

export interface LinkPreviewData {
  url?: string | null;
  title?: string | null;
  description?: string | null;
  /** OG image (enrichment de saída) */
  image_url?: string | null;
  /** Thumb do Baileys já no Storage (inbound QR) */
  thumb_url?: string | null;
  site_name?: string | null;
}

/** Valida o shape solto do metadata sem Zod aqui — campos todos opcionais. */
export function parseLinkPreview(metadata: unknown): LinkPreviewData | null {
  if (!metadata || typeof metadata !== "object" || !("link_preview" in metadata)) return null;
  const raw = (metadata as { link_preview: unknown }).link_preview;
  if (!raw || typeof raw !== "object") return null;
  const preview = raw as LinkPreviewData;
  if (!preview.title && !preview.description) return null;
  return preview;
}

/**
 * Card de preview de link dentro da bolha (paridade WhatsApp): thumb à
 * esquerda, título em negrito, descrição em 2 linhas, domínio embaixo.
 * Só texto — nunca renderiza HTML remoto.
 */
export function LinkPreviewCard({
  preview,
  isOutbound,
}: {
  preview: LinkPreviewData;
  isOutbound: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageSrc = preview.thumb_url || preview.image_url;
  const href = preview.url ?? undefined;

  let hostname: string | null = preview.site_name ?? null;
  if (!hostname && href) {
    try {
      hostname = new URL(href).hostname.replace(/^www\./, "");
    } catch {
      hostname = null;
    }
  }

  const card = (
    <div
      className={cn(
        "mb-1.5 -mx-1 flex gap-2.5 rounded-lg overflow-hidden px-2.5 py-2",
        isOutbound
          ? "bg-chat-bubble-user-foreground/10"
          : "bg-chat-bubble-contact-foreground/10",
        href && "transition-opacity hover:opacity-90"
      )}
    >
      {/* Miniatura que falhou mantém os 64 px: o texto não reflui e a altura não muda. */}
      {imageSrc &&
        (imageFailed ? (
          <div aria-hidden="true" className="w-16 h-16 shrink-0 rounded bg-muted/60" />
        ) : (
          <img
            src={imageSrc}
            alt=""
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="w-16 h-16 object-cover rounded shrink-0 outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
          />
        ))}
      <div className="min-w-0 flex-1">
        {preview.title && (
          <p className="text-message-xs font-semibold line-clamp-2 break-words">{preview.title}</p>
        )}
        {preview.description && (
          <p className="text-message-xs opacity-75 line-clamp-2 break-words mt-0.5">
            {preview.description}
          </p>
        )}
        {hostname && <p className="text-xs opacity-60 mt-0.5 truncate">{hostname}</p>}
      </div>
    </div>
  );

  if (!href) return card;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="block no-underline text-inherit">
      {card}
    </a>
  );
}
