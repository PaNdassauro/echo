import { fetchLatestWaWebVersion, type WAVersion } from '@whiskeysockets/baileys';

// WhatsApp rejeita conexões de versões antigas do client (queda em massa de 2026-07-13).
// Resolve a revisão atual em runtime via web.whatsapp.com/sw.js; cache de 6h e uma
// única requisição em voo, para N sessões reconectando não baterem N vezes.
export const FALLBACK_WA_VERSION: WAVersion = [2, 3000, 1043857760]; // default da baileys 7.0.0-rc14
const WA_VERSION_TTL_MS = 6 * 60 * 60 * 1000;

let cached: { version: WAVersion; fetchedAt: number } | null = null;
let inflight: Promise<WAVersion> | null = null;

export async function resolveWaVersion(): Promise<WAVersion> {
    if (cached && Date.now() - cached.fetchedAt < WA_VERSION_TTL_MS) return cached.version;
    if (!inflight) {
        inflight = fetchLatestWaWebVersion({})
            .then(({ version, isLatest }) => {
                if (isLatest && Array.isArray(version) && version.length === 3) {
                    cached = { version, fetchedAt: Date.now() };
                    console.log('[WA_VERSION] Resolved latest version', version.join('.'));
                    return version;
                }
                console.error('[WA_VERSION] Could not parse latest version, using fallback', FALLBACK_WA_VERSION.join('.'));
                return cached?.version ?? FALLBACK_WA_VERSION;
            })
            .catch((err: unknown) => {
                console.error('[WA_VERSION] Fetch failed, using fallback', FALLBACK_WA_VERSION.join('.'), err);
                return cached?.version ?? FALLBACK_WA_VERSION;
            })
            .finally(() => { inflight = null; });
    }
    return inflight;
}
