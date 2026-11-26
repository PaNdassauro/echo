import { useMemo, useRef, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Smile } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  EMOJI_CATEGORIES,
  SKIN_TONES,
  applySkinTone,
  searchEmojis,
} from "./chat/emoji/emojiData";
import { useRecentEmojis } from "./chat/emoji/useRecentEmojis";

interface EmojiPickerProps {
  onEmojiSelect: (emoji: string) => void;
  disabled?: boolean;
  /** Mobile: Drawer em vez de Popover (o teclado nativo cobre, mas o botão dá acesso). */
  variant?: "popover" | "drawer";
}

const TONE_STORAGE_KEY = "echo_emoji_skin_tone_v1";

function readStoredTone(): string {
  try {
    return localStorage.getItem(TONE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Painel completo do picker: busca PT/EN, recentes, tom de pele, categorias.
 * Usado pelo Popover do composer, pelo Drawer mobile e pelo "+" das reações.
 */
export const EmojiPickerPanel = ({
  onEmojiSelect,
  heightClass = "h-64",
  showToneSelector = true,
}: {
  onEmojiSelect: (emoji: string) => void;
  heightClass?: string;
  showToneSelector?: boolean;
}) => {
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState(readStoredTone);
  const { recents, pushRecent } = useRecentEmojis();

  const searchResults = useMemo(() => searchEmojis(query), [query]);
  const isSearching = query.trim().length > 0;

  const pick = (emoji: string) => {
    const finalEmoji = applySkinTone(emoji, tone);
    pushRecent(finalEmoji);
    onEmojiSelect(finalEmoji);
  };

  const selectTone = (modifier: string) => {
    setTone(modifier);
    try {
      localStorage.setItem(TONE_STORAGE_KEY, modifier);
    } catch {
      /* só-sessão */
    }
  };

  const emojiButton = (emoji: string, key: string) => (
    <button
      key={key}
      type="button"
      onClick={() => pick(emoji)}
      className="w-8 h-8 flex items-center justify-center text-lg hover:bg-accent rounded active:scale-[0.96] transition-transform duration-75 ease-out"
    >
      {applySkinTone(emoji, tone)}
    </button>
  );

  return (
    <div className="flex flex-col">
      {/* Busca + tom de pele */}
      <div className="flex items-center gap-2 p-2 border-b">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar emoji…"
            className="h-8 pl-8 text-sm"
            aria-label="Buscar emoji"
          />
        </div>
        {showToneSelector && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="w-8 h-8 flex items-center justify-center text-lg rounded hover:bg-accent"
                title="Tom de pele"
                aria-label="Escolher tom de pele"
              >
                {applySkinTone("✋", tone)}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1.5" align="end">
              <div className="flex gap-0.5">
                {SKIN_TONES.map((t) => (
                  <button
                    key={t.label}
                    type="button"
                    onClick={() => selectTone(t.modifier)}
                    className={cn(
                      "w-8 h-8 flex items-center justify-center text-lg rounded hover:bg-accent",
                      t.modifier === tone && "bg-primary/10 ring-1 ring-primary/30"
                    )}
                    title={t.label}
                  >
                    {t.sample}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>

      <ScrollArea className={heightClass}>
        <div className="p-2">
          {isSearching ? (
            searchResults.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {searchResults.map((emoji) => emojiButton(emoji, `s-${emoji}`))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-6">
                Nenhum emoji para "{query.trim()}"
              </p>
            )
          ) : (
            <>
              {recents.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2 px-1">
                    Recentes
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {/* Recentes já vêm com tom aplicado — botão cru, sem re-aplicar */}
                    {recents.map((emoji) => (
                      <button
                        key={`r-${emoji}`}
                        type="button"
                        onClick={() => {
                          pushRecent(emoji);
                          onEmojiSelect(emoji);
                        }}
                        className="w-8 h-8 flex items-center justify-center text-lg hover:bg-accent rounded active:scale-[0.96] transition-transform duration-75 ease-out"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {EMOJI_CATEGORIES.map((category) => (
                <div key={category.name} className="mb-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2 px-1">
                    {category.name}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {category.emojis.map((emoji) => emojiButton(emoji, emoji))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

/**
 * Compat: o "+" das reações e o drawer mobile importam EmojiGrid — hoje é o
 * painel completo (busca+recentes), sem o seletor de tom para caber no popover.
 */
export const EmojiGrid = ({
  onEmojiSelect,
  heightClass = "h-64",
}: {
  onEmojiSelect: (emoji: string) => void;
  heightClass?: string;
}) => (
  <EmojiPickerPanel onEmojiSelect={onEmojiSelect} heightClass={heightClass} showToneSelector={false} />
);

const EmojiPicker = ({ onEmojiSelect, disabled, variant = "popover" }: EmojiPickerProps) => {
  const [open, setOpen] = useState(false);
  // Escolheu um emoji: o foco fica no campo (quem chamou já focou ali), sem
  // voltar para o botão. Fechar por Esc/clique fora devolve ao botão.
  const pickedRef = useRef(false);

  const handleEmojiClick = (emoji: string) => {
    pickedRef.current = true;
    onEmojiSelect(emoji);
    setOpen(false);
  };

  const handleCloseAutoFocus = (e: Event) => {
    if (pickedRef.current) e.preventDefault();
    pickedRef.current = false;
  };

  if (variant === "drawer") {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          <Button type="button" variant="outline" size="icon" disabled={disabled} aria-label="Emojis">
            <Smile className="w-4 h-4" />
          </Button>
        </DrawerTrigger>
        <DrawerContent className="safe-area-bottom" onCloseAutoFocus={handleCloseAutoFocus}>
          <DrawerTitle className="sr-only">Escolher emoji</DrawerTitle>
          <EmojiPickerPanel onEmojiSelect={handleEmojiClick} heightClass="h-72" />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={disabled}
          aria-label="Emojis"
        >
          <Smile className="w-4 h-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start" onCloseAutoFocus={handleCloseAutoFocus}>
        <EmojiPickerPanel onEmojiSelect={handleEmojiClick} />
      </PopoverContent>
    </Popover>
  );
};

export default EmojiPicker;
