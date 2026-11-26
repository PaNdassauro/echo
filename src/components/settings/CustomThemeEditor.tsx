import { useCallback, useEffect, useId, useMemo, useRef, useState, type HTMLAttributes, type PointerEvent } from "react";
import { HexColorPicker } from "react-colorful";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { dragPosition } from "@/lib/customWallpaper";
import {
  DEFAULT_CUSTOM_BACKGROUND,
  backgroundFitsBase,
  deriveCustomTheme,
  hexColorSchema,
  type CustomThemeBase,
  type CustomThemeInput,
} from "@/lib/customTheme";
import CustomWallpaperFields from "./CustomWallpaperFields";
import { ThemePreview, previewStylesFromTokens, withWallpaper } from "./ThemePreview";
import { useWallpaperPreview } from "./useWallpaperPreview";

type ColorKey = "primary" | "background" | "bubble";

interface CustomThemeEditorProps {
  value: CustomThemeInput;
  onChange: (next: CustomThemeInput) => void;
  onApply: () => void;
  onReset: () => void;
  applyDisabled: boolean;
  /** Aplicando o tema (a imagem de fundo pode levar um instante para processar). */
  applying: boolean;
  /** Imagem original do rascunho (a de `value.wallpaper.imageId`). */
  wallpaperImage: Blob | null;
  wallpaperBusy: boolean;
  wallpaperError: string | null;
  onPickWallpaper: (file: File) => void;
  onRemoveWallpaper: () => void;
  onSuggestColors: () => void;
  suggestingColors: boolean;
}

const COLOR_FIELDS: { key: ColorKey; label: string; hint: string; adjustedLabel: string }[] = [
  { key: "primary", label: "Cor principal", hint: "Botões e destaques", adjustedLabel: "a cor principal" },
  { key: "background", label: "Fundo do app", hint: "Fundo das telas", adjustedLabel: "o fundo" },
  { key: "bubble", label: "Bolha enviada", hint: "Mensagens que você envia", adjustedLabel: "a bolha enviada" },
];

// Só mostra erro de digitação a partir de 7 caracteres (tamanho de #RRGGBB) ou depois do blur.
const ERROR_MIN_LENGTH = 7;
const COMPLETE_HEX = /^#?[0-9a-f]{6}$/i;

const joinList = (items: string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}` : items.join("");

interface ColorFieldProps {
  label: string;
  hint: string;
  value: string;
  onValid: (hex: string) => void;
}

function ColorField({ label, hint, value, onValid }: ColorFieldProps) {
  const uid = useId();
  const inputId = `${uid}-input`;
  const errorId = `${uid}-error`;
  const hintId = `${uid}-hint`;
  const [text, setText] = useState(value);
  const [touched, setTouched] = useState(false);

  // Sincroniza quando o valor externo muda (restaurar, troca de base).
  useEffect(() => {
    setText((current) => {
      const parsed = hexColorSchema.safeParse(current);
      return parsed.success && parsed.data === value ? current : value;
    });
  }, [value]);

  const parsed = hexColorSchema.safeParse(text);
  const showError = !parsed.success && (touched || text.trim().length >= ERROR_MIN_LENGTH);
  const errorMessage = !parsed.success ? parsed.error.issues[0]?.message ?? "" : "";

  const handleText = (raw: string) => {
    setText(raw);
    setTouched(false);
    // #RGB só é aplicado no blur: "#4f4" é prefixo de "#4f46e5" e piscaria a prévia.
    if (!COMPLETE_HEX.test(raw.trim())) return;
    const result = hexColorSchema.safeParse(raw);
    if (result.success) onValid(result.data);
  };

  // O picker dispara a cada pixel arrastado; a derivação do tema + <style> é cara,
  // então o commit sai no máximo uma vez por frame. O texto acompanha na hora.
  const onValidRef = useRef(onValid);
  onValidRef.current = onValid;
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const handlePicker = useCallback((hex: string) => {
    const result = hexColorSchema.safeParse(hex);
    if (!result.success) return;
    setText(result.data);
    setTouched(false);
    pendingRef.current = result.data;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const next = pendingRef.current;
      pendingRef.current = null;
      if (next) onValidRef.current(next);
    });
  }, []);

  return (
    <div className="space-y-1.5">
      <div>
        <Label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </Label>
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Escolher ${label.toLowerCase()}`}
              style={{ backgroundColor: parsed.success ? parsed.data : value }}
              className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-input transition-transform duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.96]"
            />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-3">
            <HexColorPicker color={value} onChange={handlePicker} className="echo-color-picker" />
          </PopoverContent>
        </Popover>
        <Input
          id={inputId}
          value={text}
          inputMode="text"
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          placeholder="#4f46e5"
          aria-invalid={showError || undefined}
          aria-describedby={showError ? `${hintId} ${errorId}` : hintId}
          onChange={(event) => handleText(event.target.value)}
          onBlur={() => {
            setTouched(true);
            const result = hexColorSchema.safeParse(text);
            if (result.success) {
              setText(result.data);
              onValid(result.data);
            }
          }}
          className="font-mono"
        />
      </div>
      {showError && (
        <p id={errorId} className="text-xs text-destructive">
          {errorMessage}
        </p>
      )}
    </div>
  );
}

export default function CustomThemeEditor({
  value,
  onChange,
  onApply,
  onReset,
  applyDisabled,
  applying,
  wallpaperImage,
  wallpaperBusy,
  wallpaperError,
  onPickWallpaper,
  onRemoveWallpaper,
  onSuggestColors,
  suggestingColors,
}: CustomThemeEditorProps) {
  const { primary, background, bubble, base } = value;
  // Só as cores entram na derivação: mexer nos controles da imagem não refaz a paleta.
  const derived = useMemo(() => deriveCustomTheme({ primary, background, bubble, base }), [primary, background, bubble, base]);
  const wallpaper = value.wallpaper;
  const preview = useWallpaperPreview(wallpaper ? wallpaperImage : null, wallpaper ?? null);
  const previewStyles = useMemo(() => {
    const styles = previewStylesFromTokens(derived.tokens);
    return wallpaper && preview ? withWallpaper(styles, derived.tokens, wallpaper, preview.url) : styles;
  }, [derived, wallpaper, preview]);

  // Arrastar a prévia move a imagem no "Preencher" (os controles de posição fazem o mesmo pelo teclado).
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    from: { x: number; y: number };
    box: { width: number; height: number };
  } | null>(null);
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };
  const wallpaperProps: HTMLAttributes<HTMLDivElement> | undefined =
    wallpaper?.fit === "cover" && preview
      ? {
          className: "cursor-grab touch-none select-none active:cursor-grabbing",
          onPointerDown: (event) => {
            if (event.button !== 0) return;
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              from: { x: wallpaper.positionX, y: wallpaper.positionY },
              box: { width: rect.width, height: rect.height },
            };
          },
          onPointerMove: (event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const next = dragPosition(
              drag.from,
              { dx: event.clientX - drag.startX, dy: event.clientY - drag.startY },
              drag.box,
              preview,
            );
            if (next.x !== wallpaper.positionX || next.y !== wallpaper.positionY) {
              onChange({ ...value, wallpaper: { ...wallpaper, positionX: next.x, positionY: next.y } });
            }
          },
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
        }
      : undefined;
  const baseName = useId();

  const adjustedFields = COLOR_FIELDS.filter((field) => derived.adjusted[field.key]);

  const handleBase = (next: string) => {
    if (next !== "light" && next !== "dark") return;
    const base: CustomThemeBase = next;
    onChange({
      ...value,
      base,
      background: backgroundFitsBase(value.background, base) ? value.background : DEFAULT_CUSTOM_BACKGROUND[base],
    });
  };

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-5">
        {COLOR_FIELDS.map((field) => (
          <ColorField
            key={field.key}
            label={field.label}
            hint={field.hint}
            value={value[field.key]}
            onValid={(hex) => onChange({ ...value, [field.key]: hex })}
          />
        ))}

        <div role="group" aria-labelledby={`${baseName}-label`} className="space-y-2">
          <Label id={`${baseName}-label`} className="text-sm font-medium">
            Base
          </Label>
          <RadioGroup value={value.base} onValueChange={handleBase} className="grid-cols-2">
            {(
              [
                { id: "light", label: "Clara" },
                { id: "dark", label: "Escura" },
              ] as const
            ).map((option) => (
              <div key={option.id} className="flex items-center gap-2 rounded-md border px-3 min-h-10">
                <RadioGroupItem value={option.id} id={`${baseName}-${option.id}`} aria-label={option.label} />
                <Label htmlFor={`${baseName}-${option.id}`} className="flex-1 cursor-pointer py-2 text-sm">
                  {option.label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>

        <CustomWallpaperFields
          wallpaper={wallpaper}
          busy={wallpaperBusy}
          error={wallpaperError}
          onPick={onPickWallpaper}
          onRemove={onRemoveWallpaper}
          onChange={(next) => onChange({ ...value, wallpaper: next })}
          onSuggest={onSuggestColors}
          suggesting={suggestingColors}
        />
      </div>

      <div className="space-y-3 md:sticky md:top-4 md:self-start">
        <ThemePreview styles={previewStyles} wallpaperProps={wallpaperProps} />
        {/* A região viva leva só a frase, que muda quando o conjunto ajustado muda; os hex ficam fora dela. */}
        <p role="status" aria-live="polite" className={adjustedFields.length ? "rounded-md border bg-muted p-3 text-xs" : "sr-only"}>
          {adjustedFields.length > 0
            ? `Ajustamos ${joinList(adjustedFields.map((field) => field.adjustedLabel))} para manter o texto legível.`
            : ""}
        </p>
        {adjustedFields.length > 0 && (
          <ul className="space-y-1 rounded-md border bg-muted p-3 text-xs">
            {adjustedFields.map((field) => (
              <li key={field.key} className="flex items-center gap-2 text-muted-foreground">
                <span aria-hidden="true" className="h-4 w-4 rounded border" style={{ backgroundColor: value[field.key] }} />
                <span aria-hidden="true" className="h-4 w-4 rounded border" style={{ backgroundColor: derived.effective[field.key] }} />
                <span>
                  Escolhida {value[field.key]} · Usada {derived.effective[field.key]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2 md:col-span-2">
        <Button type="button" variant="outline" onClick={onReset}>
          Restaurar padrão
        </Button>
        <Button
          type="button"
          aria-disabled={applyDisabled || applying || wallpaperBusy}
          onClick={() => {
            if (!applyDisabled && !applying && !wallpaperBusy) onApply();
          }}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          {applying ? "Aplicando…" : "Aplicar tema"}
        </Button>
      </div>
    </div>
  );
}
