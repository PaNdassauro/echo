import { useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { ConnectionLine, ProspectingRow } from "@/hooks/useConnectionHealth";
import type { LineCapping, LiveProvider } from "@/hooks/useQrServiceHealth";
import type { LineRisk } from "@/lib/connectionRisk";
import { RiskBadge } from "./RiskBadge";
import { ProviderSwitch } from "./ProviderSwitch";
import { closeLabel, relativeTime, shortDateTime } from "./opsFormat";

export interface LineRow {
    line: ConnectionLine;
    prospecting: ProspectingRow | undefined;
    risk: LineRisk;
    /** undefined = serviço não consultado; null = linha ausente do serviço */
    serviceStatus: string | null | undefined;
    /** Cota de conversas novas ao vivo; undefined = a sessão nunca informou */
    capping: LineCapping | undefined;
    /** Provider da sessão viva; undefined = serviço não consultado; null = sem sessão */
    liveProvider: LiveProvider | null | undefined;
}

function CappingCell({ capping }: { capping: LineCapping | undefined }) {
    if (!capping) return <span className="text-muted-foreground/60">—</span>;
    const capped = capping.status === "CAPPED";
    const warn = !capped && capping.status !== "NONE";
    // Linha sem cota imposta responde à sonda com NONE e 0/0 — mostrar "0/0" leria
    // como "zero de zero disponível". Sem ciclo real o timestamp vem na época (1970).
    const semCota = !capping.total_quota;
    const quota = semCota ? null : `${capping.used_quota ?? "?"}/${capping.total_quota}`;
    const cycleEnd = capping.cycle_end ? new Date(capping.cycle_end) : null;
    const until = cycleEnd && cycleEnd.getUTCFullYear() > 2000 ? `ciclo até ${shortDateTime(capping.cycle_end!)}` : "";
    return (
        <span
            className={cn("tabular-nums text-sm", capped && "font-semibold text-red-600 dark:text-red-400", warn && "text-orange-600 dark:text-orange-400")}
            title={`${capping.status}${until ? ` · ${until}` : ""} · ${capping.source === "probe" ? "consultado ao conectar" : "notificado pelo WhatsApp"}`}
        >
            {quota ?? (semCota && !warn && !capped ? "—" : capping.status.toLowerCase().replace(/_/g, " "))}
            {capped && quota ? " esgotada" : ""}
        </span>
    );
}

/** O id da linha é o que se cola no SQL de diagnóstico; não aparecia em lugar nenhum da UI. */
function CopyId({ id }: { id: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            aria-label="Copiar id da linha"
            title={`Copiar ${id}`}
            className="rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(e) => {
                e.stopPropagation();
                void navigator.clipboard.writeText(id).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                });
            }}
            onKeyDown={(e) => e.stopPropagation()}
        >
            {copied ? <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-3 w-3" />}
        </button>
    );
}

interface LinesTableProps {
    rows: LineRow[];
    isLoading: boolean;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    windowDays: number;
    organizationId: string | undefined;
    /** Providers aceitos pelo serviço (vazio = lista fixa). */
    registeredProviders: readonly string[];
}

function Num({ value, warnAt, title }: { value: number; warnAt?: number; title?: string }) {
    const hot = warnAt !== undefined && value >= warnAt;
    return (
        <span
            title={title}
            className={cn("tabular-nums", value === 0 && "text-muted-foreground/60", hot && "font-semibold text-red-600 dark:text-red-400")}
        >
            {value}
        </span>
    );
}

export function LinesTable({ rows, isLoading, selectedId, onSelect, windowDays, organizationId, registeredProviders }: LinesTableProps) {
    const selectedName = rows.find((r) => r.line.id === selectedId)?.line.display_name ?? null;

    return (
        <Card className="border-border bg-card shadow-sm">
            <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <CardTitle className="text-base font-semibold">Linhas QR</CardTitle>
                    {selectedId && (
                        <Button size="sm" variant="outline" className="h-7" onClick={() => onSelect(null)}>
                            <X className="mr-1.5 h-3 w-3" aria-hidden />
                            Limpar filtro{selectedName ? `: ${selectedName}` : ""}
                        </Button>
                    )}
                </div>
                <p className="text-xs text-muted-foreground">
                    Clique numa linha para filtrar o gráfico e os eventos. Contadores na janela de {windowDays} dias, salvo indicação.
                </p>
            </CardHeader>
            <CardContent className="p-0">
                {isLoading ? (
                    <div className="space-y-2 p-4">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <Skeleton key={i} className="h-9 w-full" />
                        ))}
                    </div>
                ) : rows.length === 0 ? (
                    <p className="px-4 pb-4 text-sm text-muted-foreground">
                        Nenhuma linha QR nesta organização. O painel só acompanha números conectados por QR code.
                    </p>
                ) : (
                    <Table role="grid">
                        <TableHeader>
                            <TableRow className="hover:bg-transparent">
                                <TableHead className="sticky left-0 z-20 bg-card">Linha</TableHead>
                                <TableHead>Estado</TableHead>
                                <TableHead>Serviço</TableHead>
                                <TableHead>Lib</TableHead>
                                <TableHead>Último evento</TableHead>
                                <TableHead className="text-right">Quedas 24h</TableHead>
                                <TableHead className="text-right">Conflicts 7d</TableHead>
                                <TableHead className="text-right">403</TableHead>
                                <TableHead className="text-right">Adds grupo 7d</TableHead>
                                <TableHead className="text-right">Cota chats novos</TableHead>
                                <TableHead className="text-right">Prospecção 7d</TableHead>
                                <TableHead>Último inbound</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map(({ line, prospecting, risk, serviceStatus, capping, liveProvider }) => {
                                const selected = selectedId === line.id;
                                const started = prospecting?.started_by_us_7d ?? 0;
                                const unanswered = prospecting?.unanswered_7d ?? 0;
                                const novas = prospecting?.new_conversations_7d ?? 0;
                                const isDown = risk.level === "down" || risk.level === "banned";
                                // qr_session_status é escrito pelo webhook e envelhece; o serviço é a verdade.
                                const dbConnected = line.qr_session_status === "connected";
                                const divergent = serviceStatus !== undefined && dbConnected !== (serviceStatus === "connected");
                                return (
                                    <TableRow
                                        key={line.id}
                                        tabIndex={0}
                                        aria-selected={selected}
                                        onClick={() => onSelect(selected ? null : line.id)}
                                        onKeyDown={(e) => {
                                            if (e.target !== e.currentTarget) return;
                                            if (e.key === "Enter" || e.key === " ") {
                                                e.preventDefault();
                                                onSelect(selected ? null : line.id);
                                            }
                                        }}
                                        className={cn(
                                            "cursor-pointer bg-card transition-colors hover:bg-muted",
                                            "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                                            selected && "bg-accent hover:bg-accent",
                                            !line.is_active && "opacity-60",
                                        )}
                                    >
                                        <TableCell className="sticky left-0 z-10 bg-inherit font-medium">
                                            <div className="leading-tight">{line.display_name ?? "—"}</div>
                                            <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                                <span className="tabular-nums">{line.phone_number ?? ""}</span>
                                                <CopyId id={line.id} />
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <RiskBadge risk={risk} />
                                        </TableCell>
                                        <TableCell>
                                            <span
                                                className={cn(
                                                    "font-mono text-xs",
                                                    serviceStatus === undefined && "text-muted-foreground/60",
                                                    serviceStatus === null && "text-red-600 dark:text-red-400",
                                                    serviceStatus === "connected" && "text-emerald-600 dark:text-emerald-400",
                                                )}
                                                title={serviceStatus === undefined ? "serviço não consultado" : serviceStatus === null ? "sem sessão no serviço" : "status no SessionManager"}
                                            >
                                                {serviceStatus === undefined ? "—" : serviceStatus === null ? "ausente" : serviceStatus}
                                            </span>
                                            {divergent && (
                                                <div
                                                    className="text-[11px] text-orange-600 dark:text-orange-400"
                                                    title="qr_session_status no banco discorda do serviço. O serviço é a verdade; o banco envelhece."
                                                >
                                                    banco: {line.qr_session_status ?? "—"}
                                                </div>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            <ProviderSwitch
                                                organizationId={organizationId}
                                                phoneNumberId={line.id}
                                                lineName={line.display_name ?? line.phone_number ?? line.id}
                                                db={line.qr_provider}
                                                live={liveProvider === undefined ? undefined : liveProvider?.provider ?? null}
                                                libraryId={liveProvider?.libraryId}
                                                serviceStatus={serviceStatus}
                                                registered={registeredProviders}
                                            />
                                        </TableCell>
                                        <TableCell>
                                            <div className="text-sm leading-tight">
                                                {line.last_event === null ? "—" : line.last_event === "open" ? "open" : closeLabel(line.last_status_code, line.last_reason)}
                                            </div>
                                            <div className="text-xs text-muted-foreground" title={shortDateTime(line.last_event_at)}>
                                                {relativeTime(line.last_event_at)}
                                            </div>
                                            {isDown && line.last_open_at && (
                                                <div className="text-xs text-muted-foreground/70" title={shortDateTime(line.last_open_at)}>
                                                    último open {relativeTime(line.last_open_at)}
                                                </div>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Num value={line.closes_24h} warnAt={15} title={`${line.closes} quedas na janela de ${windowDays} dias`} />
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Num value={line.conflicts_7d} warnAt={1} title={`${line.conflicts} conflicts na janela de ${windowDays} dias`} />
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Num value={line.forbidden} warnAt={1} title={line.last_forbidden_at ? `último 403 em ${shortDateTime(line.last_forbidden_at)}` : "nenhum 403 na janela"} />
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Num value={line.group_adds_7d} warnAt={10} title={`${line.group_adds} adds na janela de ${windowDays} dias`} />
                                        </TableCell>
                                        <TableCell className="text-right"><CappingCell capping={capping} /></TableCell>
                                        <TableCell className="text-right">
                                            <span className="tabular-nums" title={`iniciadas por nós / sem resposta — de ${novas} conversas novas em 7d`}>
                                                <Num value={started} warnAt={15} />
                                                <span className="text-muted-foreground"> / </span>
                                                <Num value={unanswered} />
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-sm text-muted-foreground" title={shortDateTime(line.last_inbound_at)}>
                                            {relativeTime(line.last_inbound_at)}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    );
}
