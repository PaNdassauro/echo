/**
 * Cor de um número na tela (ponto do seletor, da Equipe, do selo e do diálogo da caixa
 * conjunta): o matiz dele; sem matiz, o teal da marca. Fonte única da fórmula.
 * `luminosidade` é o L do HSL: 55 no ponto, e quem precisa de fundo mais claro (o círculo
 * da inicial no selo) passa outro valor, sem repetir a fórmula em outro arquivo.
 */
const MATIZ_PADRAO = 176;
const SATURACAO = 65;

export function getPhoneLineColor(themeHue: number | null | undefined, luminosidade = 55): string {
  return `hsl(${themeHue ?? MATIZ_PADRAO}, ${SATURACAO}%, ${luminosidade}%)`;
}
