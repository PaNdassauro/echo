import { useState } from "react";
import type { ActionButtonPlaceholder } from "@/lib/actionButtonPlaceholders";
import { cn } from "@/lib/utils";

/**
 * Custom MIME type used for HTML5 drag-and-drop. Lets the drop target
 * filter out unrelated drags (text from other apps, images, etc.)
 */
export const PLACEHOLDER_DRAG_MIME = "text/x-action-button-placeholder";

interface PlaceholderChipProps {
  placeholder: ActionButtonPlaceholder;
  /** Click fallback for keyboard / touch users (HTML5 drag doesn't work on touch) */
  onInsert: (tokenWithBraces: string) => void;
}

/**
 * A draggable + clickable chip representing one placeholder variable.
 *
 * Design engineering choices (Emil Kowalski principles):
 * - Specifies exact transition properties (no `transition: all`)
 * - 150ms duration with `ease-out` for instant hover feedback
 * - `active:scale-[0.96]` so the chip feels physical when pressed
 * - `cursor-grab` / `cursor-grabbing` to telegraph drag affordance
 * - Mono font on the token text — communicates "this is code"
 */
export function PlaceholderChip({ placeholder, onInsert }: PlaceholderChipProps) {
  const [dragging, setDragging] = useState(false);
  const Icon = placeholder.icon;
  const tokenWithBraces = `{${placeholder.token}}`;

  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PLACEHOLDER_DRAG_MIME, tokenWithBraces);
        e.dataTransfer.effectAllowed = "copy";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onClick={() => onInsert(tokenWithBraces)}
      title={placeholder.description}
      aria-label={`Inserir ${placeholder.label} (${tokenWithBraces})`}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md",
        "bg-muted text-muted-foreground text-xs font-mono",
        "border border-transparent",
        "cursor-grab active:cursor-grabbing select-none",
        "transition-[transform,background-color,border-color,color] duration-150 ease-out",
        "hover:bg-muted/70 hover:text-foreground hover:border-border",
        "active:scale-[0.96]",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        dragging && "opacity-50"
      )}
    >
      <Icon className="w-3 h-3 shrink-0" />
      <span>{placeholder.token}</span>
    </button>
  );
}
