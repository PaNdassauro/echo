// Máscara de dados sensíveis antes de guardar ou enviar texto.
// Módulo puro: sem import remoto e sem IO.

const CPF_PONTUADO = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
const CPF_CRU = /(?<![\d.-])\d{11}(?![\d]|[.-]\d)/g;
// BR Code do Pix: começa em '000201' e termina no CRC '6304' + 4 hex.
const PIX_EMV = /000201[^\n]{10,700}?6304[0-9A-Fa-f]{4}/g;
// "chave pix: <valor>" (e-mail, telefone, CPF/CNPJ, aleatória): a chave colada em texto.
const PIX_CHAVE =
  /(chave(?:\s+pix)?|pix)(\s*[:\-=]\s*|\s+(?:é|e)\s+|\s+)((?:[\w.+-]+@[\w-]+(?:\.[\w-]+)+)|(?:\+?\d[\d().\s-]{7,}\d)|(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))/gi;
const CANDIDATO_CARTAO = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

function cpfValido(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  for (const tam of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tam; i++) soma += Number(d[i]) * (tam + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(d[tam])) return false;
  }
  return true;
}

function luhn(d: string): boolean {
  let soma = 0;
  let dobra = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dobra) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    soma += n;
    dobra = !dobra;
  }
  return soma % 10 === 0;
}

/** CPF → [CPF]; EMV Pix e chave Pix → [PIX]; cartão 13–19 dígitos com Luhn → [CARTAO]. */
export function mascarar(texto: string): string {
  if (!texto) return texto;
  let t = texto.replace(PIX_EMV, '[PIX]');
  t = t.replace(PIX_CHAVE, (_m, rotulo: string, sep: string) => `${rotulo}${sep}[PIX]`);
  t = t.replace(CANDIDATO_CARTAO, (m) => {
    const d = m.replace(/\D/g, '');
    if (d.length < 13 || d.length > 19) return m;
    // Telefone BR com DDI (55 + 10/11 dígitos = 12/13) passa no Luhn 1 vez em 10:
    // nenhum cartão tem 13 dígitos começando em 55.
    if (/^55[1-9]\d{9,10}$/.test(d)) return m;
    return luhn(d) ? '[CARTAO]' : m;
  });
  t = t.replace(CPF_PONTUADO, '[CPF]');
  t = t.replace(CPF_CRU, (m) => (cpfValido(m) ? '[CPF]' : m));
  return t;
}
