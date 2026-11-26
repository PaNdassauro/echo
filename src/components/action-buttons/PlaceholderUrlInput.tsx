import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PLACEHOLDER_DRAG_MIME } from "./PlaceholderChip";

export interface PlaceholderUrlInputHandle {
  /** Insert text at the current cursor position (or append if input lost focus) */
  insertAtCursor: (text: string) => void;
}

interface PlaceholderUrlInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * `<Input>` wrapper that accepts dropped placeholder chips and exposes an
 * imperative `insertAtCursor` method for click-to-insert from the palette.
 *
 * Drop target visual feedback (Emil): a soft ring + tinted background appear
 * only while a placeholder drag is hovering — neither at default state nor
 * after a normal text drag from the browser. The transition runs at 150ms
 * `ease-out` on `box-shadow` and `background-color` only.
 */
export const PlaceholderUrlInput = forwardRef<PlaceholderUrlInputHandle, PlaceholderUrlInputProps>(
  ({ value, onChange, placeholder }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const [isDropTarget, setIsDropTarget] = useState(false);

    const insertAtCursor = useCallback(
      (text: string) => {
        const input = inputRef.current;
        if (!input) {
          onChange(value + text);
          return;
        }
        const start = input.selectionStart ?? value.length;
        const end = input.selectionEnd ?? value.length;
        const next = value.slice(0, start) + text + value.slice(end);
        onChange(next);
        // Restore focus + cursor position after React rerenders the input
        requestAnimationFrame(() => {
          input.focus();
          const pos = start + text.length;
          input.setSelectionRange(pos, pos);
        });
      },
      [value, onChange]
    );

    useImperativeHandle(ref, () => ({ insertAtCursor }), [insertAtCursor]);

    return (
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(PLACEHOLDER_DRAG_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setIsDropTarget(true);
          }
        }}
        onDragLeave={(e) => {
          // Only clear when the drag leaves the wrapper, not its children
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setIsDropTarget(false);
        }}
        onDrop={(e) => {
          const token = e.dataTransfer.getData(PLACEHOLDER_DRAG_MIME);
          if (token) {
            e.preventDefault();
            insertAtCursor(token);
          }
          setIsDropTarget(false);
        }}
        className={cn(
          "rounded-md transition-[box-shadow,background-color] duration-150 ease-out",
          isDropTarget && "ring-2 ring-primary ring-offset-1 bg-primary/5"
        )}
      >
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      </div>
    );
  }
);

PlaceholderUrlInput.displayName = "PlaceholderUrlInput";
