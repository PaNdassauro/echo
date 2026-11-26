/**
 * Detecção e parse de chave Pix "copia e cola" (BR Code / EMV) no texto de uma
 * mensagem.
 *
 * Por que no front e não no ingresso: em 180 dias de prod as 13 chaves reais
 * chegaram como texto comum (`message_type='text'`, mais uma em legenda de
 * imagem) — nenhuma via WhatsApp Pay. Detectar na renderização faz o recurso
 * valer retroativamente para o que já está no banco, sem migração e sem
 * redeploy do qr-service.
 *
 * O problema que isto resolve não é "ver" a chave — é COPIÁ-LA. O payload chega
 * como um paredão de 150-230 caracteres, muitas vezes colado a texto do
 * atendente (o `append_agent_name` prefixa `*Nome*`), então selecionar à mão
 * arrasta sujeira e invalida o código. Aqui o payload é extraído exato.
 *
 * O EMV é TLV: cada campo é `ID(2) + tamanho(2) + valor`. Campos que usamos:
 *   26..51 → merchant account information (contém `br.gov.bcb.pix`)
 *   54     → valor (OPCIONAL: QR dinâmico deixa o banco definir)
 *   59     → nome do beneficiário
 *   63     → CRC16 do payload inteiro (validado: evita card em texto que só
 *            parece Pix)
 */

/** Campo TLV do BR Code. */
interface EmvField {
  id: string;
  value: string;
}

export interface PixPayload {
  /** Payload EMV exato, pronto para a área de transferência. */
  raw: string;
  /** Nome do beneficiário (campo 59), quando presente. */
  merchantName: string | null;
  /** Valor em reais (campo 54). `null` em QR dinâmico — não invente um valor. */
  amount: number | null;
  /** Cidade do beneficiário (campo 60). */
  merchantCity: string | null;
  /** CRC16 conferiu. Falso → provável texto truncado ou colado errado. */
  crcValid: boolean;
}

/**
 * Um payload Pix começa em `000201` (payload format indicator) e vai até o CRC
 * (`6304` + 4 hex). Case-insensitive porque prod tem as duas grafias do
 * domínio, e `[\s\S]` porque um payload copiado pode ter quebra de linha no meio.
 */
const PIX_CANDIDATE = /000201[\s\S]*?6304[0-9A-Fa-f]{4}/g;

const PIX_DOMAIN = /br\.gov\.bcb\.pix/i;

/** Percorre o TLV de forma tolerante: campo malformado interrompe sem lançar. */
function parseEmvFields(payload: string): EmvField[] {
  const fields: EmvField[] = [];
  let cursor = 0;
  while (cursor + 4 <= payload.length) {
    const id = payload.slice(cursor, cursor + 2);
    const length = Number.parseInt(payload.slice(cursor + 2, cursor + 4), 10);
    if (!Number.isFinite(length) || length < 0) break;
    const start = cursor + 4;
    const end = start + length;
    if (end > payload.length) break;
    fields.push({ id, value: payload.slice(start, end) });
    cursor = end;
  }
  return fields;
}

/**
 * CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — o algoritmo que o BR Code usa.
 * Calculado sobre tudo até e incluindo `6304`.
 */
function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function hasPixDomain(fields: EmvField[]): boolean {
  // O domínio vive num merchant account information (26..51), mas conferir em
  // qualquer campo é mais robusto contra provedor que use ID fora da faixa.
  return fields.some((f) => PIX_DOMAIN.test(f.value));
}

function parseAmount(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  // Campo 54 é decimal com ponto. Zero é valor "não definido" no BR Code, não
  // uma cobrança de R$ 0,00.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Extrai o primeiro Pix válido do texto, ou `null`. Só devolve resultado quando
 * o payload traz o domínio do Bacen — texto contendo apenas "pix" (na maioria conversa como "aceita pix?") nunca vira card.
 */
export function extractPixPayload(text: string | null | undefined): PixPayload | null {
  if (!text) return null;
  // Barato antes de caro: a regex de payload é bem mais pesada que um includes.
  if (!PIX_DOMAIN.test(text)) return null;

  for (const match of text.matchAll(PIX_CANDIDATE)) {
    // Só quebras de linha são removidas — o copiar/colar as injeta, e elas nunca
    // fazem parte do payload. ESPAÇO é significativo: vive dentro do nome e da
    // cidade do beneficiário ("SAO PAULO", "DOTTI ADVOGADOS"), então limpar
    // `\s+` corromperia o TLV e invalidaria o CRC.
    const raw = match[0].replace(/[\r\n]+/g, "");
    const fields = parseEmvFields(raw);
    if (!fields.length || !hasPixDomain(fields)) continue;

    const byId = new Map(fields.map((f) => [f.id, f.value]));
    const crcIndex = raw.lastIndexOf("6304");
    const expected = crcIndex > 0 ? crc16(raw.slice(0, crcIndex + 4)) : null;
    const actual = byId.get("63")?.toUpperCase() ?? null;

    return {
      raw,
      merchantName: byId.get("59")?.trim() || null,
      amount: parseAmount(byId.get("54")),
      merchantCity: byId.get("60")?.trim() || null,
      crcValid: !!expected && !!actual && expected === actual,
    };
  }

  return null;
}

/** Valor formatado em BRL, ou `null` quando o QR é dinâmico. */
export function formatPixAmount(amount: number | null): string | null {
  if (amount === null) return null;
  return amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
