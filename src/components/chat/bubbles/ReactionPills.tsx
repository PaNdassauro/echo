import { cn } from "@/lib/utils";

/** Reações agregadas por emoji (modelo message_reactions; escalar é o fallback). */
export interface AggregatedReaction {
  emoji: string;
  count: number;
  /** Alguma das reações deste emoji é NOSSA (painel/aparelho). */
  mine: boolean;
  /** Nomes de quem reagiu (tooltip). */
  reactorNames?: string[];
}

interface ReactionPillsProps {
  reactions: AggregatedReaction[];
  isOutbound: boolean;
  /** Tocar num pill: se mine → remove; senão → reage com o mesmo emoji. */
  onReact?: (emoji: string) => void;
}

export function ReactionPills({ reactions, isOutbound, onReact }: ReactionPillsProps) {
  if (reactions.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1", isOutbound ? "justify-end" : "justify-start")}>
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => onReact?.(r.mine ? "" : r.emoji)}
          title={
            r.mine
              ? "Remover reação"
              : r.reactorNames?.length
                ? r.reactorNames.join(", ")
                : `Reagir com ${r.emoji}`
          }
          className={cn(
            "-mt-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-sm border shadow-sm transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100",
            r.mine
              ? "bg-primary/10 border-primary/30 hover:bg-primary/20"
              : "bg-muted hover:bg-accent"
          )}
        >
          <span>{r.emoji}</span>
          {r.count > 1 && <span className="text-xs font-medium">{r.count}</span>}
        </button>
      ))}
    </div>
  );
}
