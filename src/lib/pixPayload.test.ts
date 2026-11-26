import { describe, expect, it } from "vitest";
import { extractPixPayload, formatPixAmount } from "./pixPayload";

/**
 * Fixtures são payloads sintéticos no formato de cada provedor (estático, Itaú,
 * PicPay em minúsculas, dLocal), com CRC válido. Os identificadores são
 * fictícios: é o CRC deles que valida o parser.
 */
const PIX_ESTATICO_COM_VALOR =
  "00020126360014BR.GOV.BCB.PIX0114+55119999900015204000053039865406197.705802BR5918ACME COMERCIO LTDA6009SAO PAULO62260522AcmeTxid0000000000001A6304DF68";

const PIX_ITAU_DINAMICO =
  "00020101021226820014BR.GOV.BCB.PIX2560api.itau/pix/qr/v2/cobv/00000000-0000-4000-8000-0000000000aa5204000053039865802BR5912LOJA EXEMPLO6008CURITIBA62070503***63043D32";

const PIX_PICPAY_MINUSCULO =
  "00020126810014br.gov.bcb.pix2559qr-code.picpay.com/pix/00000000-0000-4000-8000-0000000000bb5204000053039865802BR5916SERVICOS EXEMPLO6009Sao Paulo62070503***63044820";

const PIX_DLOCAL =
  "00020101021226870014br.gov.bcb.pix2565qrcode.dlocal.com/qr/00000000/v1/000000000000400080000000000000015204000053039865802BR5906DLOCAL6009SAO PAULO62070503***630424A2";

describe("extractPixPayload", () => {
  it("extrai valor e beneficiário de Pix estático", () => {
    const pix = extractPixPayload(PIX_ESTATICO_COM_VALOR);
    expect(pix).not.toBeNull();
    expect(pix?.amount).toBe(197.7);
    expect(pix?.merchantName).toBe("ACME COMERCIO LTDA");
    expect(pix?.merchantCity).toBe("SAO PAULO");
    expect(pix?.crcValid).toBe(true);
  });

  it("valida o CRC16 dos quatro formatos de provedor", () => {
    for (const payload of [PIX_ESTATICO_COM_VALOR, PIX_ITAU_DINAMICO, PIX_PICPAY_MINUSCULO, PIX_DLOCAL]) {
      expect(extractPixPayload(payload)?.crcValid, payload.slice(0, 40)).toBe(true);
    }
  });

  it("aceita o domínio em minúsculas (existem as duas grafias)", () => {
    expect(extractPixPayload(PIX_PICPAY_MINUSCULO)?.merchantName).toBe("SERVICOS EXEMPLO");
  });

  it("devolve amount null em QR dinâmico em vez de inventar valor", () => {
    // Estes trazem 5403000/540300 — valor definido pelo banco na hora do pagamento.
    expect(extractPixPayload(PIX_ITAU_DINAMICO)?.amount).toBeNull();
    expect(extractPixPayload(PIX_DLOCAL)?.amount).toBeNull();
    expect(extractPixPayload(PIX_ITAU_DINAMICO)?.merchantName).toBe("LOJA EXEMPLO");
  });

  it("isola o payload do texto do atendente (append_agent_name)", () => {
    // O append_agent_name prefixa *Nome* e o atendente escreve antes.
    const withPrefix = `*Ana Souza* Segue o código do pix: ${PIX_ITAU_DINAMICO}`;
    const pix = extractPixPayload(withPrefix);
    expect(pix?.raw).toBe(PIX_ITAU_DINAMICO);
    expect(pix?.raw).not.toContain("Ana");
    expect(pix?.crcValid).toBe(true);
  });

  it("isola o payload quando há texto DEPOIS da chave", () => {
    const pix = extractPixPayload(`${PIX_DLOCAL}\n\nQualquer dúvida me chama!`);
    expect(pix?.raw).toBe(PIX_DLOCAL);
    expect(pix?.crcValid).toBe(true);
  });

  it("remove quebras de linha que o copiar/colar injeta no meio", () => {
    const half = Math.floor(PIX_DLOCAL.length / 2);
    const broken = `${PIX_DLOCAL.slice(0, half)}\n${PIX_DLOCAL.slice(half)}`;
    const pix = extractPixPayload(broken);
    expect(pix?.raw).toBe(PIX_DLOCAL);
    expect(pix?.crcValid).toBe(true);
  });

  it("ignora texto que apenas menciona pix", () => {
    // Mensagens comuns caem neste caso — nenhuma pode virar card.
    expect(extractPixPayload("O pagamento pode ser feito por pix?")).toBeNull();
    expect(extractPixPayload("Pix: contato@example.com")).toBeNull();
    expect(extractPixPayload("Valor no Pix: R$720,00 por veículo")).toBeNull();
    expect(extractPixPayload("Pix CNPJ: 12345678000195")).toBeNull();
  });

  it("marca crcValid false em payload corrompido, sem deixar de detectar", () => {
    // Um dígito trocado no meio: ainda é reconhecível como Pix, mas não confiável.
    const corrupted = PIX_DLOCAL.replace("DLOCAL", "DLOCAM");
    const pix = extractPixPayload(corrupted);
    expect(pix).not.toBeNull();
    expect(pix?.crcValid).toBe(false);
  });

  it("não estoura com entrada vazia, nula ou lixo", () => {
    expect(extractPixPayload(null)).toBeNull();
    expect(extractPixPayload(undefined)).toBeNull();
    expect(extractPixPayload("")).toBeNull();
    expect(extractPixPayload("000201")).toBeNull();
    // Prefixo certo e domínio certo, mas TLV truncado no meio do campo.
    expect(extractPixPayload("00020126360014BR.GOV.BCB.PIX0199+55")).toBeNull();
  });

  it("pega o primeiro payload quando a mensagem traz dois", () => {
    const pix = extractPixPayload(`Antigo: ${PIX_DLOCAL}\nNovo: ${PIX_ITAU_DINAMICO}`);
    expect(pix?.raw).toBe(PIX_DLOCAL);
  });
});

describe("formatPixAmount", () => {
  it("formata em BRL", () => {
    //   = espaço não-quebrável que o Intl usa entre símbolo e número.
    expect(formatPixAmount(197.7)?.replace(/ /g, " ")).toBe("R$ 197,70");
  });

  it("devolve null quando não há valor definido", () => {
    expect(formatPixAmount(null)).toBeNull();
  });
});
