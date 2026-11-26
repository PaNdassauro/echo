import { z } from "zod";

/**
 * Arquivo de um agendamento `message_type = 'media'` (coluna `scheduled_messages.media`,
 * baseline). Par do `ItemAgendadoSchema` em
 * supabase/functions/scheduled-message-execute/arquivos.ts: mudar nos dois.
 */
const Dimensao = z.number().int().min(1).max(65535);

/**
 * Tetos que o executor confere na hora de mandar (Zod em arquivos.ts e
 * MAX_MEDIA_BYTES/DEFAULT_MAX_MEDIA_BYTES em _shared/media-limits.ts). Conferidos
 * também na hora de agendar: senão o erro só aparece horas depois, no horário.
 */
export const MAX_SCHEDULED_FILE_BYTES = 52_428_800;
export const MAX_SCHEDULED_CAPTION = 4096;
export const MAX_SCHEDULED_FILENAME = 255;

export const ScheduledMediaItemSchema = z
  .object({
    storage_path: z.string().min(1).max(1024),
    filename: z.string().min(1).max(MAX_SCHEDULED_FILENAME),
    mime_type: z.string().min(1).max(255),
    size_bytes: z.number().int().nonnegative(),
    caption: z.string().max(MAX_SCHEDULED_CAPTION).nullish(),
    width: Dimensao.nullish(),
    height: Dimensao.nullish(),
    view_once: z.boolean().nullish(),
    whatsapp_message_id: z.string().nullish(),
  })
  .passthrough();

export type ScheduledMediaItem = z.infer<typeof ScheduledMediaItemSchema>;

/**
 * Item como o front grava ao agendar (o executor acrescenta `whatsapp_message_id`).
 * `type` e não `interface`: só assim o objeto entra no `Json` da coluna.
 */
export type NewScheduledMediaItem = {
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  caption?: string;
  width?: number;
  height?: number;
  view_once?: boolean;
};

/** Mesmo teto do diálogo de anexo e do CHECK do banco. */
export const MAX_SCHEDULED_FILES = 30;

/** Primeiro motivo para recusar o agendamento, em frase para o atendente; null = ok. */
export function scheduledFilesProblem(files: Array<{ name: string; size: number; caption?: string }>): string | null {
  if (files.length === 0) return "Escolha pelo menos um arquivo.";
  if (files.length > MAX_SCHEDULED_FILES) return `Agende no máximo ${MAX_SCHEDULED_FILES} arquivos de uma vez.`;
  for (const file of files) {
    if (file.size > MAX_SCHEDULED_FILE_BYTES) {
      return `${file.name} passa de ${MAX_SCHEDULED_FILE_BYTES / 1024 / 1024} MB. Agende um arquivo menor.`;
    }
    if (file.name.length > MAX_SCHEDULED_FILENAME) {
      return `O nome de ${file.name.slice(0, 40)}… é longo demais. Renomeie o arquivo e agende de novo.`;
    }
    if ((file.caption?.trim().length ?? 0) > MAX_SCHEDULED_CAPTION) {
      return `A legenda de ${file.name} passa de ${MAX_SCHEDULED_CAPTION} caracteres. Encurte a legenda.`;
    }
  }
  return null;
}

/** Lista de arquivos de uma linha vinda do banco/realtime. Forma inválida = lista vazia. */
export function parseScheduledMedia(raw: unknown): ScheduledMediaItem[] {
  const parsed = z.array(ScheduledMediaItemSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/** Mesma regra do `sanitizeFilename` da edge whatsapp-send-media. */
export const sanitizeFilename = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9.-]/g, "_")
    .replace(/_{2,}/g, "_");

/**
 * Caminho no bucket `attachments`: a pasta do próprio usuário (a única que a policy
 * `attachments_insert_prefixos` aceita e que o executor confere contra o created_by).
 * O índice evita colisão entre arquivos de mesmo nome subidos no mesmo milissegundo.
 */
export function scheduledMediaPath(userId: string, fileName: string, index: number, now = Date.now()): string {
  return `outbound/${userId}/${now}_${index}_${sanitizeFilename(fileName)}`;
}

/** Linha curta para listas: "proposta.pdf", "proposta.pdf + 2 arquivos", ou a legenda do primeiro. */
export function scheduledMediaSummary(items: ScheduledMediaItem[]): string {
  if (items.length === 0) return "Arquivo";
  const first = items[0].caption?.trim() || items[0].filename;
  if (items.length === 1) return first;
  const rest = items.length - 1;
  return `${first} + ${rest} ${rest === 1 ? "arquivo" : "arquivos"}`;
}

/** Caminhos que ainda não saíram: os que dá para apagar ao cancelar (o resto é mídia de bolha enviada). */
export function unsentScheduledPaths(items: ScheduledMediaItem[]): string[] {
  return items.filter((item) => !item.whatsapp_message_id).map((item) => item.storage_path);
}
