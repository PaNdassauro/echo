import { describe, expect, it } from "vitest";
import { thumbHashDataUrl, thumbHashToApproximateAspectRatio } from "./thumbhash";

// Hash gerado com thumbhash@0.1.1 a partir de um degradê 32x24 (ver o pacote vendorizado).
const HASH = "HggKNZpwh3eAeIiHiHiIh3BwCPeH";

describe("thumbhash", () => {
  it("decodifica o hash em uma data URL PNG com a proporção aproximada", () => {
    const url = thumbHashDataUrl(HASH);
    expect(url).toMatch(/^data:image\/png;base64,/);
    const bytes = Uint8Array.from(atob(HASH), (c) => c.charCodeAt(0));
    expect(thumbHashToApproximateAspectRatio(bytes)).toBeCloseTo(1.4, 1);
  });

  it("devolve a mesma string do cache e null para entrada inválida", () => {
    expect(thumbHashDataUrl(HASH)).toBe(thumbHashDataUrl(HASH));
    expect(thumbHashDataUrl(null)).toBeNull();
    expect(thumbHashDataUrl("")).toBeNull();
    expect(thumbHashDataUrl("abc")).toBeNull();
    expect(thumbHashDataUrl("x".repeat(70))).toBeNull();
    expect(thumbHashDataUrl("!!!!!!!!!")).toBeNull();
  });
});
