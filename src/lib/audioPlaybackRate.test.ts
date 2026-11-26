import { afterEach, describe, expect, it } from "vitest";
import {
  PLAYBACK_RATES,
  formatPlaybackRate,
  nextPlaybackRate,
  parsePlaybackRate,
  persistPlaybackRate,
  readStoredPlaybackRate,
  type PlaybackRate,
} from "./audioPlaybackRate";

const STORAGE_KEY = "echo_audio_playback_rate";

afterEach(() => {
  localStorage.clear();
});

describe("parsePlaybackRate", () => {
  it("aceita os três valores válidos", () => {
    expect(parsePlaybackRate("1")).toBe(1);
    expect(parsePlaybackRate("1.5")).toBe(1.5);
    expect(parsePlaybackRate("2")).toBe(2);
  });

  it("cai no padrão 1x para lixo, vazio e null", () => {
    expect(parsePlaybackRate(null)).toBe(1);
    expect(parsePlaybackRate("")).toBe(1);
    expect(parsePlaybackRate("3")).toBe(1);
    expect(parsePlaybackRate("1,5")).toBe(1); // vírgula é só rótulo, não formato de storage
    expect(parsePlaybackRate("Infinity")).toBe(1);
    expect(parsePlaybackRate("-2")).toBe(1);
  });
});

describe("nextPlaybackRate", () => {
  it("cicla 1 → 1,5 → 2 → 1", () => {
    expect(nextPlaybackRate(1)).toBe(1.5);
    expect(nextPlaybackRate(1.5)).toBe(2);
    expect(nextPlaybackRate(2)).toBe(1);
  });

  it("passa por todas as velocidades e volta ao início", () => {
    let rate: PlaybackRate = PLAYBACK_RATES[0];
    const seen: PlaybackRate[] = [rate];
    for (let i = 0; i < PLAYBACK_RATES.length - 1; i++) {
      rate = nextPlaybackRate(rate);
      seen.push(rate);
    }
    expect(seen).toEqual([...PLAYBACK_RATES]);
    expect(nextPlaybackRate(rate)).toBe(PLAYBACK_RATES[0]);
  });
});

describe("formatPlaybackRate", () => {
  it("usa vírgula decimal (pt-BR)", () => {
    expect(formatPlaybackRate(1)).toBe("1x");
    expect(formatPlaybackRate(1.5)).toBe("1,5x");
    expect(formatPlaybackRate(2)).toBe("2x");
  });
});

describe("persistência", () => {
  it("faz round-trip pelo localStorage", () => {
    persistPlaybackRate(2);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("2");
    expect(readStoredPlaybackRate()).toBe(2);

    persistPlaybackRate(1.5);
    expect(readStoredPlaybackRate()).toBe(1.5);
  });

  it("lê 1x quando não há nada salvo", () => {
    expect(readStoredPlaybackRate()).toBe(1);
  });

  it("grava no formato que o parse entende (ponto, não vírgula)", () => {
    persistPlaybackRate(1.5);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1.5");
  });

  it("não estoura quando o localStorage lança (modo privado)", () => {
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const originalSet = proto.setItem;
    const originalGet = proto.getItem;
    proto.setItem = () => {
      throw new DOMException("QuotaExceededError");
    };
    proto.getItem = () => {
      throw new DOMException("SecurityError");
    };

    try {
      expect(() => persistPlaybackRate(2)).not.toThrow();
      expect(readStoredPlaybackRate()).toBe(1);
    } finally {
      proto.setItem = originalSet;
      proto.getItem = originalGet;
    }
  });
});
