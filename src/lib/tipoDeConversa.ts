/** Filtro de tipo da lista: separa conversa 1:1 de grupo. OR entre os marcados; nada marcado = todas. */
export type TipoDaConversa = "individual" | "grupo";

export function ehTipoDaConversa(id: string): id is TipoDaConversa {
  return id === "individual" || id === "grupo";
}

export function casaFiltroDeTipo(conversa: { is_group?: boolean | null }, tipos: readonly TipoDaConversa[]): boolean {
  if (tipos.length === 0) return true;
  return tipos.includes(conversa.is_group ? "grupo" : "individual");
}
