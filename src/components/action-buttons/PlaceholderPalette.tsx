import { ACTION_BUTTON_PLACEHOLDERS } from "@/lib/actionButtonPlaceholders";
import { PlaceholderChip } from "./PlaceholderChip";

interface PlaceholderPaletteProps {
  /** Called when the user selects a chip (drag is handled inside the chip) */
  onInsert: (tokenWithBraces: string) => void;
}

/**
 * Horizontal flex of all available placeholder chips.
 *
 * Note: no entrance animation. The settings page is opened occasionally,
 * but the palette is always present when it's open — animating it on
 * every render would be irritating, not delightful.
 */
export function PlaceholderPalette({ onInsert }: PlaceholderPaletteProps) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        Variáveis disponíveis — arraste até o campo URL ou selecione para inserir no cursor
      </p>
      <div className="flex flex-wrap gap-1.5">
        {ACTION_BUTTON_PLACEHOLDERS.map((p) => (
          <PlaceholderChip key={p.token} placeholder={p} onInsert={onInsert} />
        ))}
      </div>
    </div>
  );
}
