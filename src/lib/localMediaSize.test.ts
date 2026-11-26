import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localMediaSize, measureLocalMedia } from "./localMediaSize";

type Mode = "load" | "error" | "never";
let mode: Mode = "load";

class FakeImage {
  naturalWidth = 1200;
  naturalHeight = 800;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    if (mode === "never") return;
    queueMicrotask(() => (mode === "load" ? this.onload?.() : this.onerror?.()));
  }
}

const png = () => new File(["x"], "a.png", { type: "image/png" });

beforeEach(() => {
  mode = "load";
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("measureLocalMedia", () => {
  it("mede a imagem e guarda para localMediaSize", async () => {
    const file = png();
    await expect(measureLocalMedia(file, "blob:x")).resolves.toEqual({ width: 1200, height: 800 });
    expect(localMediaSize(file)).toEqual({ width: 1200, height: 800 });
  });

  it("erro de carregamento resolve null", async () => {
    mode = "error";
    const file = png();
    await expect(measureLocalMedia(file, "blob:x")).resolves.toBeNull();
    expect(localMediaSize(file)).toBeUndefined();
  });

  it("sem resposta resolve null no tempo limite", async () => {
    mode = "never";
    vi.useFakeTimers();
    const promise = measureLocalMedia(png(), "blob:x");
    await vi.advanceTimersByTimeAsync(1500);
    await expect(promise).resolves.toBeNull();
  });

  it("arquivo que não é imagem nem vídeo resolve null", async () => {
    const file = new File(["x"], "a.pdf", { type: "application/pdf" });
    await expect(measureLocalMedia(file, "blob:x")).resolves.toBeNull();
    expect(localMediaSize(file)).toBeUndefined();
  });

  it("tamanho zero não vale", async () => {
    vi.stubGlobal(
      "Image",
      class extends FakeImage {
        naturalWidth = 0;
      },
    );
    await expect(measureLocalMedia(png(), "blob:x")).resolves.toBeNull();
  });

  it("nunca lança, mesmo se o Image quebrar", async () => {
    vi.stubGlobal("Image", () => {
      throw new Error("boom");
    });
    await expect(measureLocalMedia(png(), "blob:x")).resolves.toBeNull();
  });
});
