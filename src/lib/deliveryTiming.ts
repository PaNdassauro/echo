/**
 * Hora real de envio de uma mensagem recebida.
 *
 * Na Cloud API, created_at é a hora em que o aviso CHEGOU ao Echo. Quando o
 * webhook recusa avisos (queda do webhook), a Meta os reentrega por dias,
 * e created_at passa a mentir: a mensagem parece recém-enviada e a janela de
 * 24h parece aberta quando a Meta já a considera fechada. O webhook grava a
 * hora do cliente em metadata.sent_at e marca metadata.delivered_late quando o
 * atraso passa de 5 min. created_at continua sendo a chegada de propósito,
 * porque o não-lido compara created_at com last_read_at.
 */
import { z } from "zod";

const DeliveryTimingSchema = z.object({
  sent_at: z.string().datetime({ offset: true }).optional().catch(undefined),
  delivered_late: z.boolean().optional().catch(undefined),
});

export interface DeliveryTiming {
  /** Hora em que o cliente enviou; null quando o metadata não traz. */
  sentAt: Date | null;
  /** A mensagem chegou bem depois de enviada (reentrega da Meta). */
  deliveredLate: boolean;
}

export function parseDeliveryTiming(metadata: unknown): DeliveryTiming {
  if (!metadata || typeof metadata !== "object") return { sentAt: null, deliveredLate: false };
  const parsed = DeliveryTimingSchema.safeParse(metadata);
  if (!parsed.success) return { sentAt: null, deliveredLate: false };
  const sentAt = parsed.data.sent_at ? new Date(parsed.data.sent_at) : null;
  return {
    sentAt: sentAt && !Number.isNaN(sentAt.getTime()) ? sentAt : null,
    deliveredLate: parsed.data.delivered_late === true && sentAt !== null,
  };
}

interface TimedMessage {
  direction: string;
  created_at: string;
  metadata?: unknown;
}

/** Hora do cliente quando conhecida, senão a hora de chegada. */
export function inboundSentAt(message: TimedMessage): Date {
  return parseDeliveryTiming(message.metadata).sentAt ?? new Date(message.created_at);
}

/**
 * Início da janela de 24h: o envio MAIS RECENTE do cliente. Não é a última
 * mensagem recebida pela posição na lista, porque uma reentrega atrasada
 * chega depois de mensagens mais novas.
 */
export function latestInboundSentAt(messages: readonly TimedMessage[]): Date | null {
  let latest: Date | null = null;
  for (const message of messages) {
    if (message.direction !== "inbound") continue;
    const sentAt = inboundSentAt(message);
    if (Number.isNaN(sentAt.getTime())) continue;
    if (!latest || sentAt > latest) latest = sentAt;
  }
  return latest;
}
