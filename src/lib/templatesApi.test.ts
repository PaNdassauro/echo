import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));

import { isWhatsAppNotConfigured } from "./templatesApi";

describe("isWhatsAppNotConfigured", () => {
  it.each([
    ["mensagem da edge em português", new Error("WhatsApp não configurado. Verifique as configurações.")],
    ["mensagem técnica", new Error("WhatsApp credentials not configured")],
    ["texto solto", "no WhatsApp credentials for this organization"],
    ["objeto com message", { message: "WhatsApp não configurado" }],
  ])("reconhece %s", (_nome, erro) => {
    expect(isWhatsAppNotConfigured(erro)).toBe(true);
  });

  it.each([
    ["erro da Meta", new Error("Meta API error: Invalid OAuth access token")],
    ["sem texto", null],
    ["permissão", { message: "Você não tem permissão para esta ação." }],
  ])("não confunde %s", (_nome, erro) => {
    expect(isWhatsAppNotConfigured(erro)).toBe(false);
  });
});
