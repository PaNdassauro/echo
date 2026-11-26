import { beforeEach, describe, expect, it } from "vitest";
import {
  MediaDimensionsSchema,
  boxedMediaKind,
  createMediaBoxLocks,
  mediaBoxForSize,
  parseMediaDimensions,
  resolveMediaBox,
} from "./mediaBox";
import { clearMediaSizes, rememberMediaSize } from "./mediaSizeCache";

beforeEach(() => clearMediaSizes());

describe("MediaDimensionsSchema", () => {
  it("aceita dimensões válidas", () => {
    expect(MediaDimensionsSchema.safeParse({ width: 1200, height: 800 }).success).toBe(true);
    expect(MediaDimensionsSchema.safeParse({ width: 10, height: 10, seconds: 3.5, source: "proto" }).success).toBe(true);
  });

  it("rejeita valores inválidos", () => {
    for (const bad of [0, -1, 1.5, "300", NaN, 65536]) {
      expect(MediaDimensionsSchema.safeParse({ width: bad, height: 10 }).success).toBe(false);
    }
    expect(MediaDimensionsSchema.safeParse({ width: 10 }).success).toBe(false);
  });

  it("remove chaves desconhecidas", () => {
    expect(MediaDimensionsSchema.parse({ width: 1, height: 2, extra: true })).toEqual({ width: 1, height: 2 });
  });
});

describe("parseMediaDimensions", () => {
  it("devolve undefined para lixo", () => {
    expect(parseMediaDimensions(null)).toBeUndefined();
    expect(parseMediaDimensions({})).toBeUndefined();
    expect(parseMediaDimensions({ media: "x" })).toBeUndefined();
  });
  it("lê metadata.media", () => {
    expect(parseMediaDimensions({ media: { width: 5, height: 6 } })).toEqual({ width: 5, height: 6 });
  });
});

describe("boxedMediaKind", () => {
  it("só os três tipos", () => {
    expect(boxedMediaKind("image")).toBe("image");
    expect(boxedMediaKind("sticker")).toBe("sticker");
    expect(boxedMediaKind("video")).toBe("video");
    expect(boxedMediaKind("audio")).toBeNull();
    expect(boxedMediaKind(undefined)).toBeNull();
  });
});

describe("mediaBoxForSize", () => {
  it("imagem", () => {
    expect(mediaBoxForSize("image", { width: 1200, height: 800 })).toEqual({ width: 300, height: 200, fit: "cover", source: "metadata" });
    expect(mediaBoxForSize("image", { width: 120, height: 80 })).toMatchObject({ width: 120, height: 80 });
    expect(mediaBoxForSize("image", { width: 3000, height: 100 })).toMatchObject({ width: 300, height: 40 });
    expect(mediaBoxForSize("image")).toEqual({ width: 240, height: 240, fit: "contain", source: "fallback" });
  });
  it("figurinha", () => {
    expect(mediaBoxForSize("sticker", { width: 10, height: 10 })).toEqual({ width: 160, height: 160, fit: "contain", source: "fixed" });
  });
  it("vídeo", () => {
    expect(mediaBoxForSize("video", { width: 1920, height: 1080 })).toMatchObject({ width: 300, height: 169, fit: "contain" });
    expect(mediaBoxForSize("video", { width: 360, height: 640 })).toMatchObject({ width: 169, height: 300 });
    expect(mediaBoxForSize("video")).toEqual({ width: 300, height: 169, fit: "contain", source: "fallback" });
  });
});

describe("resolveMediaBox", () => {
  const url = "https://x/a.png";
  it("metadata vence o cache", () => {
    rememberMediaSize(url, 100, 100);
    const b = resolveMediaBox({ kind: "image", url, metadata: { media: { width: 1200, height: 800 } } });
    expect(b).toMatchObject({ width: 300, height: 200, source: "metadata" });
  });
  it("cache vence o fallback", () => {
    rememberMediaSize(url, 100, 50);
    expect(resolveMediaBox({ kind: "image", url, metadata: null })).toMatchObject({ width: 100, height: 50, source: "cache" });
    expect(resolveMediaBox({ kind: "image", url: "https://x/b.png", metadata: null }).source).toBe("fallback");
  });
  it("figurinha ignora metadata", () => {
    expect(resolveMediaBox({ kind: "sticker", url, metadata: { media: { width: 9, height: 9 } } })).toMatchObject({ width: 160, source: "fixed" });
  });
});

describe("createMediaBoxLocks", () => {
  it("a primeira decisão vale para sempre", () => {
    const locks = createMediaBoxLocks();
    const url = "https://x/l.png";
    const first = locks.get("k", () => resolveMediaBox({ kind: "image", url, metadata: null }));
    expect(first.source).toBe("fallback");
    rememberMediaSize(url, 100, 100);
    const again = locks.get("k", () => resolveMediaBox({ kind: "image", url, metadata: null }));
    expect(again).toBe(first);
    const other = locks.get("k2", () => resolveMediaBox({ kind: "image", url, metadata: null }));
    expect(other.source).toBe("cache");
    expect(locks.size()).toBe(2);
  });
});

describe("thumb em metadata.media", () => {
  it("aceita string, ausente e rejeita acima de 12000", () => {
    expect(parseMediaDimensions({ media: { width: 10, height: 10, thumb: "abc" } })?.thumb).toBe("abc");
    expect(parseMediaDimensions({ media: { width: 10, height: 10 } })?.thumb).toBeUndefined();
    expect(parseMediaDimensions({ media: { width: 10, height: 10, thumb: "a".repeat(12001) } })).toBeUndefined();
  });
});
