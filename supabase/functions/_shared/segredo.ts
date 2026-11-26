// Comparação de segredo sem vazar por tempo de resposta.
//
// `a !== b` sai no primeiro caractere diferente: medindo a latência, dá para
// adivinhar o segredo um caractere por vez. Aqui o laço percorre tudo.

const enc = new TextEncoder();

/** Compara duas strings em tempo constante para strings de mesmo tamanho. */
export function iguaisEmTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256(dado: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(dado)));
}

/**
 * Confere um segredo recebido (header) contra o esperado. Compara os sha256
 * dos dois, que têm sempre 32 bytes: assim nem o tamanho do segredo vaza.
 * Recebido ausente ou vazio nunca confere.
 */
export async function segredoConfere(recebido: string | null | undefined, esperado: string): Promise<boolean> {
  if (!recebido || !esperado) return false;
  const [a, b] = await Promise.all([sha256(recebido), sha256(esperado)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
