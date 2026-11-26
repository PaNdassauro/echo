import { Button } from "@/components/ui/button";
import { Forward, X } from "lucide-react";
import { MAX_SELECTED_MESSAGES } from "@/lib/messageSelection";

interface MessageSelectionBarProps {
  count: number;
  isMobile: boolean;
  onCancel: () => void;
  onForward: () => void;
}

/**
 * Substitui o ChatHeader enquanto o modo de seleção está ativo. Reusa a MESMA
 * geometria do header (h-14 no mobile, p-4 no desktop) para a lista não saltar
 * ao entrar e sair da seleção.
 */
const MessageSelectionBar = ({ count, isMobile, onCancel, onForward }: MessageSelectionBarProps) => {
  const label = count === 1 ? `1 de ${MAX_SELECTED_MESSAGES} selecionada` : `${count} de ${MAX_SELECTED_MESSAGES} selecionadas`;

  const content = (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={onCancel}
        className={isMobile ? "h-11 w-11 shrink-0 touch-manipulation" : "h-9 w-9 shrink-0"}
        aria-label="Cancelar seleção (Esc)"
        title="Cancelar seleção (Esc)"
      >
        <X className="h-5 w-5" />
      </Button>
      <span className="flex-1 min-w-0 truncate font-medium" aria-live="polite">
        {label}
      </span>
      <Button onClick={onForward} disabled={count === 0} className="shrink-0">
        <Forward className="w-4 h-4 mr-2" />
        Encaminhar{count > 0 ? ` (${count})` : ""}
      </Button>
    </>
  );

  if (isMobile) {
    return (
      <header className="theme-chat-header sticky top-0 z-40 bg-background/95 backdrop-blur border-b border-border safe-area-top">
        <div className="flex items-center h-14 px-2 gap-2">{content}</div>
      </header>
    );
  }

  return (
    <div className="theme-chat-header border-b bg-card p-4 flex items-center gap-3">{content}</div>
  );
};

export default MessageSelectionBar;
