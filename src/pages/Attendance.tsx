import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { format, parseISO } from "date-fns";
import { ArrowLeft, ClipboardList, RefreshCw, Download, Loader2 } from "lucide-react";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useIsMobile } from "@/hooks/use-mobile";
import { useToast } from "@/hooks/use-toast";
import { useAttendanceLines, useAttendanceReport, useLineAgents } from "@/hooks/useAttendanceReport";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BottomNavigation } from "@/components/layout";
import { AttendanceFilters } from "@/components/attendance/AttendanceFilters";
import { AttendanceKpis } from "@/components/attendance/AttendanceKpis";
import { OutcomeBreakdown } from "@/components/attendance/OutcomeBreakdown";
import { AttendanceTrendChart } from "@/components/attendance/AttendanceTrendChart";
import { AttendanceHourChart } from "@/components/attendance/AttendanceHourChart";
import { AgentAttendanceTable } from "@/components/attendance/AgentAttendanceTable";
import { PendingAttendanceList } from "@/components/attendance/PendingAttendanceList";
import { AttendanceMethodology } from "@/components/attendance/AttendanceMethodology";
import { cn } from "@/lib/utils";
import {
    IDLE_HOURS,
    KIND_OPTIONS,
    UNANSWERED_HOURS,
    buildSeries,
    chooseBucket,
    dateFromParam,
    dateToParam,
    fillHours,
    kindFromParam,
    kindToParam,
    periodFromParam,
    periodToParam,
    pickLine,
    resolvePeriod,
    type ConversationKind,
    type DateRange,
    type PeriodPreset,
} from "@/lib/attendanceReport";

/**
 * Painel de atendimentos de uma linha: quantos, como terminaram, fora do
 * horário, tempo e quem atendeu. A definição de atendimento mora na RPC
 * get_attendance_report; esta página só filtra e mostra.
 */
const Attendance = () => {
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    const { toast } = useToast();
    const { currentOrganization, userRole, isLoading: isOrgLoading } = useOrganization();
    const [params, setParams] = useSearchParams();
    const [isExporting, setIsExporting] = useState(false);

    const preset = periodFromParam(params.get("periodo"));
    const customStart = params.get("de");
    const customEnd = params.get("ate");
    const kind = kindFromParam(params.get("tipo"));
    const agentId = params.get("atendente");

    // Recalcula na virada do dia (a chave da query muda junto); dentro do dia é estável
    const today = format(new Date(), "yyyy-MM-dd");
    const range = useMemo(
        () => resolvePeriod(preset, new Date(), { start: dateFromParam(customStart) ?? undefined, end: dateFromParam(customEnd) ?? undefined }),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `today` invalida o memo à meia-noite
        [preset, customStart, customEnd, today],
    );

    const linesQuery = useAttendanceLines(currentOrganization?.id);
    const line = pickLine(linesQuery.data ?? [], params.get("linha"));
    const agentsQuery = useLineAgents(line?.id ?? null);

    const report = useAttendanceReport({
        orgId: currentOrganization?.id,
        phoneId: line?.id ?? null,
        range,
        kind,
        agentId,
    });
    const data = report.data;

    const updateParams = (patch: Record<string, string | null>) => {
        const next = new URLSearchParams(params);
        for (const [key, value] of Object.entries(patch)) {
            if (value === null) next.delete(key);
            else next.set(key, value);
        }
        setParams(next, { replace: true });
    };

    const setPreset = (value: Exclude<PeriodPreset, "custom">) =>
        updateParams({ periodo: periodToParam(value), de: null, ate: null });
    const setCustomRange = (value: DateRange) =>
        updateParams({ periodo: periodToParam("custom"), de: dateToParam(value.start), ate: dateToParam(value.end) });
    const setKind = (value: ConversationKind) => updateParams({ tipo: kindToParam(value) });
    const setAgent = (value: string | null) => updateParams({ atendente: value });
    // Trocar de linha zera a atendente: ela pode nem atender a outra linha
    const setLine = (value: string) => updateParams({ linha: value, atendente: null });

    // No "Histórico" o gráfico começa na primeira mensagem da linha, não em 2020
    const seriesRange = useMemo<DateRange>(() => {
        const first = data?.meta.first_message_at ? parseISO(data.meta.first_message_at) : null;
        return preset === "all" && first ? { start: first, end: range.end } : range;
    }, [preset, range, data?.meta.first_message_at]);
    const bucket = chooseBucket(seriesRange);
    const series = useMemo(
        () => (data ? buildSeries(data.by_day, seriesRange, bucket) : []),
        [data, seriesRange, bucket],
    );
    const hours = useMemo(() => fillHours(data?.by_hour ?? []), [data?.by_hour]);

    const selectedAgentLabel = agentId
        ? (agentsQuery.data?.find((a) => a.id === agentId)?.label ??
          data?.by_agent.find((a) => a.agent_id === agentId)?.agent_name ??
          "Atendente selecionada")
        : null;

    const handleExport = async () => {
        if (!data || !line) return;
        setIsExporting(true);
        try {
            const { exportAttendanceToXlsx } = await import("@/lib/attendanceExportClient");
            const fileName = await exportAttendanceToXlsx(data, {
                lineName: line.label,
                range: seriesRange,
                kindLabel: KIND_OPTIONS.find((o) => o.value === kind)?.label ?? "Todas as conversas",
                agentLabel: selectedAgentLabel,
            });
            toast({ title: "Planilha exportada", description: fileName });
        } catch (err) {
            console.error("Erro ao exportar atendimentos:", err);
            toast({ title: "Não foi possível exportar", description: "Tente novamente.", variant: "destructive" });
        } finally {
            setIsExporting(false);
        }
    };

    const header = (
        <header className="border-b bg-card sticky top-0 z-10 safe-area-top">
            <div className="container mx-auto px-4 py-3 sm:py-4 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 sm:gap-4 min-w-0">
                    {!isMobile && (
                        <Button variant="ghost" size="icon" onClick={() => navigate("/analytics")} aria-label="Voltar para Relatórios">
                            <ArrowLeft className="h-5 w-5" />
                        </Button>
                    )}
                    <div className="flex items-center gap-2 min-w-0">
                        <ClipboardList className="h-5 w-5 sm:h-6 sm:w-6 text-primary shrink-0" />
                        <h1 className="text-lg sm:text-xl font-bold truncate">Atendimentos</h1>
                        {line && <span className="hidden sm:inline text-sm text-muted-foreground truncate">· {line.label}</span>}
                    </div>
                </div>
                {userRole === "admin" && (
                    <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                        <AttendanceMethodology idleHours={IDLE_HOURS} unansweredHours={UNANSWERED_HOURS} />
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleExport}
                            disabled={!data || isExporting}
                            className="gap-2"
                            aria-label="Exportar planilha"
                        >
                            {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                            <span className="hidden sm:inline">Exportar</span>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => report.refetch()}
                            disabled={report.isFetching}
                            className="gap-2"
                            aria-label="Atualizar"
                        >
                            <RefreshCw className={cn("h-4 w-4", report.isFetching && "animate-spin")} />
                            <span className="hidden sm:inline">Atualizar</span>
                        </Button>
                    </div>
                )}
            </div>
        </header>
    );

    // Papel ainda resolvendo: sem este gate o card de "só administradores" piscaria
    if (isOrgLoading) {
        return (
            <div className="min-h-dvh bg-background">
                {header}
                <main className="container mx-auto px-4 pt-4 sm:pt-6 space-y-4">
                    <Skeleton className="h-14 rounded-lg" />
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        {Array.from({ length: 4 }, (_, i) => (
                            <Skeleton key={i} className="h-28 rounded-lg" />
                        ))}
                    </div>
                </main>
                {isMobile && <BottomNavigation />}
            </div>
        );
    }

    if (userRole !== "admin") {
        return (
            <div className="min-h-dvh bg-background flex items-center justify-center">
                <Card className="max-w-md mx-4 border-border bg-card shadow-sm">
                    <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
                        <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                            <ClipboardList className="h-6 w-6 text-primary" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold">Área de Gestão</h2>
                            <p className="text-muted-foreground mt-1 text-sm">
                                O painel de atendimentos está disponível apenas para administradores.
                            </p>
                        </div>
                        <Button variant="outline" onClick={() => navigate("/dashboard")}>
                            <ArrowLeft className="h-4 w-4 mr-2" />
                            Voltar ao Dashboard
                        </Button>
                    </CardContent>
                </Card>
                {isMobile && <BottomNavigation />}
            </div>
        );
    }

    const firstLoad = report.isLoading || (!data && !report.error);
    const noLines = linesQuery.isSuccess && (linesQuery.data?.length ?? 0) === 0;

    return (
        <div className="min-h-dvh bg-background">
            {header}

            <main className={`container mx-auto px-4 pt-4 sm:pt-6 space-y-4 sm:space-y-6 ${isMobile ? "pb-bottom-nav" : "pb-6"}`}>
                <AttendanceFilters
                    lines={linesQuery.data ?? []}
                    lineId={line?.id ?? null}
                    onLineChange={setLine}
                    preset={preset}
                    range={range}
                    onPresetChange={setPreset}
                    onCustomRange={setCustomRange}
                    kind={kind}
                    onKindChange={setKind}
                    agents={agentsQuery.data ?? []}
                    agentId={agentId}
                    onAgentChange={setAgent}
                />

                {noLines ? (
                    <div className="h-[200px] flex items-center justify-center text-muted-foreground border-2 border-dashed rounded-lg">
                        Nenhuma linha de WhatsApp nesta organização
                    </div>
                ) : report.error && !data ? (
                    <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
                        <p className="text-destructive text-sm">Erro ao carregar o painel: {report.error.message}</p>
                        <Button variant="outline" size="sm" onClick={() => report.refetch()} className="gap-2 self-start sm:self-auto">
                            <RefreshCw className="h-4 w-4" />
                            Tentar novamente
                        </Button>
                    </div>
                ) : (
                    // Refetch mantém o painel anterior esmaecido em vez de piscar skeleton
                    <div
                        className={cn(
                            "space-y-4 sm:space-y-6 transition-opacity duration-200",
                            report.isFetching && !firstLoad && "opacity-60",
                        )}
                        aria-busy={report.isFetching}
                    >
                        <AttendanceKpis
                            summary={data?.summary}
                            idleHours={IDLE_HOURS}
                            unansweredHours={UNANSWERED_HOURS}
                            isLoading={firstLoad}
                        />

                        {/* min-w-0 nos itens: item de grid não encolhe abaixo do conteúdo, e
                            nome longo de contato empurrava a página para o lado no celular */}
                        <div className="grid gap-4 sm:gap-6 lg:grid-cols-5 [&>*]:min-w-0">
                            <div className="lg:col-span-3">
                                <OutcomeBreakdown summary={data?.summary} idleHours={IDLE_HOURS} isLoading={firstLoad} />
                            </div>
                            <div className="lg:col-span-2 lg:row-span-2">
                                <PendingAttendanceList rows={data?.pending ?? []} isLoading={firstLoad} />
                            </div>
                            <div className="lg:col-span-3">
                                {firstLoad ? (
                                    <Skeleton className="h-[340px] rounded-lg" />
                                ) : series.length > 1 ? (
                                    <AttendanceTrendChart series={series} bucket={bucket} />
                                ) : (
                                    <AttendanceHourChart hours={hours} />
                                )}
                            </div>
                        </div>

                        <AgentAttendanceTable
                            rows={data?.by_agent ?? []}
                            isLoading={firstLoad}
                            selectedAgentId={agentId}
                            onSelectAgent={setAgent}
                        />

                        {/* Num dia só, o gráfico por hora já ocupou o lugar do de tendência */}
                        {!firstLoad && series.length > 1 && <AttendanceHourChart hours={hours} />}
                    </div>
                )}
            </main>

            {isMobile && <BottomNavigation />}
        </div>
    );
};

export default Attendance;
