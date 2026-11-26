import { useMemo, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toUserMessage } from "@/lib/userFacingError";
import { MediaHintSchema } from "@/lib/mediaBox";
import { seedMediaSize } from "@/lib/mediaSizeCache";
import { createUploadQueue, type UploadItem, type UploadTransport } from "@/lib/mediaUploadQueue";
import { sanitizeFilename } from "@/lib/scheduledMedia";
import { getRuntimeConfig, publicAttachmentUrl, storageUrl } from "@/lib/runtimeConfig";
import { postSendMedia } from "@/lib/sendMediaRequest";

const storageErrorMessage = (status: number, body: { message?: string; error?: string } | null) => {
  const raw = `${body?.error ?? ""} ${body?.message ?? ""}`.toLowerCase();
  if (status === 413 || raw.includes("too large") || raw.includes("maximum allowed size")) {
    return "Arquivo maior que o limite permitido.";
  }
  if (raw.includes("mime")) return "Tipo de arquivo não aceito.";
  return `Não foi possível subir o arquivo (HTTP ${status}).`;
};

const parseJson = (text: string): { error?: string; message?: string } | null => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Arquivo que já subiu: tentar de novo pula direto para o envio.
const uploadedPaths = new WeakMap<File, string>();

/**
 * Transporte da fila de mídia, em duas etapas:
 * 1. o arquivo sobe DIRETO para o Storage (attachments/outbound/<userId>/) por
 *    XHR, que é o que expõe o progresso em bytes. Cancelável;
 * 2. a edge whatsapp-send-media recebe só o caminho (`storagePath`) e envia.
 *    Com o arquivo no corpo da edge, mídia grande estourava a memória do
 *    worker (HTTP 546).
 * Token lido a cada item: numa fila de centenas de MB a sessão pode renovar.
 */
const xhrTransport: UploadTransport = async ({ file, fields, signal, onProgress, onUploaded }) => {
  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  const userId = session?.user?.id;
  if (!accessToken || !userId) throw new Error("Sessão expirada. Entre de novo para enviar mídia.");
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const apikey = getRuntimeConfig().supabaseAnonKey;

  let storagePath = uploadedPaths.get(file);
  if (!storagePath) {
    const path = `outbound/${userId}/${Date.now()}_${sanitizeFilename(file.name)}`;
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", storageUrl(`object/attachments/${path}`));
      xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
      xhr.setRequestHeader("apikey", apikey);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("x-upsert", "false");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(storageErrorMessage(xhr.status, parseJson(xhr.responseText))));
      };
      xhr.onerror = () => reject(new Error("Falha de rede ao enviar o arquivo"));
      xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
      xhr.send(file);
    });
    storagePath = path;
    uploadedPaths.set(file, path);
  }

  // Daqui em diante a edge grava e envia: não se cancela mais.
  onUploaded();

  // Semente do cache de tamanho com a URL pública FINAL (a mesma do getPublicUrl da edge): a mensagem real pode chegar pelo realtime antes da resposta da edge e já nasce com a caixa certa.
  const hint = MediaHintSchema.safeParse({ width: fields.mediaWidth, height: fields.mediaHeight });
  if (hint.success) seedMediaSize(publicAttachmentUrl(storagePath), hint.data.width, hint.data.height);

  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.append(key, value);
  formData.append("storagePath", storagePath);
  formData.append("filename", file.name);
  formData.append("mimeType", file.type || "application/octet-stream");

  const response = await postSendMedia(formData, accessToken);
  const body = parseJson(await response.text());
  if (!response.ok) throw new Error(body?.error || `Erro ao enviar mídia (HTTP ${response.status})`);
};

export const mediaUploadQueue = createUploadQueue(xhrTransport, {
  errorMessage: (error) => toUserMessage(error, "Verifique a conexão e tente de novo."),
});

// Fechar a aba mata o XHR: pede confirmação enquanto houver envio em andamento.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (!mediaUploadQueue.hasPending()) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

const EMPTY: readonly UploadItem[] = [];

/** Envios pendentes de uma conversa, na ordem da fila. */
export function useConversationUploads(conversationId: string | null | undefined): readonly UploadItem[] {
  const all = useSyncExternalStore(mediaUploadQueue.subscribe, mediaUploadQueue.getSnapshot);
  return useMemo(
    () => (conversationId ? all.filter((i) => i.conversationId === conversationId) : EMPTY),
    [all, conversationId],
  );
}
