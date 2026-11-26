import { describe, expect, it } from "vitest";
import { casaFiltroDeCanal, identificacaoDoContato, respostaVaiPeloDirect, temDirect } from "./directDoInstagram";

const agora = Date.parse("2026-09-28T20:00:00Z");
const entrada = (created_at: string, canal?: string) => ({
  direction: "inbound",
  created_at,
  metadata: canal ? { canal } : {},
});

describe("Direct no card do contato", () => {
  it("resposta vai pelo canal onde o contato escreveu por último, Direct só nas 24h", () => {
    expect(respostaVaiPeloDirect([entrada("2026-09-28T10:00:00Z"), entrada("2026-09-28T19:00:00Z", "instagram")], agora)).toBe(true);
    expect(respostaVaiPeloDirect([entrada("2026-09-28T19:00:00Z", "instagram"), entrada("2026-09-28T19:30:00Z")], agora)).toBe(false);
    expect(respostaVaiPeloDirect([entrada("2026-09-27T19:00:00Z", "instagram")], agora)).toBe(false);
    expect(respostaVaiPeloDirect([], agora)).toBe(false);
  });

  it("mostra o @ no Direct puro e telefone + @ no card juntado", () => {
    expect(identificacaoDoContato({ channel: "instagram", instagram_username: "contato" })).toBe("@contato");
    expect(
      identificacaoDoContato({ channel: "whatsapp", contact_phone: "5511987654321", instagram_user_id: "1", instagram_username: "contato" }),
    ).toBe("5511987654321 · @contato");
    expect(identificacaoDoContato({ channel: "whatsapp", contact_phone: "5511987654321" })).toBe("5511987654321");
    expect(temDirect({ channel: "whatsapp", instagram_user_id: "1" })).toBe(true);
    expect(temDirect({ channel: "whatsapp" })).toBe(false);
  });
});

describe("filtro de canal da lista", () => {
  const soDirect = { channel: "instagram", instagram_user_id: "1" };
  const juntado = { channel: "whatsapp", instagram_user_id: "1" };
  const whatsapp = { channel: "whatsapp", instagram_user_id: null };

  it("nada marcado mostra tudo", () => {
    expect([soDirect, juntado, whatsapp].every((c) => casaFiltroDeCanal(c, []))).toBe(true);
  });

  it("Instagram pega o Direct puro e o card juntado", () => {
    expect([soDirect, juntado, whatsapp].map((c) => casaFiltroDeCanal(c, ["instagram"]))).toEqual([true, true, false]);
  });

  it("WhatsApp pega toda conversa de WhatsApp, inclusive o card juntado", () => {
    expect([soDirect, juntado, whatsapp].map((c) => casaFiltroDeCanal(c, ["whatsapp"]))).toEqual([false, true, true]);
  });

  it("os dois marcados é OR", () => {
    expect([soDirect, juntado, whatsapp].every((c) => casaFiltroDeCanal(c, ["whatsapp", "instagram"]))).toBe(true);
  });
});
