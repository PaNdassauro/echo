import { afterEach, describe, expect, it, vi } from "vitest";
import { bubbleImageSrc, publicAttachmentPath } from "./mediaDerivative";

const BASE = "https://proj.supabase.co";
const orig = (p: string) => `${BASE}/storage/v1/object/public/attachments/${p}`;

describe("mediaDerivative", () => {
  it("deriva JPEG/PNG/WebP do bucket público com o tamanho pedido", () => {
    expect(bubbleImageSrc(orig("inbound/a.jpg"), 600, BASE)).toBe(
      `${BASE}/storage/v1/render/image/public/attachments/inbound/a.jpg?width=600&height=600&resize=contain&quality=75`,
    );
    expect(bubbleImageSrc(orig("x/y.PNG"), 300, BASE)).toContain("width=300&height=300");
    expect(bubbleImageSrc(orig("x/y.webp"), 600, BASE)).not.toBeNull();
  });

  it("não deriva GIF, URL assinada, host externo nem vazio", () => {
    expect(bubbleImageSrc(orig("a.gif"), 600, BASE)).toBeNull();
    expect(bubbleImageSrc(`${BASE}/storage/v1/object/sign/attachments/a.jpg?token=x`, 600, BASE)).toBeNull();
    expect(bubbleImageSrc("https://outro.host/a.jpg", 600, BASE)).toBeNull();
    expect(bubbleImageSrc(null, 600, BASE)).toBeNull();
    expect(bubbleImageSrc(orig("a.jpg"), 600, "")).toBeNull();
  });

  it("publicAttachmentPath devolve só o caminho do bucket", () => {
    expect(publicAttachmentPath(orig("inbound/a b.jpg"), BASE)).toBe("inbound/a b.jpg");
    expect(publicAttachmentPath(`${BASE}/storage/v1/object/public/outro/a.jpg`, BASE)).toBeNull();
  });
});

describe("mediaDerivative com a configuração de runtime", () => {
  afterEach(() => {
    window.__ECHO_CONFIG__ = undefined;
    vi.unstubAllEnvs();
  });

  it("sem transformacaoImagem (docker, sem imgproxy) não há derivada: a bolha usa o original", () => {
    window.__ECHO_CONFIG__ = {
      supabaseAnonKey: "anon",
      supabaseUrl: BASE,
      features: { transformacaoImagem: false },
    };

    expect(bubbleImageSrc(orig("inbound/a.jpg"))).toBeNull();
    expect(bubbleImageSrc(orig("inbound/a.jpg"), 600, BASE)).toBeNull();
  });

  it("reconhece o anexo gravado com o endereço canônico mesmo acessando por outro endereço", () => {
    const CANONICA = "https://echo.exemplo.com";
    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon", supabaseUrl: "http://192.168.0.10:8088", siteUrl: CANONICA };
    const url = `${CANONICA}/storage/v1/object/public/attachments/inbound/a.jpg`;

    expect(publicAttachmentPath(url)).toBe("inbound/a.jpg");
    expect(bubbleImageSrc(url, 300)).toBe(
      `${CANONICA}/storage/v1/render/image/public/attachments/inbound/a.jpg?width=300&height=300&resize=contain&quality=75`,
    );
  });

  it("anexo de outro host continua sem derivada", () => {
    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon", supabaseUrl: BASE };

    expect(publicAttachmentPath("https://outro.host/storage/v1/object/public/attachments/a.jpg")).toBeNull();
    expect(bubbleImageSrc("https://outro.host/storage/v1/object/public/attachments/a.jpg")).toBeNull();
  });
});
