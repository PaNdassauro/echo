import { useState, useCallback, useMemo } from "react";
import { startOfMonth, endOfDay, startOfDay } from "date-fns";

export interface AnalyticsFiltersState {
    startDate: Date;
    endDate: Date;
    phoneIds: string[];
    sectorIds: string[];
    agentIds: string[];
}

export interface UseAnalyticsFiltersReturn {
    filters: AnalyticsFiltersState;
    setDateRange: (start: Date, end: Date) => void;
    setPhoneIds: (ids: string[]) => void;
    setSectorIds: (ids: string[]) => void;
    setAgentIds: (ids: string[]) => void;
    resetFilters: () => void;
    filtersForRPC: {
        start_date: string;
        end_date: string;
        phone_ids: string[] | null;
        sector_ids: string[] | null;
        agent_ids: string[] | null;
    };
}

const getDefaultFilters = (): AnalyticsFiltersState => ({
    startDate: startOfMonth(new Date()),
    endDate: endOfDay(new Date()),
    phoneIds: [],
    sectorIds: [],
    agentIds: [],
});

export function useAnalyticsFilters(): UseAnalyticsFiltersReturn {
    const [filters, setFilters] = useState<AnalyticsFiltersState>(getDefaultFilters);

    const setDateRange = useCallback((start: Date, end: Date) => {
        setFilters((prev) => ({
            ...prev,
            startDate: startOfDay(start),
            endDate: endOfDay(end),
        }));
    }, []);

    const setPhoneIds = useCallback((ids: string[]) => {
        setFilters((prev) => ({ ...prev, phoneIds: ids }));
    }, []);

    const setSectorIds = useCallback((ids: string[]) => {
        setFilters((prev) => ({ ...prev, sectorIds: ids }));
    }, []);

    const setAgentIds = useCallback((ids: string[]) => {
        setFilters((prev) => ({ ...prev, agentIds: ids }));
    }, []);

    const resetFilters = useCallback(() => {
        setFilters(getDefaultFilters());
    }, []);

    // Format filters for RPC calls
    const filtersForRPC = useMemo(() => ({
        start_date: filters.startDate.toISOString(),
        end_date: filters.endDate.toISOString(),
        phone_ids: filters.phoneIds.length > 0 ? filters.phoneIds : null,
        sector_ids: filters.sectorIds.length > 0 ? filters.sectorIds : null,
        agent_ids: filters.agentIds.length > 0 ? filters.agentIds : null,
    }), [filters]);

    return {
        filters,
        setDateRange,
        setPhoneIds,
        setSectorIds,
        setAgentIds,
        resetFilters,
        filtersForRPC,
    };
}
