import * as React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ThemeColor = { hue: number; name: string };

export const THEME_COLORS: ReadonlyArray<ThemeColor> = [
  { hue: 176, name: "Turquesa (Echo)" },
  { hue: 195, name: "Azul" },
  { hue: 220, name: "Azul Escuro" },
  { hue: 270, name: "Roxo" },
  { hue: 330, name: "Rosa" },
  { hue: 0, name: "Vermelho" },
  { hue: 15, name: "Coral" },
  { hue: 30, name: "Laranja" },
  { hue: 45, name: "Amarelo" },
  { hue: 142, name: "Verde" },
];

// Cor de PREVIEW do swatch (a marca em 65% 55%). Superfícies com texto usam o
// L acessível calculado em usePhoneTheme (accessiblePrimaryLightness) — o
// swatch continua vibrante de propósito; ele mostra o matiz, não a superfície.
const SWATCH_SAT = 65;
const SWATCH_LIGHT = 55;

export const hueToCss = (hue: number): string =>
  `hsl(${hue}, ${SWATCH_SAT}%, ${SWATCH_LIGHT}%)`;

const clampHue = (hue: number): number => {
  if (Number.isNaN(hue)) return 0;
  if (hue < 0) return 0;
  if (hue > 360) return 360;
  return Math.round(hue);
};

// Rainbow gradient for the slider track — matches the SWATCH_SAT/SWATCH_LIGHT
// values so the bar color at position X equals the preview swatch for that hue.
const HUE_GRADIENT = `linear-gradient(to right,
  hsl(0, ${SWATCH_SAT}%, ${SWATCH_LIGHT}%) 0%,
  hsl(60, ${SWATCH_SAT}%, ${SWATCH_LIGHT}%) 16.66%,
  hsl(120, ${SWATCH_SAT}%, ${SWATCH_LIGHT}%) 33.33%,
  hsl(180, ${SWATCH_SAT}%, ${SWATCH_LIGHT}%) 50%,
  hsl(240, ${SWATCH_SAT}%, ${SWATCH_LIGHT}%) 66.66%,
  hsl(300, ${SWATCH_SAT}%, ${SWATCH_LIGHT}%) 83.33%,
  hsl(360, ${SWATCH_SAT}%, ${SWATCH_LIGHT}%) 100%)`;

interface HuePickerProps {
  value: number;
  onChange: (hue: number) => void;
  presets?: ReadonlyArray<ThemeColor>;
  className?: string;
}

/**
 * Full inline hue picker: preview swatch + gradient slider + preset row.
 * Commits to `onChange` on pointer release (not during drag), to avoid
 * flooding callers like Supabase writes on every pixel.
 */
export const HuePicker: React.FC<HuePickerProps> = ({
  value,
  onChange,
  presets = THEME_COLORS,
  className,
}) => {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const [draftHue, setDraftHue] = React.useState<number | null>(null);
  const displayHue = draftHue ?? value;

  const hueFromClientX = React.useCallback((clientX: number): number => {
    const track = trackRef.current;
    if (!track) return value;
    const rect = track.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return clampHue(ratio * 360);
  }, [value]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    setDraftHue(hueFromClientX(e.clientX));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!(e.currentTarget as HTMLDivElement).hasPointerCapture(e.pointerId)) return;
    setDraftHue(hueFromClientX(e.clientX));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget as HTMLDivElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const finalHue = hueFromClientX(e.clientX);
    setDraftHue(null);
    if (finalHue !== value) onChange(finalHue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      onChange(clampHue(value - step));
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      onChange(clampHue(value + step));
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(0);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(360);
    }
  };

  const isDragging = draftHue !== null;
  // Transition only applies when NOT dragging. During drag, the handle and
  // swatch must follow the pointer instantly — transitions would cause lag.
  // On preset click / keyboard / popover update, the transition kicks in and
  // the handle slides to the new position smoothly.
  const smoothTransition = isDragging
    ? undefined
    : "left 150ms cubic-bezier(0.23, 1, 0.32, 1), background-color 150ms cubic-bezier(0.23, 1, 0.32, 1)";

  return (
    <div className={cn("space-y-3 select-none", className)}>
      {/* Preview swatch + current value */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-full border border-border shadow-sm shrink-0"
          style={{
            backgroundColor: hueToCss(displayHue),
            transition: isDragging ? undefined : "background-color 150ms cubic-bezier(0.23, 1, 0.32, 1)",
          }}
          aria-hidden
        />
        <div className="text-sm">
          <div className="font-medium">Cor do tema</div>
          <div className="text-xs text-muted-foreground">Matiz: {displayHue}°</div>
        </div>
      </div>

      {/* Gradient slider */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Matiz da cor do tema"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={displayHue}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown}
        className="relative h-4 rounded-full cursor-pointer active:cursor-grabbing touch-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        style={{ background: HUE_GRADIENT }}
      >
        <div
          className="absolute top-1/2 w-5 h-5 rounded-full border-2 border-white shadow-md pointer-events-none"
          style={{
            left: `${(displayHue / 360) * 100}%`,
            transform: "translate(-50%, -50%)",
            backgroundColor: hueToCss(displayHue),
            transition: smoothTransition,
          }}
        />
      </div>

      {/* Preset row */}
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {presets.map((color) => {
            const active = value === color.hue;
            return (
              <button
                key={color.hue}
                type="button"
                onClick={() => onChange(color.hue)}
                title={color.name}
                aria-label={`Preset ${color.name}`}
                className={cn(
                  "w-7 h-7 rounded-full transition-[transform,opacity,box-shadow] duration-150 ease-out active:scale-[0.96]",
                  active
                    ? "ring-2 ring-offset-2 ring-foreground scale-110"
                    : "opacity-60 hover:opacity-100",
                )}
                style={{ backgroundColor: hueToCss(color.hue) }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

interface HuePickerPopoverProps {
  value: number;
  onChange: (hue: number) => void;
  presets?: ReadonlyArray<ThemeColor>;
  size?: "sm" | "md";
  className?: string;
  triggerTitle?: string;
}

/**
 * Compact swatch button that opens a popover with the full HuePicker.
 * Use in dense rows where the inline picker would take too much space.
 */
export const HuePickerPopover: React.FC<HuePickerPopoverProps> = ({
  value,
  onChange,
  presets,
  size = "md",
  className,
  triggerTitle = "Mudar cor do tema",
}) => {
  const sizeClass = size === "sm" ? "w-4 h-4" : "w-5 h-5";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={triggerTitle}
          aria-label={triggerTitle}
          className={cn(
            sizeClass,
            "rounded-full border border-border/60",
            "transition-[transform,box-shadow,background-color] duration-150 ease-out",
            "active:scale-[0.96]",
            "hover:scale-110 hover:ring-2 hover:ring-offset-1 hover:ring-foreground/40",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            className,
          )}
          style={{ backgroundColor: hueToCss(value) }}
        />
      </PopoverTrigger>
      <PopoverContent
        className="w-72 [transform-origin:var(--radix-popover-content-transform-origin)]"
        align="end"
      >
        <HuePicker value={value} onChange={onChange} presets={presets} />
      </PopoverContent>
    </Popover>
  );
};
