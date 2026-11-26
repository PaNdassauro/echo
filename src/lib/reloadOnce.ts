/**
 * Recovery from stale lazy-chunk fetches after a deploy.
 *
 * A tab left open across a deploy still holds the old content-hashed chunk
 * URLs in memory. The new deploy has already replaced those files, so lazy navigation
 * fails with "Failed to fetch dynamically imported module" and the app dies
 * with no recovery path — the reason users had to Ctrl+Shift+R.
 *
 * A single reload pulls a fresh index.html (served max-age=0, must-revalidate)
 * which references the new chunk hashes, fixing the tab silently.
 */

const RELOAD_KEY = "chunk-error-reload-ts";
const GUARD_MS = 10_000;

/**
 * Reload the page at most once per GUARD_MS window. The guard prevents a reload
 * loop when a chunk is genuinely unfetchable (e.g. the device is offline), where
 * reloading would just fail again immediately.
 *
 * @returns `true` if a reload was triggered, `false` if suppressed by the guard.
 */
export function reloadOnce(): boolean {
  const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
  if (Date.now() - last <= GUARD_MS) return false;

  sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  window.location.reload();
  return true;
}

/** Whether an error looks like a failed dynamic import of a stale chunk. */
export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (
    /dynamically imported module|Importing a module script failed|ChunkLoadError|Failed to fetch/i.test(
      message,
    ) ||
    // Chunk servido como HTML: quando o asset ainda não propagou (ou o SW
    // devolve o fallback de navegação), o rewrite do SPA responde index.html
    // com MIME text/html. O navegador rejeita o módulo por MIME e o import
    // resolve sem módulo, então o React.lazy estoura lendo `.default` de
    // undefined — mensagem que NÃO casa com os padrões acima e por isso caía
    // como erro fatal, mostrando "algo deu errado" em vez de recarregar.
    /Expected a JavaScript-or-Wasm module script|MIME type/i.test(message) ||
    /reading ['"]default['"]|of undefined \(reading|undefined is not an object/i.test(message)
  );
}
