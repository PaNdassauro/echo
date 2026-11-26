// Marca de IA da aba Com a IA (colunas ia_desde e gatilho on_message_inserted).
//
// Um agente de IA externo que atende pela echo-api grava messages.metadata.ia; o gatilho
// on_message_inserted põe a conversa na aba Com a IA, e ela só volta para o time
// quando a IA passa a conversa (/assign) ou alguém do time age.
// Os tamanhos são os mesmos que o gatilho corta (origem 40) e os de Disparos (rótulo 80).

export interface MarcaDeIa {
  origem?: string;
  rotulo?: string;
}

function texto(valor: unknown, max: number): string | undefined {
  if (typeof valor !== 'string') return undefined;
  const limpo = valor.trim().slice(0, max);
  return limpo.length > 0 ? limpo : undefined;
}

/**
 * Lê o campo `ia` do corpo da echo-api. Aceita `true` (IA sem nome) ou um objeto
 * `{ origem, rotulo }`. Qualquer outra coisa = não é IA, e a mensagem segue o
 * caminho de sempre.
 */
export function lerIa(bruto: unknown): MarcaDeIa | null {
  if (bruto === true) return {};
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const campos = bruto as Record<string, unknown>;
  const marca: MarcaDeIa = {};
  const origem = texto(campos.origem, 40);
  const rotulo = texto(campos.rotulo, 80);
  if (origem) marca.origem = origem;
  if (rotulo) marca.rotulo = rotulo;
  return marca;
}
