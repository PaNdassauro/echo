import { describe, expect, it } from "vitest";
import {
  instagramConexoesSchema,
  linhaPodeHospedar,
  mensagemDoInstagram,
  resultadoDaConexao,
  rotuloDoTipoDeLinha,
  situacaoDoToken,
  textoDoErroDaConexao,
} from "./instagramConexoes";

const agora = Date.parse("2026-11-20T12:00:00Z");

describe("linhas Instagram", () => {
  it("só linha QR ou API divide a caixa (NULL é API)", () => {
    expect(["qr", "business_api", "business", "official", null].map(linhaPodeHospedar)).toEqual([true, true, true, true, true]);
    expect(linhaPodeHospedar("instagram")).toBe(false);
    expect(rotuloDoTipoDeLinha("qr")).toBe("QR Code");
    expect(rotuloDoTipoDeLinha(null)).toBe("Business API");
  });

  it("situação do token: vencido, perto (≤10 dias), ok e sem data", () => {
    expect(situacaoDoToken("2026-11-20T11:00:00Z", agora)).toEqual({ tipo: "vencido" });
    expect(situacaoDoToken("2026-11-27T18:32:01Z", agora)).toEqual({ tipo: "perto", dias: 8 });
    expect(situacaoDoToken("2027-01-20T12:00:00Z", agora)).toEqual({ tipo: "ok", dias: 61 });
    expect(situacaoDoToken(null, agora)).toEqual({ tipo: "sem-data" });
    expect(situacaoDoToken("lixo", agora)).toEqual({ tipo: "sem-data" });
  });

  it("volta do login: ok não é erro, códigos conhecidos têm texto, desconhecido é nulo", () => {
    expect(resultadoDaConexao("ok", "acme")).toMatchObject({ erro: false, descricao: expect.stringContaining("@acme") });
    for (const codigo of ["sem-avisos", "cancelado", "link-invalido", "indisponivel", "linha", "recusado", "outra-linha", "linha-ocupada", "erro"]) {
      expect(resultadoDaConexao(codigo, null)?.erro).toBe(true);
    }
    expect(resultadoDaConexao("qualquer", null)).toBeNull();
  });

  it("erro das RPCs perde o prefixo; erro técnico vira o padrão", () => {
    expect(mensagemDoInstagram({ message: "Instagram: só administradores mexem na conexão" }, "x")).toBe("só administradores mexem na conexão");
    expect(mensagemDoInstagram(new Error("permission denied for table"), "Tente de novo.")).toBe("Tente de novo.");
  });

  it("contrato da RPC: contagens bigint chegam como número ou texto", () => {
    const linha = {
      id: "0f0e0d0c-0b0a-4908-8706-050403020100",
      organization_id: "00000000-0000-4000-8000-000000000001",
      display_name: "@acme",
      ig_user_id: "178",
      ig_username: "acme",
      status: "connected",
      last_error: null,
      token_expires_at: "2026-11-27T18:32:01.838+00:00",
      connected_at: "2026-09-28T18:32:01+00:00",
      ligada: false,
      modo: "off",
      linha_id: "00000000-0000-4000-8000-000000000002",
      linha_nome: "Vendas API",
      linha_tipo: "business_api",
      conversas_so_direct: "1",
      cards_juntados: 0,
      pode_gerenciar: true,
    };
    const parsed = instagramConexoesSchema.parse([linha]);
    expect(parsed[0].conversas_so_direct).toBe(1);
    expect(instagramConexoesSchema.safeParse([{ ...linha, id: "x" }]).success).toBe(false);
    expect(instagramConexoesSchema.safeParse([{ ...linha, modo: "outro" }]).success).toBe(false);
    expect(instagramConexoesSchema.safeParse([{ ...linha, modo: "piloto" }]).success).toBe(false);
  });

  it("erro da conexão vira instrução com data dd/mm/aaaa; sem erro, nada", () => {
    expect(textoDoErroDaConexao(null)).toBeNull();
    expect(
      textoDoErroDaConexao("renovação do token: Invalid OAuth access token código 190; reconecte a conta antes de 2026-11-27"),
    ).toBe("O Echo não conseguiu renovar o acesso ao Instagram. Reconecte a conta até 27/11/2026.");
    expect(textoDoErroDaConexao("assinatura dos avisos: erro sem detalhe | token longo recusado (x)")).toContain("avisos de mensagem");
    expect(textoDoErroDaConexao("token longo recusado (x); conexão com token de 1 hora")).toContain("1 hora");
    expect(textoDoErroDaConexao("qualquer coisa")).toContain("Reconecte a conta");
  });
});
