import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface AnalyticsStats {
    total_inbound: number; // Used for "Unique Responses" technically in old code it was different
    total_sent: number;
    total_delivered: number;
    total_read: number;
    total_failed: number;
    unique_responses: number;
    total_cost: number;
    avg_cost_per_msg: number;
    total_template_messages: number;
    total_api_messages: number; // outbound não-template de números business_api (custo R$ 0,04)
    // Legacy fields for backward compat or if needed
    active_agents: number;
    avg_response_time_seconds: number;
    total_conversations: number;
}

export interface ButtonStats {
    label: string;
    type: string;
    count: number;
}

export interface TemplateStats {
    template_name: string;
    category: string;
    sent: number;
    delivered: number;
    read: number;
    clicked: number;
}

export interface AgentStats {
    agent_id: string;
    agent_name: string;
    agent_email: string;
    sector_name: string | null;
    messages_sent: number;
    conversations_handled: number;
    avg_response_time_seconds: number;
    current_open_conversations: number;
}

export interface DailyVolume {
    date: string;
    inbound: number;
    outbound: number;
}

export interface ServiceMetrics {
    first_response_p50_seconds: number;
    first_response_p90_seconds: number;
    pct_within_sla: number;
    conversations_opened: number;
    conversations_closed: number;
    resolution_rate: number;
    avg_resolution_seconds: number;
    open_backlog: number;
    unanswered_count: number;
}

export interface CloseReasonStat {
    reason: string;
    count: number;
}

export interface HeatmapCell {
    dow: number; // 0=Sunday .. 6=Saturday
    hour: number; // 0..23
    count: number;
}

export interface ChannelVolume {
    connection_type: string;
    inbound: number;
    outbound: number;
}

// SLA target for first-response (seconds). TODO: make configurable per org.
export const SLA_SECONDS = 300;

export interface UseAnalyticsParams {
    orgId: string;
    startDate: string;
    endDate: string;
    phoneIds: string[] | null;
    sectorIds: string[] | null;
    agentIds: string[] | null;
}

export interface UseAnalyticsReturn {
    stats: AnalyticsStats | null;
    previousStats: AnalyticsStats | null;
    buttonStats: ButtonStats[];
    templateStats: TemplateStats[];
    agentStats: AgentStats[];
    dailyVolume: DailyVolume[];
    serviceMetrics: ServiceMetrics | null;
    closeReasons: CloseReasonStat[];
    heatmap: HeatmapCell[];
    channelVolume: ChannelVolume[];
    isLoading: boolean;
    error: string | null;
    refetch: () => void;
}

export function useAnalytics(params: UseAnalyticsParams): UseAnalyticsReturn {
    const [stats, setStats] = useState<AnalyticsStats | null>(null);
    const [previousStats, setPreviousStats] = useState<AnalyticsStats | null>(null);
    const [agentStats, setAgentStats] = useState<AgentStats[]>([]);
    const [dailyVolume, setDailyVolume] = useState<DailyVolume[]>([]);
    const [buttonStats, setButtonStats] = useState<ButtonStats[]>([]);
    const [templateStats, setTemplateStats] = useState<TemplateStats[]>([]);
    const [serviceMetrics, setServiceMetrics] = useState<ServiceMetrics | null>(null);
    const [closeReasons, setCloseReasons] = useState<CloseReasonStat[]>([]);
    const [heatmap, setHeatmap] = useState<HeatmapCell[]>([]);
    const [channelVolume, setChannelVolume] = useState<ChannelVolume[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        if (!params.orgId) return;

        setIsLoading(true);
        setError(null);

        // Preceding window of equal length (ends exactly at the current start).
        const startMs = new Date(params.startDate).getTime();
        const endMs = new Date(params.endDate).getTime();
        const durationMs = Math.max(endMs - startMs, 0);
        const prevEnd = new Date(startMs).toISOString();
        const prevStart = new Date(startMs - durationMs).toISOString();

        try {
            // Fetch all data in parallel
            // Note: Using 'as any' for RPC names until types are generated
            const [
                advancedStatsResult,
                previousStatsResult,
                agentResult,
                volumeResult,
                buttonResult,
                templateResult,
                serviceResult,
                closeReasonResult,
                heatmapResult,
                channelResult
            ] = await Promise.all([
                supabase.rpc("get_advanced_analytics_stats" as any, {
                    p_org_id: params.orgId,
                    p_start_date: params.startDate,
                    p_end_date: params.endDate,
                    p_phone_ids: params.phoneIds,
                    p_sector_ids: params.sectorIds,
                    p_agent_ids: params.agentIds,
                }),
                supabase.rpc("get_advanced_analytics_stats" as any, {
                    p_org_id: params.orgId,
                    p_start_date: prevStart,
                    p_end_date: prevEnd,
                    p_phone_ids: params.phoneIds,
                    p_sector_ids: params.sectorIds,
                    p_agent_ids: params.agentIds,
                }),
                supabase.rpc("get_agent_detailed_stats" as any, {
                    p_org_id: params.orgId,
                    p_start_date: params.startDate,
                    p_end_date: params.endDate,
                    p_phone_ids: params.phoneIds,
                    p_sector_ids: params.sectorIds,
                    p_agent_ids: params.agentIds,
                }),
                supabase.rpc("get_analytics_daily_volume" as any, {
                    p_org_id: params.orgId,
                    p_days: 30, // Could be dynamic based on date range difference
                    p_start_date: params.startDate,
                    p_end_date: params.endDate,
                    p_phone_ids: params.phoneIds,
                    p_sector_ids: params.sectorIds,
                    p_agent_ids: params.agentIds,
                }),
                supabase.rpc("get_button_click_stats" as any, {
                    p_org_id: params.orgId,
                    p_start_date: params.startDate,
                    p_end_date: params.endDate,
                    p_phone_ids: params.phoneIds,
                    p_sector_ids: params.sectorIds,
                    p_agent_ids: params.agentIds,
                }),
                supabase.rpc("get_template_stats" as any, {
                    p_org_id: params.orgId,
                    p_start_date: params.startDate,
                    p_end_date: params.endDate,
                }),
                supabase.rpc("get_service_metrics" as any, {
                    p_org_id: params.orgId,
                    p_start_date: params.startDate,
                    p_end_date: params.endDate,
                    p_phone_ids: params.phoneIds,
                    p_sector_ids: params.sectorIds,
                    p_agent_ids: params.agentIds,
                    p_sla_seconds: SLA_SECONDS,
                }),
                supabase.rpc("get_close_reason_stats" as any, {
                    p_org_id: params.orgId,
                    p_start_date: params.startDate,
                    p_end_date: params.endDate,
                    p_phone_ids: params.phoneIds,
                    p_sector_ids: params.sectorIds,
                    p_agent_ids: params.agentIds,
                }),
                supabase.rpc("get_hourly_heatmap" as any, {
                    p_org_id: params.orgId,
                    p_start_date: params.startDate,
                    p_end_date: params.endDate,
                    p_phone_ids: params.phoneIds,
                    p_sector_ids: params.sectorIds,
                    p_agent_ids: params.agentIds,
                }),
                supabase.rpc("get_channel_volume" as any, {
                    p_org_id: params.orgId,
                    p_start_date: params.startDate,
                    p_end_date: params.endDate,
                    p_phone_ids: params.phoneIds,
                    p_sector_ids: params.sectorIds,
                    p_agent_ids: params.agentIds,
                }),
            ]);

            if (advancedStatsResult.error) throw advancedStatsResult.error;
            if (agentResult.error) throw agentResult.error;
            if (volumeResult.error) throw volumeResult.error;
            if (buttonResult.error) throw buttonResult.error;
            if (templateResult.error) throw templateResult.error;
            if (serviceResult.error) throw serviceResult.error;
            if (closeReasonResult.error) throw closeReasonResult.error;
            if (heatmapResult.error) throw heatmapResult.error;
            if (channelResult.error) throw channelResult.error;

            // Stats is a single row
            const statsData = Array.isArray(advancedStatsResult.data)
                ? advancedStatsResult.data[0]
                : advancedStatsResult.data;

            const prevStatsData = Array.isArray(previousStatsResult.data)
                ? previousStatsResult.data[0]
                : previousStatsResult.data;

            const serviceData = Array.isArray(serviceResult.data)
                ? serviceResult.data[0]
                : serviceResult.data;

            setStats(statsData as unknown as AnalyticsStats || null);
            setPreviousStats((prevStatsData as unknown as AnalyticsStats) || null);
            setAgentStats((agentResult.data as unknown as AgentStats[]) || []);
            setDailyVolume((volumeResult.data as unknown as DailyVolume[]) || []);
            setButtonStats((buttonResult.data as unknown as ButtonStats[]) || []);
            setTemplateStats((templateResult.data as unknown as TemplateStats[]) || []);
            setServiceMetrics((serviceData as unknown as ServiceMetrics) || null);
            setCloseReasons((closeReasonResult.data as unknown as CloseReasonStat[]) || []);
            setHeatmap((heatmapResult.data as unknown as HeatmapCell[]) || []);
            setChannelVolume((channelResult.data as unknown as ChannelVolume[]) || []);

        } catch (err) {
            console.error("Error fetching analytics:", err);
            setError(err instanceof Error ? err.message : "Failed to fetch analytics");
        } finally {
            setIsLoading(false);
        }
    }, [params.orgId, params.startDate, params.endDate, params.phoneIds, params.sectorIds, params.agentIds]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    return {
        stats,
        previousStats,
        agentStats,
        dailyVolume,
        buttonStats,
        templateStats,
        serviceMetrics,
        closeReasons,
        heatmap,
        channelVolume,
        isLoading,
        error,
        refetch: fetchData,
    };
}
