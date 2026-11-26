/**
 * MediaTempStore: reserva conta os downloads em voo, respeita a folga livre,
 * libera ao apagar e expira reserva órfã.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaTempStore, MediaTempDiskFullError } from '../src/lib/mediaTemp.js';

const MB = 1024 * 1024;

async function makeStore(free: number, now = { t: 0 }) {
    const root = await mkdtemp(join(tmpdir(), 'media-temp-test-'));
    const dir = join(root, 'qr-media');
    const store = new MediaTempStore({
        dir,
        reserveFreeBytes: 100 * MB,
        ttlMs: 1_000,
        freeBytes: async () => free,
        now: () => now.t,
    });
    return { store, dir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('recusa quando a reserva comeria a folga livre, contando as reservas em voo', async () => {
    const { store, cleanup } = await makeStore(500 * MB);
    try {
        const a = await store.reserve(300 * MB, 'a');
        assert.equal(store.reservedBytes, 300 * MB);
        // 500 livres − 300 em voo − 100 de folga = 100 utilizáveis
        await assert.rejects(store.reserve(150 * MB, 'b'), (e: unknown) =>
            e instanceof MediaTempDiskFullError && e.available === 100 * MB);
        await a.release();
        assert.equal(store.reservedBytes, 0);
        const b = await store.reserve(150 * MB, 'b');
        await b.release();
    } finally {
        await cleanup();
    }
});

test('release apaga o arquivo e é idempotente', async () => {
    const { store, dir, cleanup } = await makeStore(10_000 * MB);
    try {
        const f = await store.reserve(MB, 'wamid/../x');
        assert.ok(f.path.startsWith(dir + '/'), 'caminho fora do diretório');
        await writeFile(f.path, 'x');
        await f.release();
        await f.release();
        assert.deepEqual(await readdir(dir), []);
    } finally {
        await cleanup();
    }
});

test('reserva órfã expira e devolve o espaço', async () => {
    const now = { t: 0 };
    const { store, dir, cleanup } = await makeStore(500 * MB, now);
    try {
        const orphan = await store.reserve(350 * MB, 'orfa');
        await writeFile(orphan.path, 'x');
        await assert.rejects(store.reserve(100 * MB, 'b'), MediaTempDiskFullError);
        now.t = 1_001;
        const b = await store.reserve(100 * MB, 'b');
        assert.equal(store.reservedBytes, 100 * MB);
        assert.deepEqual(await readdir(dir), []);
        await b.release();
    } finally {
        await cleanup();
    }
});

test('apaga sobras de um processo anterior na primeira reserva', async () => {
    const root = await mkdtemp(join(tmpdir(), 'media-temp-test-'));
    const dir = join(root, 'qr-media');
    try {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'sobra'), 'x');
        const store = new MediaTempStore({ dir, reserveFreeBytes: 0, ttlMs: 1_000, freeBytes: async () => 1_000 * MB });
        const f = await store.reserve(MB, 'novo');
        assert.deepEqual(await readdir(dir), []);
        await f.release();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
