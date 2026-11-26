import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Message } from "./useMessages";

export interface MessageFilters {
  messageTypes: string[];
  direction: "all" | "inbound" | "outbound";
  dateRange: { from: Date | null; to: Date | null };
  hasMedia: boolean | null;
  senderPhones: string[];
}

const DEFAULT_FILTERS: MessageFilters = {
  messageTypes: [],
  direction: "all",
  dateRange: { from: null, to: null },
  hasMedia: null,
  senderPhones: [],
};

interface UseMessageSearchOptions {
  messages: Message[];
  conversationId: string | null;
  isGroup?: boolean;
  /**
   * Nomes já resolvidos (apelido > pushName > contato 1:1), chaveados por
   * telefone e por bare do JID. Só muda o RÓTULO do chip — o filtro continua
   * casando por `phone`.
   */
  participantNames?: Record<string, string>;
}

export interface Participant {
  name: string;
  phone: string;
}

export function useMessageSearch({
  messages,
  conversationId,
  isGroup = false,
  participantNames,
}: UseMessageSearchOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [filters, setFilters] = useState<MessageFilters>(DEFAULT_FILTERS);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Debounce: sem isso, cada tecla varria o histórico completo (até 10k
  // mensagens) e re-renderizava todas as bolhas visíveis.
  const [debouncedTerm, setDebouncedTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTerm(searchTerm), 250);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Preserva a posição por id do match: mensagem nova chegando não pode jogar
  // o usuário do match 7/30 de volta para o 1.
  const currentMatchIdRef = useRef<string | null>(null);
  useEffect(() => {
    currentMatchIdRef.current = searchResults[currentIndex] || null;
  }, [searchResults, currentIndex]);

  // Extract unique participants from messages (for groups)
  const participants = useMemo((): Participant[] => {
    if (!isGroup) return [];

    const uniqueParticipants = new Map<string, Participant>();
    messages.forEach((m) => {
      if (m.sender_phone && !uniqueParticipants.has(m.sender_phone)) {
        const resolved =
          participantNames?.[m.sender_phone] ??
          (m.sender_jid ? participantNames?.[m.sender_jid.split("@")[0]] : undefined);
        uniqueParticipants.set(m.sender_phone, {
          // `phone` fica intacto: é a chave do filtro. Só o rótulo melhora — o
          // fallback de dígitos crus vira o nome resolvido quando existe.
          name: resolved || m.sender_name || m.sender_phone,
          phone: m.sender_phone,
        });
      }
    });
    return Array.from(uniqueParticipants.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [messages, isGroup, participantNames]);

  // Check if any filter is active
  const hasActiveFilters = useMemo(() => {
    return (
      filters.messageTypes.length > 0 ||
      filters.direction !== "all" ||
      filters.dateRange.from !== null ||
      filters.dateRange.to !== null ||
      filters.hasMedia !== null ||
      filters.senderPhones.length > 0
    );
  }, [filters]);

  // Count active filters
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.messageTypes.length > 0) count++;
    if (filters.direction !== "all") count++;
    if (filters.dateRange.from || filters.dateRange.to) count++;
    if (filters.hasMedia !== null) count++;
    if (filters.senderPhones.length > 0) count++;
    return count;
  }, [filters]);

  // Search and filter when term or filters change
  useEffect(() => {
    const hasSearchTerm = debouncedTerm.trim().length > 0;

    // If no search term and no filters, clear results
    if (!hasSearchTerm && !hasActiveFilters) {
      setSearchResults([]);
      setCurrentIndex(0);
      return;
    }

    let filtered = messages;

    // Filter by text content
    if (hasSearchTerm) {
      const term = debouncedTerm.toLowerCase();
      filtered = filtered.filter((m) =>
        m.content?.toLowerCase().includes(term)
      );
    }

    // Filter by message type
    if (filters.messageTypes.length > 0) {
      filtered = filtered.filter((m) =>
        filters.messageTypes.includes(m.message_type || "text")
      );
    }

    // Filter by direction
    if (filters.direction !== "all") {
      filtered = filtered.filter((m) => m.direction === filters.direction);
    }

    // Filter by date range - from
    if (filters.dateRange.from) {
      const fromDate = new Date(filters.dateRange.from);
      fromDate.setHours(0, 0, 0, 0);
      filtered = filtered.filter(
        (m) => new Date(m.created_at) >= fromDate
      );
    }

    // Filter by date range - to
    if (filters.dateRange.to) {
      const toDate = new Date(filters.dateRange.to);
      toDate.setHours(23, 59, 59, 999);
      filtered = filtered.filter(
        (m) => new Date(m.created_at) <= toDate
      );
    }

    // Filter by media presence
    if (filters.hasMedia === true) {
      filtered = filtered.filter((m) => m.media_url);
    } else if (filters.hasMedia === false) {
      filtered = filtered.filter((m) => !m.media_url);
    }

    // Filter by sender (groups only)
    if (filters.senderPhones.length > 0) {
      filtered = filtered.filter(
        (m) => m.sender_phone && filters.senderPhones.includes(m.sender_phone)
      );
    }

    const matchingIds = filtered.map((m) => m.id);
    setSearchResults(matchingIds);
    setCurrentIndex(() => {
      // Mantém o usuário no MESMO match quando a lista recomputa (mensagem
      // nova, status mudando); só volta ao início se o match sumiu.
      const prevId = currentMatchIdRef.current;
      if (prevId) {
        const idx = matchingIds.indexOf(prevId);
        if (idx !== -1) return idx;
      }
      if (matchingIds.length === 0) return -1;
      // Filtro sem termo: começa no match mais RECENTE (fim da lista), não no
      // mais antigo do histórico.
      return hasSearchTerm ? 0 : matchingIds.length - 1;
    });
  }, [debouncedTerm, messages, filters, hasActiveFilters]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  // Reset when conversation changes
  useEffect(() => {
    setIsOpen(false);
    setSearchTerm("");
    // Sem zerar o debounced, o effect de busca re-rodava com o termo ANTIGO
    // assim que as mensagens da conversa nova chegassem.
    setDebouncedTerm("");
    currentMatchIdRef.current = null;
    setSearchResults([]);
    setCurrentIndex(0);
    setFilters(DEFAULT_FILTERS);
  }, [conversationId]);

  const open = useCallback(() => {
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setSearchTerm("");
    setDebouncedTerm("");
    currentMatchIdRef.current = null;
    setSearchResults([]);
    setCurrentIndex(0);
    setFilters(DEFAULT_FILTERS);
  }, []);

  const goToPrev = useCallback(() => {
    if (searchResults.length === 0) return;
    setCurrentIndex((prev) =>
      prev <= 0 ? searchResults.length - 1 : prev - 1
    );
  }, [searchResults.length]);

  const goToNext = useCallback(() => {
    if (searchResults.length === 0) return;
    setCurrentIndex((prev) =>
      prev >= searchResults.length - 1 ? 0 : prev + 1
    );
  }, [searchResults.length]);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
  }, []);

  const updateFilters = useCallback((updates: Partial<MessageFilters>) => {
    setFilters((prev) => ({ ...prev, ...updates }));
  }, []);

  return {
    isOpen,
    searchTerm,
    setSearchTerm,
    searchResults,
    currentIndex,
    searchInputRef,
    open,
    close,
    goToPrev,
    goToNext,
    currentMatchId: searchResults[currentIndex] || null,
    // New filter-related exports
    filters,
    setFilters,
    updateFilters,
    resetFilters,
    hasActiveFilters,
    activeFilterCount,
    participants,
    isGroup,
  };
}
