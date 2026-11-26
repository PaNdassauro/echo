import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, RefreshCw, ShieldAlert } from "lucide-react";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionHealth, type HealthWindowDays } from "@/hooks/useConnectionHealth";
import { useQrServiceHealth } from "@/hooks/useQrServiceHealth";
import { classifyLineRisk, RISK_ORDER } from "@/lib/connectionRisk";
import { OpsKpis, type KpiItem } from "@/components/ops/OpsKpis";
import { LinesTable, type LineRow } from "@/components/ops/LinesTable";
import { ServiceBar } from "@/components/ops/ServiceBar";
import { ServiceDiagnostics } from "@/components/ops/ServiceDiagnostics";
import { ClosesChart } from "@/components/ops/ClosesChart";
import { EventsFeed } from "@/components/ops/EventsFeed";
import { RestrictedGroups } from "@/components/ops/RestrictedGroups";
import { relativeTime } from "@/components/ops/opsFormat";

const WINDOWS: HealthWindowDays[] = [7, 30, 90];
const DEFAULT_WINDOW: HealthWindowDays = 30;

function isWindow(value: string): value is `${HealthWindowDays}` {
    return WINDOWS.some((w) => String(w) === value);
}

/**
 * /ops — painel oculto (sem link na navegação) de conexão e bans das linhas QR.
 * Mesmo gate da RPC: admin da org ou super admin.
 *
 * Janela e linha selecionada vivem na URL: um plantão se compartilha por link
 * ("olha a linha X nos últimos 90 dias") e sobrevive a um F5.
 */
const Ops = () => {
    const navigate = useNavigate();
    const { currentOrganization, userRole, isSuperAdmin, isLoading: isOrgLoading } = useOrganization();
    const [searchParams, setSearchParams] = useSearchParams();

    const daysParam = searchParams.get("dias") ?? "";
    const days: HealthWindowDays = isWindow(daysParam) ? (Number(daysParam) as HealthWindowDays) : DEFAULT_WINDOW;
    const selectedId = searchParams.get("linha");

    const patchParams = (patch: Record<string, string | null>) => {
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                for (const [key, value] of Object.entries(patch)) {
                    if (value === null) next.delete(key);
                    else next.set(key, value);
                }
                return next;
            },
            { replace: true },
        );
    };

    const isAdmin = userRole === "admin" || isSuperAdmin;
    const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useConnectionHealth(currentOrganization?.id, days, isAdmin);
    const live = useQrServiceHealth(currentOrganization?.id, isAdmin);
    // undefined enquanto o serviço não respondeu: o classificador cai no log
    const liveSessions = live.data?.sessions;
    const liveCapping = live.data?.capping;
    const liveProviders = live.data?.providers;
    const registeredProviders = live.data?.registered_providers ?? [];

    const rows = useMemo<LineRow[]>(() => {
        if (!data) return [];
        const prospecting = new Map(data.prospecting.map((p) => [p.phone_number_id, p]));
        return data.lines
            .map((line) => {
                const serviceStatus = liveSessions === undefined ? undefined : liveSessions[line.id] ?? null;
                const capping = liveCapping?.[line.id];
                const liveProvider = liveProviders === undefined ? undefined : liveProviders[line.id] ?? null;
                return {
                    line,
                    prospecting: prospecting.get(line.id),
                    serviceStatus,
                    capping,
                    liveProvider,
                    risk: classifyLineRisk(line, prospecting.get(line.id), serviceStatus, Date.now(), capping),
                };
            })
            .sort((a, b) => RISK_ORDER[a.risk.level] - RISK_ORDER[b.risk.level] || (a.line.display_name ?? "").localeCompare(b.line.display_name ?? ""));
    }, [data, liveSessions, liveCapping, liveProviders]);

    const lineNames = useMemo(() => new Map(rows.map((r) => [r.line.id, r.line.display_name ?? r.line.phone_number ?? "—"])), [rows]);
    const selectedName = selectedId ? lineNames.get(selectedId) ?? null : null;

    const kpis = useMemo<KpiItem[]>(() => {
        const active = rows.filter((r) => r.line.is_active);
        const up = active.filter((r) => (r.serviceStatus === undefined ? r.line.last_event === "open" : r.serviceStatus === "connected")).length;
        const down = active.length - up;
        const conflicts7d = active.reduce((n, r) => n + r.line.conflicts_7d, 0);
        const forbidden = active.reduce((n, r) => n + r.line.forbidden, 0);
        const adds7d = active.reduce((n, r) => n + r.line.group_adds_7d, 0);
        const cappingWarn = active.filter((r) => r.capping && r.capping.status !== "NONE").length;
        const capped = active.filter((r) => r.capping?.status === "CAPPED").length;
        return [
            { label: "Conectadas", value: `${up}/${active.length}`, hint: liveSessions ? "ao vivo, pelo serviço" : "último evento = open", tone: down > 0 ? "bad" : "good" },
            { label: "Fora do ar", value: down, hint: liveSessions ? "sem sessão connected" : "último evento = close", tone: down > 0 ? "bad" : "default" },
            { label: "Conflicts 7d", value: conflicts7d, hint: "401/440 após add em grupo", tone: conflicts7d > 0 ? "bad" : "default" },
            { label: "403 na janela", value: forbidden, hint: "assinatura de ban", tone: forbidden > 0 ? "bad" : "default" },
            { label: "Adds em grupo 7d", value: adds7d, hint: "o que o anti-abuso vigia" },
            {
                label: "Cota de chats novos",
                value: capped > 0 ? `${capped} esgotada${capped > 1 ? "s" : ""}` : cappingWarn,
                hint: liveCapping ? (capped > 0 ? "contato frio recusado pelo WhatsApp" : "linhas com aviso de cota") : "sem dado do serviço",
                tone: capped > 0 ? "bad" : cappingWarn > 0 ? "default" : "good",
            },
        ];
    }, [rows, liveSessions, liveCapping]);

    if (isOrgLoading) {
        return (
            <div className="min-h-dvh bg-background">
                <div className="container mx-auto space-y-4 px-4 py-6">
                    <Skeleton className="h-8 w-64" />
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-64 w-full" />
                </div>
            </div>
        );
    }

    if (!isAdmin) {
        return (
            <div className="flex min-h-dvh items-center justify-center bg-background p-4">
                <Card className="max-w-md">
                    <CardContent className="space-y-3 p-6 text-center">
                        <ShieldAlert className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
                        <h1 className="text-lg font-semibold">Acesso restrito</h1>
                        <p className="text-sm text-muted-foreground">Este painel é só para administradores da organização.</p>
                        <Button variant="outline" onClick={() => navigate("/dashboard")}>Voltar</Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="min-h-dvh bg-background">
            <header className="sticky top-0 z-10 border-b bg-card safe-area-top">
                <div className="container mx-auto flex items-center justify-between gap-3 px-4 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                        {/* /ops não tem link na navegação: sem este botão, o celular fica sem saída. */}
                        <Button variant="ghost" size="icon" aria-label="Voltar" onClick={() => navigate("/dashboard")}>
                            <ArrowLeft className="h-4 w-4" />
                        </Button>
                        <div className="min-w-0">
                            <h1 className="truncate text-lg font-bold sm:text-xl">Conexão &amp; bans</h1>
                            <p className="truncate text-xs text-muted-foreground">
                                {currentOrganization?.name}
                                {dataUpdatedAt ? ` · atualizado ${relativeTime(new Date(dataUpdatedAt).toISOString())}, sozinho a cada 60s` : ""}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Select value={String(days)} onValueChange={(v) => { if (isWindow(v)) patchParams({ dias: v }); }}>
                            <SelectTrigger className="h-9 w-[110px]" aria-label="Janela">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {WINDOWS.map((w) => (
                                    <SelectItem key={w} value={String(w)}>{w} dias</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Button variant="outline" size="sm" onClick={() => { void refetch(); void live.refetch(); }} disabled={isFetching || live.isFetching} aria-label="Atualizar">
                            <RefreshCw className={isFetching || live.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                            <span className="ml-2 hidden sm:inline">Atualizar</span>
                        </Button>
                    </div>
                </div>
            </header>

            <main className="container mx-auto space-y-4 px-4 py-4 sm:space-y-6 sm:py-6">
                {error && (
                    <Card className="border-destructive/40">
                        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                            <span>Falha ao carregar: {error.message}</span>
                            <Button size="sm" variant="outline" onClick={() => void refetch()}>Tentar novamente</Button>
                        </CardContent>
                    </Card>
                )}

                <ServiceBar health={live.data} error={live.error} isLoading={live.isLoading} onRetry={() => void live.refetch()} />

                <ServiceDiagnostics health={live.data} lineNames={lineNames} />

                <OpsKpis items={kpis} isLoading={isLoading} />

                <LinesTable
                    rows={rows}
                    isLoading={isLoading}
                    selectedId={selectedId}
                    onSelect={(id) => patchParams({ linha: id })}
                    windowDays={days}
                    organizationId={currentOrganization?.id}
                    registeredProviders={registeredProviders}
                />

                <RestrictedGroups groups={data?.restricted_groups ?? []} lineNames={lineNames} selectedId={selectedId} />

                <div className="grid gap-4 sm:gap-6 xl:grid-cols-5">
                    <div className="xl:col-span-3">
                        <ClosesChart daily={data?.daily ?? []} isLoading={isLoading} selectedId={selectedId} selectedName={selectedName} />
                    </div>
                    <div className="xl:col-span-2">
                        <EventsFeed events={data?.events ?? []} lineNames={lineNames} isLoading={isLoading} selectedId={selectedId} />
                    </div>
                </div>
            </main>
        </div>
    );
};

export default Ops;
