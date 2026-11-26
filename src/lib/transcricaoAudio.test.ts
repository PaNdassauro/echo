import { afterEach, describe, expect, it } from "vitest";
import {
  TRANSCRICAO_SEM_CHAVE_MS,
  lembrarTranscricao,
  limparMemoriaTranscricao,
  mensagemDoErroDaEdge,
  transcricaoCortada,
  TRANSCRICAO_TEXTO_MAX,
  FALLBACK_ERRO,
  marcarSemChave,
  mensagemDaTranscricao,
  podeTranscrever,
  transcricaoGravada,
  transcricaoImpossivel,
  transcricaoLembrada,
  transcricaoRespostaSchema,
  transcricaoSemChave,
} from "./transcricaoAudio";

afterEach(limparMemoriaTranscricao);

describe("transcricaoGravada", () => {
  it("lê o texto da leitura de áudio", () => {
    expect(transcricaoGravada({ leitura: { v: 1, tipo: "audio", texto: "oi" } })).toBe("oi");
  });
  it("texto vazio (áudio mudo) é transcrição, não ausência", () => {
    expect(transcricaoGravada({ leitura: { tipo: "audio", texto: "" } })).toBe("");
  });
  it("sem leitura, leitura em curso, de outro tipo ou malformada → null", () => {
    expect(transcricaoGravada(null)).toBeNull();
    expect(transcricaoGravada({})).toBeNull();
    expect(transcricaoGravada({ leitura: { tipo: "audio", texto: null, em_leitura_desde: "x" } })).toBeNull();
    expect(transcricaoGravada({ leitura: { tipo: "imagem", texto: "uma foto" } })).toBeNull();
    expect(transcricaoGravada({ leitura: { texto: 42 } })).toBeNull();
  });
});

describe("transcricaoImpossivel", () => {
  it("lacuna sem texto = desistência gravada", () => {
    expect(transcricaoImpossivel({ leitura: { tipo: "audio", texto: null, lacuna: true } })).toBe(true);
    expect(transcricaoImpossivel({ leitura: { tipo: "audio", texto: null, lacuna: false } })).toBe(false);
    expect(transcricaoImpossivel(null)).toBe(false);
  });
});

describe("transcricaoRespostaSchema", () => {
  it("aceita as quatro formas do contrato", () => {
    for (const r of [
      { status: "ok", texto: "a" },
      { status: "em_andamento" },
      { status: "indisponivel", motivo: "chave_anthropic" },
      { status: "falhou", erro: "timeout", definitivo: false },
    ]) {
      expect(transcricaoRespostaSchema.safeParse(r).success).toBe(true);
    }
  });
  it("recusa forma desconhecida", () => {
    expect(transcricaoRespostaSchema.safeParse({ status: "ok" }).success).toBe(false);
    expect(transcricaoRespostaSchema.safeParse({ status: "talvez" }).success).toBe(false);
  });
});

describe("mensagemDaTranscricao", () => {
  it("erro conhecido tem frase própria; desconhecido cai no genérico pelo definitivo", () => {
    expect(mensagemDaTranscricao({ status: "falhou", erro: "grande_demais", definitivo: true })).toMatch(/longo demais/);
    expect(mensagemDaTranscricao({ status: "falhou", erro: "http_500", definitivo: false })).toMatch(/Tente de novo/);
    expect(mensagemDaTranscricao({ status: "falhou", erro: "xyz", definitivo: true })).toMatch(/Não foi possível/);
    expect(mensagemDaTranscricao({ status: "indisponivel", motivo: "chave_anthropic" })).toMatch(/OpenAI/);
    expect(mensagemDaTranscricao({ status: "em_andamento" })).toMatch(/em andamento/);
  });
});

describe("memória", () => {
  it("guarda o texto por mensagem", () => {
    expect(transcricaoLembrada("m1")).toBeNull();
    lembrarTranscricao("m1", "olá");
    expect(transcricaoLembrada("m1")).toBe("olá");
  });
  it("sem chave vale por 10 min", () => {
    expect(transcricaoSemChave("org1", 1000)).toBe(false);
    marcarSemChave("org1", 1000);
    expect(transcricaoSemChave("org1", 1000 + TRANSCRICAO_SEM_CHAVE_MS - 1)).toBe(true);
    expect(transcricaoSemChave("org1", 1000 + TRANSCRICAO_SEM_CHAVE_MS)).toBe(false);
  });
  it("sem chave é por organização", () => {
    marcarSemChave("org1", 1000);
    expect(transcricaoSemChave("org2", 1000)).toBe(false);
    expect(transcricaoSemChave(null, 1000)).toBe(false);
  });
});

describe("podeTranscrever", () => {
  it("só uuid (bolha otimista tem id temporário)", () => {
    expect(podeTranscrever("3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b")).toBe(true);
    expect(podeTranscrever("temp-1731250000000")).toBe(false);
  });
});

describe("mensagemDoErroDaEdge", () => {
  it("código conhecido vira frase; código cru vira fallback; frase humana passa adiante", () => {
    expect(mensagemDoErroDaEdge(new Error("unauthorized"))).toMatch(/sessão expirou/);
    expect(mensagemDoErroDaEdge(new Error("mensagem_nao_encontrada"))).toMatch(/não tem acesso/);
    expect(mensagemDoErroDaEdge(new Error("erro_interno"))).toBe(FALLBACK_ERRO);
    expect(mensagemDoErroDaEdge(new Error("Serviço temporariamente indisponível. Tente novamente."))).toBeNull();
    expect(mensagemDoErroDaEdge("x")).toBeNull();
  });
});

describe("transcricaoCortada", () => {
  it("no teto do texto guardado", () => {
    expect(transcricaoCortada("a".repeat(TRANSCRICAO_TEXTO_MAX))).toBe(true);
    expect(transcricaoCortada("a".repeat(TRANSCRICAO_TEXTO_MAX - 1))).toBe(false);
  });
});
