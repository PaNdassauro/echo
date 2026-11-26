/**
 * Descoberta das sessões guardadas no boot, com nova tentativa.
 *
 * O Baileys lista as sessões do disco (não falha). A zapo lista pelas linhas do
 * Postgres (`phone_numbers.qr_provider = 'zapo'`) via gateway/rest. Quando o host
 * reinicia, o Docker sobe os containers juntos e não respeita `depends_on` (que só vale
 * no `compose up`): o qr pode chegar antes do banco. Sem isto, a consulta falha, a lista
 * vira vazia e nenhuma linha zapo é restaurada, sem aviso e sem nova tentativa.
 */

export interface StoredSessionLister {
    readonly name: string;
    listStoredSessions(): Promise<string[]>;
}

/** Esperas entre tentativas: 2+4+8+16+32+60+60 s ≈ 3 min no total. */
export const DISCOVERY_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Uma tentativa. `null` = a leitura falhou (erro logado); `[]` = leu e não há sessões. */
export async function listStoredOnce(factory: StoredSessionLister): Promise<string[] | null> {
    try {
        return await factory.listStoredSessions();
    } catch (err) {
        console.error(`[SessionManager] Falha ao listar sessões guardadas de '${factory.name}': ${errorMessage(err)}`);
        return null;
    }
}

/**
 * Repete a leitura com backoff. Devolve a lista, ou `null` depois de esgotar as
 * tentativas (com um erro explícito no log dizendo como recuperar). `shouldStop`
 * interrompe entre as esperas (devolve `null` sem o erro de desistência).
 */
export async function listStoredWithRetry(
    factory: StoredSessionLister,
    delaysMs: readonly number[] = DISCOVERY_RETRY_DELAYS_MS,
    sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    shouldStop: () => boolean = () => false,
): Promise<string[] | null> {
    for (let i = 0; i < delaysMs.length; i++) {
        await sleepFn(delaysMs[i]);
        // Encerramento (SIGTERM) no meio do backoff: não lê nem restaura nada depois do shutdown.
        if (shouldStop()) {
            console.log(`[SessionManager] Nova tentativa de listar as sessões de '${factory.name}' cancelada (encerrando)`);
            return null;
        }
        const ids = await listStoredOnce(factory);
        if (ids) {
            console.log(`[SessionManager] Sessões de '${factory.name}' listadas na tentativa ${i + 2}`);
            return ids;
        }
    }
    console.error(
        `[SessionManager] Desisti de listar as sessões de '${factory.name}' após ${delaysMs.length + 1} tentativas: ` +
        `as linhas dessa lib ficam desconectadas até reiniciar o qr (./echo restart qr) ou reconectar pelo painel`,
    );
    return null;
}
