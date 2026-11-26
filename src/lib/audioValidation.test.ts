import { describe, it, expect } from "vitest";
import {
  MIN_AUDIO_BYTES,
  MIN_AUDIO_DURATION_S,
  validateAudioBlob,
  isValidAudioBlob,
} from "./audioValidation";

describe("audioValidation", () => {
  it("rejeita blob nulo ou indefinido", () => {
    expect(validateAudioBlob(null)).toEqual({ valid: false, reason: "missing" });
    expect(validateAudioBlob(undefined)).toEqual({ valid: false, reason: "missing" });
    expect(isValidAudioBlob(null)).toBe(false);
  });

  it("rejeita áudio vazio ou menor que MIN_AUDIO_BYTES (ex.: 128 bytes de header vazio)", () => {
    // 128 bytes é o tamanho exato do container OpusHead + OpusTags vazio
    const emptyOggHeaderBlob = new Blob([new Uint8Array(128)], { type: "audio/ogg" });
    expect(validateAudioBlob(emptyOggHeaderBlob)).toEqual({ valid: false, reason: "too_small" });
    expect(isValidAudioBlob(emptyOggHeaderBlob)).toBe(false);

    const zeroBlob = new Blob([], { type: "audio/ogg" });
    expect(validateAudioBlob(zeroBlob)).toEqual({ valid: false, reason: "too_small" });
    expect(isValidAudioBlob(zeroBlob)).toBe(false);

    const boundaryBlob = new Blob([new Uint8Array(MIN_AUDIO_BYTES - 1)], { type: "audio/ogg" });
    expect(validateAudioBlob(boundaryBlob)).toEqual({ valid: false, reason: "too_small" });
    expect(isValidAudioBlob(boundaryBlob)).toBe(false);
  });

  it("aceita áudio com tamanho válido sem duração informada", () => {
    const validBlob = new Blob([new Uint8Array(MIN_AUDIO_BYTES)], { type: "audio/ogg" });
    expect(validateAudioBlob(validBlob)).toEqual({ valid: true });
    expect(isValidAudioBlob(validBlob)).toBe(true);

    const normalVoiceBlob = new Blob([new Uint8Array(10000)], { type: "audio/ogg" });
    expect(validateAudioBlob(normalVoiceBlob)).toEqual({ valid: true });
    expect(isValidAudioBlob(normalVoiceBlob)).toBe(true);
  });

  it("valida duração quando fornecida", () => {
    const validBlob = new Blob([new Uint8Array(2000)], { type: "audio/ogg" });

    // Duração zero
    expect(validateAudioBlob(validBlob, 0)).toEqual({
      valid: false,
      reason: "invalid_duration",
    });
    expect(isValidAudioBlob(validBlob, 0)).toBe(false);

    // Duração NaN ou infinita
    expect(validateAudioBlob(validBlob, NaN)).toEqual({
      valid: false,
      reason: "invalid_duration",
    });
    expect(validateAudioBlob(validBlob, Infinity)).toEqual({
      valid: false,
      reason: "invalid_duration",
    });

    // Duração menor que 0.5s
    expect(validateAudioBlob(validBlob, 0.2)).toEqual({
      valid: false,
      reason: "invalid_duration",
    });
    expect(isValidAudioBlob(validBlob, 0.2)).toBe(false);

    // Duração válida
    expect(validateAudioBlob(validBlob, MIN_AUDIO_DURATION_S)).toEqual({ valid: true });
    expect(validateAudioBlob(validBlob, 2.5)).toEqual({ valid: true });
    expect(isValidAudioBlob(validBlob, 2.5)).toBe(true);
  });
});
