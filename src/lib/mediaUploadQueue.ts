/**
 * Fila de envio de mídia fora do dialog.
 *
 * O dialog de mídia só escolhe arquivos e legendas: ao clicar em Enviar, cada
 * arquivo vira um item desta fila e aparece na conversa como bolha pendente
 * (progresso + X para cancelar), enquanto o atendente segue usando o chat.
 *
 * - Store de módulo: sobrevive à troca de conversa (o upload continua).
 * - Em série POR CONVERSA: a ordem de chegada no WhatsApp é a ordem da seleção.
 *   Conversas diferentes sobem em paralelo.
 * - Cancelar só vale enquanto os bytes ainda estão subindo. Depois do último
 *   byte a edge já grava e envia (write não idempotente): abortar ali não
 *   desfaz o envio, então o item fica em `processing`, sem X.
 * - Falha não trava a fila: o item fica `failed` (tentar de novo / descartar) e
 *   o próximo sobe.
 *
 * O transporte é injetado (XHR em produção, fake nos testes).
 */

import type { MediaSize } from "@/lib/mediaSizeCache";

export type UploadStatus = "queued" | "uploading" | "processing" | "failed";

export interface UploadItem {
  id: string;
  conversationId: string;
  file: File;
  /** object URL da prévia ('' para documento). A fila é dona: revoga ao remover. */
  previewUrl: string;
  caption: string;
  status: UploadStatus;
  loaded: number;
  total: number;
  error: string | null;
  /** Posição dentro do lote enviado junto: escalona a entrada das bolhas. */
  batchIndex: number;
  /** Tamanho real medido no navegador (imagem/vídeo); congelado na vida do item. */
  mediaSize?: MediaSize;
}

export interface UploadRequest {
  conversationId: string;
  file: File;
  previewUrl: string;
  caption: string;
  /** Campos do FormData além de `file` (to, phoneNumberId, caption…). */
  fields: Record<string, string>;
  /** Tamanho real medido no navegador (imagem/vídeo); congelado na vida do item. */
  mediaSize?: MediaSize;
}

export interface TransportArgs {
  file: File;
  fields: Record<string, string>;
  signal: AbortSignal;
  onProgress: (loaded: number, total: number) => void;
  /** Último byte saiu do navegador: a partir daqui o servidor já está enviando. */
  onUploaded: () => void;
}

export type UploadTransport = (args: TransportArgs) => Promise<void>;

export interface EnqueueCallbacks {
  onSent?: (item: UploadItem) => void;
  onFailed?: (item: UploadItem, error: unknown) => void;
}

interface Entry {
  item: UploadItem;
  fields: Record<string, string>;
  callbacks: EnqueueCallbacks;
  controller: AbortController | null;
}

const isAbort = (error: unknown) =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : (error as { name?: string })?.name === "AbortError";

export function createUploadQueue(
  transport: UploadTransport,
  options: {
    revokeUrl?: (url: string) => void;
    errorMessage?: (error: unknown) => string;
  } = {},
) {
  const revokeUrl =
    options.revokeUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const errorMessage =
    options.errorMessage ??
    ((error: unknown) =>
      error instanceof Error ? error.message : "Erro ao enviar");

  let entries: Entry[] = [];
  let snapshot: readonly UploadItem[] = [];
  const listeners = new Set<() => void>();
  let seq = 0;
  // Saíram da tela pelo settle() mas o request ainda não voltou: seguram a vez
  // da conversa, senão o próximo arquivo subiria em paralelo e a ordem quebraria.
  const settledInFlight = new Set<Entry>();

  const emit = () => {
    snapshot = entries.map((e) => e.item);
    listeners.forEach((l) => l());
  };

  const find = (id: string) => entries.find((e) => e.item.id === id);

  const patch = (id: string, changes: Partial<UploadItem>) => {
    const entry = find(id);
    if (!entry) return;
    entry.item = { ...entry.item, ...changes };
    emit();
  };

  const remove = (id: string) => {
    const entry = find(id);
    if (!entry) return;
    entries = entries.filter((e) => e !== entry);
    if (entry.item.previewUrl) revokeUrl(entry.item.previewUrl);
    emit();
  };

  const isBusy = (conversationId: string) =>
    [...settledInFlight].some(
      (e) => e.item.conversationId === conversationId,
    ) ||
    entries.some(
      (e) =>
        e.item.conversationId === conversationId &&
        (e.item.status === "uploading" || e.item.status === "processing"),
    );

  const pump = (conversationId: string) => {
    if (isBusy(conversationId)) return;
    const next = entries.find(
      (e) =>
        e.item.conversationId === conversationId && e.item.status === "queued",
    );
    if (next) void run(next);
  };

  const run = async (entry: Entry) => {
    const { id, conversationId } = entry.item;
    const controller = new AbortController();
    entry.controller = controller;
    patch(id, { status: "uploading", loaded: 0, error: null });

    try {
      await transport({
        file: entry.item.file,
        fields: entry.fields,
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (controller.signal.aborted) return;
          patch(id, { loaded, total });
        },
        onUploaded: () => {
          if (controller.signal.aborted) return;
          entry.controller = null; // daqui em diante não se cancela mais
          patch(id, { status: "processing", loaded: entry.item.total });
        },
      });
      const sent = find(id)?.item ?? entry.item;
      remove(id);
      entry.callbacks.onSent?.(sent);
    } catch (error) {
      // Cancelado pelo X: o item já saiu da fila em cancel().
      if (controller.signal.aborted && isAbort(error)) return;
      if (!find(id)) return;
      console.error(
        "[mediaUploadQueue] falha ao enviar",
        entry.item.file.name,
        error,
      );
      entry.controller = null;
      patch(id, { status: "failed", error: errorMessage(error) });
      entry.callbacks.onFailed?.(find(id)!.item, error);
    } finally {
      settledInFlight.delete(entry);
      pump(conversationId);
    }
  };

  return {
    enqueue(
      requests: UploadRequest[],
      callbacks: EnqueueCallbacks = {},
    ): string[] {
      const ids: string[] = [];
      for (const [batchIndex, req] of requests.entries()) {
        const id = `upload-${Date.now().toString(36)}-${(seq++).toString(36)}`;
        ids.push(id);
        entries.push({
          item: {
            id,
            conversationId: req.conversationId,
            file: req.file,
            previewUrl: req.previewUrl,
            caption: req.caption,
            status: "queued",
            loaded: 0,
            total: req.file.size,
            error: null,
            batchIndex,
            mediaSize: req.mediaSize ? { ...req.mediaSize } : undefined,
          },
          fields: req.fields,
          callbacks,
          controller: null,
        });
      }
      emit();
      new Set(requests.map((r) => r.conversationId)).forEach(pump);
      return ids;
    },

    /** X da bolha. Na fila ou subindo: some. Já no servidor: não cancela. */
    cancel(id: string): boolean {
      const entry = find(id);
      if (!entry) return false;
      const { status, conversationId } = entry.item;
      if (status === "processing") return false;
      entry.controller?.abort();
      remove(id);
      if (status === "uploading") pump(conversationId);
      return true;
    },

    /**
     * A mensagem real já chegou pelo realtime (antes da resposta HTTP, que ainda
     * espera webhooks): some com a bolha pendente no mesmo render, para as duas
     * não aparecerem juntas. O `run` segue e termina sem efeito visual.
     */
    settle(id: string) {
      const entry = find(id);
      if (!entry || entry.item.status !== "processing") return;
      settledInFlight.add(entry);
      remove(id);
    },

    retry(id: string) {
      const entry = find(id);
      if (!entry || entry.item.status !== "failed") return;
      patch(id, { status: "queued", loaded: 0, error: null });
      pump(entry.item.conversationId);
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot(): readonly UploadItem[] {
      return snapshot;
    },

    /** Algo ainda subindo ou na fila (fechar a aba perderia o envio). */
    hasPending(): boolean {
      return entries.some((e) => e.item.status !== "failed");
    },
  };
}

export type UploadQueue = ReturnType<typeof createUploadQueue>;

interface DeliveredCandidate {
  id: string;
  direction: string;
  media_filename?: string | null;
}

/**
 * Casa item pendente com a mensagem real que o realtime já trouxe.
 *
 * Ao ver um item em `processing` pela primeira vez, guarda os ids das mensagens
 * que já estavam na conversa: só uma mensagem NOVA depois disso, de saída e com
 * o mesmo nome de arquivo, conta como a entrega dele. Assim reenviar o mesmo
 * arquivo não casa com o envio antigo. Cada mensagem vale para um item só.
 * Sem par (a mensagem chegou antes do `processing`), a bolha sai pela resposta
 * HTTP, como antes.
 */
export function createDeliveryMatcher() {
  const baselines = new Map<string, ReadonlySet<string>>();
  const claimed = new Set<string>();

  return (
    items: readonly UploadItem[],
    messages: readonly DeliveredCandidate[],
    conversationId: string,
  ): string[] => {
    const live = new Set(items.map((i) => i.id));
    for (const id of baselines.keys()) if (!live.has(id)) baselines.delete(id);

    const settled: string[] = [];
    for (const item of items) {
      if (
        item.conversationId !== conversationId ||
        item.status !== "processing"
      )
        continue;
      const baseline = baselines.get(item.id);
      if (!baseline) {
        baselines.set(item.id, new Set(messages.map((m) => m.id)));
        continue;
      }
      const match = messages.find(
        (m) =>
          !baseline.has(m.id) &&
          !claimed.has(m.id) &&
          m.direction === "outbound" &&
          m.media_filename === item.file.name,
      );
      if (match) {
        claimed.add(match.id);
        settled.push(item.id);
      }
    }
    return settled;
  };
}
