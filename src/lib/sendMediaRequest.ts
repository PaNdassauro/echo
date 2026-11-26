import { functionUrl, getRuntimeConfig } from "@/lib/runtimeConfig";

/**
 * POST multipart para a edge `whatsapp-send-media`, com o JWT da sessão e a
 * chave anon (o gateway exige as duas). Ponto único: reenvio, áudio, figurinha
 * e a fila de mídia montam o FormData e passam por aqui.
 */
export function postSendMedia(formData: FormData, accessToken: string, signal?: AbortSignal): Promise<Response> {
  return fetch(functionUrl("whatsapp-send-media"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: getRuntimeConfig().supabaseAnonKey,
    },
    body: formData,
    signal,
  });
}
