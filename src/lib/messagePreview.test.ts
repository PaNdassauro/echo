import { describe, expect, it } from "vitest";
import { getMessagePreview } from "./messagePreview";

describe("getMessagePreview", () => {
  it.each([
    ["image", "📷 Imagem"],
    ["video", "🎥 Vídeo"],
    ["audio", "🎵 Áudio"],
    ["ptt", "🎵 Áudio"],
    ["document", "📄 Documento"],
    ["sticker", "🏷️ Figurinha"],
    ["location", "📍 Localização"],
    ["contact", "👤 Contato"],
    ["contacts", "👤 Contato"],
    ["deleted", "🗑️ Mensagem apagada"],
  ])("mapeia %s", (type, expected) => {
    expect(getMessagePreview({ message_type: type, content: "conteúdo" })).toBe(expected);
  });

  it("texto usa o content cru", () => {
    expect(getMessagePreview({ message_type: "text", content: "oi!" })).toBe("oi!");
  });

  it("tipo desconhecido cai no content", () => {
    expect(getMessagePreview({ message_type: "poll", content: "Almoço?" })).toBe("Almoço?");
  });

  it("content nulo vira string vazia", () => {
    expect(getMessagePreview({ message_type: "text", content: null })).toBe("");
    expect(getMessagePreview({})).toBe("");
  });

  it("apagada tem precedência sobre o tipo (imagem apagada não vira 📷)", () => {
    expect(getMessagePreview({ message_type: "image", content: "x", is_deleted: true })).toBe(
      "🗑️ Mensagem apagada"
    );
  });

  it("ligação mantém o desfecho na prévia, não só o ícone", () => {
    expect(getMessagePreview({ message_type: "call", content: "Chamada não atendida" })).toBe(
      "📞 Chamada não atendida"
    );
    expect(getMessagePreview({ message_type: "call", content: "Chamada de voz · 38s" })).toBe(
      "📞 Chamada de voz · 38s"
    );
    expect(getMessagePreview({ message_type: "call", content: null })).toBe("📞 Chamada de voz");
  });

});
