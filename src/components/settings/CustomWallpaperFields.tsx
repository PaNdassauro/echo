import { useId, useRef } from "react";
import { ImagePlus, Loader2, Trash2, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import {
  WALLPAPER_ACCEPTED_TYPES,
  WALLPAPER_FITS,
  WALLPAPER_LIMITS,
  type CustomWallpaper,
  type WallpaperFit,
} from "@/lib/customWallpaper";

interface CustomWallpaperFieldsProps {
  wallpaper: CustomWallpaper | undefined;
  /** Lendo/reduzindo o arquivo escolhido. */
  busy: boolean;
  error: string | null;
  onPick: (file: File) => void;
  onRemove: () => void;
  onChange: (next: CustomWallpaper) => void;
  /** Troca principal, fundo, bolha e base pelas cores tiradas da imagem. */
  onSuggest: () => void;
  suggesting: boolean;
}

const FIT_LABELS: Record<WallpaperFit, string> = {
  cover: "Preencher",
  contain: "Ajustar",
  tile: "Repetir",
};

type SliderKey = keyof typeof WALLPAPER_LIMITS;

interface SliderFieldProps {
  name: SliderKey;
  label: string;
  hint?: string;
  value: number;
  format: (value: number) => string;
  onValue: (value: number) => void;
}

function SliderField({ name, label, hint, value, format, onValue }: SliderFieldProps) {
  const uid = useId();
  const limits = WALLPAPER_LIMITS[name];
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p id={`${uid}-label`} className="text-sm font-medium">
            {label}
          </p>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-hidden="true">
          {format(value)}
        </span>
      </div>
      <Slider
        value={[value]}
        min={limits.min}
        max={limits.max}
        step={limits.step}
        thumbLabel={label}
        onValueChange={([next]) => onValue(next)}
        className="py-1.5"
      />
    </div>
  );
}

export default function CustomWallpaperFields({
  wallpaper,
  busy,
  error,
  onPick,
  onRemove,
  onChange,
  onSuggest,
  suggesting,
}: CustomWallpaperFieldsProps) {
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof CustomWallpaper>(key: K, next: CustomWallpaper[K]) => {
    if (wallpaper) onChange({ ...wallpaper, [key]: next });
  };

  const off = (suffix: string) => (value: number) => (value === 0 ? "Desligado" : `${value}${suffix}`);

  return (
    <div role="group" aria-labelledby={`${uid}-title`} className="space-y-4">
      <div>
        <Label id={`${uid}-title`} className="text-sm font-medium">
          Imagem de fundo
        </Label>
        <p className="text-xs text-muted-foreground">Aparece atrás das mensagens, guardada só neste navegador</p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={WALLPAPER_ACCEPTED_TYPES.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Limpa para o mesmo arquivo poder ser escolhido de novo.
          event.target.value = "";
          if (file) onPick(file);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ImagePlus aria-hidden="true" />}
          {busy ? "Preparando imagem…" : wallpaper ? "Trocar imagem" : "Escolher imagem"}
        </Button>
        {wallpaper && (
          <Button type="button" variant="outline" disabled={busy || suggesting} onClick={onSuggest}>
            {suggesting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <WandSparkles aria-hidden="true" />}
            Sugerir cores pela imagem
          </Button>
        )}
        {wallpaper && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onRemove}>
            <Trash2 aria-hidden="true" />
            Remover
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {wallpaper && (
        <div className="space-y-4">
          <div role="group" aria-labelledby={`${uid}-fit`} className="space-y-2">
            <p id={`${uid}-fit`} className="text-sm font-medium">
              Encaixe
            </p>
            <RadioGroup
              value={wallpaper.fit}
              onValueChange={(next) => {
                const fit = WALLPAPER_FITS.find((option) => option === next);
                if (fit) set("fit", fit);
              }}
              className="grid-cols-3"
            >
              {WALLPAPER_FITS.map((fit) => (
                <div key={fit} className="flex items-center gap-2 rounded-md border px-3 min-h-10">
                  <RadioGroupItem value={fit} id={`${uid}-fit-${fit}`} aria-label={FIT_LABELS[fit]} />
                  <Label htmlFor={`${uid}-fit-${fit}`} className="flex-1 cursor-pointer py-2 text-sm">
                    {FIT_LABELS[fit]}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          {wallpaper.fit === "cover" && (
            <>
              <SliderField
                name="positionX"
                label="Posição horizontal"
                hint="Ou arraste a imagem na prévia"
                value={wallpaper.positionX}
                format={(value) => `${value}%`}
                onValue={(value) => set("positionX", value)}
              />
              <SliderField
                name="positionY"
                label="Posição vertical"
                value={wallpaper.positionY}
                format={(value) => `${value}%`}
                onValue={(value) => set("positionY", value)}
              />
            </>
          )}
          {wallpaper.fit === "tile" && (
            <SliderField
              name="tileSize"
              label="Tamanho do bloco"
              value={wallpaper.tileSize}
              format={(value) => `${value} px`}
              onValue={(value) => set("tileSize", value)}
            />
          )}
          <SliderField
            name="blur"
            label="Desfoque"
            value={wallpaper.blur}
            format={off(" px")}
            onValue={(value) => set("blur", value)}
          />
          <SliderField
            name="dither"
            label="Dither"
            hint="Reduz as cores em um padrão de pontos"
            value={wallpaper.dither}
            format={off("%")}
            onValue={(value) => set("dither", value)}
          />
          {wallpaper.dither > 0 && (
            <SliderField
              name="ditherSize"
              label="Tamanho do ponto"
              value={wallpaper.ditherSize}
              format={(value) => `${value} px`}
              onValue={(value) => set("ditherSize", value)}
            />
          )}
          <SliderField
            name="veil"
            label="Véu"
            hint="Cobre a imagem com a cor de fundo para destacar as mensagens"
            value={wallpaper.veil}
            format={off("%")}
            onValue={(value) => set("veil", value)}
          />
        </div>
      )}
    </div>
  );
}
