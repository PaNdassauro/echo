import { supabase } from "@/integrations/supabase/client";
import type { ParsedRow } from "@/lib/importHistoryCsvParser";

// One edge-function call per DB sub-batch (the function inserts in batches of
// 200), keeping each request short-lived. Retrying a chunk is safe: the
// function dedups via upsert DO NOTHING, so rows already applied by a request
// that failed mid-way just count as skipped on the retry.
const CHUNK_SIZE = 200;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000];

export interface ImportTotals {
  inserted: number;
  skipped: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function invokeChunk(conversationId: string, rows: ParsedRow[]): Promise<ImportTotals> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 3_000);
    const { data, error } = await supabase.functions.invoke("import-history", {
      body: {
        conversation_id: conversationId,
        rows: rows.map((r) => ({
          ts: r.ts,
          direction: r.direction,
          content: r.content,
          whatsapp_message_id: r.whatsappMessageId,
          sender_phone: r.senderPhone,
          sender_name: r.senderName,
        })),
      },
    });
    if (!error) {
      const payload = (data ?? {}) as { inserted?: number; skipped?: number };
      return { inserted: payload.inserted ?? 0, skipped: payload.skipped ?? 0 };
    }
    lastError = new Error(error.message || "Falha ao importar.");
  }
  throw lastError ?? new Error("Falha ao importar.");
}

/** Imports parsed CSV rows into a conversation, chunked and with retries. */
export async function importRowsToConversation(
  conversationId: string,
  rows: ParsedRow[],
): Promise<ImportTotals> {
  let inserted = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const totals = await invokeChunk(conversationId, rows.slice(i, i + CHUNK_SIZE));
    inserted += totals.inserted;
    skipped += totals.skipped;
  }
  return { inserted, skipped };
}
