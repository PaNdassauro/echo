import { describe, expect, it } from "vitest";
import { mediaDownloadName, mediaFilenameFromUrl, toDownloadUrl } from "./mediaDownload";

const STORAGE = "https://proj.supabase.co/storage/v1/object/public/attachments/inbound/abc/LogoDoEvento.zip";

describe("toDownloadUrl", () => {
  it("põe ?download=<nome> em URL do Storage", () => {
    const out = new URL(toDownloadUrl(STORAGE, "LogoDoEvento.zip"));
    expect(out.searchParams.get("download")).toBe("LogoDoEvento.zip");
  });

  it("preserva params existentes e não duplica o download", () => {
    const out = new URL(toDownloadUrl(`${STORAGE}?v=1&download=velho`, "novo.zip"));
    expect(out.searchParams.get("v")).toBe("1");
    expect(out.searchParams.getAll("download")).toEqual(["novo.zip"]);
  });

  it("deixa URL de fora do Storage, blob: e lixo como estão", () => {
    expect(toDownloadUrl("https://exemplo.com/a.pdf", "a.pdf")).toBe("https://exemplo.com/a.pdf");
    expect(toDownloadUrl("blob:http://localhost/123", "a.pdf")).toBe("blob:http://localhost/123");
    expect(toDownloadUrl("não é url", "a.pdf")).toBe("não é url");
  });
});

describe("mediaDownloadName", () => {
  it("usa o nome original da mensagem quando existe", () => {
    expect(mediaDownloadName(STORAGE, "  Contrato final.pdf ", "document")).toBe("Contrato final.pdf");
  });

  it("sem nome, usa o do path da URL", () => {
    expect(mediaDownloadName(STORAGE, null, "document")).toBe("LogoDoEvento.zip");
  });

  it("sem nome e sem extensão na URL, gera <tipo>-<timestamp>.<ext> pelo tipo", () => {
    const semExt = "https://x.supabase.co/storage/v1/object/public/attachments/inbound/abc/7f3e9c";
    expect(mediaDownloadName(semExt, null, "image")).toMatch(/^imagem-\d+\.jpg$/);
    expect(mediaDownloadName(semExt, "", "video")).toMatch(/^video-\d+\.mp4$/);
    expect(mediaDownloadName(semExt, undefined, "sticker")).toMatch(/^figurinha-\d+\.webp$/);
    expect(mediaDownloadName(semExt, null, "tipo-novo")).toMatch(/^arquivo-\d+\.bin$/);
  });
});

describe("mediaFilenameFromUrl", () => {
  it("mantém o prefixo audio por padrão (AudioPlayer)", () => {
    expect(mediaFilenameFromUrl("blob:x", "ogg")).toMatch(/^audio-\d+\.ogg$/);
  });
});
