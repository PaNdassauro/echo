import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRetainedImages, createMediaPreloader } from "@/lib/mediaPreload";
vi.mock("@/lib/videoPoster", () => ({
  getVideoPoster: vi.fn(() => null),
  captureVideoPoster: vi.fn(() => Promise.resolve(null)),
}));
import { captureVideoPoster } from "@/lib/videoPoster";
import { clearMediaSizes, knownMediaSize, wasMediaLoaded } from "@/lib/mediaSizeCache";
import type { TimelineItem } from "@/lib/timeline";

const BASE = "https://x.supabase.co";
vi.stubEnv("VITE_SUPABASE_URL", BASE);

const started: string[] = [];
let inFlight = 0;
let maxInFlight = 0;
let failing = new Set<string>();
const gates: Array<() => void> = [];
let manual = false;

class FakeImage {
  decoding = "";
  naturalWidth = 640;
  naturalHeight = 480;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = "";
  get src(): string {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    started.push(v);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const done = () => {
      inFlight -= 1;
      if (failing.has(v)) this.onerror?.();
      else this.onload?.();
    };
    if (manual) gates.push(done);
    else setTimeout(done, 0);
  }
  decode(): Promise<void> {
    return Promise.resolve();
  }
}

const url = (n: number) => `${BASE}/storage/v1/object/public/attachments/c/${n}.jpg`;
const img = (n: number): TimelineItem =>
  ({ id: `i${n}`, _type: "message", message_type: "image", media_url: url(n) }) as unknown as TimelineItem;
const txt = (n: number): TimelineItem =>
  ({ id: `t${n}`, _type: "message", message_type: "text", media_url: null }) as unknown as TimelineItem;

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const display = (n: number) => `${BASE}/storage/v1/render/image/public/attachments/c/${n}.jpg?width=600&height=600&resize=contain&quality=75`;
const thumb = (n: number) => display(n).replace("width=600&height=600", "width=32&height=32");

beforeEach(() => {
  clearRetainedImages();
  vi.stubGlobal("Image", FakeImage);
  started.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  failing = new Set();
  gates.length = 0;
  manual = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_SUPABASE_URL", BASE);
  clearMediaSizes();
});

describe("createMediaPreloader", () => {
  it("pré-carrega só imagens, no sentido e na quantidade pedidos", async () => {
    const items = [img(0), txt(1), img(2), img(3), img(4), img(5)];
    const p = createMediaPreloader();
    p.preload(items, 2, 1, 2);
    await flush();
    expect(started).toEqual([thumb(2), display(2), thumb(3), display(3)]);
    started.length = 0;
    p.preload(items, 3, -1, 3);
    await flush();
    // Sentido oposto: 3, 2 e 1 (texto) — as imagens já carregadas não voltam à fila.
    expect(started).toEqual([]);
  });

  it("para nos limites do array e pula linhas que não são imagem", async () => {
    const items = [txt(0), img(1)];
    const p = createMediaPreloader({ fetchThumbs: false });
    p.preload(items, 1, 1, 10);
    await flush();
    expect(started).toEqual([display(1)]);
  });

  it("registra o tamanho só da URL de exibição; o placeholder não marca como carregada", async () => {
    const p = createMediaPreloader();
    p.preload([img(1)], 0, 1);
    await flush();
    expect(knownMediaSize(url(1))).toEqual({ width: 640, height: 480 });
    expect(wasMediaLoaded(url(1))).toBe(true);
    expect(wasMediaLoaded(thumb(1))).toBe(false);
    expect(knownMediaSize(thumb(1))).toBeUndefined();
  });

  it("respeita a concorrência", async () => {
    const items = [img(0), img(1), img(2), img(3), img(4)];
    const p = createMediaPreloader({ concurrency: 3, fetchThumbs: false });
    p.preload(items, 0, 1, 5);
    await flush();
    expect(started).toHaveLength(5);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("outro sentido cancela a fila pendente, mas não o que está em voo", async () => {
    manual = true;
    const items = [img(0), img(1), img(2), img(3), img(4), img(5)];
    const p = createMediaPreloader({ concurrency: 2, fetchThumbs: false });
    p.preload(items, 0, 1, 4);
    expect(started).toEqual([display(0), display(1)]);
    p.preload(items, 5, -1, 1);
    expect(started).toEqual([display(0), display(1)]);
    gates.splice(0).forEach((g) => g());
    await flush();
    gates.splice(0).forEach((g) => g());
    await flush();
    expect(started).toEqual([display(0), display(1), display(5)]);
  });

  it("saveData ligado não faz nada", async () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const p = createMediaPreloader();
    p.preload([img(1)], 0, 1);
    await flush();
    expect(started).toEqual([]);
  });

  it("erro de carregamento não lança e libera a vaga", async () => {
    failing = new Set([display(0)]);
    const p = createMediaPreloader({ concurrency: 1, fetchThumbs: false });
    expect(() => p.preload([img(0), img(1)], 0, 1, 2)).not.toThrow();
    await flush();
    expect(started).toEqual([display(0), display(1)]);
    expect(p.size()).toBe(1);
    expect(wasMediaLoaded(url(0))).toBe(false);
  });

  it("o LRU descarta o mais antigo além de `keep`", async () => {
    const items = [img(0), img(1), img(2), img(3)];
    const p = createMediaPreloader({ keep: 2, fetchThumbs: false });
    p.preload(items, 0, 1, 4);
    await flush();
    expect(p.size()).toBe(2);
  });

  it("não busca de novo o que já carregou", async () => {
    const p = createMediaPreloader({ fetchThumbs: false });
    p.preload([img(1)], 0, 1);
    await flush();
    started.length = 0;
    p.preload([img(1)], 0, 1);
    await flush();
    expect(started).toEqual([]);
  });
});

describe("mediaPreload — vídeo", () => {
  it("não captura poster de vídeo na pré-carga (isso é da bolha, em tempo ocioso)", async () => {
    const vid = { id: "v1", _type: "message", message_type: "video", media_url: "https://x.supabase.co/v.mp4" } as unknown as TimelineItem;
    started.length = 0;
    createMediaPreloader().preload([vid], 0, 1);
    await flush();
    expect(captureVideoPoster).not.toHaveBeenCalled();
    expect(started).toHaveLength(0);
  });
});
