// Instante canônico com microssegundos.
//
// `messages.created_at` e `message_reactions.reacted_at` são timestamptz em µs.
// Passar por `Date` corta para ms e um cursor baseado numa mensagem passaria a ficar
// "antes" dela, repetindo-a na janela seguinte. Por isso a string do PostgREST é
// tratada por regex, nunca por `new Date(x).toISOString()`.
//
// Módulo puro: sem import remoto e sem IO.

const RE_INSTANTE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** 'YYYY-MM-DDTHH:MM:SS.ffffffZ' (6 casas). Lança em formato inválido. */
export function isoUs(x: string | Date): string {
  if (x instanceof Date) {
    const t = x.getTime();
    if (Number.isNaN(t)) throw new Error('isoUs: Date inválido');
    // Date só tem ms: completa com '000'.
    return x.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
  }
  const m = RE_INSTANTE.exec(typeof x === 'string' ? x.trim() : '');
  if (!m) throw new Error(`isoUs: formato inválido: ${String(x).slice(0, 40)}`);
  const [, ano, mes, dia, hh, mm, ss, fracao, zona] = m;
  const us = (fracao ?? '').padEnd(6, '0').slice(0, 6);
  const base = `${ano}-${mes}-${dia}T${hh}:${mm}:${ss}`;

  let deslocamentoMin = 0;
  if (zona && zona.toUpperCase() !== 'Z') {
    const sinal = zona[0] === '-' ? -1 : 1;
    const digitos = zona.slice(1).replace(':', '');
    const oh = Number(digitos.slice(0, 2));
    const om = Number(digitos.slice(2, 4) || '0');
    deslocamentoMin = sinal * (oh * 60 + om);
  }

  // Validação de calendário (e conversão de fuso) pela parte inteira em segundos:
  // os µs ficam fora do Date, que os perderia.
  const ms = Date.parse(`${base}Z`);
  if (Number.isNaN(ms)) throw new Error(`isoUs: instante inválido: ${base}`);
  const utc = new Date(ms - deslocamentoMin * 60_000);
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}` +
    `T${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}.${us}Z`;
}

/** Largura fixa: a ordem do texto é a ordem cronológica. */
export function compararIso(a: string, b: string): number {
  const x = isoUs(a);
  const y = isoUs(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
