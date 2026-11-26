import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { TableVirtuoso } from "react-virtuoso";
import { Loader2, CheckCircle, XCircle, Clock, Copy, Users, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { IconSwap } from "@/components/ui/icon-swap";
import { fetchAllPaginated } from "@/lib/fetchAllPaginated";
import { RecipientStatusBadge } from "./broadcastStatus";
import { cn } from "@/lib/utils";

interface Recipient {
    id: string;
    phone_number: string;
    contact_name: string | null;
    status: string;
    error_message: string | null;
    sent_at: string | null;
}

interface BroadcastDetailsProps {
    broadcastId: string;
    broadcastName: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

type Filter = "all" | "sent" | "failed" | "pending";

interface Stats {
    total: number;
    sent: number;
    failed: number;
    pending: number;
}

const EMPTY_STATS: Stats = { total: 0, sent: 0, failed: 0, pending: 0 };

const RECIPIENT_COLUMNS = "id, phone_number, contact_name, status, error_message, sent_at";

export default function BroadcastDetails({
    broadcastId,
    broadcastName,
    open,
    onOpenChange,
}: BroadcastDetailsProps) {
    const { toast } = useToast();
    const [recipients, setRecipients] = useState<Recipient[]>([]);
    const [stats, setStats] = useState<Stats>(EMPTY_STATS);
    const [loading, setLoading] = useState(true);
    const [copying, setCopying] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const [filter, setFilter] = useState<Filter>("all");
    // Guards against a slow response from a previous filter overwriting a newer one.
    const requestRef = useRef(0);

    /**
     * Counts come from the server, one `head: true` count per status.
     *
     * They used to be `recipients.filter(...).length` over a single unpaginated
     * select — and PostgREST caps responses at 1000 rows, silently. A 1.756-recipient
     * broadcast therefore reported "Todos (1000)" forever while the list page showed
     * the real total, so the same broadcast contradicted itself on two screens.
     * A count query is immune to the cap.
     */
    const fetchStats = useCallback(async () => {
        const countFor = async (status?: string) => {
            let query = supabase
                .from("broadcast_recipients")
                .select("*", { count: "exact", head: true })
                .eq("broadcast_id", broadcastId);
            if (status) query = query.eq("status", status);
            const { count, error } = await query;
            if (error) throw error;
            return count || 0;
        };

        const [total, sent, failed, pending] = await Promise.all([
            countFor(),
            countFor("sent"),
            countFor("failed"),
            countFor("pending"),
        ]);
        setStats({ total, sent, failed, pending });
    }, [broadcastId]);

    /**
     * The rows themselves, filtered ON THE SERVER and paged until drained, so
     * recipient 1001 and beyond are reachable at all.
     */
    const fetchRecipients = useCallback(
        async (activeFilter: Filter, { showSpinner = true }: { showSpinner?: boolean } = {}) => {
            const requestId = ++requestRef.current;
            if (showSpinner) setLoading(true);
            try {
                const rows = await fetchAllPaginated<Recipient>((from, to) => {
                    let query = supabase
                        .from("broadcast_recipients")
                        .select(RECIPIENT_COLUMNS)
                        .eq("broadcast_id", broadcastId);
                    if (activeFilter !== "all") query = query.eq("status", activeFilter);
                    // created_at alone is ambiguous: every row of a broadcast is inserted by
                    // one statement and shares it. id breaks the tie so pages can't overlap.
                    return query
                        .order("created_at", { ascending: true })
                        .order("id", { ascending: true })
                        .range(from, to);
                });

                if (requestId !== requestRef.current) return;
                setRecipients(rows);
            } catch (error: any) {
                if (requestId !== requestRef.current) return;
                console.error("Error fetching recipients:", error);
                toast({
                    title: "Não foi possível carregar os destinatários",
                    description: toUserMessage(error, "Verifique a conexão e abra o disparo de novo."),
                    variant: "destructive",
                });
            } finally {
                if (requestId === requestRef.current) setLoading(false);
            }
        },
        [broadcastId, toast]
    );

    useEffect(() => {
        if (!open || !broadcastId) return;
        fetchStats().catch((e) => console.error("Error fetching stats:", e));
        fetchRecipients(filter);
    }, [open, broadcastId, filter, fetchStats, fetchRecipients]);

    // Live progress while the broadcast is being delivered. Without this the modal was
    // a snapshot: the only way to see movement was to close and reopen it.
    useEffect(() => {
        if (!open || !broadcastId) return;

        // fetchStats são QUATRO count(*) exatos, e o disparo emite um UPDATE por
        // destinatário: um broadcast de 5.000 gerava ~20.000 COUNT no banco
        // durante a entrega, multiplicado por cada modal aberto. 1,5s é
        // imperceptível numa barra de progresso e corta duas ordens de grandeza.
        //
        // O timer de CAUDA é o que importa para a correção: sem ele o último
        // evento cairia dentro da janela de throttle e o modal congelaria no
        // penúltimo estado, mostrando o disparo como incompleto para sempre.
        const THROTTLE_MS = 1500;
        let lastRun = 0;
        let trailing: ReturnType<typeof setTimeout> | undefined;

        const scheduleStats = () => {
            const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastRun));
            if (trailing) clearTimeout(trailing);
            trailing = setTimeout(() => {
                lastRun = Date.now();
                fetchStats().catch(() => undefined);
            }, wait);
        };

        const channel = supabase
            .channel(`broadcast-details-${broadcastId}`)
            .on(
                "postgres_changes",
                {
                    event: "UPDATE",
                    schema: "public",
                    table: "broadcast_recipients",
                    filter: `broadcast_id=eq.${broadcastId}`,
                },
                () => {
                    // Refresh counts on every change, but never yank the list into a
                    // spinner underneath the user while they are reading it.
                    scheduleStats();
                }
            )
            .subscribe();

        return () => {
            if (trailing) clearTimeout(trailing);
            supabase.removeChannel(channel);
        };
    }, [open, broadcastId, fetchStats]);

    // This is the operator's re-send list, so it must be the COMPLETE set of failures.
    // Deriving it from the loaded array silently dropped every failure past row 1000
    // while still toasting success — on a 5.000-recipient broadcast that meant
    // thousands of people quietly left out of the retry.
    const copyFailedPhones = async () => {
        setCopying(true);
        try {
            const failed = await fetchAllPaginated<{ phone_number: string }>((from, to) =>
                supabase
                    .from("broadcast_recipients")
                    .select("phone_number")
                    .eq("broadcast_id", broadcastId)
                    .eq("status", "failed")
                    .order("created_at", { ascending: true })
                    .order("id", { ascending: true })
                    .range(from, to)
            );

            if (failed.length === 0) {
                toast({ title: "Nenhuma falha para copiar" });
                return;
            }

            await navigator.clipboard.writeText(failed.map((r) => r.phone_number).join("\n"));
            toast({
                title: `${failed.length.toLocaleString("pt-BR")} ${failed.length === 1 ? "número copiado" : "números copiados"}`,
            });
        } catch (error: any) {
            console.error("Error copying failed phones:", error);
            toast({
                title: "Não foi possível copiar os números",
                description: "A lista pode estar incompleta. Tente novamente.",
                variant: "destructive",
            });
        } finally {
            setCopying(false);
        }
    };

    /**
     * Requeue the failures instead of making the operator rebuild the campaign by hand.
     * Returning rows to 'pending' is all that is needed — the dispatch-broadcast-work
     * cron job notices pending work and sends workers at it.
     */
    const retryFailed = async () => {
        setRetrying(true);
        try {
            const { error } = await supabase
                .from("broadcast_recipients")
                .update({ status: "pending", attempts: 0, claimed_at: null, error_message: null })
                .eq("broadcast_id", broadcastId)
                .eq("status", "failed");
            if (error) throw error;

            // Reopen the parent so the dispatcher considers it again.
            const { error: reopenError } = await supabase
                .from("broadcasts")
                .update({ status: "processing", completed_at: null })
                .eq("id", broadcastId);
            if (reopenError) throw reopenError;

            toast({
                title: "Falhas reenfileiradas",
                description: "O envio recomeça em instantes para quem falhou.",
            });

            await fetchStats();
            await fetchRecipients(filter, { showSpinner: false });
        } catch (error: any) {
            console.error("Error retrying failed recipients:", error);
            toast({
                title: "Não foi possível reenviar as falhas",
                description: toUserMessage(error, "Nada foi reenviado. Verifique a conexão e tente de novo."),
                variant: "destructive",
            });
        } finally {
            setRetrying(false);
        }
    };

    const fmt = (n: number) => n.toLocaleString("pt-BR");

    const FILTERS: { key: Filter; label: string; count: number; Icon?: typeof CheckCircle; tint: string }[] = [
        { key: "all", label: "Todos", count: stats.total, Icon: Users, tint: "text-foreground" },
        { key: "sent", label: "Enviados", count: stats.sent, Icon: CheckCircle, tint: "text-success" },
        { key: "failed", label: "Falhas", count: stats.failed, Icon: XCircle, tint: "text-destructive" },
        { key: "pending", label: "Pendentes", count: stats.pending, Icon: Clock, tint: "text-warning" },
    ];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl h-[85vh] flex flex-col gap-4">
                <DialogHeader className="flex-none">
                    <DialogTitle>Detalhes do disparo</DialogTitle>
                    <DialogDescription className="truncate" title={broadcastName}>{broadcastName}</DialogDescription>
                </DialogHeader>

                {/* Status filters. The count lives in the button so the tallies and the
                    filter are the same control instead of two things to reconcile. */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 flex-none">
                    {FILTERS.map(({ key, label, count, Icon, tint }) => {
                        const active = filter === key;
                        return (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setFilter(key)}
                                aria-pressed={active}
                                className={cn(
                                    "group rounded-lg border bg-card px-3 py-2 text-left",
                                    "active:scale-[0.96] motion-reduce:active:scale-100 transition-[border-color,box-shadow,background-color,transform] duration-150 ease-out",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                                    active
                                        ? "border-primary shadow-sm bg-primary/5"
                                        : "border-border hover:border-primary/50"
                                )}
                            >
                                <span className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                                    {Icon && <Icon className={cn("h-3 w-3", tint)} />}
                                    {label}
                                </span>
                                {/* tabular-nums so the four counts line up as a row of figures */}
                                <span className="block text-lg font-semibold tabular-nums leading-tight">
                                    {fmt(count)}
                                </span>
                            </button>
                        );
                    })}
                </div>

                {stats.failed > 0 && (
                    <div className="flex flex-wrap gap-2 flex-none">
                        <Button variant="outline" size="sm" onClick={copyFailedPhones} disabled={copying}>
                            <IconSwap
                                className="mr-2"
                                active={copying ? "spinner" : "copy"}
                                icons={{
                                    spinner: <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />,
                                    copy: <Copy className="h-3 w-3" />,
                                }}
                            />
                            Copiar números que falharam
                        </Button>
                        <Button variant="outline" size="sm" onClick={retryFailed} disabled={retrying}>
                            <IconSwap
                                className="mr-2"
                                active={retrying ? "spinner" : "retry"}
                                icons={{
                                    spinner: <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />,
                                    retry: <RotateCcw className="h-3 w-3" />,
                                }}
                            />
                            Reenviar {fmt(stats.failed)} {stats.failed === 1 ? "falha" : "falhas"}
                        </Button>
                    </div>
                )}

                {loading ? (
                    // Geometry-matched to the real rows so nothing jumps when data lands.
                    <div className="flex-1 min-h-0 border rounded-lg p-3 space-y-2">
                        {Array.from({ length: 8 }).map((_, i) => (
                            <Skeleton key={i} className="h-9 w-full" />
                        ))}
                    </div>
                ) : recipients.length === 0 ? (
                    <div className="flex-1 min-h-0 border rounded-lg flex flex-col items-center justify-center gap-2 px-6 text-center">
                        <p className="text-sm text-muted-foreground text-pretty">
                            {filter === "all"
                                ? "Nenhum destinatário neste disparo."
                                : `Nenhum destinatário com status “${FILTERS.find((f) => f.key === filter)?.label ?? filter}”.`}
                        </p>
                        {filter !== "all" && (
                            <Button variant="link" size="sm" onClick={() => setFilter("all")}>
                                Ver todos
                            </Button>
                        )}
                    </div>
                ) : (
                    // Virtualized: a 5.000-recipient broadcast would otherwise mount 5.000
                    // rows and their badges at once.
                    <TableVirtuoso
                        className="flex-1 min-h-0 w-full border rounded-lg"
                        data={recipients}
                        components={{
                            Table: (props) => <table {...props} className="w-full caption-bottom text-sm" />,
                            TableRow: (props) => <tr {...props} className="border-b transition-colors hover:bg-muted/50" />,
                        }}
                        fixedHeaderContent={() => (
                            <tr className="border-b bg-card">
                                <th className="h-10 px-4 text-left align-middle text-xs font-medium text-muted-foreground">Telefone</th>
                                <th className="h-10 px-4 text-left align-middle text-xs font-medium text-muted-foreground">Nome</th>
                                <th className="h-10 px-4 text-left align-middle text-xs font-medium text-muted-foreground">Status</th>
                                <th className="h-10 px-4 text-left align-middle text-xs font-medium text-muted-foreground">Erro</th>
                            </tr>
                        )}
                        itemContent={(_index, recipient) => (
                            <>
                                <td className="px-4 py-2 font-mono text-sm tabular-nums">{recipient.phone_number}</td>
                                <td className="px-4 py-2">{recipient.contact_name || "-"}</td>
                                <td className="px-4 py-2"><RecipientStatusBadge status={recipient.status} /></td>
                                <td className="px-4 py-2 text-sm text-destructive max-w-[200px] truncate" title={recipient.error_message || undefined}>
                                    {recipient.error_message || "-"}
                                </td>
                            </>
                        )}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
