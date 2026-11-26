import { describe, expect, it } from "vitest";
import {
  COPILOTO_DEBOUNCE_MS,
  COPILOTO_INTERVALO_MIN_MS,
  COPILOTO_JANELA_AUTO_MS,
  copilotoRespostaSchema,
  deveAnalisar,
  ultimaFala,
  type CopilotoMensagem,
} from "./copiloto";

const AGORA = Date.parse("2026-11-10T15:00:00.000Z");
const ha = (ms: number) => new Date(AGORA - ms).toISOString();
const msg = (id: string, direction: "inbound" | "outbound", extra: Partial<CopilotoMensagem> = {}): CopilotoMensagem => ({
  id,
  direction,
  created_at: ha(60_000),
  ...extra,
});
const base = { ultimaAnalisadaId: null, emVoo: false, ultimaChamadaEm: null, agora: AGORA };

describe("ultimaFala", () => {
  it("pula apagada, reação e tipos sem fala", () => {
    const mensagens = [
      msg("a", "inbound"),
      msg("b", "outbound", { is_deleted: true }),
      msg("c", "outbound", { message_type: "reaction" }),
      msg("d", "outbound", { message_type: "system" }),
    ];
    expect(ultimaFala(mensagens)?.id).toBe("a");
  });
  it("lista vazia não tem fala", () => {
    expect(ultimaFala([])).toBeNull();
  });
});

describe("deveAnalisar", () => {
  it("analisa a inbound nova depois do debounce", () => {
    const d = deveAnalisar({ ...base, mensagens: [msg("a", "outbound"), msg("b", "inbound")] });
    expect(d).toEqual({ tipo: "analisar", alvoId: "b", esperarMs: COPILOTO_DEBOUNCE_MS });
  });
  it("não analisa quando o atendente falou por último", () => {
    const d = deveAnalisar({ ...base, mensagens: [msg("a", "inbound"), msg("b", "outbound")] });
    expect(d).toEqual({ tipo: "nada", motivo: "vez_do_cliente" });
  });
  it("uma análise por inbound", () => {
    const d = deveAnalisar({ ...base, ultimaAnalisadaId: "b", mensagens: [msg("b", "inbound")] });
    expect(d).toEqual({ tipo: "nada", motivo: "ja_analisada" });
  });
  it("uma chamada por vez", () => {
    const d = deveAnalisar({ ...base, emVoo: true, mensagens: [msg("b", "inbound")] });
    expect(d).toEqual({ tipo: "nada", motivo: "em_voo" });
  });
  it("inbound antiga não dispara sozinha", () => {
    const d = deveAnalisar({
      ...base,
      mensagens: [msg("b", "inbound", { created_at: ha(COPILOTO_JANELA_AUTO_MS + 1) })],
    });
    expect(d).toEqual({ tipo: "nada", motivo: "antiga" });
  });
  it("respeita o intervalo mínimo desde a última chamada", () => {
    const d = deveAnalisar({ ...base, ultimaChamadaEm: AGORA - 2_000, mensagens: [msg("b", "inbound")] });
    expect(d).toEqual({ tipo: "analisar", alvoId: "b", esperarMs: COPILOTO_INTERVALO_MIN_MS - 2_000 });
  });
  it("sem mensagens não faz nada", () => {
    expect(deveAnalisar({ ...base, mensagens: [] })).toEqual({ tipo: "nada", motivo: "sem_mensagens" });
  });
});

describe("copilotoRespostaSchema", () => {
  it("aceita ok e indisponível", () => {
    expect(
      copilotoRespostaSchema.safeParse({
        status: "ok",
        momento: "Cliente pediu orçamento",
        sugestoes: [{ texto: "Oi!", intencao: "responder", porque: "abre" }],
        analisado_ate: "x",
      }).success,
    ).toBe(true);
    expect(copilotoRespostaSchema.safeParse({ status: "indisponivel", motivo: "sem_chave" }).success).toBe(true);
  });
  it("recusa intenção fora da lista e mais de 3 sugestões", () => {
    const s = { texto: "a", intencao: "responder", porque: "" };
    expect(
      copilotoRespostaSchema.safeParse({
        status: "ok",
        momento: "",
        sugestoes: [{ ...s, intencao: "vender" }],
        analisado_ate: null,
      }).success,
    ).toBe(false);
    expect(
      copilotoRespostaSchema.safeParse({ status: "ok", momento: "", sugestoes: [s, s, s, s], analisado_ate: null })
        .success,
    ).toBe(false);
  });
});
