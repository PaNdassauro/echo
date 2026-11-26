import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatParticipantPhone } from "@/lib/phone";
import { Users } from "lucide-react";

export interface MentionParticipant {
  id: string; // Full JID like "260200000001001@s.whatsapp.net" or "260200000001001@lid"
  jid: string; // The actual WhatsApp JID to use for mentions (always @s.whatsapp.net format)
  phone: string; // Just the phone number
  name?: string; // Display name (alias or pushName)
  isLid?: boolean;
}

// Entrada sintética "Marcar todos": o ChatInput intercepta pelo id e expande
// para todos os participantes do grupo (estilo hidetag). O jid sentinela
// nunca vai para o wire.
export const MENTION_ALL_ID = "__mention_all__";

const MENTION_ALL_ENTRY: MentionParticipant = {
  id: MENTION_ALL_ID,
  jid: MENTION_ALL_ID,
  phone: "todos",
};

interface MentionPopupProps {
  participants: MentionParticipant[];
  searchQuery: string;
  onSelect: (participant: MentionParticipant) => void;
  onClose: () => void;
  position: { top: number; left: number };
  visible: boolean;
  /** Combobox: o composer aponta aria-activedescendant para a opção ativa. */
  onActiveIndexChange?: (index: number) => void;
}

const MentionPopup = ({
  participants,
  searchQuery,
  onSelect,
  onClose,
  position,
  visible,
  onActiveIndexChange,
}: MentionPopupProps) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const popupRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Lista exibida: participantes filtrados pela query, com "Marcar todos"
  // fixado no topo enquanto a query for prefixo de todos/all (query vazia
  // passa). Prefix-match para não poluir buscas por nome. useMemo: `items`
  // entra nas deps do useEffect de teclado.
  const items = useMemo(() => {
    const query = searchQuery.toLowerCase();
    const filtered = participants.filter((p) => {
      const name = (p.name || "").toLowerCase();
      const phone = p.phone.toLowerCase();
      return name.includes(query) || phone.includes(query);
    });
    const showAllEntry =
      participants.length > 1 &&
      ("todos".startsWith(query) || "all".startsWith(query));
    return showAllEntry ? [MENTION_ALL_ENTRY, ...filtered] : filtered;
  }, [participants, searchQuery]);

  // Reset selected index when filtered results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    onActiveIndexChange?.(selectedIndex);
  }, [selectedIndex, onActiveIndexChange]);

  // Scroll selected item into view
  useEffect(() => {
    if (itemRefs.current[selectedIndex]) {
      itemRefs.current[selectedIndex]?.scrollIntoView({
        block: "nearest",
      });
    }
  }, [selectedIndex]);

  // Handle keyboard navigation
  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < items.length - 1 ? prev + 1 : prev
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          break;
        case "Enter":
        case "Tab":
          e.preventDefault();
          if (items[selectedIndex]) {
            onSelect(items[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [visible, selectedIndex, items, onSelect, onClose]);

  // Close when clicking outside
  useEffect(() => {
    if (!visible) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [visible, onClose]);

  if (!visible || items.length === 0) return null;

  return (
    <div
      ref={popupRef}
      role="listbox"
      id="mention-listbox"
      aria-label="Mencionar participante"
      className="absolute z-50 w-64 max-h-48 overflow-y-auto bg-popover border rounded-lg shadow-lg animate-in fade-in-0 duration-100 ease-out"
      style={{
        bottom: position.top,
        left: position.left,
        transformOrigin: "bottom left",
      }}
    >
      <div className="p-2 border-b bg-muted/30">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Users className="w-3 h-3" />
          <span>Mencionar participante</span>
        </div>
      </div>
      <div className="py-1">
        {items.map((participant, index) => (
          <button
            key={participant.id}
            ref={(el) => (itemRefs.current[index] = el)}
            role="option"
            id={`mention-opt-${index}`}
            aria-selected={index === selectedIndex}
            className={cn(
              "w-full px-3 py-2 text-left flex items-center gap-3 hover:bg-accent",
              index === selectedIndex && "bg-accent",
              participant.id === MENTION_ALL_ID && items.length > 1 && "border-b"
            )}
            onClick={() => onSelect(participant)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            {participant.id === MENTION_ALL_ID ? (
              <>
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Users className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">Marcar todos</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {participants.length} participantes
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <span className="text-xs font-medium">
                    {(participant.name || participant.phone).slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" title={participant.name || formatParticipantPhone(participant.phone, participant.isLid)}>
                    {participant.name || formatParticipantPhone(participant.phone, participant.isLid)}
                  </p>
                  {participant.name && (
                    <p className="text-xs text-muted-foreground truncate">
                      {formatParticipantPhone(participant.phone, participant.isLid)}
                    </p>
                  )}
                </div>
              </>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default MentionPopup;
