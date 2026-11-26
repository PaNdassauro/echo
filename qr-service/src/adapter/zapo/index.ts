import './polyfill.js';
import { createStore, type WaStore } from 'zapo-js';
import type { ClientConfig, WhatsAppClient, WhatsAppClientFactory } from '../WhatsAppClient.js';
import type { SessionStore } from '../types.js';
import { ZAPO_CAPABILITIES, ZAPO_LIBRARY_ID, ZapoClient } from './ZapoClient.js';
import { ZapoSessionStore } from './ZapoSessionStore.js';
import { zapoWaVersion } from './waVersion.js';

export { ZapoClient, ZapoSessionStore, ZAPO_CAPABILITIES, ZAPO_LIBRARY_ID };

export type ZapoStoreMode =
    /** Só testes: nada sobrevive ao processo. */
    | { kind: 'memory' }
    /** Produção: schema próprio no Postgres (tabelas `<prefix>*`). */
    | { kind: 'postgres'; connectionString: string; tablePrefix?: string };

const MEMORY_PROVIDERS = {
    auth: 'memory', signal: 'memory', preKey: 'memory', session: 'memory', identity: 'memory',
    senderKey: 'memory', appState: 'memory', privacyToken: 'memory',
    messages: 'none', threads: 'none', contacts: 'none',
} as const;

/**
 * Quando o contato não consegue decifrar uma mensagem nossa, o aparelho dele pede reenvio
 * (retry receipt) e a zapo só reenvia o que ainda está no cache de retry — 60 s por padrão.
 * Contato offline por mais que isso ficava com "Aguardando esta mensagem" para sempre (o
 * Baileys tinha o getMessage de fallback). 6 h cobre quem fica fora algumas horas; o teto
 * por sessão (LRU) segura a RAM.
 */
const RETRY_WINDOW = {
    cacheTtlMs: { retryMs: 6 * 60 * 60 * 1000 },
    limits: { retryOutboundMessages: 3000 },
} as const;

export class ZapoClientFactory implements WhatsAppClientFactory {
    readonly name = 'zapo';
    readonly libraryId = ZAPO_LIBRARY_ID;
    readonly capabilities = ZAPO_CAPABILITIES;
    private store: WaStore | null = null;
    private readonly known = new Set<string>();

    /**
     * `listSessionIds` é quem sabe quais linhas estão na zapo (phone_numbers.qr_provider);
     * o WaStore não enumera sessões.
     */
    constructor(
        private readonly mode: ZapoStoreMode,
        private readonly listSessionIds?: () => Promise<string[]>,
    ) {}

    private waStore(): WaStore {
        if (this.store) return this.store;
        if (this.mode.kind === 'memory') {
            this.store = createStore({ providers: MEMORY_PROVIDERS } as unknown as Parameters<typeof createStore>[0]);
        } else {
            // Import dinâmico: `pg` só é carregado quando a zapo em Postgres está configurada.
            throw new Error('ZapoClientFactory: use ZapoClientFactory.postgres() para o modo postgres');
        }
        return this.store;
    }

    /** Factory em Postgres (schema próprio; a mesma instância serve todas as sessões). */
    static async postgres(connectionString: string, tablePrefix = 'wa_zapo_', listSessionIds?: () => Promise<string[]>): Promise<ZapoClientFactory> {
        const { createPostgresStore } = await import('@zapo-js/store-postgres');
        const pg = createPostgresStore({ pool: { connectionString }, tablePrefix });
        const factory = new ZapoClientFactory({ kind: 'postgres', connectionString, tablePrefix }, listSessionIds);
        factory.store = createStore({
            backends: { pg },
            memory: RETRY_WINDOW,
            providers: {
                auth: 'pg', signal: 'pg', preKey: 'pg', session: 'pg', identity: 'pg',
                senderKey: 'pg', appState: 'pg', privacyToken: 'pg',
                messages: 'none', threads: 'none', contacts: 'none',
            },
        } as unknown as Parameters<typeof createStore>[0]);
        return factory;
    }

    createStore(sessionId: string): SessionStore {
        this.known.add(sessionId);
        const locator = this.mode.kind === 'memory' ? `memory:${sessionId}` : `${this.mode.tablePrefix ?? 'wa_zapo_'}*/${sessionId}`;
        return new ZapoSessionStore(this.waStore(), sessionId, `zapo-${this.mode.kind}`, locator);
    }

    async listStoredSessions(): Promise<string[]> {
        if (this.listSessionIds) return this.listSessionIds();
        return [...this.known];
    }

    create(config: ClientConfig): WhatsAppClient {
        return new ZapoClient(config);
    }

    async describeRuntime(): Promise<{ libraryId: string; waVersion?: string }> {
        return { libraryId: this.libraryId, waVersion: await zapoWaVersion.resolve() };
    }
}
