import fs from 'fs';
import path from 'path';
import { BufferJSON } from '@whiskeysockets/baileys';
import type { AuthSnapshot, SessionStore } from '../types.js';

/**
 * Store do Baileys = pasta com `creds.json` + `<tipo>-<id>.json` (useMultiFileAuthState).
 * Exporta/importa no formato neutro `AuthSnapshot` para a troca de lib sem re-parear.
 */
export class FileSessionStore implements SessionStore {
    readonly kind = 'baileys-multifile';

    constructor(readonly dir: string) {}

    get locator(): string {
        return this.dir;
    }

    async exists(): Promise<boolean> {
        return fs.existsSync(path.join(this.dir, 'creds.json'));
    }

    async isPaired(): Promise<boolean> {
        const credsPath = path.join(this.dir, 'creds.json');
        if (!fs.existsSync(credsPath)) return false;
        try {
            // `registered` só existe no fluxo por código; sessão QR pareada tem `me`.
            const creds = JSON.parse(await fs.promises.readFile(credsPath, 'utf8')) as { registered?: boolean; me?: { id?: string } };
            return !!(creds.me?.id || creds.registered === true);
        } catch {
            return false;
        }
    }

    async wipe(): Promise<void> {
        await fs.promises.rm(this.dir, { recursive: true, force: true });
    }

    async ensureDir(): Promise<void> {
        await fs.promises.mkdir(this.dir, { recursive: true });
    }

    async exportSnapshot(libraryId: string): Promise<AuthSnapshot> {
        const credsPath = path.join(this.dir, 'creds.json');
        if (!fs.existsSync(credsPath)) {
            throw new Error(`Sem creds.json em ${this.dir}`);
        }
        const creds = JSON.parse(await fs.promises.readFile(credsPath, 'utf8'), BufferJSON.reviver) as Record<string, unknown>;
        const keys: Record<string, Record<string, unknown>> = {};
        for (const file of await fs.promises.readdir(this.dir)) {
            if (file === 'creds.json' || !file.endsWith('.json')) continue;
            const match = /^([a-z-]+)-(.+)\.json$/i.exec(file);
            if (!match) continue;
            const type = match[1]!;
            const id = match[2]!.replace(/__/g, '/').replace(/-/g, ':');
            const value = JSON.parse(await fs.promises.readFile(path.join(this.dir, file), 'utf8'), BufferJSON.reviver) as unknown;
            (keys[type] ??= {})[id] = value;
        }
        return { format: 'baileys-v1', creds, keys, exportedAt: Date.now(), libraryId };
    }

    async importSnapshot(snapshot: AuthSnapshot): Promise<void> {
        if (snapshot.format !== 'baileys-v1') {
            throw new Error(`Formato de snapshot não suportado: ${snapshot.format}`);
        }
        await this.wipe();
        await this.ensureDir();
        await fs.promises.writeFile(
            path.join(this.dir, 'creds.json'),
            JSON.stringify(snapshot.creds, BufferJSON.replacer, 2),
        );
        for (const [type, entries] of Object.entries(snapshot.keys)) {
            for (const [id, value] of Object.entries(entries)) {
                const fileId = id.replace(/\//g, '__').replace(/:/g, '-');
                await fs.promises.writeFile(
                    path.join(this.dir, `${type}-${fileId}.json`),
                    JSON.stringify(value, BufferJSON.replacer, 2),
                );
            }
        }
    }
}
