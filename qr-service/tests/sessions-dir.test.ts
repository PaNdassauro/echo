/**
 * Teste de escrita do diretório de sessões no boot (src/lib/sessionsDir.ts): volume antigo com dono root
 * não pode deixar o serviço subir "healthy" sem conseguir guardar credenciais nem o spill do outbox.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionsDirNotWritableError, assertSessionsDirWritable } from '../src/lib/sessionsDir.js';

test('diretório com escrita: passa e não deixa a sonda para trás', () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-qr-sessions-'));
    try {
        assertSessionsDirWritable(dir);
        assert.deepEqual(readdirSync(dir), []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('diretório inexistente: erro tipado com o caminho e o comando de chown', () => {
    const dir = join(tmpdir(), 'echo-qr-sessions-nao-existe-' + process.pid);
    assert.equal(existsSync(dir), false);
    assert.throws(
        () => assertSessionsDirWritable(dir),
        (err: unknown) =>
            err instanceof SessionsDirNotWritableError && err.dir === dir && /chown .* 1000:1000/.test(err.message),
    );
});

test('diretório somente leitura: erro tipado', { skip: process.getuid?.() === 0 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-qr-sessions-ro-'));
    chmodSync(dir, 0o555);
    try {
        assert.throws(() => assertSessionsDirWritable(dir), SessionsDirNotWritableError);
    } finally {
        chmodSync(dir, 0o755);
        rmSync(dir, { recursive: true, force: true });
    }
});
