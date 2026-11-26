import { useState } from "react";
import { Plus, Smile } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { EmojiGrid } from "@/components/EmojiPicker";

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

interface ReactionPickerProps {
  /** Reagir/trocar (emoji) ou remover (""). Trocar é direto — sem remover antes. */
  onReact: (emoji: string) => void;
  /** Nossa reação atual — destaca no quick row e vira toggle (mesmo emoji remove). */
  ourReaction?: string | null;
  isOutbound: boolean;
}

/**
 * Picker de reações desktop (paridade WhatsApp): 6 rápidas + "+" que abre a
 * grade completa. Um Popover só, com conteúdo trocado — o "+" não abre um
 * segundo popover (foco continua preso num único portal).
 */
export function ReactionPicker({ onReact, ourReaction, isOutbound }: ReactionPickerProps) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);

  const pick = (emoji: string) => {
    // Mesmo emoji = toggle off; diferente = troca direta (reactToMessage cobre os dois)
    onReact(emoji === ourReaction ? "" : emoji);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setShowFull(false);
      }}
    >
      <PopoverTrigger asChild>
        <button
          className="mt-0.5 p-1 rounded-full hover:bg-muted/50 transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 opacity-100 [@media(hover:hover)]:opacity-40 hover:opacity-100"
          title="Reagir"
        >
          <Smile className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("p-2", showFull ? "w-80 p-0" : "w-auto")}
        side="top"
        align={isOutbound ? "end" : "start"}
      >
        {showFull ? (
          <EmojiGrid onEmojiSelect={pick} heightClass="h-56" />
        ) : (
          <div className="flex gap-1 items-center">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => pick(emoji)}
                className={cn(
                  "text-xl p-1 rounded transition-[background-color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-muted",
                  emoji === ourReaction && "bg-primary/10 ring-1 ring-primary/30"
                )}
                title={emoji === ourReaction ? "Remover reação" : `Reagir com ${emoji}`}
              >
                {emoji}
              </button>
            ))}
            <button
              onClick={() => setShowFull(true)}
              className="p-1.5 rounded-full hover:bg-muted transition-[background-color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100"
              title="Mais emojis"
              aria-label="Abrir todos os emojis"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
