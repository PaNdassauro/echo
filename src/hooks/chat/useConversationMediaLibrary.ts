import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPaginated } from "@/lib/fetchAllPaginated";

/** Um arquivo enviado/recebido na conversa, já pronto para a UI. */
export interface MediaLibraryItem {
    id: string;
    messageType: string;
    url: string;
    mimeType: string | null;
    filename: string | null;
    sizeBytes: number | null;
    /** Legenda real; placeholders ("[Imagem]") viram null. */
    caption: string | null;
    createdAt: string;
    direction: "inbound" | "outbound";
}

export interface MediaLibrary {
    /** Imagens e vídeos, em ordem cronológica (a mesma que o lightbox navega). */
    visual: MediaLibraryItem[];
    docs: MediaLibraryItem[];
    audio: MediaLibraryItem[];
}

export interface MediaRow {
    id: string;
    message_type: string | null;
    media_url: string | null;
    media_mime_type: string | null;
    media_filename: string | null;
    media_size_bytes: number | null;
    content: string | null;
    created_at: string;
    direction: string | null;
}

/**
 * Tipos com arquivo anexado. `audio` e `ptt` são O MESMO conteúdo gravado por
 * serviços diferentes — o whatsapp-webhook grava `audio` no recebido e o
 * echo-api grava `ptt` no enviado — então os dois caem no bucket de áudio.
 *
 * `sticker` fica de fora de propósito: é reação, não arquivo compartilhado (o
 * lightbox das bolhas já adota o mesmo critério).
 */
const MEDIA_TYPES = ["image", "video", "document", "audio", "ptt"] as const;

const AUDIO_TYPES = new Set(["audio", "ptt"]);
const VISUAL_TYPES = new Set(["image", "video"]);

/** Legendas sintéticas gravadas quando a mídia veio sem texto. */
const PLACEHOLDER_CAPTIONS = new Set([
    "[Imagem]",
    "[Vídeo]",
    "[Áudio]",
    "[Documento]",
    "[Mensagem de voz]",
]);

/** Janela em que a galeria é servida do cache sem ir ao banco de novo. Curta:
 *  mídia nova durante a sessão é comum, e o custo do refetch é baixo. */
export const MEDIA_LIBRARY_TTL_MS = 2 * 60 * 1000;

/** Válvula de segurança: nenhuma conversa real tem tanta mídia, e sem isso uma
 *  query mal formada pagina para sempre travando a UI. */
const MAX_MEDIA_ROWS = 5000;

const EMPTY_LIBRARY: MediaLibrary = { visual: [], docs: [], audio: [] };

// Cache entre instâncias: o painel 1:1 e o do grupo montam/desmontam a cada
// abertura, e reabrir a mesma conversa não deve refazer a drenagem.
const libraryCache = new Map<string, { library: MediaLibrary; fetchedAt: number }>();

function toItem(row: MediaRow): MediaLibraryItem | null {
    // A query já filtra, mas o tipo do PostgREST é nullable — sem a guarda o
    // `url` do item seria `string | null` e vazaria para o lightbox.
    if (!row.media_url || !row.message_type) return null;

    const caption =
        row.content && !PLACEHOLDER_CAPTIONS.has(row.content) ? row.content : null;

    return {
        id: row.id,
        messageType: row.message_type,
        url: row.media_url,
        mimeType: row.media_mime_type,
        filename: row.media_filename,
        sizeBytes: row.media_size_bytes,
        caption,
        createdAt: row.created_at,
        direction: row.direction === "outbound" ? "outbound" : "inbound",
    };
}

/** Exportada para teste: é aqui que mora a regra (audio+ptt, sticker fora, etc). */
export function groupMediaRows(rows: MediaRow[]): MediaLibrary {
    const library: MediaLibrary = { visual: [], docs: [], audio: [] };

    for (const row of rows) {
        const item = toItem(row);
        if (!item) continue;

        if (VISUAL_TYPES.has(item.messageType)) library.visual.push(item);
        else if (AUDIO_TYPES.has(item.messageType)) library.audio.push(item);
        else if (item.messageType === "document") library.docs.push(item);
    }

    return library;
}

/**
 * Toda a mídia da conversa, do primeiro ao último arquivo — não só o que está
 * carregado em memória (é justamente o que `useConversationMedia` não cobre).
 *
 * Busca só quando `enabled` (painel aberto): a query é barata mas inútil
 * enquanto ninguém está olhando.
 */
export function useConversationMediaLibrary(
    conversationId: string | null,
    enabled: boolean,
): {
    library: MediaLibrary;
    isLoading: boolean;
    error: string | null;
    reload: () => void;
} {
    const [library, setLibrary] = useState<MediaLibrary>(EMPTY_LIBRARY);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Conversa em foco: descarta resposta que chega depois da troca.
    const activeIdRef = useRef<string | null>(null);
    // Incrementado pelo reload() para furar o cache e refazer a busca.
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        if (!conversationId || !enabled) {
            activeIdRef.current = null;
            return;
        }

        activeIdRef.current = conversationId;

        const cached = libraryCache.get(conversationId);
        const isFresh = cached && Date.now() - cached.fetchedAt < MEDIA_LIBRARY_TTL_MS;

        // Cache fresco entra sem piscar loading. Obsoleto/ausente: zera para não
        // exibir a mídia da conversa anterior enquanto a nova carrega.
        setLibrary(cached?.library ?? EMPTY_LIBRARY);
        setError(null);

        // reload() apaga a entrada do cache antes de bumpar o token, então aqui
        // basta olhar a frescura — sem testar o token, que ficaria "furado para
        // sempre" depois do primeiro reload.
        if (isFresh) {
            setIsLoading(false);
            return;
        }

        let cancelled = false;
        setIsLoading(true);

        const load = async () => {
            try {
                const rows = await fetchAllPaginated<MediaRow>(
                    (from, to) =>
                        supabase
                            .from("messages")
                            .select(
                                "id, message_type, media_url, media_mime_type, media_filename, media_size_bytes, content, created_at, direction",
                            )
                            .eq("conversation_id", conversationId)
                            .not("media_url", "is", null)
                            .in("message_type", [...MEDIA_TYPES])
                            .eq("is_deleted", false)
                            .order("created_at", { ascending: true })
                            // Tiebreaker obrigatório: linhas importadas em lote
                            // compartilham created_at e as páginas do .range()
                            // se sobreporiam.
                            .order("id", { ascending: true })
                            .range(from, to),
                    { maxRows: MAX_MEDIA_ROWS },
                );

                if (cancelled || activeIdRef.current !== conversationId) return;

                const grouped = groupMediaRows(rows);
                libraryCache.set(conversationId, {
                    library: grouped,
                    fetchedAt: Date.now(),
                });
                setLibrary(grouped);
                setError(null);
            } catch (err) {
                if (cancelled || activeIdRef.current !== conversationId) return;
                console.error("[MediaLibrary] Erro ao carregar mídia da conversa:", err);
                setError("Não foi possível carregar a mídia desta conversa.");
            } finally {
                if (!cancelled && activeIdRef.current === conversationId) {
                    setIsLoading(false);
                }
            }
        };

        void load();

        return () => {
            cancelled = true;
        };
    }, [conversationId, enabled, reloadToken]);

    const reload = useCallback(() => {
        if (conversationId) libraryCache.delete(conversationId);
        setReloadToken((token) => token + 1);
    }, [conversationId]);

    return useMemo(
        () => ({ library, isLoading, error, reload }),
        [library, isLoading, error, reload],
    );
}
