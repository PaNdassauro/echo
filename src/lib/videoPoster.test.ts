import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureVideoPoster, clearVideoPosters, getVideoPoster } from "@/lib/videoPoster";

type Listener = () => void;

class FakeVideo {
  static created: FakeVideo[] = [];
  crossOrigin = "";
  muted = false;
  playsInline = false;
  preload = "";
  videoWidth = 640;
  videoHeight = 360;
  duration = 10;
  currentTime = 0;
  private _src = "";
  removed = false;
  private listeners = new Map<string, Listener[]>();
  constructor() {
    FakeVideo.created.push(this);
  }
  get src(): string {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
  }
  addEventListener(name: string, fn: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  emit(name: string): void {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }
  removeAttribute(): void {
    this.removed = true;
  }
  load(): void {}
}

const tick = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const drawImage = vi.fn();
let toDataURL: () => string;
const realCreate = document.createElement.bind(document);

beforeEach(() => {
  clearVideoPosters();
  FakeVideo.created = [];
  drawImage.mockClear();
  toDataURL = () => "data:image/jpeg;base64,AAA";
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag === "video") return new FakeVideo() as unknown as HTMLVideoElement;
    if (tag === "canvas")
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage }),
        toDataURL: () => toDataURL(),
      } as unknown as HTMLCanvasElement;
    return realCreate(tag);
  }) as typeof document.createElement);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const finishCapture = async (v: FakeVideo) => {
  v.emit("loadedmetadata");
  v.emit("seeked");
  await tick();
};

describe("videoPoster", () => {
  it("captura, devolve data URL e cacheia (leitura síncrona depois)", async () => {
    const p = captureVideoPoster("https://p/a.mp4");
    await tick();
    const v = FakeVideo.created[0];
    expect(v.crossOrigin).toBe("anonymous");
    expect(v.muted).toBe(true);
    expect(v.preload).toBe("metadata");
    await finishCapture(v);
    expect(await p).toBe("data:image/jpeg;base64,AAA");
    expect(v.currentTime).toBeCloseTo(0.1);
    expect(v.removed).toBe(true);
    expect(getVideoPoster("https://p/a.mp4")).toBe("data:image/jpeg;base64,AAA");
    expect(JSON.parse(localStorage.getItem("echo.videoPoster.v1") ?? "{}")["https://p/a.mp4"]).toBeTruthy();
  });

  it("deduplica capturas em voo da mesma URL", async () => {
    const a = captureVideoPoster("https://p/b.mp4");
    const b = captureVideoPoster("https://p/b.mp4");
    expect(a).toBe(b);
    await tick();
    expect(FakeVideo.created).toHaveLength(1);
    await finishCapture(FakeVideo.created[0]);
    await a;
  });

  it("captura uma por vez (decodificar vídeo compete com a rolagem)", async () => {
    const ps = [1, 2, 3].map((n) => captureVideoPoster(`https://p/c${n}.mp4`));
    await tick();
    expect(FakeVideo.created).toHaveLength(1);
    await finishCapture(FakeVideo.created[0]);
    await tick();
    expect(FakeVideo.created).toHaveLength(2);
    await finishCapture(FakeVideo.created[1]);
    await tick();
    expect(FakeVideo.created).toHaveLength(3);
    await finishCapture(FakeVideo.created[2]);
    expect(await Promise.all(ps)).toHaveLength(3);
  });

  it("timeout resolve null e não tenta de novo na sessão", async () => {
    vi.useFakeTimers();
    const p = captureVideoPoster("https://p/d.mp4", { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(150);
    expect(await p).toBeNull();
    expect(await captureVideoPoster("https://p/d.mp4")).toBeNull();
    expect(FakeVideo.created).toHaveLength(1);
  });

  it("canvas contaminado (SecurityError) resolve null", async () => {
    toDataURL = () => {
      throw new DOMException("tainted", "SecurityError");
    };
    const p = captureVideoPoster("https://p/e.mp4");
    await tick();
    await finishCapture(FakeVideo.created[0]);
    expect(await p).toBeNull();
    expect(getVideoPoster("https://p/e.mp4")).toBeNull();
  });

  it("falhas do localStorage são ignoradas", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cheio");
    });
    expect(getVideoPoster("https://p/f.mp4")).toBeNull();
    const p = captureVideoPoster("https://p/f.mp4");
    await tick();
    await finishCapture(FakeVideo.created[0]);
    expect(await p).toBe("data:image/jpeg;base64,AAA");
    expect(getVideoPoster("https://p/f.mp4")).toBe("data:image/jpeg;base64,AAA");
  });
});
