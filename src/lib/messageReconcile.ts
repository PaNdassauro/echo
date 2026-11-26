/**
 * Reconciliação da bolha otimista com a linha real da mensagem.
 *
 * O envio cria uma bolha `temp-…` na hora; a linha real chega depois por três
 * caminhos, em qualquer ordem: o INSERT do realtime, a página do
 * `syncNewMessages` (reconexão do canal, volta à aba) e a resposta do
 * `whatsapp-send`. Todos passam por aqui. Um caminho que anexava por `id`
 * deixava a temp "sent" (✓) ao lado da linha real (✓✓): bolha fantasma.
 */

export interface ReconcilableMessage {
  id: string;
  direction: "inbound" | "outbound";
  status?: string;
  content?: string | null;
  whatsapp_message_id?: string | null;
  /** Identidade React estável da bolha; a linha real herda a da temp. */
  clientKey?: string;
}

export const isOptimisticId = (id: string) => id.startsWith("temp-");

/**
 * `whatsapp-send` prefixa o corpo com o nome do agente quando o número tem
 * `append_agent_name`. A bolha otimista guarda o texto que o usuário digitou,
 * então comparar conteúdo cru nunca casa e a linha real entra como 2ª bolha.
 */
const AGENT_NAME_HEADER = /^\*[^*\n]+\*\n\n/;
export const stripAgentNameHeader = (content: string) => content.replace(AGENT_NAME_HEADER, "");

/**
 * Bolha local que é a mesma mensagem que `incoming`: por wamid (preciso; cobre
 * a temp já promovida pela resposta E o retry de linha persistida cuja linha
 * antiga o servidor apagou na corrida com o eco do Baileys) ou por conteúdo de
 * uma temp sem wamid: "sending" (a linha real chegou antes da resposta) ou
 * "error" (o invoke estourou no navegador, mas o servidor já tinha enviado e
 * gravado — sem isto a bolha de erro ficava ao lado da real).
 */
export function findOptimisticMatch<M extends ReconcilableMessage>(
  prev: M[],
  incoming: M,
): M | undefined {
  if (incoming.direction !== "outbound") return undefined;
  return prev.find(
    (m) =>
      (m.id !== incoming.id &&
        m.direction === "outbound" &&
        !!incoming.whatsapp_message_id &&
        m.whatsapp_message_id === incoming.whatsapp_message_id) ||
      (isOptimisticId(m.id) &&
        m.direction === "outbound" &&
        (m.status === "sending" || m.status === "error") &&
        // Compara cru E normalizado: só normalizado quebraria o caso de
        // append_agent_name desligado com texto que o próprio usuário começou
        // com *negrito* + linha em branco.
        (m.content === incoming.content ||
          m.content === stripAgentNameHeader(incoming.content ?? ""))),
  );
}

/**
 * Encaixa uma linha real na lista: já existe pelo id → lista intacta (mesma
 * referência); casa com uma bolha local → substitui NO LUGAR, herdando o
 * clientKey para o nó não remontar nem reanimar; senão, anexa no fim.
 */
export function mergeIncomingMessage<M extends ReconcilableMessage>(prev: M[], incoming: M): M[] {
  if (prev.some((m) => m.id === incoming.id)) return prev;
  const match = findOptimisticMatch(prev, incoming);
  if (match) {
    return prev.map((m) =>
      m.id === match.id ? { ...incoming, clientKey: match.clientKey ?? match.id } : m,
    );
  }
  return [...prev, incoming];
}

/**
 * Resposta do `whatsapp-send` para a bolha `tempId`. Se a linha real já chegou
 * (mesmo wamid), a temp é órfã e sai: promovê-la a "sent" é o que congela a
 * bolha duplicada pelo resto da sessão. Senão a temp progride sending→sent
 * com o wamid, e o próximo caminho (realtime ou sync) a casa por ele.
 */
export function settleOptimistic<M extends ReconcilableMessage>(
  prev: M[],
  tempId: string,
  wamid: string | null,
): M[] {
  // `m.id !== tempId`: no retry, o UPDATE do realtime pode ter mergeado o wamid
  // novo na própria linha. Sem o guard ela casaria consigo mesma e sumiria.
  const landed = wamid
    ? prev.find((m) => !isOptimisticId(m.id) && m.id !== tempId && m.whatsapp_message_id === wamid)
    : undefined;

  if (landed) {
    const orphan = prev.find((m) => m.id === tempId);
    return prev
      .filter((m) => m.id !== tempId)
      // Herda a identidade da bolha para a lista não reanimar a linha real.
      .map((m) =>
        m.id === landed.id ? { ...m, clientKey: orphan?.clientKey ?? m.clientKey } : m,
      );
  }

  return prev.map((m) =>
    m.id === tempId
      ? { ...m, status: "sent", whatsapp_message_id: wamid ?? m.whatsapp_message_id }
      : m,
  );
}

/**
 * Normaliza a linha crua de `messages` (payload do realtime ou select sem join)
 * como o transformMessages faz: `failed` vira `error` e `error_message` vira
 * `error`. Linha com error_message null (reenvio com sucesso) limpa o erro.
 */
export function normalizeMessageRow<R extends { status?: string | null; error_message?: string | null }>(
  row: R,
): R & { status: string | undefined; error: string | undefined } {
  return {
    ...row,
    status: row.status === "failed" ? "error" : (row.status ?? undefined),
    error: row.error_message || undefined,
  };
}

/** Campos que mudam numa mensagem já gravada (recibo, falha, edição, apagado, reação). */
const REFRESHABLE_FIELDS = [
  "status",
  "error",
  "content",
  "message_type",
  "media_url",
  "is_edited",
  "edited_at",
  "is_deleted",
  "deleted_at",
  "reaction",
  "our_reaction",
  "whatsapp_message_id",
  "metadata",
] as const;

const sameValue = (a: unknown, b: unknown) =>
  a === b || ((a ?? null) === null && (b ?? null) === null) ||
  (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

/**
 * Aplica uma releitura das últimas linhas da conversa às bolhas que já estão
 * na lista — o equivalente aos UPDATEs do realtime que se perderam (✓ → ✓✓ →
 * lido, falha, edição, apagado para todos). Só toca bolhas existentes pelo id:
 * linha nova é papel do sync. Preserva o que o select cru não traz (quoted_*,
 * clientKey). Sem mudança, devolve a mesma referência (sem re-render).
 */
export function mergeRefreshedRows<M extends { id: string }>(
  prev: M[],
  rows: Array<Record<string, unknown> & { id: string }>,
): M[] {
  if (rows.length === 0) return prev;
  const byId = new Map(rows.map((r) => [r.id, normalizeMessageRow(r as { status?: string | null; error_message?: string | null }) as Record<string, unknown>]));
  let changed = false;
  const next = prev.map((m) => {
    const fresh = byId.get(m.id);
    if (!fresh) return m;
    const current = m as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const field of REFRESHABLE_FIELDS) {
      if (field in fresh && !sameValue(current[field], fresh[field])) patch[field] = fresh[field];
    }
    if (Object.keys(patch).length === 0) return m;
    changed = true;
    return { ...m, ...patch } as M;
  });
  return changed ? next : prev;
}
