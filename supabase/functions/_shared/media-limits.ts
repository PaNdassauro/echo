// Limite e tamanho da mídia que já está no Storage.
//
// O front sobe o arquivo direto para attachments/outbound/<userId>/ e a edge só
// recebe o caminho. O bucket aceita até 1 GB, mas o qr-service baixa o
// media_url sem teto próprio: o teto do envio mora aqui, no MAX_MEDIA_BYTES (o
// mesmo nome e default do qr-service, 50 MB).

export const DEFAULT_MAX_MEDIA_BYTES = 52_428_800;

/** Erro com `code` estável para o front decidir sem ler a frase. */
export class MediaSendError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'MediaSendError';
  }
}

/** MAX_MEDIA_BYTES da env; valor ausente ou inválido cai no default de 50 MB. */
export function maxMediaBytes(raw: string | undefined | null): number {
  if (raw == null || !/^\d+$/.test(raw.trim())) return DEFAULT_MAX_MEDIA_BYTES;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_MEDIA_BYTES;
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1).replace('.', ',')} MB`;
}

export function assertMediaSize(sizeBytes: number, limitBytes: number): void {
  if (sizeBytes > limitBytes) {
    throw new MediaSendError(
      `Arquivo maior que o limite de ${formatMb(limitBytes)}. Envie um arquivo menor.`,
      'media_too_large',
      413,
    );
  }
}

/**
 * Erro do HEAD no objeto público. 400/404 = objeto não existe (o Storage
 * responde 400 "Object not found" em alguns caminhos): o front precisa subir de
 * novo. Outro status é falha passageira e não invalida o que já subiu.
 */
export function storageHeadError(status: number): Error {
  if (status === 400 || status === 404) {
    return new MediaSendError(
      'Arquivo não encontrado no armazenamento. Envie de novo.',
      'storage_object_missing',
      404,
    );
  }
  return new Error(`Não foi possível conferir o arquivo no armazenamento (HTTP ${status}). Tente de novo.`);
}

/** Inteiro não negativo vindo de header, metadata ou formulário; senão null. */
export function parseByteCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{1,16}$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Tamanho do objeto gravado, nesta ordem: content-length do HEAD, metadata da
 * listagem do Storage (servidor) e, por último, o File.size que o front mandou.
 * Nunca devolve 0 por falta de dado: sem nenhuma fonte, recusa o envio.
 */
export async function resolveStoredSize(sources: {
  contentLength: string | null;
  listObjectSize: () => Promise<unknown>;
  clientSize: string | null;
}): Promise<number> {
  // content-length 0 num HEAD é tão suspeito quanto ausente (proxy/CDN que não
  // repassa o tamanho): confere no Storage antes de aceitar 0.
  const fromHead = parseByteCount(sources.contentLength);
  if (fromHead !== null && fromHead > 0) return fromHead;

  let fromStorage: number | null = null;
  try {
    fromStorage = parseByteCount(await sources.listObjectSize());
  } catch (err) {
    console.warn('[SendMedia] Tamanho pela listagem do Storage falhou:', err);
  }
  if (fromStorage !== null) return fromStorage;

  const fromClient = parseByteCount(sources.clientSize);
  if (fromClient !== null) return fromClient;

  throw new Error('Não foi possível conferir o tamanho do arquivo no armazenamento. Tente de novo.');
}
