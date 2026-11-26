import { createRoot } from "react-dom/client";
import { registerServiceWorker } from "@/lib/serviceWorkerRegistration";
import { deleteLegacyRuntimeCaches } from "@/lib/legacyCaches";
import App from "./App.tsx";
import { reloadOnce } from "@/lib/reloadOnce";
import { isCallActive } from "@/lib/callActivity";
import { mediaUploadQueue } from "@/lib/mediaUploadTransport";
import { createDeferredReload } from "@/lib/deferredReload";
import "./index.css";
import { applyA11yPrefs, readA11yPrefs } from "@/lib/accessibilityPrefs";

// Acessibilidade (tamanho do texto, contraste, movimento) antes do primeiro
// render, pela última preferência aplicada: o app não pinta em 100% para
// depois pular. O UserThemeMount troca pela do usuário quando a sessão chega.
applyA11yPrefs(readA11yPrefs(null));

// Recover from stale lazy-chunk fetches after a deploy. Vite wraps every
// dynamic import() (including React.lazy) and dispatches `vite:preloadError`
// when a chunk fetch fails — which happens when a tab open across a deploy
// still references old hashed chunk URLs that the new deploy has already replaced.
// `reloadOnce` pulls a fresh index.html (max-age=0) with the new hashes, and
// guards against a reload loop when the chunk is genuinely unfetchable.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault(); // we own recovery; suppress the default hard failure
  reloadOnce();
});

// Auto-reload when a new service worker takes over — but only on subsequent
// updates, not on the first install. Attaching unconditionally caused F5 to
// reload-trap mid-boot: skipWaiting + clientsClaim made the freshly installed
// SW claim the page, fire `controllerchange`, and reload before React mounted.
if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
  // Don't interrupt an active session: a reload tears down the realtime
  // channel and resets the audio-unlock state, which is exactly how open
  // tabs stopped notifying mid-day. Reload only while the tab is in the
  // background, and never over a voice call (o serviço desliga assim que o
  // WebSocket de áudio cai) or a media upload (o XHR morre e o arquivo não
  // chega). Genuinely missing lazy chunks are still recovered eagerly via
  // `vite:preloadError`.
  const swReload = createDeferredReload({
    isHidden: () => document.visibilityState === "hidden",
    isBlocked: () => isCallActive() || mediaUploadQueue.hasPending(),
    reload: () => window.location.reload(),
  });
  navigator.serviceWorker.addEventListener("controllerchange", swReload.request);
  // Reavalia quando a aba some e quando a fila de mídia anda: o último envio
  // terminando com a aba já escondida libera o reload na hora.
  document.addEventListener("visibilitychange", swReload.evaluate);
  mediaUploadQueue.subscribe(swReload.evaluate);
}

// One-time cleanup of the legacy runtime caches. Older builds created two:
// - `html-cache`: navigation responses cached for 24h, which made tab-reopen
//   serve stale HTML;
// - `supabase-cache`: GET responses of `*.supabase.co` (REST, auth, functions),
//   authenticated and per user, keyed only by URL.
// The new SW config creates neither, but existing devices still have them
// (Workbox's cleanupOutdatedCaches only touches precaches, and the expiration
// plugin only runs while a route uses the cache) — delete explicitly so no
// code path can serve from them and no old response outlives a logout.
if ("caches" in window) {
  void deleteLegacyRuntimeCaches(caches);
}

// Register the SW ourselves (not via `virtual:pwa-register`, whose autoUpdate
// client reloads the page the moment a new SW activates, foreground or not)
// and poll for updates. The dev server doesn't build a SW.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void registerServiceWorker({
    container: navigator.serviceWorker,
    win: window,
    doc: document,
  });
}

createRoot(document.getElementById("root")!).render(<App />);
