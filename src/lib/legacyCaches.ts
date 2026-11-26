/**
 * Caches de runtime que versões antigas do service worker criavam e que a
 * configuração atual não cria mais:
 * - `html-cache`: respostas de navegação guardadas por 24h (servia HTML velho ao reabrir a aba);
 * - `supabase-cache`: GET de `*.supabase.co` (REST, auth, functions), autenticado e por usuário,
 *   chaveado só pela URL.
 * O `cleanupOutdatedCaches` do Workbox só remove caches de precache, e a expiração dele só roda
 * enquanto uma rota usa o cache: sem apagar à mão, o aparelho antigo guarda as respostas para sempre.
 */
export const LEGACY_RUNTIME_CACHES = ["html-cache", "supabase-cache"] as const;

/** Apaga cada cache legado; falha em um não impede os outros, e nada aqui derruba o boot. */
export async function deleteLegacyRuntimeCaches(storage: Pick<CacheStorage, "delete">): Promise<void> {
  await Promise.all(
    LEGACY_RUNTIME_CACHES.map(async (name) => {
      try {
        await storage.delete(name);
      } catch (error) {
        console.warn(`Não foi possível apagar o cache legado ${name}`, error);
      }
    }),
  );
}
