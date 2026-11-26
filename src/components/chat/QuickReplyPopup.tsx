import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Zap } from "lucide-react";
import type { QuickReply } from "@/hooks/useQuickReplies";

interface QuickReplyPopupProps {
  /**
   * Já filtrados pelo ChatInput — a visibilidade é derivada de
   * items.length > 0 lá, então o listener de teclado daqui nunca fica ativo
   * com lista vazia (bug latente do MentionPopup que este componente evita).
   */
  items: QuickReply[];
  onSelect: (reply: QuickReply) => void;
  onClose: () => void;
  position: { top: number; left: number };
  visible: boolean;
  /** Combobox: o composer aponta aria-activedescendant para a opção ativa. */
  onActiveIndexChange?: (index: number) => void;
}

// Popup de frases prontas do composer ("/atalho"), espelho estrutural do
// MentionPopup: listbox absoluto acima do textarea, navegação por teclado em
// listener global (o textarea mantém o foco) e click-outside para fechar.
const QuickReplyPopup = ({
  items,
  onSelect,
  onClose,
  position,
  visible,
  onActiveIndexChange,
}: QuickReplyPopupProps) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const popupRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Reset selected index when filtered results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useEffect(() => {
    onActiveIndexChange?.(selectedIndex);
  }, [selectedIndex, onActiveIndexChange]);

  // Scroll selected item into view
  useEffect(() => {
    if (itemRefs.current[selectedIndex]) {
      itemRefs.current[selectedIndex]?.scrollIntoView({
        block: "nearest",
      });
    }
  }, [selectedIndex]);

  // Handle keyboard navigation
  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < items.length - 1 ? prev + 1 : prev
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          break;
        case "Enter":
        case "Tab":
          e.preventDefault();
          if (items[selectedIndex]) {
            onSelect(items[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [visible, selectedIndex, items, onSelect, onClose]);

  // Close when clicking outside
  useEffect(() => {
    if (!visible) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [visible, onClose]);

  if (!visible || items.length === 0) return null;

  return (
    <div
      ref={popupRef}
      role="listbox"
      id="quick-reply-listbox"
      aria-label="Frases prontas"
      className="absolute z-50 w-72 max-h-48 overflow-y-auto bg-popover border rounded-lg shadow-lg animate-in fade-in-0 duration-100 ease-out"
      style={{
        bottom: position.top,
        left: position.left,
        transformOrigin: "bottom left",
      }}
    >
      <div className="p-2 border-b bg-muted/30">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Zap className="w-3 h-3" />
          <span>Frases prontas</span>
        </div>
      </div>
      <div className="py-1">
        {items.map((reply, index) => (
          <button
            key={reply.id}
            ref={(el) => (itemRefs.current[index] = el)}
            role="option"
            id={`quick-reply-opt-${index}`}
            aria-selected={index === selectedIndex}
            className={cn(
              "w-full px-3 py-2 text-left hover:bg-accent",
              index === selectedIndex && "bg-accent"
            )}
            onClick={() => onSelect(reply)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <p className="text-sm font-medium truncate" title={`/${reply.shortcut}`}>/{reply.shortcut}</p>
            <p className="text-xs text-muted-foreground line-clamp-2" title={reply.content}>
              {reply.content}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
};

export default QuickReplyPopup;
