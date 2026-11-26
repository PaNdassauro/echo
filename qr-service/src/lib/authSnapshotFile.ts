import fs from 'fs';
import path from 'path';
import type { AuthSnapshot } from '../adapter/types.js';

/**
 * Snapshot de credenciais em disco (backup para rollback da troca de provider).
 * Bytes viram `{ "$bytes": "<base64>" }`; nada da lib entra aqui.
 */
const BYTES = '$bytes';

function replacer(_key: string, value: unknown): unknown {
    if (value instanceof Uint8Array) return { [BYTES]: Buffer.from(value).toString('base64') };
    if (value && typeof value === 'object' && (value as { type?: string; data?: unknown }).type === 'Buffer' && Array.isArray((value as { data?: unknown }).data)) {
        return { [BYTES]: Buffer.from((value as { data: number[] }).data).toString('base64') };
    }
    return value;
}

function reviver(_key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && typeof (value as Record<string, unknown>)[BYTES] === 'string') {
        return Buffer.from((value as Record<string, string>)[BYTES]!, 'base64');
    }
    return value;
}

export function snapshotToJson(snapshot: AuthSnapshot): string {
    return JSON.stringify(snapshot, replacer, 2);
}

export function snapshotFromJson(json: string): AuthSnapshot {
    return JSON.parse(json, reviver) as AuthSnapshot;
}

/** Grava em `<root>/_snapshots/<sessionId>/<timestamp>-<provider>.json` e devolve o caminho. */
export async function saveSnapshotBackup(root: string, sessionId: string, snapshot: AuthSnapshot): Promise<string> {
    const dir = path.join(root, '_snapshots', sessionId);
    await fs.promises.mkdir(dir, { recursive: true });
    const safeProvider = snapshot.libraryId.replace(/[^a-z0-9._-]/gi, '_');
    const file = path.join(dir, `${new Date(snapshot.exportedAt).toISOString().replace(/[:.]/g, '-')}-${safeProvider}.json`);
    await fs.promises.writeFile(file, snapshotToJson(snapshot), { mode: 0o600 });
    return file;
}

/** Último backup gravado para a sessão (ou null). */
export async function latestSnapshotBackup(root: string, sessionId: string): Promise<{ file: string; snapshot: AuthSnapshot } | null> {
    const dir = path.join(root, '_snapshots', sessionId);
    if (!fs.existsSync(dir)) return null;
    const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    const last = files[files.length - 1];
    if (!last) return null;
    const file = path.join(dir, last);
    return { file, snapshot: snapshotFromJson(await fs.promises.readFile(file, 'utf8')) };
}
