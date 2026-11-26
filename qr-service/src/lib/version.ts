import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Identidade da imagem em execução, servida pelos dois health checks.
 *
 * Diz qual build está vivo (versão + commit) sem depender dos logs do container:
 * "qual imagem está rodando?" é uma pergunta de um GET.
 *
 * Os valores vêm do build (Dockerfile: ARG → ENV). Lidos na chamada, não no
 * import, porque `dotenv.config()` do index.ts roda depois da inicialização dos
 * módulos — no container o env é real, mas em dev o .env precisa valer.
 *
 * Sem `--build-arg APP_VERSION` o Dockerfile deixa 'dev': aí vale a versão do
 * package.json.
 */
let packageVersionCache: string | null | undefined;

function packageVersion(): string | null {
    if (packageVersionCache !== undefined) return packageVersionCache;
    try {
        // src/lib/version.ts e dist/lib/version.js: o package.json fica duas pastas acima.
        const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
        const version = (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version;
        packageVersionCache = typeof version === 'string' && version ? version : null;
    } catch {
        packageVersionCache = null;
    }
    return packageVersionCache;
}

export function buildInfo(): { version: string; commit: string } {
    const fromBuild = process.env.APP_VERSION;
    return {
        version: fromBuild && fromBuild !== 'dev' ? fromBuild : packageVersion() ?? 'dev',
        commit: process.env.GIT_SHA || 'unknown',
    };
}
