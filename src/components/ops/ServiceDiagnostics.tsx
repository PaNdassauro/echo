import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { QrServiceHealth } from "@/hooks/useQrServiceHealth";
import { formatMs, formatUptime, relativeTime } from "./opsFormat";

interface ServiceDiagnosticsProps {
    health: QrServiceHealth | undefined;
    lineNames: Map<string, string>;
}

const LIMIT_LABELS: Record<string, string> = {
    send_spacing_enabled: "Espaçamento de envio",
    send_min_gap_ms: "Intervalo mínimo entre envios",
    send_max_gap_ms: "Intervalo máximo entre envios",
    send_max_queue_wait_ms: "Espera máxima na fila de envio",
    new_contact_hourly_cap: "Contatos novos por hora",
    qr_hourly_cap: "QRs por hora",
    connect_cooldown_after_fatal_ms: "Espera após erro fatal",
    restore_stagger_ms: "Intervalo entre sessões no boot",
};

function formatLimit(key: string, value: number): string {
    if (key === "send_spacing_enabled") return value === 1 ? "ligado" : "desligado";
    if (key.endsWith("_ms")) return value === 0 ? "desligado" : formatMs(value);
    return String(value);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="space-y-2">
            <h3 className="text-xs font-semibold text-foreground">{title}</h3>
            <dl className="space-y-1 text-xs">{children}</dl>
        </section>
    );
}

function Row({ label, value, bad }: { label: string; value: ReactNode; bad?: boolean }) {
    return (
        <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn("text-right tabular-nums", bad && "font-medium text-red-600 dark:text-red-400")}>{value}</dd>
        </div>
    );
}

/**
 * O que hoje se descobre com `curl /health` e SQL no qr_message_log: fila do
 * outbox, memória, avatares, limites de proteção, bloqueios de contato frio e
 * falhas da última hora. Só leitura, e nada aqui gera tráfego no WhatsApp.
 */
export function ServiceDiagnostics({ health, lineNames }: ServiceDiagnosticsProps) {
    const abnormal = Boolean(
        health &&
            ((health.service.outbox_disk ?? 0) > 0 ||
                Object.keys(health.reachout_locks).length > 0 ||
                (health.failures && (health.failures.spilled > 0 || Object.keys(health.failures.by_action).length > 0))),
    );
    // Abre sozinho quando há algo a ver; o usuário que fechar não é reaberto no refetch.
    const [open, setOpen] = useState(abnormal);

    if (!health) return null;
    const { service, failures } = health;
    const locks = Object.entries(health.reachout_locks);
    const limits = Object.entries(health.protection_limits);
    const failureRows = failures ? Object.entries(failures.by_action).sort((a, b) => b[1] - a[1]) : [];

    return (
        <Card className="shadow-sm">
            <Collapsible open={open} onOpenChange={setOpen}>
                <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 p-3 text-left text-sm font-medium">
                    Diagnóstico do serviço
                    <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out", open && "rotate-180")} aria-hidden />
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <CardContent className="grid gap-x-8 gap-y-5 border-t p-4 sm:grid-cols-2 xl:grid-cols-3">
                        <Section title="Fila de webhooks">
                            <Row label="Em memória" value={service.outbox_mem ?? "—"} />
                            <Row label="Em disco" value={service.outbox_disk ?? "—"} bad={(service.outbox_disk ?? 0) > 0 && service.outbox_stalled === true} />
                            <Row label="Mais antigo em disco" value={service.outbox_oldest_disk_age_s != null ? formatUptime(service.outbox_oldest_disk_age_s) : "—"} />
                            <Row label="Pulados no último sweep" value={service.outbox_skipped ?? "—"} bad={(service.outbox_skipped ?? 0) > 0} />
                            <Row label="Travada" value={service.outbox_stalled === null ? "—" : service.outbox_stalled ? "sim" : "não"} bad={service.outbox_stalled === true} />
                        </Section>

                        <Section title="Memória e avatares">
                            <Row label="RSS" value={service.rss_mb != null ? `${Math.round(service.rss_mb)} MB` : "—"} />
                            <Row label="Heap" value={service.heap_used_mb != null ? `${Math.round(service.heap_used_mb)} MB` : "—"} />
                            {service.avatars ? (
                                <>
                                    <Row label="Fotos na fila" value={service.avatars.queued} />
                                    <Row label="Fotos em andamento" value={service.avatars.inFlight} />
                                    <Row label="Fotos descartadas" value={service.avatars.dropped} />
                                    <Row label="429 seguidos" value={service.avatars.consecutive429} bad={service.avatars.consecutive429 > 0} />
                                    <Row label="Pausada até" value={service.avatars.pausedUntil ? relativeTime(service.avatars.pausedUntil) : "não"} />
                                </>
                            ) : (
                                <Row label="Fila de fotos" value="sem dado" />
                            )}
                        </Section>

                        <Section title="Limites de proteção">
                            {limits.length === 0 ? (
                                <Row label="Limites" value="sem dado" />
                            ) : (
                                limits.map(([key, value]) => <Row key={key} label={LIMIT_LABELS[key] ?? key} value={formatLimit(key, value)} />)
                            )}
                        </Section>

                        <Section title="Contato frio bloqueado">
                            {locks.length === 0 ? (
                                <Row label="Linhas bloqueadas" value="nenhuma" />
                            ) : (
                                locks.map(([id, lock]) => (
                                    <Row
                                        key={id}
                                        label={lineNames.get(id) ?? id.slice(0, 8)}
                                        value={`${lock.hits} ${lock.hits === 1 ? "recusa" : "recusas"} · libera ${relativeTime(lock.locked_until)}`}
                                        bad
                                    />
                                ))
                            )}
                        </Section>

                        <Section title={failures ? `Falhas na última hora (${failures.window_minutes}min)` : "Falhas na última hora"}>
                            {!failures ? (
                                <Row label="Resumo" value="sem dado" />
                            ) : (
                                <>
                                    <Row label="webhook_spilled" value={failures.spilled} bad={failures.spilled > 0} />
                                    {failureRows.map(([action, n]) => (
                                        <Row key={action} label={action} value={failures.truncated ? `≥ ${n}` : n} bad />
                                    ))}
                                    {failures.spilled === 0 && failureRows.length === 0 && <Row label="Falhas" value="nenhuma" />}
                                </>
                            )}
                        </Section>
                    </CardContent>
                </CollapsibleContent>
            </Collapsible>
        </Card>
    );
}
