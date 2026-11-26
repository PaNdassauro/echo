import { useRef, useState } from "react";
import { Loader2, Plus, Sticker as StickerIcon, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useIsMobile } from "@/hooks/use-mobile";
import { STICKER_UPLOAD_ACCEPT, type UserSticker } from "@/hooks/useStickers";
import { cn } from "@/lib/utils";

interface StickerPickerProps {
  stickers: UserSticker[];
  isLoading: boolean;
  isConverting: boolean;
  isSaving: boolean;
  /** true no business_api: sticker fora da spec da Meta não pode ser enviado. */
  requireMetaCompliant: boolean;
  disabled?: boolean;
  onOpen: () => void;
  onSelect: (sticker: UserSticker) => void;
  onConvert: (file: File) => Promise<Blob | null>;
  onConfirmUpload: (blob: Blob) => Promise<boolean>;
  onRemove: (stickerId: string) => void;
}

// Fundo xadrez para o preview: figurinha tem transparência e o usuário
// precisa ver o que realmente vai ser enviado.
const checkerboardStyle = {
  backgroundImage:
    "repeating-conic-gradient(hsl(var(--muted)) 0% 25%, transparent 0% 50%)",
  backgroundSize: "16px 16px",
} as const;

interface StickerCellProps {
  sticker: UserSticker;
  blocked: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

const StickerCell = ({ sticker, blocked, onSelect, onRemove }: StickerCellProps) => {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onSelect}
        disabled={blocked}
        aria-label={blocked ? "Figurinha fora do padrão — só envia via QR" : "Enviar figurinha"}
        title={blocked ? "Fora do padrão do WhatsApp — só envia por números conectados via QR" : undefined}
        className={cn(
          "aspect-square w-full rounded-lg p-1 transition-transform duration-75 ease-out",
          blocked
            ? "cursor-not-allowed opacity-40"
            : "hover:bg-accent active:scale-[0.96]",
        )}
      >
        <img
          src={sticker.file_url}
          alt=""
          loading="lazy"
          draggable={false}
          onLoad={() => setLoaded(true)}
          className={cn(
            "h-full w-full object-contain transition-opacity duration-200",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
        {!loaded && (
          <div className="absolute inset-1 animate-pulse rounded-lg bg-muted" />
        )}
      </button>
      {blocked && (
        <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-muted px-1 text-xs font-medium text-muted-foreground">
          só QR
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        aria-label="Remover figurinha"
        className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-[opacity,color,transform] duration-150 ease-out opacity-60 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 hover:text-destructive active:scale-[0.96] motion-reduce:active:scale-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
};

const StickerPicker = ({
  stickers,
  isLoading,
  isConverting,
  isSaving,
  requireMetaCompliant,
  disabled,
  onOpen,
  onSelect,
  onConvert,
  onConfirmUpload,
  onRemove,
}: StickerPickerProps) => {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<{ blob: Blob; url: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const clearPending = () => {
    setPending((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      onOpen();
    } else {
      clearPending();
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const blob = await onConvert(file);
    if (blob) {
      clearPending();
      setPending({ blob, url: URL.createObjectURL(blob) });
    }
  };

  const handleConfirm = async () => {
    if (!pending || isSaving) return;
    const ok = await onConfirmUpload(pending.blob);
    if (ok) clearPending();
  };

  const handleSelect = (sticker: UserSticker) => {
    onSelect(sticker);
    setOpen(false);
  };

  const previewPanel = pending && (
    <div className="flex flex-col items-center gap-3 p-4">
      <div
        className="flex h-40 w-40 items-center justify-center rounded-lg border"
        style={checkerboardStyle}
      >
        <img
          src={pending.url}
          alt="Prévia da figurinha"
          className="max-h-36 max-w-36 object-contain"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {Math.max(1, Math.round(pending.blob.size / 1024))} KB · 512×512
      </p>
      <div className="flex w-full gap-2">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          onClick={clearPending}
          disabled={isSaving}
        >
          Cancelar
        </Button>
        <Button type="button" className="flex-1" onClick={handleConfirm} disabled={isSaving}>
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}
        </Button>
      </div>
    </div>
  );

  const gridPanel = (
    <div className="grid grid-cols-4 gap-2 p-2">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={isConverting}
        aria-label="Criar figurinha a partir de uma imagem"
        className="flex aspect-square w-full items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/30 text-muted-foreground transition-colors hover:border-muted-foreground/60 hover:text-foreground active:scale-[0.96]"
      >
        {isConverting ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <Plus className="h-5 w-5" />
        )}
      </button>
      {isLoading
        ? Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-lg bg-muted" />
          ))
        : stickers.map((sticker) => (
            <StickerCell
              key={sticker.id}
              sticker={sticker}
              blocked={requireMetaCompliant && !sticker.meta_compliant}
              onSelect={() => handleSelect(sticker)}
              onRemove={() => onRemove(sticker.id)}
            />
          ))}
    </div>
  );

  const emptyHint = !isLoading && !pending && stickers.length === 0 && (
    <p className="px-4 pb-4 text-center text-sm text-muted-foreground">
      Sem figurinhas ainda — toque no + para criar a primeira a partir de uma
      imagem ou GIF.
    </p>
  );

  const panel = pending ? (
    previewPanel
  ) : (
    <>
      {gridPanel}
      {emptyHint}
    </>
  );

  const trigger = (
    <Button
      type="button"
      variant="outline"
      size="icon"
      disabled={disabled}
      aria-label="Figurinhas"
      onClick={isMobile ? () => handleOpenChange(true) : undefined}
    >
      <StickerIcon className="w-4 h-4" />
    </Button>
  );

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={STICKER_UPLOAD_ACCEPT}
        className="hidden"
        aria-label="Escolher imagem para figurinha"
        onChange={handleFileChange}
      />
      {isMobile ? (
        <>
          {trigger}
          <Drawer open={open} onOpenChange={handleOpenChange}>
            <DrawerContent className="max-h-[85dvh]">
              <DrawerHeader className="pb-0">
                <DrawerTitle>Figurinhas</DrawerTitle>
              </DrawerHeader>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {panel}
              </div>
            </DrawerContent>
          </Drawer>
        </>
      ) : (
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start">
            <ScrollArea className="h-64">{panel}</ScrollArea>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
};

export default StickerPicker;
