import { useCallback, useMemo, useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
    Download,
    FileText,
    Headphones,
    ImageOff,
    Image as ImageIcon,
    Play,
    RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AudioPlayer from "@/components/AudioPlayer";
import { formatBytes } from "@/lib/formatBytes";
import { mediaDownloadName, toDownloadUrl } from "@/lib/mediaDownload";
import {
    useConversationMediaLibrary,
    type MediaLibraryItem,
} from "@/hooks/chat/useConversationMediaLibrary";
import { MediaLightbox } from "./MediaLightbox";
import type { ConversationMediaItem } from "./useConversationMedia";

interface ConversationMediaTabsProps {
    conversationId: string;
    /** false enquanto o painel está fechado — evita a query. */
    active: boolean;
}

const formatItemDate = (iso: string) =>
    format(new Date(iso), "d MMM yyyy, HH:mm", { locale: ptBR });

/** Rótulo de leitor de tela: "Imagem de 12 ago 2026, 14:30". */
const itemLabel = (item: MediaLibraryItem) => {
    const kind = item.messageType === "video" ? "Vídeo" : "Imagem";
    return `${kind} de ${formatItemDate(item.createdAt)}`;
};

function EmptyState({ icon, children }: { icon: React.ReactNode; children: string }) {
    return (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
            {icon}
            <p className="text-sm">{children}</p>
        </div>
    );
}

/** Thumb do grid: some para um placeholder se o arquivo não existir mais no bucket. */
function VisualThumb({
    item,
    onOpen,
}: {
    item: MediaLibraryItem;
    onOpen: (messageId: string) => void;
}) {
    const [broken, setBroken] = useState(false);
    const isVideo = item.messageType === "video";

    return (
        <button
            type="button"
            onClick={() => onOpen(item.id)}
            // O alt fica vazio de propósito: o nome acessível já está aqui, e
            // duplicar faz o leitor de tela ler duas vezes.
            aria-label={itemLabel(item)}
            className="relative aspect-square overflow-hidden rounded-md bg-muted transition-[transform,opacity] duration-150 ease-out active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 hover:opacity-90"
        >
            {broken ? (
                <span className="flex h-full w-full items-center justify-center text-muted-foreground">
                    <ImageOff className="h-5 w-5" />
                </span>
            ) : isVideo ? (
                // Vídeo NÃO pode ir num <img> (o decode falha sempre). O próprio
                // <video> pinta o primeiro frame como pôster, e
                // preload="metadata" limita o custo a um range request por tile.
                <video
                    src={item.url}
                    muted
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-cover"
                    onError={() => setBroken(true)}
                />
            ) : (
                <img
                    src={item.url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                    onError={() => setBroken(true)}
                />
            )}

            {isVideo && !broken && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25">
                    <Play className="h-5 w-5 fill-white text-white" />
                </span>
            )}
        </button>
    );
}

/**
 * Galeria da conversa por tipo (imagens/vídeos, documentos, áudios), cobrindo o
 * histórico inteiro. Compartilhada pelo painel de perfil 1:1 e pelo do grupo —
 * mora aqui, e não dentro de nenhum dos dois, para não engordar arquivos que já
 * são grandes.
 */
export function ConversationMediaTabs({ conversationId, active }: ConversationMediaTabsProps) {
    const { library, isLoading, error, reload } = useConversationMediaLibrary(
        conversationId,
        active,
    );
    const [lightboxId, setLightboxId] = useState<string | null>(null);

    // O lightbox fala ConversationMediaItem (contrato das bolhas) — a galeria do
    // painel tem itens próprios, de todo o histórico, então converte.
    const lightboxItems = useMemo<ConversationMediaItem[]>(
        () =>
            library.visual.map((item) => ({
                messageId: item.id,
                url: item.url,
                type: item.messageType === "video" ? "video" : "image",
                caption: item.caption,
                timestamp: item.createdAt,
            })),
        [library.visual],
    );

    const closeLightbox = useCallback(() => setLightboxId(null), []);

    const total = library.visual.length + library.docs.length + library.audio.length;

    // Abrir numa aba vazia enquanto outra tem 40 itens é um bug que o usuário
    // reporta. A primeira aba não-vazia manda.
    const defaultTab =
        library.visual.length > 0 ? "visual" : library.docs.length > 0 ? "docs" : "audio";

    if (isLoading) {
        return (
            <div className="p-4">
                <div className="grid grid-cols-3 gap-1" aria-label="Carregando mídia">
                    {Array.from({ length: 9 }).map((_, i) => (
                        <Skeleton key={i} className="aspect-square rounded-md" />
                    ))}
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center gap-3 py-12">
                <p className="px-6 text-center text-sm text-muted-foreground">{error}</p>
                <Button variant="outline" size="sm" onClick={reload}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Tentar de novo
                </Button>
            </div>
        );
    }

    // Conversa sem mídia nenhuma: um estado vazio só, sem obrigar o usuário a
    // clicar nas três abas para descobrir que não há nada.
    if (total === 0) {
        return (
            <EmptyState icon={<ImageIcon className="h-8 w-8" />}>
                Nenhuma mídia nesta conversa
            </EmptyState>
        );
    }

    return (
        <Tabs defaultValue={defaultTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-4 grid shrink-0 grid-cols-3">
                <TabsTrigger value="visual">Imagens {library.visual.length || ""}</TabsTrigger>
                <TabsTrigger value="docs">Docs {library.docs.length || ""}</TabsTrigger>
                <TabsTrigger value="audio">Áudios {library.audio.length || ""}</TabsTrigger>
            </TabsList>

            <TabsContent value="visual" className="mt-0 min-h-0 flex-1">
                <div className="h-full overflow-y-auto overscroll-contain">
                    {library.visual.length === 0 ? (
                        <EmptyState icon={<ImageIcon className="h-8 w-8" />}>
                            Nenhuma imagem ou vídeo nesta conversa
                        </EmptyState>
                    ) : (
                        <div className="grid grid-cols-3 gap-1 p-4">
                            {library.visual.map((item) => (
                                <VisualThumb key={item.id} item={item} onOpen={setLightboxId} />
                            ))}
                        </div>
                    )}
                </div>
            </TabsContent>

            <TabsContent value="docs" className="mt-0 min-h-0 flex-1">
                <div className="h-full overflow-y-auto overscroll-contain">
                    {library.docs.length === 0 ? (
                        <EmptyState icon={<FileText className="h-8 w-8" />}>
                            Nenhum documento nesta conversa
                        </EmptyState>
                    ) : (
                        <ul className="flex flex-col gap-1 p-4">
                            {library.docs.map((item) => {
                                const size = formatBytes(item.sizeBytes);
                                const name = mediaDownloadName(item.url, item.filename, "document");
                                return (
                                    <li key={item.id}>
                                        <a
                                            href={toDownloadUrl(item.url, name)}
                                            download={name}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center gap-3 rounded-lg p-2 transition-[background-color,transform] duration-150 ease-out active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-accent"
                                        >
                                            <FileText className="h-8 w-8 shrink-0 text-muted-foreground" />
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-medium">
                                                    {item.filename || "Documento"}
                                                </p>
                                                <p className="truncate text-xs text-muted-foreground">
                                                    {[
                                                        item.mimeType?.split("/")[1]?.toUpperCase(),
                                                        size,
                                                        formatItemDate(item.createdAt),
                                                    ]
                                                        .filter(Boolean)
                                                        .join(" · ")}
                                                </p>
                                            </div>
                                            <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        </a>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </TabsContent>

            <TabsContent value="audio" className="mt-0 min-h-0 flex-1">
                <div className="h-full overflow-y-auto overscroll-contain">
                    {library.audio.length === 0 ? (
                        <EmptyState icon={<Headphones className="h-8 w-8" />}>
                            Nenhum áudio nesta conversa
                        </EmptyState>
                    ) : (
                        <ul className="flex flex-col gap-3 p-4">
                            {library.audio.map((item) => (
                                <li key={item.id} className="flex flex-col gap-1">
                                    {/* Existe UM <audio> global para todo o app: tocar
                                        aqui pausa a bolha do mesmo áudio, e é o que se
                                        espera (uma faixa tocando, as duas representações
                                        em sincronia). A key é o id da mensagem, não a
                                        url: o mesmo arquivo enviado duas vezes colidiria. */}
                                    <AudioPlayer src={item.url} />
                                    <span className="pl-1 text-xs text-muted-foreground">
                                        {formatItemDate(item.createdAt)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </TabsContent>

            <MediaLightbox
                items={lightboxItems}
                initialMessageId={lightboxId}
                onClose={closeLightbox}
            />
        </Tabs>
    );
}
