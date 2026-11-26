import fs from 'fs';
import path from 'path';
import NodeCache from 'node-cache';
import type { ClientConfig, WhatsAppClient, WhatsAppClientFactory } from '../WhatsAppClient.js';
import type { SessionStore } from '../types.js';
import { BAILEYS_CAPABILITIES, BAILEYS_LIBRARY_ID, BaileysClient, type BaileysRuntime } from './BaileysClient.js';
import { FileSessionStore } from './FileSessionStore.js';
import { resolveWaVersion } from './waVersion.js';

export { BaileysClient, FileSessionStore, BAILEYS_CAPABILITIES, BAILEYS_LIBRARY_ID, resolveWaVersion };

export class BaileysClientFactory implements WhatsAppClientFactory {
    readonly name = 'baileys';
    readonly libraryId = BAILEYS_LIBRARY_ID;
    readonly capabilities = BAILEYS_CAPABILITIES;

    private readonly runtime: BaileysRuntime;

    /** `sessionsRoot` = a pasta `sessions/` de hoje; cada sessão vira `sessions/<id>`. */
    constructor(private readonly sessionsRoot: string) {
        this.runtime = {
            msgRetryCounterCache: new NodeCache({ stdTTL: 86400, checkperiod: 3600 }),
        };
    }

    createStore(sessionId: string): SessionStore {
        return new FileSessionStore(path.join(this.sessionsRoot, sessionId));
    }

    async listStoredSessions(): Promise<string[]> {
        if (!fs.existsSync(this.sessionsRoot)) return [];
        return fs.readdirSync(this.sessionsRoot).filter((id) =>
            !id.startsWith('_') && fs.existsSync(path.join(this.sessionsRoot, id, 'creds.json')));
    }

    create(config: ClientConfig): WhatsAppClient {
        return new BaileysClient(config, this.runtime);
    }

    async describeRuntime(): Promise<{ libraryId: string; waVersion?: string }> {
        const version = await resolveWaVersion();
        return { libraryId: this.libraryId, waVersion: version.join('.') };
    }
}
