/**
 * Insere `text` na seleção atual de um input/textarea (substitui o trecho
 * selecionado) e devolve o valor novo + a posição do cursor depois dele.
 * Sem seleção conhecida (campo nunca focado), acrescenta no fim.
 */
export function insertAtSelection(
  value: string,
  text: string,
  selectionStart: number | null | undefined,
  selectionEnd: number | null | undefined
): { value: string; caret: number } {
  const start = clamp(selectionStart ?? value.length, value.length);
  const end = Math.max(start, clamp(selectionEnd ?? start, value.length));
  return {
    value: value.slice(0, start) + text + value.slice(end),
    caret: start + text.length,
  };
}

/**
 * Insere no campo controlado e devolve o foco com o cursor logo depois do
 * texto (o rAF espera o React aplicar o valor novo).
 */
export function insertIntoField(
  field: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
  text: string,
  setValue: (next: string) => void
): void {
  const { value: next, caret } = insertAtSelection(
    value,
    text,
    field?.selectionStart,
    field?.selectionEnd
  );
  setValue(next);
  requestAnimationFrame(() => {
    if (!field) return;
    field.focus();
    field.setSelectionRange(caret, caret);
  });
}

function clamp(n: number, max: number): number {
  return Math.min(Math.max(0, n), max);
}
