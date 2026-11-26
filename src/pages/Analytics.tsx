import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, TrendingUp, RefreshCw, LayoutDashboard, LayoutTemplate, Sparkles, Headphones, CalendarClock, ClipboardList } from "lucide-react";
import { useAnalyticsFilters } from "@/hooks/useAnalyticsFilters";
import { useAnalytics } from "@/hooks/useAnalytics";
import { AnalyticsFilters } from "@/components/analytics/AnalyticsFilters";
import { AnalyticsKPICards } from "@/components/analytics/AnalyticsKPICards";
import { CostProjectionCard } from "@/components/analytics/CostProjectionCard";
import { MessageVolumeChart } from "@/components/analytics/MessageVolumeChart";
import { AgentStatsTable } from "@/components/analytics/AgentStatsTable";
import { ServiceMetricsCards } from "@/components/analytics/ServiceMetricsCards";
import { CloseReasonsChart } from "@/components/analytics/CloseReasonsChart";
import { DemandHeatmap } from "@/components/analytics/DemandHeatmap";
import { ChannelVolumeChart } from "@/components/analytics/ChannelVolumeChart";
import { AgentLoadChart } from "@/components/analytics/AgentLoadChart";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TemplatesTable } from "@/components/analytics/TemplatesTable";
import { ButtonClicksTable } from "@/components/analytics/ButtonClicksTable";
import { AIConfigurationModal } from "@/components/analytics/AIConfigurationModal";
import { AIInsights } from "@/components/analytics/AIInsights";
import { useIsMobile } from "@/hooks/use-mobile";
import { BottomNavigation } from "@/components/layout";

const Analytics = () => {
    const navigate = useNavigate();
    const { currentOrganization, userRole, isLoading: isOrgLoading } = useOrganization();
    const isMobile = useIsMobile();
    // Controlada: o bloco de erro desmonta as Tabs; sem estado no pai, o
    // "Tentar novamente" jogava o usuário de volta pra Visão Geral
    const [activeTab, setActiveTab] = useState("overview");

    const {
        filters,
        setDateRange,
        setPhoneIds,
        setSectorIds,
        setAgentIds,
        resetFilters,
        filtersForRPC,
    } = useAnalyticsFilters();

    const {
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
        refetch
    } = useAnalytics({
        orgId: currentOrganization?.id || "",
        startDate: filtersForRPC.start_date,
        endDate: filtersForRPC.end_date,
        phoneIds: filtersForRPC.phone_ids,
        sectorIds: filtersForRPC.sector_ids,
        agentIds: filtersForRPC.agent_ids,
    });

    const handleResetFilters = () => {
        resetFilters();
    };

    // Admin-only access check
    const isAdmin = userRole === "admin";

    // O contexto ainda está resolvendo o papel: sem este gate, TODO admin via
    // o card de "apenas administradores" piscar em cada load da página
    if (isOrgLoading) {
        return (
            <div className="min-h-dvh bg-background">
                <header className="border-b bg-card sticky top-0 z-10 safe-area-top">
                    <div className="container mx-auto px-4 py-4 flex items-center gap-2">
                        <TrendingUp className="h-5 w-5 sm:h-6 sm:w-6 text-primary" />
                        <h1 className="text-lg sm:text-xl font-bold">Analytics</h1>
                    </div>
                </header>
                <main className="container mx-auto px-4 pt-4 sm:pt-6 space-y-4">
                    <Skeleton className="h-12 rounded-lg" />
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        {Array.from({ length: 4 }, (_, i) => (
                            <Skeleton key={i} className="h-28 rounded-lg" />
                        ))}
                    </div>
                    <Skeleton className="h-64 rounded-lg" />
                </main>
                {isMobile && <BottomNavigation />}
            </div>
        );
    }

    if (!isAdmin) {
        return (
            <div className="min-h-dvh bg-background flex items-center justify-center">
                <Card className="max-w-md mx-4 border-border bg-card shadow-sm">
                    <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
                        <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                            <TrendingUp className="h-6 w-6 text-primary" />
                        </div>
                        <div>
                            <h2 className="text-base sm:text-lg font-semibold">
                                Área de gestão
                            </h2>
                            <p className="text-muted-foreground mt-1 text-sm">
                                O módulo de Analytics está disponível apenas para administradores.
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

    return (
        <div className="min-h-dvh bg-background">
            {/* Header */}
            <header className="border-b bg-card sticky top-0 z-10 safe-area-top">
                <div className="container mx-auto px-4 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-2 sm:gap-4">
                        {!isMobile && (
                            <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")} aria-label="Voltar">
                                <ArrowLeft className="h-5 w-5" />
                            </Button>
                        )}
                        <div className="flex items-center gap-2">
                            <TrendingUp className="h-5 w-5 sm:h-6 sm:w-6 text-primary" />
                            <h1 className="text-lg sm:text-xl font-bold">Analytics</h1>
                        </div>
                        {!isMobile && currentOrganization && (
                            <span className="text-sm text-muted-foreground">
                                {currentOrganization.name}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => navigate("/atendimentos")}
                            className="gap-2"
                            aria-label="Painel de atendimentos"
                        >
                            <ClipboardList className="h-4 w-4" />
                            <span className="hidden sm:inline">Atendimentos</span>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={refetch}
                            disabled={isLoading}
                            className="gap-2"
                            aria-label="Atualizar"
                        >
                            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
                            <span className="hidden sm:inline">Atualizar</span>
                        </Button>
                    </div>
                </div>
            </header>

            <main className={`container mx-auto px-4 pt-4 sm:pt-6 space-y-4 sm:space-y-6 ${isMobile ? "pb-bottom-nav" : "pb-4 sm:pb-6"}`}>

                {/* Filters */}
                <AnalyticsFilters
                    dateRange={{ from: filters.startDate, to: filters.endDate }}
                    onDateRangeChange={setDateRange}
                    selectedPhones={filters.phoneIds}
                    onPhonesChange={setPhoneIds}
                    selectedSectors={filters.sectorIds}
                    onSectorsChange={setSectorIds}
                    selectedAgents={filters.agentIds}
                    onAgentsChange={setAgentIds}
                    onReset={handleResetFilters}
                />

                {/* Error State — com retry; os "sem dados" abaixo ficam suprimidos
                    para o erro não se disfarçar de período vazio */}
                {error && (
                    <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
                        <p className="text-destructive text-sm">Erro ao carregar dados: {error}</p>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={refetch}
                            disabled={isLoading}
                            className="gap-2 shrink-0 self-start sm:self-auto"
                        >
                            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
                            Tentar novamente
                        </Button>
                    </div>
                )}

                {/* Tabs */}
                {!error && (
                <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
                    {/* justify-start quando w-full: com justify-center num scroll
                        container, o overflow do lado esquerdo fica inalcançável */}
                    <TabsList className="w-full sm:w-auto overflow-x-auto justify-start sm:justify-center">
                        <TabsTrigger value="overview" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm">
                            <LayoutDashboard className="h-4 w-4" />
                            <span className="hidden xs:inline">Visão Geral</span><span className="xs:hidden">Geral</span>
                        </TabsTrigger>
                        <TabsTrigger value="service" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm">
                            <Headphones className="h-4 w-4" />
                            Atendimento
                        </TabsTrigger>
                        <TabsTrigger value="demand" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm">
                            <CalendarClock className="h-4 w-4" />
                            Demanda
                        </TabsTrigger>
                        <TabsTrigger value="templates" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm">
                            <LayoutTemplate className="h-4 w-4" />
                            Templates
                        </TabsTrigger>
                        <TabsTrigger value="insights" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm">
                            <Sparkles className="h-4 w-4" />
                            <span className="hidden xs:inline">AI Insights</span><span className="xs:hidden">Insights</span>
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="overview" className="space-y-4 sm:space-y-6">
                        {/* KPI Cards (com comparação vs período anterior) */}
                        <AnalyticsKPICards
                            stats={stats}
                            previous={previousStats}
                            isLoading={isLoading}
                        />

                        {/* Projeção de custo do mês (só aparece no mês corrente) */}
                        <CostProjectionCard
                            stats={stats}
                            startDate={filtersForRPC.start_date}
                            endDate={filtersForRPC.end_date}
                            isLoading={isLoading}
                        />

                        {/* Chart */}
                        <MessageVolumeChart data={dailyVolume} isLoading={isLoading} />

                        {/* Agent Stats Table */}
                        <AgentStatsTable data={agentStats} isLoading={isLoading} />
                    </TabsContent>

                    <TabsContent value="service" className="space-y-4 sm:space-y-6">
                        <ServiceMetricsCards metrics={serviceMetrics} isLoading={isLoading} />
                        <CloseReasonsChart data={closeReasons} isLoading={isLoading} />
                    </TabsContent>

                    <TabsContent value="demand" className="space-y-4 sm:space-y-6">
                        <DemandHeatmap data={heatmap} isLoading={isLoading} />
                        <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
                            <ChannelVolumeChart data={channelVolume} isLoading={isLoading} />
                            <AgentLoadChart data={agentStats} isLoading={isLoading} />
                        </div>
                    </TabsContent>

                    <TabsContent value="templates" className="space-y-4 sm:space-y-6">
                        <TemplatesTable data={templateStats} isLoading={isLoading} />

                        {/* Button Clicks Table (Non-template generic clicks) */}
                        <ButtonClicksTable data={buttonStats} isLoading={isLoading} />
                    </TabsContent>

                    <TabsContent value="insights" className="space-y-4 sm:space-y-6">
                        <div className="flex justify-end mb-4">
                            <AIConfigurationModal orgId={currentOrganization?.id || ""} />
                        </div>
                        <AIInsights
                            orgId={currentOrganization?.id || ""}
                            startDate={filtersForRPC.start_date}
                            endDate={filtersForRPC.end_date}
                        />
                    </TabsContent>
                </Tabs>
                )}
            </main>

            {isMobile && <BottomNavigation />}
        </div>
    );
};

export default Analytics;
