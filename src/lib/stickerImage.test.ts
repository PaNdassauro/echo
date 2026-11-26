import { describe, expect, it } from "vitest";

import { isAnimatedWebp, sha256Hex } from "./stickerImage";

// Monta um header webp mínimo em memória — só o que isAnimatedWebp lê.
function webpBytes({
  chunk = "VP8X",
  flags = 0,
}: {
  chunk?: string;
  flags?: number;
} = {}): Uint8Array {
  const bytes = new Uint8Array(32);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  write(0, "RIFF");
  write(8, "WEBP");
  write(12, chunk);
  bytes[20] = flags;
  return bytes;
}

describe("sha256Hex", () => {
  it("computes the well-known hash of an empty buffer", async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("computes the well-known hash of 'abc'", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("isAnimatedWebp", () => {
  it("detects the VP8X animation flag", () => {
    expect(isAnimatedWebp(webpBytes({ flags: 0x02 }))).toBe(true);
  });

  it("rejects a static VP8X webp (alpha flag only)", () => {
    expect(isAnimatedWebp(webpBytes({ flags: 0x10 }))).toBe(false);
  });

  it("detects an ANIM chunk even without the flag", () => {
    const bytes = new Uint8Array(64);
    const write = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
    };
    write(0, "RIFF");
    write(8, "WEBP");
    write(12, "VP8X");
    write(30, "ANIM");
    expect(isAnimatedWebp(bytes)).toBe(true);
  });

  it("rejects a simple lossy webp (VP8 chunk)", () => {
    expect(isAnimatedWebp(webpBytes({ chunk: "VP8 " }))).toBe(false);
  });

  it("rejects non-webp bytes (PNG magic)", () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isAnimatedWebp(png)).toBe(false);
  });

  it("rejects buffers shorter than a VP8X header", () => {
    expect(isAnimatedWebp(new Uint8Array(10))).toBe(false);
  });
});
