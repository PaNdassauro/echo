import { pairingPhoneSchema } from "@/lib/pairingPhone";
import { getLookupVariations } from "@/lib/phone";

/**
 * Telefone digitado à mão nos fluxos de grupo (criar grupo / adicionar membro).
 *
 * Existe para acabar com duas divergências que já geraram participante inválido
 * em produção:
 *
 * 1. O input do GroupInfoPanel mandava o valor CRU para a API — espaço, letra e
 *    número truncado chegavam ao WhatsApp. O do CreateGroupDialog tirava os
 *    não-dígitos mas não checava comprimento.
 * 2. O dedupe manual comparava string exata enquanto o picker comparava com
 *    tolerância ao 9º dígito, então "5511999999999" digitado não colidia com
 *    "551199999999" escolhido na lista — a mesma pessoa entrava duas vezes.
 *
 * A regra de comprimento NÃO é reescrita aqui: `pairingPhoneSchema` já a define
 * (10–15 dígitos, mensagens em português) e uma segunda cópia divergiria.
 */

/** Teto de dígitos do E.164 — evita colar um texto inteiro no campo. */
const MAX_DIGITS = 15;

/**
 * Sanitiza o que o usuário digita/cola: só dígitos, cortado no tamanho máximo.
 * Aplicado no `onChange`, então caractere inválido nunca chega ao state.
 */
export const sanitizeParticipantInput = (raw: string): string =>
  String(raw ?? "").replace(/\D/g, "").slice(0, MAX_DIGITS);

/** Mesma regra do pareamento por código: dígitos E.164 sem '+', 10–15. */
export const participantPhoneSchema = pairingPhoneSchema;

export interface ParticipantPhoneCheck {
  ok: boolean;
  /** Telefone normalizado (dígitos E.164 sem '+'); vazio quando inválido. */
  phone: string;
  /** Mensagem pronta para exibição; null quando válido. */
  error: string | null;
}

/**
 * Valida o número digitado — nunca lança.
 *
 * `error` é sempre um campo presente (e não um braço de união discriminada)
 * porque o resultado é lido direto dentro do JSX, onde o TS não estreita a
 * união através de um `&&`.
 */
export const validateParticipantPhone = (raw: string): ParticipantPhoneCheck => {
  const result = participantPhoneSchema.safeParse(raw ?? "");
  if (result.success) return { ok: true, phone: result.data, error: null };
  return {
    ok: false,
    phone: "",
    error: result.error.issues[0]?.message ?? "Número inválido",
  };
};

/**
 * A mesma pessoa já está na lista? Compara pelas variações de telefone
 * (com/sem 55, com/sem o 9º dígito) usando `getLookupVariations`, que espelha
 * `phone_lookup_variations()` no banco — a mesma tolerância do picker.
 */
export const isDuplicateParticipant = (phone: string, existing: string[]): boolean => {
  const digits = sanitizeParticipantInput(phone);
  if (!digits) return false;

  const candidateKeys = new Set(getLookupVariations(digits));
  return existing.some((other) => {
    const otherDigits = sanitizeParticipantInput(other);
    if (!otherDigits) return false;
    return getLookupVariations(otherDigits).some((key) => candidateKeys.has(key));
  });
};
