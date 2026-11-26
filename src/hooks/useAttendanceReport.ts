import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
    BUSINESS_HOURS,
    IDLE_HOURS,
    UNANSWERED_HOURS,
    type AttendanceReport,
    type ConversationKind,
    type DateRange,
} from "@/lib/attendanceReport";

export interface UseAttendanceReportParams {
    orgId: string | undefined;
    phoneId: string | null;
    range: DateRange;
    kind: ConversationKind;
    agentId: string | null;
}

/**
 * Relatório de atendimentos de uma linha (RPC get_attendance_report).
 *
 * `keepPreviousData`: trocar o filtro mantém o painel anterior na tela (a
 * página o esmaece enquanto busca) em vez de piscar skeleton — o histórico
 * completo leva alguns segundos para calcular.
 */
export function useAttendanceReport({ orgId, phoneId, range, kind, agentId }: UseAttendanceReportParams) {
    const startIso = range.start.toISOString();
    const endIso = range.end.toISOString();

    return useQuery({
        queryKey: ["attendance-report", orgId, phoneId, startIso, endIso, kind, agentId],
        enabled: !!orgId && !!phoneId,
        placeholderData: keepPreviousData,
        staleTime: 2 * 60 * 1000,
        // Painel aberto numa tela de acompanhamento continua se atualizando
        refetchInterval: 5 * 60 * 1000,
        queryFn: async (): Promise<AttendanceReport> => {
            const { data, error } = await supabase.rpc("get_attendance_report", {
                p_org_id: orgId as string,
                p_phone_ids: [phoneId as string],
                p_start_date: startIso,
                p_end_date: endIso,
                p_agent_ids: agentId ? [agentId] : undefined,
                p_conversation_kind: kind,
                p_idle_hours: IDLE_HOURS,
                p_unanswered_hours: UNANSWERED_HOURS,
                p_business_start: BUSINESS_HOURS.start,
                p_business_end: BUSINESS_HOURS.end,
                p_business_days: [...BUSINESS_HOURS.days],
            });
            if (error) throw new Error(error.message);
            if (!data) throw new Error("Relatório vazio");
            return data as unknown as AttendanceReport;
        },
    });
}

export interface LineOption {
    id: string;
    label: string;
}

/** Linhas da organização, para o seletor. */
export function useAttendanceLines(orgId: string | undefined) {
    return useQuery({
        queryKey: ["attendance-lines", orgId],
        enabled: !!orgId,
        staleTime: 10 * 60 * 1000,
        queryFn: async (): Promise<LineOption[]> => {
            const { data, error } = await supabase
                .from("phone_numbers")
                .select("id, display_name, phone_number")
                .eq("organization_id", orgId as string)
                .order("display_name");
            if (error) throw new Error(error.message);
            return (data ?? []).map((line) => ({ id: line.id, label: line.display_name || line.phone_number }));
        },
    });
}

export interface AgentOption {
    id: string;
    label: string;
}

/**
 * Quem tem acesso à linha — as opções do filtro de atendente. Vem do acesso,
 * não do relatório: filtrar por uma atendente não pode encolher a lista.
 */
export function useLineAgents(phoneId: string | null) {
    return useQuery({
        queryKey: ["attendance-line-agents", phoneId],
        enabled: !!phoneId,
        staleTime: 10 * 60 * 1000,
        queryFn: async (): Promise<AgentOption[]> => {
            const { data: access, error } = await supabase
                .from("user_phone_numbers")
                .select("user_id")
                .eq("phone_number_id", phoneId as string);
            if (error) throw new Error(error.message);
            const ids = [...new Set((access ?? []).map((row) => row.user_id))];
            if (ids.length === 0) return [];

            const { data: profiles, error: profilesError } = await supabase
                .from("profiles")
                .select("id, full_name, email")
                .in("id", ids);
            if (profilesError) throw new Error(profilesError.message);
            return (profiles ?? [])
                .map((p) => ({ id: p.id, label: p.full_name || p.email || "Sem nome" }))
                .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
        },
    });
}
