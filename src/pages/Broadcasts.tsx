import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchAllPaginated } from "@/lib/fetchAllPaginated";
import { BroadcastStatusBadge } from "@/components/broadcasts/broadcastStatus";
import {
    Plus,
    Send,
    ArrowLeft,
    Clock,
    CheckCircle,
    XCircle,
    Loader2,
    Calendar,
    Users,
    FileSpreadsheet,
    MoreVertical,
    Trash2,
    Play,
    Eye,
} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatDistanceToNow, format } from "date-fns";
import { ptBR } from "date-fns/locale";
import BroadcastBuilder from "@/components/broadcasts/BroadcastBuilder";
import BroadcastDetails from "@/components/broadcasts/BroadcastDetails";
import ScheduledMessagesList from "@/components/scheduled/ScheduledMessagesList";
import { useIsMobile } from "@/hooks/use-mobile";
import { BottomNavigation } from "@/components/layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Broadcast {
    id: string;
    name: string;
    template_name: string | null;
    status: string;
    scheduled_at: string | null;
    completed_at: string | null;
    total_recipients: number;
    sent_count: number;
    failed_count: number;
    created_at: string;
    phone_numbers?: {
        display_name: string;
    };
}

const fmtNumber = (n: number) => (n ?? 0).toLocaleString("pt-BR");

/**
 * Progress for an in-flight broadcast.
 *
 * `ui/progress.tsx` exists in this repo and had zero importers; rather than pull in
 * the Radix primitive for a single bar, this mirrors the inline pattern already used
 * for upload progress in ChatArea.tsx:1717.
 */
function BroadcastProgress({ broadcast }: { broadcast: Broadcast }) {
    const total = broadcast.total_recipients || 0;
    const done = (broadcast.sent_count || 0) + (broadcast.failed_count || 0);
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs tabular-nums">
                <span className="text-muted-foreground">
                    {fmtNumber(done)} de {fmtNumber(total)}
                </span>
                <span className="font-medium">{pct}%</span>
            </div>
            <div
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Progresso do disparo ${broadcast.name}`}
            >
                <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300 ease-linear"
                    style={{ width: `${pct}%` }}
                />
            </div>
            {broadcast.failed_count > 0 && (
                <p className="text-xs text-destructive tabular-nums">
                    {fmtNumber(broadcast.failed_count)} falha(s) até agora
                </p>
            )}
        </div>
    );
}

export default function Broadcasts() {
    const navigate = useNavigate();
    const { toast } = useToast();
    const { currentOrganization, userRole } = useOrganization();
    const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [showBuilder, setShowBuilder] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState<Broadcast | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [detailsBroadcast, setDetailsBroadcast] = useState<Broadcast | null>(null);
    const [activeTab, setActiveTab] = useState<"disparos" | "agendados">("disparos");
    const isMobile = useIsMobile();

    // Live progress. The page had no subscription and no polling at all, so the toast's
    // promise that "a lista será atualizada automaticamente" was simply false: the only
    // refreshes were on mount, after an action, and one 3s timeout.
    useEffect(() => {
        if (!currentOrganization?.id) return;

        const channel = supabase
            .channel(`broadcasts-${currentOrganization.id}`)
            .on(
                "postgres_changes",
                {
                    event: "UPDATE",
                    schema: "public",
                    table: "broadcasts",
                    filter: `organization_id=eq.${currentOrganization.id}`,
                },
                (payload) => {
                    // Patch in place instead of refetching: counts tick constantly during a
                    // send, and a refetch per event would thrash the list.
                    const updated = payload.new as Broadcast;
                    setBroadcasts((prev) =>
                        prev.map((b) => (b.id === updated.id ? { ...b, ...updated } : b))
                    );
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [currentOrganization?.id]);

    // `silent` refreshes leave the current cards on screen. The unconditional
    // setLoading(true) meant every refresh — including the one 3s after pressing
    // "Enviar Agora" — destroyed the whole grid and replaced it with a spinner.
    const fetchBroadcasts = useCallback(
        async ({ silent = false }: { silent?: boolean } = {}) => {
            if (!currentOrganization?.id) return;

            if (!silent) setLoading(true);
            try {
                // Paged until drained: PostgREST caps a response at 1000 rows silently,
                // so an org that crosses 1000 broadcasts would just stop seeing older ones.
                const data = await fetchAllPaginated<Broadcast>((from, to) =>
                    (supabase as any)
                        .from("broadcasts")
                        .select(`*, phone_numbers ( display_name )`)
                        .eq("organization_id", currentOrganization.id)
                        .order("created_at", { ascending: false })
                        .order("id", { ascending: false })
                        .range(from, to)
                );

                setBroadcasts(data);
                setLoadError(null);
            } catch (error: any) {
                console.error("Error fetching broadcasts:", error);
                // Distinguished from "no broadcasts yet": a failed fetch used to render
                // the first-run onboarding empty state, which is a lie.
                setLoadError(toUserMessage(error, "Verifique a conexão e tente novamente."));
                if (!silent) {
                    toast({
                        title: "Não foi possível carregar disparos",
                        description: toUserMessage(error, "Verifique a conexão e tente novamente."),
                        variant: "destructive",
                    });
                }
            } finally {
                if (!silent) setLoading(false);
            }
        },
        [currentOrganization?.id, toast]
    );

    useEffect(() => {
        if (currentOrganization?.id) {
            fetchBroadcasts();
        }
    }, [currentOrganization?.id, fetchBroadcasts]);


    const handleDelete = async (broadcast: Broadcast) => {
        setDeleting(true);
        try {
            const { error } = await (supabase as any)
                .from("broadcasts")
                .delete()
                .eq("id", broadcast.id);

            if (error) throw error;

            setBroadcasts(broadcasts.filter((b) => b.id !== broadcast.id));
            toast({ title: "Disparo excluído" });
        } catch (error: any) {
            toast({
                title: "Não foi possível excluir",
                description: toUserMessage(error, "Verifique a conexão e tente novamente."),
                variant: "destructive",
            });
        } finally {
            setDeleting(false);
            setDeleteConfirm(null);
        }
    };

    // Hand the broadcast to the queue and return. Delivery is owned by the
    // dispatch-broadcast-work cron job from here on, so it no longer matters whether
    // this tab stays open — which is what used to strand broadcasts half-sent.
    const handleExecuteNow = async (broadcast: Broadcast) => {
        try {
            const { error } = await supabase
                .from("broadcasts")
                .update({ status: "processing" })
                .eq("id", broadcast.id);

            if (error) throw error;

            toast({
                title: broadcast.status === "processing" ? "Envio retomado!" : "Disparo na fila!",
                description: "As mensagens começam a sair em instantes. Pode fechar a aba — o envio continua.",
            });

            // Nudge a worker immediately so the first messages don't wait for the next
            // tick. Latency only: if this fails, the dispatcher picks it up within a minute.
            supabase.functions
                .invoke("broadcast-execute", { body: { broadcastId: broadcast.id } })
                .catch((err) =>
                    console.error("[Broadcast] Nudge imediato falhou; o dispatcher assume:", err)
                );

            fetchBroadcasts();
        } catch (error: any) {
            console.error("[Broadcast] Erro ao enfileirar disparo:", error);
            toast({
                title: "Não foi possível iniciar disparo",
                description: toUserMessage(error, "Verifique a conexão e tente novamente."),
                variant: "destructive",
            });
        }
    };

    const handleBroadcastCreated = () => {
        setShowBuilder(false);
        fetchBroadcasts();
    };

    if (showBuilder) {
        return (
            <BroadcastBuilder
                onBack={() => setShowBuilder(false)}
                onSuccess={handleBroadcastCreated}
            />
        );
    }

    return (
        <div className="min-h-dvh bg-background">
            {/* Header */}
            {/* bg-card, matching Analytics.tsx:76 and the rest of the app's sticky
                headers. bg-background gave the header no surface separation from the
                body, so it read as a flat seam. */}
            <div className="border-b sticky top-0 z-10 bg-card safe-area-top">
                <div className="container mx-auto px-4 py-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 sm:gap-4">
                            {!isMobile && (
                                <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")} aria-label="Voltar">
                                    <ArrowLeft className="h-5 w-5" />
                                </Button>
                            )}
                            <div>
                                <h1 className="text-lg sm:text-2xl font-bold flex items-center gap-2">
                                    <Send className="h-5 w-5 sm:h-6 sm:w-6 text-primary" />
                                    Disparos
                                </h1>
                                {!isMobile && (
                                    <p className="text-muted-foreground text-sm">
                                        Envie templates para múltiplos contatos
                                    </p>
                                )}
                            </div>
                        </div>
                        {(userRole === "admin" || userRole === "agent") && (
                            <Button onClick={() => setShowBuilder(true)} size={isMobile ? "sm" : "default"}>
                                <Plus className="h-4 w-4 mr-1 sm:mr-2" />
                                <span className="hidden xs:inline">Novo Disparo</span><span className="xs:hidden">Disparo</span>
                            </Button>
                        )}
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className={`container mx-auto px-4 pt-4 sm:pt-8 ${isMobile ? "pb-bottom-nav" : "pb-4 sm:pb-8"}`}>
                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "disparos" | "agendados")}>
                    <TabsList className="mb-4">
                        <TabsTrigger value="disparos" className="gap-2">
                            <Send className="h-4 w-4" />
                            Disparos
                        </TabsTrigger>
                        <TabsTrigger value="agendados" className="gap-2">
                            <Clock className="h-4 w-4" />
                            Agendados
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="disparos">
                        {loading ? (
                            // Geometry-matched to the real card grid so nothing jumps when
                            // data lands. The old spinner sat in a fixed h-64 box and was
                            // replaced by a grid of a completely different height.
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <Card key={i}>
                                        <CardHeader className="pb-3 space-y-2">
                                            <Skeleton className="h-5 w-3/4" />
                                            <Skeleton className="h-4 w-1/2" />
                                        </CardHeader>
                                        <CardContent className="space-y-3">
                                            <div className="flex items-center justify-between">
                                                <Skeleton className="h-6 w-24 rounded-full" />
                                                <Skeleton className="h-4 w-12" />
                                            </div>
                                            <Skeleton className="h-3 w-32" />
                                        </CardContent>
                                    </Card>
                                ))}
                            </div>
                        ) : loadError ? (
                            // A failed fetch is not an empty account. Rendering the
                            // first-run onboarding card here told users their broadcasts
                            // were gone whenever the network hiccuped.
                            <Card className="border-dashed">
                                <CardContent className="flex flex-col items-center justify-center py-12 sm:py-16">
                                    <XCircle className="h-12 w-12 text-destructive/60 mb-4" />
                                    <h3 className="text-lg font-semibold mb-2 text-balance">Não foi possível carregar os disparos</h3>
                                    <p className="text-muted-foreground text-center mb-6 max-w-md text-sm text-pretty">
                                        {loadError}
                                    </p>
                                    <Button variant="outline" onClick={() => fetchBroadcasts()}>
                                        Tentar novamente
                                    </Button>
                                </CardContent>
                            </Card>
                        ) : broadcasts.length === 0 ? (
                            <Card className="border-dashed">
                                <CardContent className="flex flex-col items-center justify-center py-12 sm:py-16">
                                    <Send className="h-12 w-12 sm:h-16 sm:w-16 text-muted-foreground/50 mb-4" />
                                    <h3 className="text-lg font-semibold mb-2 text-balance">Nenhum disparo ainda</h3>
                                    <p className="text-muted-foreground text-center mb-6 max-w-md text-sm text-pretty">
                                        Crie disparos para enviar mensagens de template para múltiplos
                                        contatos de uma vez.
                                    </p>
                                    {(userRole === "admin" || userRole === "agent") && (
                                        <Button onClick={() => setShowBuilder(true)}>
                                            <Plus className="h-4 w-4 mr-2" />
                                            Criar primeiro disparo
                                        </Button>
                                    )}
                                </CardContent>
                            </Card>
                        ) : (
                            // One scroll height for both tabs: the sibling "Agendados"
                            // panel used a different magic number (-200px) for the same
                            // layout, so the two disagreed by 50px.
                            <ScrollArea className="h-[calc(100dvh-250px)]">
                                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                    {broadcasts.map((broadcast) => (
                                        <Card
                                            key={broadcast.id}
                                            className="group hover:border-primary/50 transition-colors"
                                        >
                                            <CardHeader className="pb-3">
                                                <div className="flex items-start justify-between">
                                                    {/* The card already advertised itself as clickable with
                                                        hover:border-primary/50, but "Ver Detalhes" was buried in
                                                        the dropdown. The title is now the affordance — a real
                                                        button, so it works by keyboard too. */}
                                                    <button
                                                        type="button"
                                                        onClick={() => setDetailsBroadcast(broadcast)}
                                                        className="flex-1 min-w-0 text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                    >
                                                        <CardTitle className="text-base truncate group-hover:text-primary transition-colors">
                                                            {broadcast.name}
                                                        </CardTitle>
                                                        <CardDescription className="truncate">
                                                            {broadcast.template_name} • {broadcast.phone_numbers?.display_name}
                                                        </CardDescription>
                                                    </button>
                                                    <DropdownMenu>
                                                        <DropdownMenuTrigger asChild>
                                                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 touch-manipulation" aria-label={`Mais opções do disparo ${broadcast.name}`}>
                                                                <MoreVertical className="h-4 w-4" />
                                                            </Button>
                                                        </DropdownMenuTrigger>
                                                        <DropdownMenuContent align="end">
                                                            {(broadcast.status === "draft" || broadcast.status === "scheduled" || broadcast.status === "processing") && (
                                                                <DropdownMenuItem onClick={() => handleExecuteNow(broadcast)}>
                                                                    <Play className="h-4 w-4 mr-2" />
                                                                    {broadcast.status === "processing" ? "Retomar Envio" : "Enviar Agora"}
                                                                </DropdownMenuItem>
                                                            )}
                                                            <DropdownMenuItem onClick={() => setDetailsBroadcast(broadcast)}>
                                                                <Eye className="h-4 w-4 mr-2" />
                                                                Ver Detalhes
                                                            </DropdownMenuItem>
                                                            <DropdownMenuItem
                                                                onClick={() => setDeleteConfirm(broadcast)}
                                                                className="text-destructive"
                                                            >
                                                                <Trash2 className="h-4 w-4 mr-2" />
                                                                Excluir
                                                            </DropdownMenuItem>
                                                        </DropdownMenuContent>
                                                    </DropdownMenu>
                                                </div>
                                            </CardHeader>
                                            <CardContent className="space-y-3">
                                                <div className="flex items-center justify-between">
                                                    <BroadcastStatusBadge status={broadcast.status} />
                                                    <div className="flex items-center gap-1 text-sm text-muted-foreground tabular-nums">
                                                        <Users className="h-4 w-4" />
                                                        {fmtNumber(broadcast.total_recipients)}
                                                    </div>
                                                </div>

                                                {/* Live progress. This is the piece that made the engine's
                                                    failures invisible: during a send the card showed only a
                                                    spinner and the total, so a stalled broadcast and a
                                                    healthy one looked identical for hours. */}
                                                {broadcast.status === "processing" && (
                                                    <BroadcastProgress broadcast={broadcast} />
                                                )}

                                                {(broadcast.status === "completed" || broadcast.status === "failed") && (
                                                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
                                                        <span className="inline-flex items-center gap-1 text-success">
                                                            <CheckCircle className="h-3.5 w-3.5" />
                                                            {fmtNumber(broadcast.sent_count)} enviados
                                                        </span>
                                                        {broadcast.failed_count > 0 && (
                                                            <span className="inline-flex items-center gap-1 text-destructive">
                                                                <XCircle className="h-3.5 w-3.5" />
                                                                {fmtNumber(broadcast.failed_count)} falhas
                                                            </span>
                                                        )}
                                                    </div>
                                                )}

                                                {broadcast.scheduled_at && broadcast.status === "scheduled" && (
                                                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                                        <Calendar className="h-4 w-4" />
                                                        {format(new Date(broadcast.scheduled_at), "dd/MM/yyyy 'às' HH:mm", {
                                                            locale: ptBR,
                                                        })}
                                                    </div>
                                                )}

                                                <p className="text-xs text-muted-foreground">
                                                    Criado{" "}
                                                    {formatDistanceToNow(new Date(broadcast.created_at), {
                                                        addSuffix: true,
                                                        locale: ptBR,
                                                    })}
                                                </p>
                                            </CardContent>
                                        </Card>
                                    ))}
                                </div>
                            </ScrollArea>
                        )}
                    </TabsContent>

                    <TabsContent value="agendados">
                        <ScheduledMessagesList />
                    </TabsContent>
                </Tabs>
            </div>

            {/* Delete Confirmation */}
            <AlertDialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Excluir Disparo</AlertDialogTitle>
                        <AlertDialogDescription>
                            Tem certeza que deseja excluir o disparo "{deleteConfirm?.name}"? Esta ação não
                            pode ser desfeita.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
                            disabled={deleting}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                            Excluir
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Broadcast Details Modal */}
            {detailsBroadcast && (
                <BroadcastDetails
                    broadcastId={detailsBroadcast.id}
                    broadcastName={detailsBroadcast.name}
                    open={!!detailsBroadcast}
                    onOpenChange={(open) => !open && setDetailsBroadcast(null)}
                />
            )}

            {isMobile && <BottomNavigation />}
        </div>
    );
}
