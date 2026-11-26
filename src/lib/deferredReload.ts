/**
 * Reload do service worker adiado até ser seguro.
 *
 * Só recarrega com a aba em segundo plano (recarregar na frente do atendente
 * derruba o realtime e o desbloqueio de áudio) e nunca por cima do que um
 * reload destrói sem volta: ligação em curso ou envio de mídia subindo.
 * `request()` marca que há versão nova; `evaluate()` é chamado a cada sinal
 * que pode liberar (aba escondida, ligação ou fila terminando).
 */
export function createDeferredReload(deps: {
  isHidden: () => boolean;
  isBlocked: () => boolean;
  reload: () => void;
}) {
  let requested = false;
  let done = false;

  const evaluate = () => {
    if (!requested || done) return;
    if (!deps.isHidden() || deps.isBlocked()) return;
    done = true;
    deps.reload();
  };

  return {
    request() {
      requested = true;
      evaluate();
    },
    evaluate,
  };
}
