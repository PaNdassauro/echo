import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearMediaSizes, wasMediaLoaded } from "@/lib/mediaSizeCache";
import { clearVideoPosters, seedVideoPoster } from "@/lib/videoPoster";
import MessageBubble from "./MessageBubble";

beforeEach(() => clearMediaSizes());
afterEach(() => {
  cleanup();
  clearMediaSizes();
});

const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

const base = {
  content: "",
  direction: "inbound" as const,
  timestamp: "2026-08-17T12:00:00.000Z",
};

const IMG = "https://p.supabase.co/storage/v1/object/public/attachments/a.jpg";

const frame = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-media-box]");

describe("MessageBubble — caixa de mídia fixa", () => {
  it("imagem com metadata.media nasce com a caixa final, antes de qualquer load", () => {
    const { container } = render(
      <MessageBubble {...base} message_type="image" media_url={IMG} metadata={{ media: { width: 1200, height: 800 } }} />,
    );
    const f = frame(container);
    expect(f?.getAttribute("data-media-box")).toBe("300x200");
    expect(f?.style.width).toBe("300px");
    expect((f?.firstElementChild as HTMLElement).style.paddingTop.startsWith("66.66")).toBe(true);
  });

  it("o load não muda a caixa e marca a mídia como carregada", () => {
    const { container } = render(
      <MessageBubble {...base} message_type="image" media_url={IMG} metadata={{ media: { width: 1200, height: 800 } }} />,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 50 });
    Object.defineProperty(img, "naturalHeight", { value: 50 });
    fireEvent.load(img);
    expect(frame(container)?.getAttribute("data-media-box")).toBe("300x200");
    expect(wasMediaLoaded(IMG)).toBe(true);
  });

  it("sem metadata usa o letterbox de 240x240", () => {
    const { container } = render(<MessageBubble {...base} message_type="image" media_url={IMG} />);
    expect(frame(container)?.getAttribute("data-media-box")).toBe("240x240");
    expect(frame(container)?.getAttribute("data-media-source")).toBe("fallback");
  });

  it("erro mantém a moldura e mostra a UI de recarregar", () => {
    const { container } = render(<MessageBubble {...base} message_type="image" media_url={IMG} />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(frame(container)?.getAttribute("data-media-box")).toBe("240x240");
    expect(screen.getByText("Mídia indisponível")).toBeTruthy();
    expect(screen.getByText("Recarregar")).toBeTruthy();
  });

  it("caixa estreita mostra só o botão de ícone", () => {
    const { container } = render(
      <MessageBubble
        {...base}
        message_type="image"
        media_url={IMG}
        mediaBox={{ width: 120, height: 120, fit: "contain", source: "fallback" }}
      />,
    );
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    // O nome acessível diz que falhou E o que o botão faz; o texto visível some.
    expect(screen.getByRole("button", { name: "Mídia indisponível. Recarregar" })).toBeTruthy();
    expect(screen.queryByText("Mídia indisponível")).toBeNull();
  });

  it("figurinha tem 160x160 e continua solta depois do erro", () => {
    const { container } = render(
      <MessageBubble {...base} message_type="sticker" media_url="https://p/s.webp" />,
    );
    expect(frame(container)?.getAttribute("data-media-box")).toBe("160x160");
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(frame(container)?.getAttribute("data-media-box")).toBe("160x160");
    expect(container.querySelector(".px-4")).toBeNull();
  });

  it("vídeo 640x360 dá 300x169 e o loadedmetadata não muda", () => {
    const { container } = render(
      <MessageBubble {...base} message_type="video" media_url="https://p/v.mp4" metadata={{ media: { width: 640, height: 360 } }} />,
    );
    expect(frame(container)?.getAttribute("data-media-box")).toBe("300x169");
    fireEvent.click(screen.getByRole("button", { name: "Reproduzir vídeo" }));
    fireEvent(container.querySelector("video") as HTMLVideoElement, new Event("loadedmetadata"));
    expect(frame(container)?.getAttribute("data-media-box")).toBe("300x169");
  });

  it("a prop mediaBox vence o metadata", () => {
    const { container } = render(
      <MessageBubble
        {...base}
        message_type="image"
        media_url={IMG}
        metadata={{ media: { width: 1200, height: 800 } }}
        mediaBox={{ width: 100, height: 50, fit: "cover", source: "cache" }}
      />,
    );
    expect(frame(container)?.getAttribute("data-media-box")).toBe("100x50");
  });

  it("nenhuma img usa loading=lazy", () => {
    const { container } = render(<MessageBubble {...base} message_type="image" media_url={IMG} />);
    expect(container.querySelector('img[loading="lazy"]')).toBeNull();
  });
});

describe("MessageBubble — miniatura, derivada e revelação", () => {
  const SB = "https://p.supabase.co";
  const bucketImg = `${SB}/storage/v1/object/public/attachments/a.jpg`;
  const meta = { media: { width: 1200, height: 800 } };

  beforeEach(() => vi.stubEnv("VITE_SUPABASE_URL", SB));
  afterEach(() => vi.unstubAllEnvs());

  const imgs = (c: HTMLElement) => Array.from(c.querySelectorAll("img"));

  it("thumb do metadata vira placeholder borrado data: sob a imagem principal", () => {
    const { container } = render(
      <MessageBubble {...base} message_type="image" media_url={bucketImg} metadata={{ media: { ...meta.media, thumb: "AAAA" } }} />,
    );
    const [placeholder, main] = imgs(container);
    expect(placeholder.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder.className).toContain("blur-[10px]");
    expect(main.getAttribute("src")).toContain("width=600");
  });

  it("sem thumb, o placeholder é a derivada de 32 px e a principal a de 600 px", () => {
    const { container } = render(<MessageBubble {...base} message_type="image" media_url={bucketImg} metadata={meta} />);
    const [placeholder, main] = imgs(container);
    expect(placeholder.getAttribute("src")).toContain("width=32&height=32");
    expect(main.getAttribute("src")).toContain("width=600&height=600");
  });

  it("o placeholder some depois que a imagem principal carrega", async () => {
    const { container } = render(<MessageBubble {...base} message_type="image" media_url={bucketImg} metadata={meta} />);
    expect(imgs(container)).toHaveLength(2);
    const main = imgs(container)[1];
    Object.defineProperty(main, "naturalWidth", { value: 600 });
    Object.defineProperty(main, "naturalHeight", { value: 400 });
    fireEvent.load(main);
    await waitFor(() => expect(imgs(container)).toHaveLength(1));
  });

  it("imagem já completa na montagem aparece sem opacity-0 e sem fade", () => {
    const completeDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete");
    const widthDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth");
    Object.defineProperty(HTMLImageElement.prototype, "complete", { configurable: true, get: () => true });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 600 });
    try {
      const { container } = render(<MessageBubble {...base} message_type="image" media_url={bucketImg} metadata={meta} />);
      const list = imgs(container);
      expect(list).toHaveLength(1);
      expect(list[0].className).not.toContain("opacity-0");
      expect(list[0].className).not.toContain("transition-opacity");
    } finally {
      if (completeDesc) Object.defineProperty(HTMLImageElement.prototype, "complete", completeDesc);
      else delete (HTMLImageElement.prototype as { complete?: boolean }).complete;
      if (widthDesc) Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", widthDesc);
      else delete (HTMLImageElement.prototype as { naturalWidth?: number }).naturalWidth;
    }
  });

  it("figurinha não tem esqueleto bg-muted na moldura", () => {
    const { container } = render(<MessageBubble {...base} message_type="sticker" media_url="https://p/s.webp" />);
    expect(frame(container)?.querySelector('[class*="bg-muted"]')).toBeNull();
  });

  it("erro na derivada cai no original; erro no original mostra a UI de erro", () => {
    const { container } = render(<MessageBubble {...base} message_type="image" media_url={bucketImg} metadata={meta} />);
    const main = () => imgs(container).find((i) => !i.hasAttribute("aria-hidden")) as HTMLImageElement;
    expect(main().getAttribute("src")).toContain("/render/image/");
    fireEvent.error(main());
    expect(main().getAttribute("src")).toBe(bucketImg);
    fireEvent.error(main());
    expect(screen.getByText("Mídia indisponível")).toBeTruthy();
  });

  it("o vídeo só monta depois do clique em Reproduzir vídeo", () => {
    const { container } = render(<MessageBubble {...base} message_type="video" media_url="https://p/v.mp4" metadata={meta} />);
    expect(container.querySelector("video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reproduzir vídeo" }));
    const v = container.querySelector("video") as HTMLVideoElement;
    expect(v).not.toBeNull();
    expect(v.getAttribute("preload")).toBe("auto");
  });

  it("thumbhash no metadata vira miniatura borrada instantânea (data:image/png) sob a imagem", () => {
    const { container } = render(
      <MessageBubble
        {...base}
        message_type="image"
        media_url={IMG}
        metadata={{ media: { width: 1200, height: 800, thumbhash: "HggKNZpwh3eAeIiHiHiIh3BwCPeH" } }}
      />,
    );
    const placeholder = container.querySelector('img[aria-hidden="true"]') as HTMLImageElement | null;
    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });
});

describe("MessageBubble — poster do vídeo", () => {
  const VID = "https://p/poster.mp4";
  const meta = { media: { width: 640, height: 360 } };
  beforeEach(() => clearVideoPosters());
  afterEach(() => clearVideoPosters());

  it("thumb do metadata vira poster sob o botão, sem <video> antes do clique", () => {
    const { container } = render(
      <MessageBubble {...base} message_type="video" media_url={VID} metadata={{ media: { ...meta.media, thumb: "QUJD" } }} />,
    );
    const btn = screen.getByRole("button", { name: "Reproduzir vídeo" });
    const poster = btn.querySelector("img");
    expect(poster?.getAttribute("src")).toBe("data:image/jpeg;base64,QUJD");
    expect(poster?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("video")).toBeNull();
  });

  it("poster em cache aparece mesmo sem thumb", () => {
    seedVideoPoster(VID, "data:image/jpeg;base64,CACHE");
    const { container } = render(<MessageBubble {...base} message_type="video" media_url={VID} metadata={meta} />);
    expect(screen.getByRole("button", { name: "Reproduzir vídeo" }).querySelector("img")?.getAttribute("src")).toBe(
      "data:image/jpeg;base64,CACHE",
    );
    expect(container.querySelector("video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reproduzir vídeo" }));
    expect(container.querySelector("video")?.getAttribute("poster")).toBe("data:image/jpeg;base64,CACHE");
  });

  it("sem poster algum mantém o tom liso e nenhum <video>", () => {
    const { container } = render(<MessageBubble {...base} message_type="video" media_url={VID} metadata={meta} />);
    expect(screen.getByRole("button", { name: "Reproduzir vídeo" }).querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
  });
});
