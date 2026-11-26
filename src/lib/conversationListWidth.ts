/**
 * Largura da lista de conversas no desktop, arrastável pela borda direita.
 *
 * Preferência de ferramenta, não credencial — localStorage é apropriado aqui
 * (mesmo raciocínio de audioPlaybackRate). Em px, não em %: a lista é uma
 * coluna de leitura e não deve crescer junto com o monitor.
 */

export const LIST_WIDTH_DEFAULT = 384; // o antigo md:w-96
export const LIST_WIDTH_MIN = 240; // modo estreito (sidebar-narrow): só ícones, sem foto, em 100% de texto
export const LIST_WIDTH_MAX = 640;
/** Passo das setas do teclado no separador; Shift multiplica por 4. */
export const LIST_WIDTH_KEY_STEP = 16;

const STORAGE_KEY = "echo_conversation_list_width";

/**
 * Mínimo que vale agora: o cabeçalho da lista é rem e cresce com o "Tamanho do
 * texto do app", então o mínimo cresce junto (15rem; 300px em 125%). Recebe o
 * font-size computado do <html>; sem valor em px (jsdom) fica no de 16px.
 */
export const minListWidthFor = (rootFontSize: string): number => {
  const px = /^(\d+(?:\.\d+)?)px$/.exec(rootFontSize.trim());
  const scale = px ? Number(px[1]) / 16 : 1;
  return Math.min(LIST_WIDTH_MAX, Math.round(LIST_WIDTH_MIN * Math.max(scale, 1)));
};

export const clampListWidth = (width: number, min: number = LIST_WIDTH_MIN): number =>
  Math.round(Math.min(LIST_WIDTH_MAX, Math.max(min, width)));

export const parseListWidth = (value: string | null): number => {
  if (value === null || value.trim() === "") return LIST_WIDTH_DEFAULT;
  const n = Number(value);
  return Number.isFinite(n) ? clampListWidth(n) : LIST_WIDTH_DEFAULT;
};

export const readStoredListWidth = (): number => {
  try {
    return parseListWidth(localStorage.getItem(STORAGE_KEY));
  } catch {
    return LIST_WIDTH_DEFAULT;
  }
};

export const persistListWidth = (width: number): void => {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampListWidth(width)));
  } catch {
    /* modo privado / storage cheio — a largura só não persiste */
  }
};

/** Largura resultante de uma tecla no separador, ou null se a tecla não é dele. */
export const widthForKey = (
  width: number,
  key: string,
  shift: boolean,
  min: number = LIST_WIDTH_MIN,
): number | null => {
  const step = LIST_WIDTH_KEY_STEP * (shift ? 4 : 1);
  switch (key) {
    case "ArrowLeft":
      return clampListWidth(width - step, min);
    case "ArrowRight":
      return clampListWidth(width + step, min);
    case "Home":
      return min;
    case "End":
      return LIST_WIDTH_MAX;
    case "Enter":
      return LIST_WIDTH_DEFAULT;
    default:
      return null;
  }
};
