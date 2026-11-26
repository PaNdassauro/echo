import { supabase } from "@/integrations/supabase/client";

/**
 * Cliente da edge function `mirror-group-history`.
 *
 * `invoke()` não devolve o corpo da resposta quando o status é de erro — a
 * mensagem real vem em `error.context`, que precisa ser lido para o usuário não
 * ver só "Edge Function returned a non-2xx status code".
 */

export interface MirrorTotals {
  inserted: number;
  skipped: number;
  total: number;
  /** Citações religadas pelo wamid — ver relinkQuotes na edge function. */
  quotesRelinked: number;
  hasMore: boolean;
}

/** Quantas chamadas encadeadas antes de desistir — cada uma cobre 5k mensagens. */
const MAX_PAGES = 20;

async function readErrorMessage(error: unknown): Promise<string> {
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    try {
      const body = (await context.clone().json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      // Corpo não-JSON: cai na mensagem genérica abaixo.
    }
  }
  return (error as { message?: string })?.message || "Falha ao espelhar o histórico.";
}

async function invokeMirror(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("mirror-group-history", { body });
  if (error) throw new Error(await readErrorMessage(error));
  return data as Record<string, unknown>;
}

/** Quantas mensagens seriam copiadas — usado no preview antes de confirmar. */
export async function countMirrorableMessages(
  sourceConversationId: string,
  targetConversationId: string,
  since: string | null
): Promise<number> {
  const data = await invokeMirror({
    source_conversation_id: sourceConversationId,
    target_conversation_id: targetConversationId,
    since,
    count_only: true,
  });
  return Number(data?.total ?? 0);
}

/**
 * Copia o histórico. Grupos antigos passam do teto por chamada, então repete
 * enquanto `has_more` — cada repetição é idempotente (upsert DO NOTHING), o que
 * também torna o retry seguro.
 */
export async function mirrorGroupHistory(
  sourceConversationId: string,
  targetConversationId: string,
  since: string | null,
  onProgress?: (processed: number) => void
): Promise<MirrorTotals> {
  const totals: MirrorTotals = {
    inserted: 0,
    skipped: 0,
    total: 0,
    quotesRelinked: 0,
    hasMore: false,
  };
  let after: { created_at: string; id: string } | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await invokeMirror({
      source_conversation_id: sourceConversationId,
      target_conversation_id: targetConversationId,
      since,
      count_only: false,
      ...(after ? { after } : {}),
    });

    totals.inserted += Number(data?.inserted ?? 0);
    totals.skipped += Number(data?.skipped ?? 0);
    totals.total += Number(data?.total ?? 0);
    totals.quotesRelinked += Number(data?.quotes_relinked ?? 0);
    onProgress?.(totals.total);

    const nextAfter = data?.next_after as { created_at: string; id: string } | null | undefined;
    // Sem cursor não há como avançar: parar em vez de reler o mesmo bloco.
    if (data?.has_more !== true || !nextAfter) return totals;
    after = nextAfter;
  }

  totals.hasMore = true;
  return totals;
}
