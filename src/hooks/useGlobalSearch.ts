import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { chaveEscopo, idsDaChave } from "@/lib/caixaConjunta";
import { buscarNosNumeros, LIMITE_DA_BUSCA, type GlobalSearchResult } from "@/lib/globalSearchFetch";

export type { GlobalSearchResult };

export interface GlobalSearchFilters {
  messageTypes: string[];
  direction: "all" | "inbound" | "outbound";
  dateRange: { from: Date | null; to: Date | null };
  hasMedia: boolean | null;
}

const DEFAULT_FILTERS: GlobalSearchFilters = {
  messageTypes: [],
  direction: "all",
  dateRange: { from: null, to: null },
  hasMedia: null,
};

interface UseGlobalSearchOptions {
  /** Os números (phone_numbers.id) em que se busca: uma chamada por número. Vazio = sem número. */
  phoneNumberIds: readonly string[];
  debounceMs?: number;
}

export function useGlobalSearch({
  phoneNumberIds,
  debounceMs = 300,
}: UseGlobalSearchOptions) {
  // O conjunto vem pela chave: o pai pode recriar o array a cada render sem mudar os
  // números, e a busca não pode mudar de identidade por isso.
  const numerosKey = chaveEscopo(phoneNumberIds);
  const numeros = useMemo(() => idsDaChave(numerosKey), [numerosKey]);
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // Erro ≠ vazio: falha de rede/RLS não pode ser comunicada como "nenhum resultado".
  const [error, setError] = useState<"failed" | "no-phone" | null>(null);
  const [filters, setFilters] = useState<GlobalSearchFilters>(DEFAULT_FILTERS);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Última requisição vence: respostas velhas (mesmo sem abort efetivo) são descartadas.
  const requestIdRef = useRef(0);

  const search = useCallback(
    async (term: string, currentFilters: GlobalSearchFilters) => {
      // Cancel previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const requestId = ++requestIdRef.current;

      const trimmedTerm = term.trim();

      if (!trimmedTerm || trimmedTerm.length < 2) {
        setResults([]);
        setIsLoading(false);
        setError(null);
        return;
      }

      if (numeros.length === 0) {
        setResults([]);
        setIsLoading(false);
        setError("no-phone");
        return;
      }

      setIsLoading(true);
      setError(null);
      // UM controller por lote: cada termo novo aborta o lote anterior inteiro.
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Build date range for query
      let dateTo: string | null = null;
      if (currentFilters.dateRange.to) {
        const endDate = new Date(currentFilters.dateRange.to);
        endDate.setDate(endDate.getDate() + 1);
        dateTo = endDate.toISOString();
      }

      // Use optimized RPC function that bypasses per-row RLS checks. Uma chamada por número
      // (`p_phone_number_id` é um só); `buscarNosNumeros` junta e corta em 50.
      // O abortSignal PRECISA ser encadeado — antes o controller existia mas
      // nenhuma requisição era de fato cancelada.
      const lote = await buscarNosNumeros(
        numeros,
        (numeroId, sinal) =>
          supabase
            .rpc("search_messages", {
              p_phone_number_id: numeroId,
              p_search_term: trimmedTerm,
              p_direction: currentFilters.direction !== "all" ? currentFilters.direction : undefined,
              p_message_types: currentFilters.messageTypes.length > 0 ? currentFilters.messageTypes : undefined,
              p_date_from: currentFilters.dateRange.from?.toISOString() ?? undefined,
              p_date_to: dateTo ?? undefined,
              p_has_media: currentFilters.hasMedia ?? undefined,
              p_limit: LIMITE_DA_BUSCA,
            })
            .abortSignal(sinal),
        controller.signal,
      );

      // Resposta de um termo antigo não pode sobrescrever a busca atual.
      if (requestId !== requestIdRef.current) return;

      // Erro ≠ vazio. Se só alguns números falharam, o que os outros acharam continua na
      // tela e o aviso de falha (com "Tentar novamente") aparece junto.
      if (!lote.abortado) {
        setResults(lote.resultados);
        setError(lote.falhas.length > 0 ? "failed" : null);
      }
      setIsLoading(false);
    },
    [numeros]
  );

  // Reexecuta a busca atual (botão "Tentar novamente" do estado de erro).
  const retry = useCallback(() => {
    search(searchTerm, filters);
  }, [search, searchTerm, filters]);

  // Debounced search
  const debouncedSearch = useCallback(
    (term: string) => {
      setSearchTerm(term);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      if (!term.trim() || term.trim().length < 2) {
        setResults([]);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);

      debounceRef.current = setTimeout(() => {
        search(term, filters);
      }, debounceMs);
    },
    [search, debounceMs, filters]
  );

  // Update filters and re-search
  const updateFilters = useCallback(
    (newFilters: Partial<GlobalSearchFilters>) => {
      const updated = { ...filters, ...newFilters };
      setFilters(updated);

      // Re-search with new filters if we have a search term
      if (searchTerm.trim().length >= 2) {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }
        setIsLoading(true);
        debounceRef.current = setTimeout(() => {
          search(searchTerm, updated);
        }, 100);
      }
    },
    [filters, searchTerm, search]
  );

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    // Re-search with default filters
    if (searchTerm.trim().length >= 2) {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      setIsLoading(true);
      debounceRef.current = setTimeout(() => {
        search(searchTerm, DEFAULT_FILTERS);
      }, 100);
    }
  }, [searchTerm, search]);

  const hasActiveFilters =
    filters.messageTypes.length > 0 ||
    filters.direction !== "all" ||
    filters.dateRange.from !== null ||
    filters.dateRange.to !== null ||
    filters.hasMedia !== null;

  const activeFilterCount =
    (filters.messageTypes.length > 0 ? 1 : 0) +
    (filters.direction !== "all" ? 1 : 0) +
    (filters.dateRange.from || filters.dateRange.to ? 1 : 0) +
    (filters.hasMedia !== null ? 1 : 0);

  const clear = useCallback(() => {
    setSearchTerm("");
    setResults([]);
    setIsLoading(false);
    setError(null);
    setFilters(DEFAULT_FILTERS);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    // Invalida a requisição em voo ANTES do abort: o postgrest resolve aborts
    // como { error } (não lança AbortError), e sem isto o ramo de erro setava
    // "failed" depois de o usuário simplesmente fechar o dialog.
    requestIdRef.current++;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      requestIdRef.current++;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    searchTerm,
    setSearchTerm: debouncedSearch,
    results,
    isLoading,
    error,
    retry,
    filters,
    updateFilters,
    resetFilters,
    hasActiveFilters,
    activeFilterCount,
    clear,
  };
}
