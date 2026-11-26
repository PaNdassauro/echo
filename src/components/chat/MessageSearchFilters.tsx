import { useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  CalendarIcon,
  Filter,
  X,
  MessageSquare,
  Image,
  Video,
  Mic,
  FileText,
  Smile,
  MapPin,
  User,
  Paperclip,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { MessageFilters, Participant } from "@/hooks/chat/useMessageSearch";
import type { DateRange } from "react-day-picker";

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

interface MessageSearchFiltersProps {
  filters: MessageFilters;
  onFiltersChange: (filters: Partial<MessageFilters>) => void;
  onReset: () => void;
  hasActiveFilters: boolean;
  activeFilterCount: number;
  isGroup: boolean;
  participants: Participant[];
}

export function MessageSearchFilters({
  filters,
  onFiltersChange,
  onReset,
  hasActiveFilters,
  activeFilterCount,
  isGroup,
  participants,
}: MessageSearchFiltersProps) {
  const [open, setOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);

  const toggleMessageType = (typeId: string) => {
    // Handle audio/ptt together (both are audio messages)
    if (typeId === "audio") {
      const isCurrentlySelected =
        filters.messageTypes.includes("audio") ||
        filters.messageTypes.includes("ptt");

      if (isCurrentlySelected) {
        onFiltersChange({
          messageTypes: filters.messageTypes.filter(
            (t) => t !== "audio" && t !== "ptt"
          ),
        });
      } else {
        onFiltersChange({
          messageTypes: [...filters.messageTypes, "audio", "ptt"],
        });
      }
      return;
    }

    const types = filters.messageTypes.includes(typeId)
      ? filters.messageTypes.filter((t) => t !== typeId)
      : [...filters.messageTypes, typeId];

    onFiltersChange({ messageTypes: types });
  };

  const toggleParticipant = (phone: string) => {
    const phones = filters.senderPhones.includes(phone)
      ? filters.senderPhones.filter((p) => p !== phone)
      : [...filters.senderPhones, phone];
    onFiltersChange({ senderPhones: phones });
  };

  const handleDateSelect = (range: DateRange | undefined) => {
    onFiltersChange({
      dateRange: {
        from: range?.from || null,
        to: range?.to || null,
      },
    });
    // Close when both dates selected
    if (range?.from && range?.to) {
      setDateOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 px-2 gap-1",
            hasActiveFilters && "text-primary bg-primary/10"
          )}
          title="Filtros de busca"
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
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <div className="px-3 py-2 border-b flex items-center justify-between">
          <span className="font-medium text-sm">Filtros</span>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs text-muted-foreground px-2"
              onClick={onReset}
            >
              <X className="w-3 h-3 mr-1" />
              Limpar
            </Button>
          )}
        </div>

        <ScrollArea className="max-h-[60vh]">
          <div className="p-3 space-y-3">
            {/* Message Type Filter - Chips */}
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
                        "inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs transition-colors",
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

            {/* Direction Filter - Inline buttons */}
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
                      onFiltersChange({
                        direction: opt.value as "all" | "inbound" | "outbound",
                      })
                    }
                    className={cn(
                      "px-3 py-1 rounded text-xs transition-colors",
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
                          onFiltersChange({
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

            {/* Media Filter - Inline buttons */}
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
                        onFiltersChange({
                          hasMedia:
                            opt.value === "all"
                              ? null
                              : opt.value === "with"
                              ? true
                              : false,
                        })
                      }
                      className={cn(
                        "inline-flex items-center gap-1 px-3 py-1 rounded text-xs transition-colors",
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

            {/* Participant Filter (Groups only) */}
            {isGroup && participants.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Quem enviou
                </Label>
                <div className="max-h-32 overflow-y-auto pr-1">
                  <div className="flex flex-wrap gap-1.5">
                    {participants.map((p) => (
                      <button
                        key={p.phone}
                        onClick={() => toggleParticipant(p.phone)}
                        className={cn(
                          "px-2 py-1 rounded-full text-xs transition-colors truncate max-w-[140px]",
                          filters.senderPhones.includes(p.phone)
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted hover:bg-muted/80 text-muted-foreground"
                        )}
                        title={p.name !== p.phone ? `${p.name} (${p.phone})` : p.phone}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
