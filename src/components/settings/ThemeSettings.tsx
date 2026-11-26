import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AppThemePreset, CUSTOM_THEME, DARK_PRESETS, useLocalTheme } from "@/hooks/useLocalTheme";
import { DEFAULT_CUSTOM_THEME, deriveCustomTheme, type CustomThemeInput } from "@/lib/customTheme";
import {
  DEFAULT_WALLPAPER_OPTIONS,
  PLAIN_EFFECTS_KEY,
  newWallpaperImageId,
  validateWallpaperFile,
} from "@/lib/customWallpaper";
import { toUserMessage } from "@/lib/userFacingError";
import { PALETTE_SAMPLE_SIDE, suggestColorsFromPixels } from "@/lib/wallpaperPalette";
import { normalizeWallpaperFile, samplePixels } from "@/lib/wallpaperRender";
import { deleteWallpaperRecord, getWallpaperRecord, putWallpaperRecord } from "@/lib/wallpaperStore";
import CustomThemeEditor from "./CustomThemeEditor";
import { ThemePreview, previewStylesFromTokens, withWallpaper } from "./ThemePreview";
import { useStoredWallpaperUrl } from "./useWallpaperPreview";

interface ThemeSettingsProps {
  userId: string;
}

interface ThemePresetConfig {
  id: AppThemePreset;
  name: string;
  description: string;
  accentClass: string;
  headerClass: string;
  outboundClass: string;
  inboundClass: string;
  wallpaperClass: string;
  inputClass: string;
}

const THEME_PRESETS: ThemePresetConfig[] = [
  {
    id: "echo",
    name: "Echo",
    description: "Tema padrão, segue a cor do número",
    accentClass: "bg-[hsl(176_66%_43%)]",
    headerClass: "bg-[hsl(176_66%_43%)] text-white",
    outboundClass: "bg-[hsl(176_60%_40%)] text-white",
    inboundClass: "bg-[hsl(0_0%_96%)] text-[hsl(200_15%_20%)]",
    wallpaperClass: "bg-[hsl(174_20%_98%)]",
    inputClass: "bg-white/90 border-black/5 text-[hsl(200_15%_20%)]",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    description: "Verde, bubbles claras e fundo de conversa",
    accentClass: "bg-[hsl(142_70%_49%)]",
    headerClass: "bg-[hsl(174_86%_20%)] text-white",
    outboundClass: "bg-[hsl(112_74%_91%)] text-[hsl(174_42%_13%)]",
    inboundClass: "bg-white text-[hsl(174_42%_13%)]",
    wallpaperClass: "theme-chat-wallpaper bg-[hsl(36_28%_91%)]",
    inputClass: "bg-white/90 border-black/5 text-[hsl(174_42%_13%)]",
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Modo escuro do Echo",
    accentClass: "bg-[hsl(176_60%_48%)]",
    headerClass: "bg-[hsl(200_18%_12%)] text-[hsl(174_15%_96%)]",
    outboundClass: "bg-[hsl(174_55%_45%)] text-white",
    inboundClass: "bg-[hsl(200_15%_14%)] text-[hsl(174_15%_96%)]",
    wallpaperClass: "bg-[hsl(200_20%_8%)]",
    inputClass: "bg-[hsl(200_15%_13%)] border-white/10 text-[hsl(174_15%_96%)]",
  },
  {
    id: "dracula",
    name: "Dracula",
    description: "Escuro com tons roxos",
    accentClass: "bg-[hsl(265_89%_78%)] text-[hsl(231_15%_15%)]",
    headerClass: "bg-[hsl(231_15%_15%)] text-[hsl(60_30%_96%)]",
    outboundClass: "bg-[hsl(265_50%_42%)] text-[hsl(60_30%_96%)]",
    inboundClass: "bg-[hsl(232_14%_26%)] text-[hsl(60_30%_96%)]",
    wallpaperClass: "bg-[hsl(231_15%_18%)]",
    inputClass: "bg-[hsl(232_14%_24%)] border-[hsl(232_14%_31%)] text-[hsl(60_30%_96%)]",
  },
  {
    id: "barbie",
    name: "Pink",
    description: "Rosa vibrante",
    accentClass: "bg-[hsl(327_81%_48%)]",
    headerClass: "bg-[hsl(327_81%_48%)] text-white",
    outboundClass: "bg-[hsl(327_81%_48%)] text-white",
    inboundClass: "bg-white text-[hsl(330_60%_25%)]",
    wallpaperClass: "bg-[hsl(340_100%_94%)]",
    inputClass: "bg-white/90 border-black/5 text-[hsl(330_60%_25%)]",
  },  {
    id: "lavanda",
    name: "Lavanda",
    description: "Lilás suave e sereno",
    accentClass: "bg-[hsl(262_48%_47%)]",
    headerClass: "bg-[hsl(262_48%_47%)] text-white",
    outboundClass: "bg-[hsl(258_64%_89%)] text-[hsl(262_38%_20%)]",
    inboundClass: "bg-white text-[hsl(262_38%_20%)]",
    wallpaperClass: "bg-[hsl(252_45%_96%)]",
    inputClass: "bg-white/90 border-[hsl(254_30%_87%)] text-[hsl(262_38%_20%)]",
  },
  {
    id: "nord",
    name: "Nord",
    description: "Escuro azulado em tons árticos",
    accentClass: "bg-[hsl(193_43%_67%)] text-[hsl(220_16%_18%)]",
    headerClass: "bg-[hsl(220_17%_18%)] text-[hsl(218_27%_94%)]",
    outboundClass: "bg-[hsl(213_32%_40%)] text-[hsl(218_27%_94%)]",
    inboundClass: "bg-[hsl(222_16%_28%)] text-[hsl(218_27%_94%)]",
    wallpaperClass: "bg-[hsl(220_16%_22%)]",
    inputClass: "bg-[hsl(222_16%_26%)] border-[hsl(220_16%_36%)] text-[hsl(218_27%_94%)]",
  },
  {
    id: "breu",
    name: "Breu",
    description: "Preto puro para telas OLED",
    accentClass: "bg-[hsl(38_92%_58%)] text-[hsl(0_0%_4%)]",
    headerClass: "bg-[hsl(0_0%_5%)] text-[hsl(0_0%_95%)]",
    outboundClass: "bg-[hsl(36_70%_26%)] text-[hsl(40_30%_96%)]",
    inboundClass: "bg-[hsl(0_0%_12%)] text-[hsl(0_0%_95%)]",
    wallpaperClass: "bg-[hsl(0_0%_0%)]",
    inputClass: "bg-[hsl(0_0%_7%)] border-[hsl(0_0%_17%)] text-[hsl(0_0%_95%)]",
  },
];

const THEME_GROUPS = [
  { id: "claros", title: "Claros", presets: THEME_PRESETS.filter((preset) => !DARK_PRESETS.has(preset.id)) },
  { id: "escuros", title: "Escuros", presets: THEME_PRESETS.filter((preset) => DARK_PRESETS.has(preset.id)) },
];

export default function ThemeSettings({ userId }: ThemeSettingsProps) {
  const { themePreset, setThemePreset, customTheme, setCustomTheme } = useLocalTheme(userId);
  const [draft, setDraft] = useState<CustomThemeInput>(customTheme ?? DEFAULT_CUSTOM_THEME);
  const [draftImage, setDraftImage] = useState<Blob | null>(null);
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  const [wallpaperError, setWallpaperError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  // O editor só abre pelo cartão "Personalizado".
  const [editorOpen, setEditorOpen] = useState(false);
  const applyingRef = useRef(false);
  // Imagem escolhida e gravada no IndexedDB, mas ainda não aplicada (apagada se for trocada).
  const unappliedImageIdRef = useRef<string | null>(null);

  const savedKey = JSON.stringify(customTheme);
  useEffect(() => {
    setDraft(customTheme ?? DEFAULT_CUSTOM_THEME);
    // Ressincroniza só quando o tema salvo muda de fato.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  // A imagem original do rascunho mora no IndexedDB; a prévia precisa dela em memória.
  const draftImageId = draft.wallpaper?.imageId ?? null;
  useEffect(() => {
    if (!draftImageId) {
      setDraftImage(null);
      return;
    }
    let cancelled = false;
    void getWallpaperRecord(draftImageId).then((record) => {
      if (!cancelled) setDraftImage(record?.original ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [draftImageId]);

  const customSelected = themePreset === CUSTOM_THEME;
  const applyDisabled = customSelected && customTheme !== null && JSON.stringify(customTheme) === JSON.stringify(draft);
  const savedTokens = useMemo(() => deriveCustomTheme(customTheme ?? DEFAULT_CUSTOM_THEME).tokens, [customTheme]);
  const savedWallpaperUrl = useStoredWallpaperUrl(customTheme?.wallpaper?.imageId ?? null);
  const savedPreviewStyles = useMemo(() => {
    const styles = previewStylesFromTokens(savedTokens);
    const wallpaper = customTheme?.wallpaper;
    return wallpaper && savedWallpaperUrl ? withWallpaper(styles, savedTokens, wallpaper, savedWallpaperUrl) : styles;
  }, [savedTokens, customTheme, savedWallpaperUrl]);

  const discardUnappliedImage = (keepId: string | null) => {
    const pending = unappliedImageIdRef.current;
    if (pending && pending !== keepId && pending !== customTheme?.wallpaper?.imageId) {
      void deleteWallpaperRecord(pending);
    }
    unappliedImageIdRef.current = null;
  };

  const handlePickWallpaper = async (file: File) => {
    const invalid = validateWallpaperFile(file);
    if (invalid) {
      setWallpaperError(invalid);
      return;
    }
    setWallpaperError(null);
    setWallpaperBusy(true);
    try {
      const original = await normalizeWallpaperFile(file);
      const imageId = newWallpaperImageId();
      const saved = await putWallpaperRecord(imageId, { original, processed: original, effectsKey: PLAIN_EFFECTS_KEY });
      if (!saved) {
        setWallpaperError("Não foi possível guardar a imagem neste navegador. Saia do modo privado ou libere espaço e tente de novo.");
        return;
      }
      discardUnappliedImage(null);
      unappliedImageIdRef.current = imageId;
      setDraftImage(original);
      setDraft((current) => ({
        ...current,
        wallpaper: { ...DEFAULT_WALLPAPER_OPTIONS, ...current.wallpaper, imageId },
      }));
    } catch (error) {
      console.error("[wallpaper] falha ao preparar a imagem", error);
      setWallpaperError(toUserMessage(error, "Não foi possível ler a imagem. Tente outro arquivo."));
    } finally {
      setWallpaperBusy(false);
    }
  };

  const handleRemoveWallpaper = () => {
    discardUnappliedImage(null);
    setWallpaperError(null);
    setDraft(({ wallpaper: _removed, ...rest }) => rest);
  };

  const applyDraft = async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    setWallpaperError(null);
    const previousImageId = customTheme?.wallpaper?.imageId ?? null;
    const nextImageId = draft.wallpaper?.imageId ?? null;
    try {
      const result = await setCustomTheme(draft);
      if (result === "missing" || result === "error") {
        setWallpaperError("Não foi possível aplicar a imagem de fundo. Escolha a imagem de novo e aplique.");
      }
      if (unappliedImageIdRef.current === nextImageId) unappliedImageIdRef.current = null;
      if (previousImageId && previousImageId !== nextImageId) void deleteWallpaperRecord(previousImageId);
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  };

  const suggestColors = async () => {
    if (!draftImage || suggesting) return;
    setSuggesting(true);
    setWallpaperError(null);
    try {
      const colors = suggestColorsFromPixels(await samplePixels(draftImage, PALETTE_SAMPLE_SIDE));
      if (!colors) {
        setWallpaperError("Não encontramos cores nesta imagem. Escolha as cores à mão ou tente outra imagem.");
        return;
      }
      setDraft((current) => ({ ...current, ...colors }));
    } catch (error) {
      console.error("[wallpaper] falha ao sugerir cores", error);
      setWallpaperError(toUserMessage(error, "Não foi possível ler as cores da imagem. Tente de novo."));
    } finally {
      setSuggesting(false);
    }
  };

  const handleCustomCard = () => {
    if (!customSelected) {
      setEditorOpen(true);
      // Sem tema salvo, o cartão aplica o rascunho (senão as edições se perderiam no padrão).
      if (customTheme) setThemePreset(CUSTOM_THEME);
      else void applyDraft();
      return;
    }
    setEditorOpen((open) => !open);
  };

  const resetDraft = () => {
    discardUnappliedImage(null);
    setWallpaperError(null);
    setDraft(DEFAULT_CUSTOM_THEME);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Tema</h2>
        <p className="text-sm text-muted-foreground">Aparência deste navegador</p>
      </div>

      <section aria-labelledby="theme-group-custom" className="space-y-3">
        <h3 id="theme-group-custom" className="text-sm font-medium text-muted-foreground">
          Personalizado
        </h3>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <button
            type="button"
            aria-pressed={customSelected}
            aria-expanded={editorOpen}
            aria-controls="custom-theme-editor"
            onClick={handleCustomCard}
            className={cn(
              "group text-left rounded-lg border bg-card p-3",
              "transition-[border-color,box-shadow,transform] duration-150 ease-out",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "active:scale-[0.96]",
              customSelected ? "border-primary shadow-sm" : "border-border hover:border-primary/50",
            )}
          >
            <div className="flex items-center justify-between gap-3 pb-3">
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className="h-8 w-8 rounded-md flex items-center justify-center shrink-0"
                  style={savedPreviewStyles.accent}
                >
                  <Palette className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium text-sm">Personalizado</span>
                  <span className="block text-xs text-muted-foreground truncate">
                    {editorOpen ? "Suas cores e imagem; não segue a cor do número" : "Suas cores e imagem; clique para editar"}
                  </span>
                </span>
              </div>
              <span
                className={cn(
                  "h-6 w-6 rounded-full border flex items-center justify-center transition-[background-color,border-color,color] duration-150 ease-out",
                  customSelected ? "bg-primary border-primary text-primary-foreground" : "border-border text-transparent",
                )}
                aria-hidden="true"
              >
                <Check className="h-3.5 w-3.5" />
              </span>
            </div>
            <ThemePreview styles={savedPreviewStyles} />
          </button>
        </div>
        {editorOpen && (
          <div id="custom-theme-editor" className="animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out">
            <CustomThemeEditor
              value={draft}
              onChange={setDraft}
              onApply={() => void applyDraft()}
              onReset={resetDraft}
              applyDisabled={applyDisabled}
              applying={applying}
              wallpaperImage={draftImage}
              wallpaperBusy={wallpaperBusy}
              wallpaperError={wallpaperError}
              onPickWallpaper={(file) => void handlePickWallpaper(file)}
              onRemoveWallpaper={handleRemoveWallpaper}
              onSuggestColors={() => void suggestColors()}
              suggestingColors={suggesting}
            />
          </div>
        )}
      </section>

      {THEME_GROUPS.map((group) => (
        <section key={group.title} aria-labelledby={`theme-group-${group.id}`} className="space-y-3">
          <h3 id={`theme-group-${group.id}`} className="text-sm font-medium text-muted-foreground">
            {group.title}
          </h3>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {group.presets.map((preset) => {
              const selected = themePreset === preset.id;

              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setThemePreset(preset.id)}
                  className={cn(
                    "group text-left rounded-lg border bg-card p-3",
                    "transition-[border-color,box-shadow,transform] duration-150 ease-out",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    "active:scale-[0.96]",
                    selected ? "border-primary shadow-sm" : "border-border hover:border-primary/50",
                  )}
                  aria-pressed={selected}
                >
                  <div className="flex items-center justify-between gap-3 pb-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={cn("h-8 w-8 rounded-md flex items-center justify-center text-white", preset.accentClass)}>
                        <Palette className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block font-medium text-sm">{preset.name}</span>
                        <span className="block text-xs text-muted-foreground truncate">{preset.description}</span>
                      </span>
                    </div>
                    <span
                      className={cn(
                        "h-6 w-6 rounded-full border flex items-center justify-center transition-[background-color,border-color,color] duration-150 ease-out",
                        selected ? "bg-primary border-primary text-primary-foreground" : "border-border text-transparent",
                      )}
                      aria-hidden="true"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  </div>

                  <ThemePreview
                    classes={{
                      accent: preset.accentClass,
                      header: preset.headerClass,
                      outbound: preset.outboundClass,
                      inbound: preset.inboundClass,
                      wallpaper: preset.wallpaperClass,
                      input: preset.inputClass,
                    }}
                  />
                </button>
              );
            })}
          </div>
        </section>
      ))}

      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={() => setThemePreset("echo")} disabled={themePreset === "echo"}>
          Restaurar Echo
        </Button>
      </div>
    </div>
  );
}
