/**
 * Validação de integridade de áudios gravados antes de preview ou envio.
 *
 * Um container Ogg Opus vazio (somente páginas OpusHead e OpusTags sem nenhum
 * pacote de áudio) possui exatamente 128 bytes. Um áudio com pelo menos 0,5s
 * de fala em taxa padrão Opus ocupa > 1.500 bytes. Arquivos com < 512 bytes
 * não possuem dados de áudio válidos.
 */

export const MIN_AUDIO_BYTES = 512;
export const MIN_AUDIO_DURATION_S = 0.5;

export type AudioValidationReason = "missing" | "too_small" | "invalid_duration";

export interface AudioValidationResult {
  valid: boolean;
  reason?: AudioValidationReason;
}

export function validateAudioBlob(
  blob: Blob | null | undefined,
  duration?: number
): AudioValidationResult {
  if (!blob) {
    return { valid: false, reason: "missing" };
  }

  if (blob.size < MIN_AUDIO_BYTES) {
    return { valid: false, reason: "too_small" };
  }

  if (duration !== undefined) {
    if (!Number.isFinite(duration) || Number.isNaN(duration) || duration < MIN_AUDIO_DURATION_S) {
      return { valid: false, reason: "invalid_duration" };
    }
  }

  return { valid: true };
}

export function isValidAudioBlob(
  blob: Blob | null | undefined,
  duration?: number
): boolean {
  return validateAudioBlob(blob, duration).valid;
}
