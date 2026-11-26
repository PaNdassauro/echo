import { fetchLatestWaWebVersion } from 'zapo-js';

// O WhatsApp recusa cliente com versão antiga (`failure_client_too_old`, 405): com a versão
// fixa na lib, todas as linhas da zapo caem de uma vez quando ela envelhece. Par do
// `baileys/waVersion.ts`: resolve a revisão atual em runtime, com cache e uma única busca
// em voo para N sessões reconectando juntas. Sem resposta válida devolve `undefined`, e a
// lib usa a versão que traz embutida.
const WA_VERSION_TTL_MS = 60 * 60 * 1000;
const WA_VERSION_RETRY_COOLDOWN_MS = 60 * 1000;
const WEB_VERSION = /^2\.3000\.\d{6,12}$/;

export interface WaVersionResolver {
    resolve(): Promise<string | undefined>;
    /** Descarta o cache: a versão guardada acabou de ser recusada pelo servidor. */
    invalidate(): void;
}

export function createWaVersionResolver(
    fetchLatest: () => Promise<{ version: string }> = () => fetchLatestWaWebVersion(),
    now: () => number = Date.now,
): WaVersionResolver {
    let cached: { version: string; fetchedAt: number } | null = null;
    let lastFailedAt: number | null = null;
    let inflight: Promise<string | undefined> | null = null;

    return {
        resolve(): Promise<string | undefined> {
            const currentTime = now();
            if (cached && currentTime - cached.fetchedAt < WA_VERSION_TTL_MS) {
                return Promise.resolve(cached.version);
            }
            if (cached && lastFailedAt !== null && currentTime - lastFailedAt < WA_VERSION_RETRY_COOLDOWN_MS) {
                return Promise.resolve(cached.version);
            }
            if (!inflight) {
                inflight = fetchLatest()
                    .then(({ version }) => {
                        if (typeof version === 'string' && WEB_VERSION.test(version)) {
                            cached = { version, fetchedAt: now() };
                            lastFailedAt = null;
                            console.log('[WA_VERSION][zapo] Versão atual resolvida', version);
                            return version;
                        }
                        lastFailedAt = cached ? now() : null;
                        console.error('[WA_VERSION][zapo] Versão em formato inesperado, usando a anterior ou a da lib', version);
                        return cached?.version;
                    })
                    .catch((err: unknown) => {
                        lastFailedAt = cached ? now() : null;
                        console.error('[WA_VERSION][zapo] Busca falhou, usando a anterior ou a da lib', err);
                        return cached?.version;
                    })
                    .finally(() => { inflight = null; });
            }
            return inflight;
        },
        invalidate(): void {
            cached = null;
            lastFailedAt = null;
        },
    };
}

export const zapoWaVersion = createWaVersionResolver();
