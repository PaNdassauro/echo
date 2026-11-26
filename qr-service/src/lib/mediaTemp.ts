/**
 * Arquivos temporários da mídia grande (download → disco → upload resumível).
 *
 * O disco do container é o mesmo das credenciais das sessões: encher o disco com
 * vídeo corrompe a gravação de creds, e sessão que perde creds re-pareia (risco de
 * ban). Por isso cada download reserva o espaço antes de começar, contando o que
 * os downloads em voo ainda vão escrever, e deixa sempre uma folga livre.
 *
 * Reserva que ninguém liberou (exceção entre o download e o upload) expira: o
 * arquivo é apagado e o espaço volta, para a contagem não travar os próximos.
 */
import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface MediaTempFile {
    path: string;
    /** Apaga o arquivo e devolve a reserva. Idempotente. */
    release(): Promise<void>;
}

export interface MediaTempStoreOptions {
    dir: string;
    /** Espaço que fica livre no disco depois de todas as reservas. */
    reserveFreeBytes: number;
    /** Reserva sem release depois disso é considerada órfã. */
    ttlMs: number;
    /** Espaço livre do disco (injetável para teste). */
    freeBytes?: (dir: string) => Promise<number>;
    now?: () => number;
}

export class MediaTempDiskFullError extends Error {
    constructor(readonly needed: number, readonly available: number) {
        super(`disco sem espaço para a mídia: precisa de ${needed} bytes, há ${available} utilizáveis`);
        this.name = 'MediaTempDiskFullError';
    }
}

async function statfsFree(dir: string): Promise<number> {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
}

export class MediaTempStore {
    private readonly reservations = new Map<string, { bytes: number; at: number }>();
    private readonly freeBytes: (dir: string) => Promise<number>;
    private readonly now: () => number;
    private ready: Promise<void> | null = null;

    constructor(private readonly opts: MediaTempStoreOptions) {
        this.freeBytes = opts.freeBytes ?? statfsFree;
        this.now = opts.now ?? Date.now;
    }

    /** Bytes reservados pelos downloads que ainda não liberaram. */
    get reservedBytes(): number {
        let total = 0;
        for (const r of this.reservations.values()) total += r.bytes;
        return total;
    }

    /**
     * Reserva `bytes` e devolve um caminho novo dentro do diretório. Lança
     * `MediaTempDiskFullError` quando a reserva deixaria menos que a folga livre.
     */
    async reserve(bytes: number, label: string): Promise<MediaTempFile> {
        await this.init();
        await this.expireOrphans();
        const free = await this.freeBytes(this.opts.dir);
        const available = free - this.reservedBytes - this.opts.reserveFreeBytes;
        if (bytes > available) throw new MediaTempDiskFullError(bytes, Math.max(0, available));

        const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'media';
        const path = join(this.opts.dir, `${safeLabel}-${randomBytes(6).toString('hex')}`);
        this.reservations.set(path, { bytes, at: this.now() });
        let released = false;
        return {
            path,
            release: async () => {
                if (released) return;
                released = true;
                this.reservations.delete(path);
                await rm(path, { force: true }).catch(() => undefined);
            },
        };
    }

    /** Cria o diretório e apaga sobras de um processo anterior (reinício no meio de um upload). */
    private init(): Promise<void> {
        this.ready ??= (async () => {
            await mkdir(this.opts.dir, { recursive: true });
            for (const name of await readdir(this.opts.dir)) {
                await rm(join(this.opts.dir, name), { force: true, recursive: true }).catch(() => undefined);
            }
        })();
        return this.ready;
    }

    private async expireOrphans(): Promise<void> {
        const limit = this.now() - this.opts.ttlMs;
        for (const [path, r] of this.reservations) {
            if (r.at > limit) continue;
            this.reservations.delete(path);
            const exists = await stat(path).then(() => true, () => false);
            console.warn(`[MediaTemp] Reserva órfã expirada (${r.bytes} bytes${exists ? ', arquivo apagado' : ''}): ${path}`);
            await rm(path, { force: true }).catch(() => undefined);
        }
    }
}
