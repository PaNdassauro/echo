import type { CSSProperties, HTMLAttributes } from "react";
import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { wallpaperBackground, type CustomWallpaper } from "@/lib/customWallpaper";

export type PreviewPart = "accent" | "header" | "outbound" | "inbound" | "wallpaper" | "input";
export type PreviewClasses = Record<PreviewPart, string>;
export type PreviewStyles = Partial<Record<PreviewPart, CSSProperties>>;

interface ThemePreviewProps {
  classes?: Partial<PreviewClasses>;
  styles?: PreviewStyles;
  /** Atributos extras do papel de parede (ex.: arrastar a imagem no editor). */
  wallpaperProps?: HTMLAttributes<HTMLDivElement>;
}

export function ThemePreview({ classes = {}, styles = {}, wallpaperProps }: ThemePreviewProps) {
  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <div className={cn("h-11 px-3 flex items-center gap-2", classes.header)} style={styles.header}>
        <div className="h-7 w-7 rounded-full bg-white/20 flex items-center justify-center">
          <MessageCircle className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="h-2 w-20 rounded-full bg-current/80" />
          <div className="mt-1.5 h-1.5 w-12 rounded-full bg-current/45" />
        </div>
      </div>

      <div
        {...wallpaperProps}
        className={cn("min-h-[180px] p-3 flex flex-col gap-2", classes.wallpaper, wallpaperProps?.className)}
        style={styles.wallpaper}
      >
        <div
          className={cn("max-w-[78%] rounded-lg rounded-tl-sm px-3 py-2 shadow-sm", classes.inbound)}
          style={styles.inbound}
        >
          <div className="h-2 w-28 rounded-full bg-current/45" />
          <div className="mt-2 h-2 w-16 rounded-full bg-current/25" />
        </div>
        <div
          className={cn("max-w-[76%] self-end rounded-lg rounded-tr-sm px-3 py-2 shadow-sm", classes.outbound)}
          style={styles.outbound}
        >
          <div className="h-2 w-32 rounded-full bg-current/45" />
          <div className="mt-2 h-2 w-20 rounded-full bg-current/25" />
        </div>
        <div
          className={cn("max-w-[68%] rounded-lg rounded-tl-sm px-3 py-2 shadow-sm", classes.inbound)}
          style={styles.inbound}
        >
          <div className="h-2 w-24 rounded-full bg-current/45" />
        </div>
        <div className={cn("mt-auto h-9 rounded-full border flex items-center px-3", classes.input)} style={styles.input}>
          <div className="h-2 w-24 rounded-full bg-current/20" />
          <div className={cn("ml-auto h-6 w-6 rounded-full", classes.accent)} style={styles.accent} />
        </div>
      </div>
    </div>
  );
}

const hsl = (tokens: Record<string, string>, key: string): string | undefined =>
  tokens[key] ? `hsl(${tokens[key]})` : undefined;

/** Estilos da prévia a partir dos tokens derivados ("H S% L%"). */
export function previewStylesFromTokens(tokens: Record<string, string>): PreviewStyles {
  return {
    accent: { backgroundColor: hsl(tokens, "primary"), color: hsl(tokens, "primary-foreground") },
    header: { backgroundColor: hsl(tokens, "primary"), color: hsl(tokens, "primary-foreground") },
    outbound: {
      backgroundColor: hsl(tokens, "chat-bubble-user"),
      color: hsl(tokens, "chat-bubble-user-foreground"),
    },
    inbound: {
      backgroundColor: hsl(tokens, "chat-bubble-contact"),
      color: hsl(tokens, "chat-bubble-contact-foreground"),
    },
    wallpaper: { backgroundColor: hsl(tokens, "background") },
    input: {
      backgroundColor: hsl(tokens, "card"),
      borderColor: hsl(tokens, "border"),
      color: hsl(tokens, "foreground"),
    },
  };
}

// A prévia tem ~1/3 da largura da conversa: o bloco do mosaico encolhe junto.
const PREVIEW_TILE_SCALE = 0.4;

/** Põe a imagem de fundo (com o véu na cor do tema) no papel de parede da prévia. */
export function withWallpaper(
  styles: PreviewStyles,
  tokens: Record<string, string>,
  wallpaper: CustomWallpaper,
  imageUrl: string,
): PreviewStyles {
  const background = tokens.background ?? "0 0% 100%";
  return {
    ...styles,
    wallpaper: {
      ...styles.wallpaper,
      ...wallpaperBackground(wallpaper, imageUrl, (alpha) => `hsl(${background} / ${alpha})`, PREVIEW_TILE_SCALE),
    },
  };
}
