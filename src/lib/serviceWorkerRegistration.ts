/**
 * Registro do service worker sem o cliente do vite-plugin-pwa.
 *
 * O `registerSW` de `virtual:pwa-register` no modo `autoUpdate` chama
 * `window.location.reload()` assim que o SW novo ativa, sem olhar se a aba
 * está na frente. Com o poll de 60 s, todo deploy na `main` recarregava o app
 * na cara do atendente. Quem decide o reload é o `createDeferredReload` do
 * `main.tsx` (aba escondida, sem ligação nem upload); aqui só se registra e se
 * procura versão nova.
 */

export const SW_URL = "/sw.js";
export const UPDATE_INTERVAL_MS = 60 * 1000;

export function registerServiceWorker(deps: {
  container: ServiceWorkerContainer;
  win: Pick<Window, "addEventListener" | "setInterval">;
  doc: Pick<Document, "addEventListener" | "visibilityState">;
}): Promise<ServiceWorkerRegistration | null> {
  const { container, win, doc } = deps;

  return container
    .register(SW_URL, { scope: "/" })
    .then((registration) => {
      const check = () => {
        registration.update().catch(() => {});
      };

      // Poll a cada 60 s para abas abertas notarem o deploy novo; sem isso o
      // navegador só procura em navegação (ou a cada ~24 h).
      win.setInterval(check, UPDATE_INTERVAL_MS);

      // E também na hora em que a aba volta ao foco ou a rede volta.
      win.addEventListener("focus", check);
      doc.addEventListener("visibilitychange", () => {
        if (doc.visibilityState === "visible") check();
      });
      win.addEventListener("online", check);

      return registration;
    })
    .catch((error: unknown) => {
      console.error("[PWA] Falha ao registrar o service worker:", error);
      return null;
    });
}
