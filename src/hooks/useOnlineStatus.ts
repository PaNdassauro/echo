import { useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/**
 * Estado de conexão do navegador. Num PWA usado em celular, "a internet caiu"
 * precisa ser distinguível de "o sistema quebrou" — este é o sinal para a
 * faixa offline global e para desabilitar envios.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
