import { useEffect, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Loader2,
  Users,
  User,
  MessageSquare,
  Filter,
  X,
  Image,
  Video,
  Mic,
  FileText,
  Smile,
  MapPin,
  CalendarIcon,
  Paperclip,
} from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useGlobalSearch, GlobalSearchResult, GlobalSearchFilters } from "@/hooks/useGlobalSearch";
import type { DateRange } from "react-day-picker";
import { SeloNumero } from "@/components/SeloNumero";

const MESSAGE_TYPES = [
  { id: "text", label: "Texto", icon: MessageSquare },
  { id: "image", label: "Imagem", icon: Image },
  { id: "video", label: "Vídeo", icon: Video },
  { id: "audio", label: "Áudio", icon: Mic },
  { id: "document", label: "Doc", icon: FileText },
  { id: "sticker", label: "Figurinha", icon: Smile },
  { id: "location", label: "Local", icon: MapPin },
  { id: "contact", label: "Contato", icon: User },
];

interface GlobalSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectResult: (conversationId: string, messageId: string) => void;
  /** Os números em que se busca (uma busca por número). Vazio desliga a busca. */
  phoneNumberIds: readonly string[];
  /**
   * Nome e cor de cada número: com ele o resultado leva o selo do número em que a mensagem
   * foi achada, em qualquer modo (número ou caixa conjunta). Sem o mapa nada é mostrado.
   */
  numerosPorId?: ReadonlyMap<string, { nome: string; hue: number | null }>;
}

function highlightMatch(text: string, term: string): React.ReactNode {
  if (!term.trim()) return text;

  const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} className="bg-yellow-200 text-yellow-950 dark:bg-yellow-500/30 dark:text-yellow-100 rounded px-0.5">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

function truncateWithContext(text: string, term: string, maxLength: number = 100): string {
  if (!term.trim() || text.length <= maxLength) {
    return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
  }

  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const index = lowerText.indexOf(lowerTerm);

  if (index === -1) {
    return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
  }

  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + term.length + 50);

  let result = text.slice(start, end);
  if (start > 0) result = "…" + result;
  if (end < text.length) result = result + "…";

  return result;
}

export function GlobalSearchDialog({
  open,
  onOpenChange,
  onSelectResult,
  phoneNumberIds,
  numerosPorId,
}: GlobalSearchDialogProps) {
  const {
    searchTerm,
    setSearchTerm,
    results,
    isLoading,
    error: searchError,
    retry: retrySearch,
    filters,
    updateFilters,
    resetFilters,
    hasActiveFilters,
    activeFilterCount,
    clear,
  } = useGlobalSearch({ phoneNumberIds });

  const [showFilters, setShowFilters] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);

  // Clear on close
  useEffect(() => {
    if (!open) {
      clear();
      setShowFilters(false);
    }
  }, [open, clear]);

  const handleSelect = (result: GlobalSearchResult) => {
    onSelectResult(result.conversation_id, result.id);
    onOpenChange(false);
  };

  const toggleMessageType = (typeId: string) => {
    if (typeId === "audio") {
      const isCurrentlySelected =
        filters.messageTypes.includes("audio") ||
        filters.messageTypes.includes("ptt");

      if (isCurrentlySelected) {
        updateFilters({
          messageTypes: filters.messageTypes.filter(
            (t) => t !== "audio" && t !== "ptt"
          ),
        });
      } else {
        updateFilters({
          messageTypes: [...filters.messageTypes, "audio", "ptt"],
        });
      }
      return;
    }

    const types = filters.messageTypes.includes(typeId)
      ? filters.messageTypes.filter((t) => t !== typeId)
      : [...filters.messageTypes, typeId];

    updateFilters({ messageTypes: types });
  };

  const handleDateSelect = (range: DateRange | undefined) => {
    updateFilters({
      dateRange: {
        from: range?.from || null,
        to: range?.to || null,
      },
    });
    if (range?.from && range?.to) {
      setDateOpen(false);
    }
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} shouldFilter={false}>
      <div className="flex items-center border-b px-3">
        <CommandInput
          placeholder="Buscar em mensagens…"
          value={searchTerm}
          onValueChange={setSearchTerm}
          className="border-0"
        />
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 px-2 gap-1 shrink-0",
            hasActiveFilters && "text-primary bg-primary/10"
          )}
          onClick={() => setShowFilters(!showFilters)}
        >
          <Filter className="w-4 h-4" />
          {activeFilterCount > 0 && (
            <Badge
              variant="secondary"
              className="h-5 px-1.5 text-xs bg-primary text-primary-foreground"
            >
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      </div>

      {showFilters && (
        <div className="border-b p-3 space-y-3 max-h-[35vh] overflow-y-auto">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Filtros</span>
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs text-muted-foreground px-2"
                onClick={resetFilters}
              >
                <X className="w-3 h-3 mr-1" />
                Limpar
              </Button>
            )}
          </div>

          {/* Message Type Filter */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Tipo</Label>
            <div className="flex flex-wrap gap-1.5">
              {MESSAGE_TYPES.map((type) => {
                const Icon = type.icon;
                const isChecked =
                  type.id === "audio"
                    ? filters.messageTypes.includes("audio") ||
                      filters.messageTypes.includes("ptt")
                    : filters.messageTypes.includes(type.id);

                return (
                  <button
                    key={type.id}
                    onClick={() => toggleMessageType(type.id)}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs active:scale-[0.96]",
                      isChecked
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted hover:bg-muted/80 text-muted-foreground"
                    )}
                  >
                    <Icon className="w-3 h-3" />
                    {type.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Direction Filter */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Direção</Label>
            <div className="flex gap-1">
              {[
                { value: "all", label: "Todas" },
                { value: "outbound", label: "Enviadas" },
                { value: "inbound", label: "Recebidas" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() =>
                    updateFilters({
                      direction: opt.value as "all" | "inbound" | "outbound",
                    })
                  }
                  className={cn(
                    "px-3 py-1 rounded text-xs active:scale-[0.96]",
                    filters.direction === opt.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted hover:bg-muted/80 text-muted-foreground"
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Date Range Filter */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Período</Label>
            <Popover open={dateOpen} onOpenChange={setDateOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start text-left font-normal h-8"
                >
                  <CalendarIcon className="mr-2 h-3.5 w-3.5 shrink-0" />
                  {filters.dateRange.from ? (
                    filters.dateRange.to ? (
                      <span className="text-xs">
                        {format(filters.dateRange.from, "dd/MM/yyyy", {
                          locale: ptBR,
                        })}{" "}
                        -{" "}
                        {format(filters.dateRange.to, "dd/MM/yyyy", {
                          locale: ptBR,
                        })}
                      </span>
                    ) : (
                      <span className="text-xs">
                        {format(filters.dateRange.from, "dd/MM/yyyy", {
                          locale: ptBR,
                        })}
                      </span>
                    )
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Selecionar período
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="range"
                  defaultMonth={filters.dateRange.from || new Date()}
                  selected={{
                    from: filters.dateRange.from || undefined,
                    to: filters.dateRange.to || undefined,
                  }}
                  onSelect={handleDateSelect}
                  numberOfMonths={1}
                  locale={ptBR}
                />
                {(filters.dateRange.from || filters.dateRange.to) && (
                  <div className="p-2 border-t">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-xs h-7"
                      onClick={() => {
                        updateFilters({
                          dateRange: { from: null, to: null },
                        });
                        setDateOpen(false);
                      }}
                    >
                      Limpar período
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>

          {/* Media Filter */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Anexos</Label>
            <div className="flex gap-1">
              {[
                { value: "all", label: "Todas" },
                { value: "with", label: "Com mídia", icon: Paperclip },
                { value: "without", label: "Sem mídia" },
              ].map((opt) => {
                const isSelected =
                  (opt.value === "all" && filters.hasMedia === null) ||
                  (opt.value === "with" && filters.hasMedia === true) ||
                  (opt.value === "without" && filters.hasMedia === false);

                return (
                  <button
                    key={opt.value}
                    onClick={() =>
                      updateFilters({
                        hasMedia:
                          opt.value === "all"
                            ? null
                            : opt.value === "with"
                            ? true
                            : false,
                      })
                    }
                    className={cn(
                      "inline-flex items-center gap-1 px-3 py-1 rounded text-xs active:scale-[0.96]",
                      isSelected
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted hover:bg-muted/80 text-muted-foreground"
                    )}
                  >
                    {opt.icon && <opt.icon className="w-3 h-3" />}
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <CommandList className="max-h-[50vh] flex-1 overflow-y-auto">
        {isLoading && (
          // Skeleton na forma do resultado real (avatar + duas linhas)
          <div className="space-y-1 p-2" aria-hidden="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-md px-2 py-2.5">
                <div className="h-8 w-8 rounded-full bg-muted animate-pulse shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-1/3 rounded bg-muted animate-pulse" />
                  <div className="h-3 w-2/3 rounded bg-muted animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Erro nunca vira "nenhum resultado": estados distintos, com saída */}
        {!isLoading && searchError === "failed" && (
          <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
            <span>Não foi possível buscar as mensagens</span>
            <Button variant="outline" size="sm" onClick={retrySearch}>
              Tentar novamente
            </Button>
          </div>
        )}
        {!isLoading && searchError === "no-phone" && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Selecione um número conectado para buscar
          </div>
        )}

        {!isLoading && !searchError && searchTerm.length >= 2 && results.length === 0 && (
          <CommandEmpty>Nenhum resultado encontrado</CommandEmpty>
        )}

        {!isLoading && searchTerm.length > 0 && searchTerm.length < 2 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Digite pelo menos 2 caracteres
          </div>
        )}

        {!isLoading && results.length > 0 && (
          <CommandGroup heading={`${results.length} resultado${results.length > 1 ? "s" : ""}`}>
            {results.map((result) => (
              <CommandItem
                key={result.id}
                value={result.id}
                onSelect={() => handleSelect(result)}
                className="group cursor-pointer py-3"
              >
                <div className="flex items-start gap-3 w-full">
                  <div className="flex-shrink-0 mt-0.5">
                    {result.is_group ? (
                      <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                        <Users className="h-4 w-4 text-muted-foreground" />
                      </div>
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                        <User className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate" title={result.contact_name ?? undefined}>
                        {result.contact_name}
                      </span>
                      <div className="flex max-w-[55%] items-center gap-1.5">
                        {(() => {
                          const numero = numerosPorId?.get(result.phone_number_id);
                          return numero ? (
                            <SeloNumero
                              nome={numero.nome}
                              hue={numero.hue}
                              className="group-data-[selected=true]:border-accent-foreground/40 group-data-[selected=true]:text-accent-foreground"
                            />
                          ) : null;
                        })()}
                        <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap tabular-nums group-data-[selected=true]:text-accent-foreground">
                          {formatDistanceToNow(new Date(result.created_at), {
                            addSuffix: true,
                            locale: ptBR,
                          })}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      {result.direction === "outbound" && (
                        <MessageSquare className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      )}
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {highlightMatch(
                          truncateWithContext(result.content, searchTerm),
                          searchTerm
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {!isLoading && !searchTerm && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
            Digite para buscar em mensagens
          </div>
        )}
      </CommandList>
    </CommandDialog>
  );
}
