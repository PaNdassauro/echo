import { useCallback, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { qrFetch } from "@/lib/qrService";
import { publicAttachmentUrl } from "@/lib/runtimeConfig";
import { extractErrorMessage, toUserMessage } from "@/lib/userFacingError";
import {
  canEncodeWebp,
  getImageDimensions,
  imageToStickerWebp,
  isAnimatedWebp,
  sha256Hex,
} from "@/lib/stickerImage";
import type { Tables } from "@/integrations/supabase/types";

export type UserSticker = Tables<"user_stickers">;

export const STICKER_COLLECTION_CAP = 200;

export const STICKER_UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

const UPLOAD_ACCEPT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

interface UseStickersOptions {
  userId: string;
  onSuccess?: (title: string, description?: string) => void;
  onError?: (title: string, description: string) => void;
}

// Coleção pessoal de figurinhas (tabela user_stickers, RLS por auth.uid()).
// Sem realtime de propósito: a coleção só muda por ação do próprio usuário;
// staleness multi-aba se resolve com fetchStickers() no open do picker.
export function useStickers({ userId, onSuccess, onError }: UseStickersOptions) {
  const [stickers, setStickers] = useState<UserSticker[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const hasFetchedRef = useRef(false);

  const fetchStickers = useCallback(async () => {
    if (!userId) return;
    // Só mostra skeleton no primeiro load; refreshes de open são silenciosos.
    if (!hasFetchedRef.current) setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("user_stickers")
        .select("*")
        .eq("user_id", userId)
        .order("last_used_at", { ascending: false });

      if (error) {
        console.error("Error fetching stickers:", error);
        return;
      }
      hasFetchedRef.current = true;
      setStickers(data ?? []);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  /**
   * Converte uma imagem em blob de figurinha (webp 512x512), sem salvar —
   * o picker mostra o preview do resultado antes de confirmar.
   * Estático converte no canvas (instantâneo); GIF/webp animado e browsers
   * sem encoder webp vão ao /sticker/convert do qr-service (sharp).
   * Retorna null em erro já toasted.
   */
  const convertToSticker = useCallback(
    async (file: File): Promise<Blob | null> => {
      if (!UPLOAD_ACCEPT_TYPES.includes(file.type)) {
        onError?.(
          "Formato não suportado",
          "Use PNG, JPEG, WebP ou GIF para criar uma figurinha.",
        );
        return null;
      }

      setIsConverting(true);
      try {
        const inputBytes = new Uint8Array(await file.arrayBuffer());
        const needsServerConvert =
          file.type === "image/gif" ||
          (file.type === "image/webp" && isAnimatedWebp(inputBytes)) ||
          !canEncodeWebp();

        if (!needsServerConvert) {
          return await imageToStickerWebp(file);
        }

        const formData = new FormData();
        formData.append("file", file);
        const response = await qrFetch("/sticker/convert", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          onError?.(
            "Erro ao criar figurinha",
            response.status === 422
              ? "Esta imagem/animação é complexa demais para virar figurinha."
              : body?.error || "Falha na conversão. Tente novamente.",
          );
          return null;
        }
        return await response.blob();
      } catch (error: unknown) {
        const message = extractErrorMessage(error);
        onError?.(
          "Não foi possível criar a figurinha",
          message === "browser-cannot-encode-webp"
            ? "Seu navegador não suporta criar figurinhas — use Chrome/Edge ou Safari 17+."
            : toUserMessage(error, "Verifique a conexão e tente novamente."),
        );
        return null;
      } finally {
        setIsConverting(false);
      }
    },
    [onError],
  );

  /**
   * Sobe o blob e registra na coleção. O sha256 do conteúdo é a identidade
   * do sticker: filename no storage e chave de dedup na tabela.
   */
  const saveStickerBlob = useCallback(
    async (blob: Blob, source: "upload" | "saved"): Promise<boolean> => {
      if (!userId) return false;

      setIsSaving(true);
      try {
        const bytes = await blob.arrayBuffer();
        const sha = await sha256Hex(bytes);

        const { data: existing } = await supabase
          .from("user_stickers")
          .select("id")
          .eq("user_id", userId)
          .eq("file_sha256", sha)
          .maybeSingle();

        if (existing) {
          onSuccess?.("Figurinha já salva", "Esta figurinha já está na sua coleção.");
          return true;
        }

        if (stickers.length >= STICKER_COLLECTION_CAP) {
          onError?.(
            "Coleção cheia",
            `Limite de ${STICKER_COLLECTION_CAP} figurinhas atingido — remova algumas para salvar novas.`,
          );
          return false;
        }

        const { width, height } = await getImageDimensions(blob);
        const isAnimated = isAnimatedWebp(new Uint8Array(bytes));

        const storagePath = `stickers/${userId}/${sha}.webp`;
        const { error: uploadError } = await supabase.storage
          .from("attachments")
          .upload(storagePath, bytes, {
            contentType: "image/webp",
            upsert: false,
          });

        // 409 "already exists" = o arquivo já está lá (row deletada e recriada,
        // ou corrida entre abas) — o conteúdo é o mesmo por construção (sha).
        if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) {
          console.error("Sticker upload error:", uploadError);
          onError?.("Erro ao salvar figurinha", "Falha ao enviar o arquivo. Tente novamente.");
          return false;
        }

        // Endereço canônico (o que a edge também grava), não o da aba: ver publicAttachmentUrl.
        const fileUrl = publicAttachmentUrl(storagePath);

        const { data: row, error: insertError } = await supabase
          .from("user_stickers")
          .insert({
            user_id: userId,
            file_url: fileUrl,
            file_sha256: sha,
            mime_type: "image/webp",
            is_animated: isAnimated,
            width,
            height,
            size_bytes: blob.size,
            source,
          })
          .select()
          .single();

        if (insertError) {
          // 23505 = corrida com outra aba salvando o mesmo sticker.
          if (insertError.code === "23505") {
            onSuccess?.("Figurinha já salva", "Esta figurinha já está na sua coleção.");
            return true;
          }
          if (/limit reached/i.test(insertError.message)) {
            onError?.(
              "Coleção cheia",
              `Limite de ${STICKER_COLLECTION_CAP} figurinhas atingido — remova algumas para salvar novas.`,
            );
            return false;
          }
          console.error("Sticker insert error:", insertError);
          onError?.("Erro ao salvar figurinha", "Falha ao registrar a figurinha. Tente novamente.");
          return false;
        }

        setStickers((prev) => [row, ...prev]);
        onSuccess?.(
          "Figurinha salva",
          source === "upload" ? "Sua figurinha foi criada." : "Adicionada à sua coleção.",
        );
        return true;
      } finally {
        setIsSaving(false);
      }
    },
    [userId, stickers.length, onSuccess, onError],
  );

  // Salvar figurinha recebida: baixa o blob ORIGINAL e o copia byte a byte
  // para a coleção — NUNCA re-encoda (canvas mataria a animação).
  const saveStickerFromUrl = useCallback(
    async (mediaUrl: string): Promise<boolean> => {
      try {
        const response = await fetch(mediaUrl);
        if (!response.ok) {
          throw new Error(`fetch failed: ${response.status}`);
        }
        const blob = await response.blob();
        return await saveStickerBlob(blob, "saved");
      } catch (error) {
        console.error("Error saving sticker from URL:", error);
        onError?.(
          "Erro ao salvar figurinha",
          "Não foi possível baixar a figurinha — mídia indisponível.",
        );
        return false;
      }
    },
    [saveStickerBlob, onError],
  );

  const removeSticker = useCallback(
    async (stickerId: string): Promise<boolean> => {
      const { error } = await supabase
        .from("user_stickers")
        .delete()
        .eq("id", stickerId);

      if (error) {
        onError?.("Erro ao remover figurinha", error.message);
        return false;
      }

      // Só a row sai; o arquivo fica no storage (padrão do repo — pode estar
      // referenciado por messages.media_url antigas).
      setStickers((prev) => prev.filter((s) => s.id !== stickerId));
      onSuccess?.("Figurinha removida");
      return true;
    },
    [onSuccess, onError],
  );

  // MRU: atualiza o banco no envio, mas NÃO reordena a lista local — o grid
  // não deve fugir do dedo com o picker aberto; reordena no próximo open.
  const touchLastUsed = useCallback((stickerId: string) => {
    void supabase
      .from("user_stickers")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", stickerId)
      .then(({ error }) => {
        if (error) console.error("Error touching sticker last_used_at:", error);
      });
  }, []);

  return {
    stickers,
    isLoading,
    isConverting,
    isSaving,
    fetchStickers,
    convertToSticker,
    saveStickerBlob,
    saveStickerFromUrl,
    removeSticker,
    touchLastUsed,
  };
}
