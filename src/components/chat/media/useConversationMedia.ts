import { useMemo } from "react";
import type { Message } from "@/hooks/chat/useMessages";

export interface ConversationMediaItem {
  messageId: string;
  url: string;
  type: "image" | "video";
  caption: string | null;
  /** Ausente na prévia do envio (arquivo ainda não virou mensagem). */
  timestamp?: string;
}

const PLACEHOLDER_CAPTIONS = new Set(["[Imagem]", "[Vídeo]"]);

/**
 * Galeria da conversa para o lightbox: imagens e vídeos das PÁGINAS JÁ
 * CARREGADAS, em ordem cronológica. Cobrir o histórico inteiro exigiria
 * fetchAllMessages — deliberadamente fora do v1 (a navegação cresce conforme
 * o usuário pagina para cima).
 */
export function useConversationMedia(messages: Message[]): ConversationMediaItem[] {
  return useMemo(
    () =>
      messages
        .filter(
          (m): m is Message & { media_url: string } =>
            !!m.media_url &&
            (m.message_type === "image" || m.message_type === "video") &&
            !m.is_deleted
        )
        .map((m) => ({
          messageId: m.id,
          url: m.media_url,
          type: m.message_type as "image" | "video",
          caption: m.content && !PLACEHOLDER_CAPTIONS.has(m.content) ? m.content : null,
          timestamp: m.created_at,
        })),
    [messages]
  );
}
