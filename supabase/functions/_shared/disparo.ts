// Marca de disparo da aba Disparos.
//
// Quem manda em massa (integrações pela API e o disparo do próprio Echo)
// grava messages.metadata.disparo; o gatilho on_message_inserted decide se a
// conversa entra, fica ou sai da aba.
// Os tamanhos são os mesmos que o gatilho corta (rótulo 80, campanha 120).

export interface MarcaDeDisparo {
  rotulo?: string;
  campanha?: string;
  origem?: string;
}

function texto(valor: unknown, max: number): string | undefined {
  if (typeof valor !== 'string') return undefined;
  const limpo = valor.trim().slice(0, max);
  return limpo.length > 0 ? limpo : undefined;
}

/**
 * Lê o campo `disparo` do corpo da echo-api. Aceita `true` (disparo sem rótulo)
 * ou um objeto `{ rotulo, campanha, origem }`. Qualquer outra coisa = não é
 * disparo, e a mensagem segue o caminho de sempre.
 */
export function lerDisparo(bruto: unknown): MarcaDeDisparo | null {
  if (bruto === true) return {};
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const campos = bruto as Record<string, unknown>;
  const marca: MarcaDeDisparo = {};
  const rotulo = texto(campos.rotulo, 80);
  const campanha = texto(campos.campanha, 120);
  const origem = texto(campos.origem, 40);
  if (rotulo) marca.rotulo = rotulo;
  if (campanha) marca.campanha = campanha;
  if (origem) marca.origem = origem;
  return marca;
}
