import { describe, expect, it } from "vitest";
import { classificarUpdate, FALHAS_VISTAS_MAX, FALHA_NOVA_MAX_MS } from "./messageUpdateNotify";

const falha = (id = "m1") => ({ id, conversation_id: "c1", status: "failed" as string | null });

describe("classificarUpdate", () => {
  it("a primeira vez que a mensagem aparece failed notifica", () => {
    const vistas = new Set<string>();
    expect(classificarUpdate({ id: "m1" }, falha(), vistas)).toBe("falha");
    expect(vistas.has("m1")).toBe(true);
  });

  it("UPDATE só de metadata em mensagem failed já vista não notifica", () => {
    const vistas = new Set<string>();
    expect(classificarUpdate({ id: "m1" }, falha(), vistas)).toBe("falha");
    expect(classificarUpdate({ id: "m1" }, falha(), vistas)).toBeNull();
    expect(classificarUpdate(null, falha(), vistas)).toBeNull();
  });

  it("UPDATE só de metadata numa failed antiga e nunca vista não notifica", () => {
    const vistas = new Set<string>();
    const agora = Date.parse("2026-10-16T11:00:00.000Z");
    const ontem = { ...falha(), created_at: "2026-10-15T21:50:00.000Z" };
    expect(classificarUpdate({ id: "m1" }, ontem, vistas, agora)).toBeNull();
    expect(vistas.has("m1")).toBe(true);
  });

  it("falha tardia em linha antiga notifica quando o carimbo failed_at é recente", () => {
    const vistas = new Set<string>();
    const agora = Date.parse("2026-10-16T11:00:00.000Z");
    const tardia = { ...falha(), created_at: "2026-10-16T10:00:00.000Z", metadata: { failed_at: "2026-10-16T10:59:30.000000Z" } };
    expect(classificarUpdate({ id: "m1" }, tardia, vistas, agora)).toBe("falha");
  });

  it("carimbo failed_at antigo não notifica (UPDATE de metadata em falha velha)", () => {
    const vistas = new Set<string>();
    const agora = Date.parse("2026-10-16T11:00:00.000Z");
    const velha = { ...falha(), created_at: "2026-10-16T10:59:00.000Z", metadata: { failed_at: "2026-10-16T09:00:00.000000Z" } };
    expect(classificarUpdate({ id: "m1" }, velha, vistas, agora)).toBeNull();
  });

  it("falha recente (dentro da janela) continua notificando na primeira vez", () => {
    const vistas = new Set<string>();
    const agora = Date.parse("2026-10-16T11:00:00.000Z");
    const recente = { ...falha(), created_at: new Date(agora - FALHA_NOVA_MAX_MS + 1000).toISOString() };
    expect(classificarUpdate({ id: "m1" }, recente, vistas, agora)).toBe("falha");
  });

  it("old com status sent → failed notifica mesmo com created_at antigo (a transição é a prova)", () => {
    const vistas = new Set<string>();
    const agora = Date.parse("2026-10-16T11:00:00.000Z");
    expect(classificarUpdate({ id: "m1", status: "sent" }, { ...falha(), created_at: "2026-10-01T00:00:00.000Z" }, vistas, agora)).toBe("falha");
  });

  it("ids diferentes são independentes", () => {
    const vistas = new Set<string>();
    expect(classificarUpdate({ id: "m1" }, falha("m1"), vistas)).toBe("falha");
    expect(classificarUpdate({ id: "m2" }, falha("m2"), vistas)).toBe("falha");
  });

  it("old com status usa a comparação (sent → failed notifica, failed → failed não)", () => {
    const vistas = new Set<string>();
    expect(classificarUpdate({ id: "m1", status: "sent" }, falha(), vistas)).toBe("falha");
    // mesmo com o Set já preenchido, a comparação do old é quem manda
    expect(classificarUpdate({ id: "m1", status: "failed" }, falha(), vistas)).toBeNull();
    expect(classificarUpdate({ id: "m1", status: "sent" }, falha(), vistas)).toBe("falha");
  });

  it("old com status failed, sem o id no Set (aba aberta depois), não notifica e passa a lembrar", () => {
    const vistas = new Set<string>();
    expect(classificarUpdate({ id: "m1", status: "failed" }, falha(), vistas)).toBeNull();
    expect(vistas.has("m1")).toBe(true);
  });

  it("sair de failed (reenvio) esquece o id: a próxima falha notifica de novo", () => {
    const vistas = new Set<string>();
    expect(classificarUpdate({ id: "m1" }, falha(), vistas)).toBe("falha");
    expect(classificarUpdate({ id: "m1" }, { id: "m1", conversation_id: "c1", status: "sent" }, vistas)).toBeNull();
    expect(vistas.has("m1")).toBe(false);
    expect(classificarUpdate({ id: "m1" }, falha(), vistas)).toBe("falha");
  });

  it("reação nunca sai do UPDATE: linha com reaction e status normal não notifica nada", () => {
    const vistas = new Set<string>();
    const linhaComReacao = { id: "m1", conversation_id: "c1", status: "delivered", reaction: "👍" };
    expect(classificarUpdate({ id: "m1" }, linhaComReacao, vistas)).toBeNull();
    expect(classificarUpdate({ id: "m1", status: "delivered" }, linhaComReacao, vistas)).toBeNull();
    // e UPDATE de metadata (leitura) numa mensagem com reação continua mudo
    expect(classificarUpdate(null, { ...linhaComReacao, status: null }, vistas)).toBeNull();
  });

  it("o Set por sessão tem teto e descarta o mais antigo", () => {
    const vistas = new Set<string>();
    for (let i = 0; i < FALHAS_VISTAS_MAX + 5; i++) classificarUpdate({ id: `m${i}` }, falha(`m${i}`), vistas);
    expect(vistas.size).toBe(FALHAS_VISTAS_MAX);
    expect(vistas.has("m0")).toBe(false);
    expect(vistas.has(`m${FALHAS_VISTAS_MAX + 4}`)).toBe(true);
  });
});
