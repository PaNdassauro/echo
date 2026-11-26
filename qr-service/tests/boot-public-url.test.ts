/**
 * Boot com ECHO_PUBLIC_URL: valor inválido derruba o serviço na subida (exit 1, mensagem que cita a
 * variável) em vez de deixar o upload de mídia falhar depois, e valor válido sobe normalmente.
 * Sobe o `src/index.ts` de verdade num processo filho, sem rede (nada escuta no 127.0.0.1:9).
 *
 * O filho roda num diretório temporário VAZIO: sem `.env` do desenvolvedor para o dotenv carregar
 * (ZAPO_PG_URL e afins) e sem `sessions/` real para o restore reconectar. Se o teste usasse a pasta do
 * serviço, o boot abriria um 2º socket de WhatsApp com as credenciais de um checkout em uso. Regra do
 * serviço: nenhum teste fala com o WhatsApp (ver CLAUDE.md).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENTRADA = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const CWD_VAZIO = mkdtempSync(join(tmpdir(), 'echo-qr-boot-'));
after(() => rmSync(CWD_VAZIO, { recursive: true, force: true }));

function subir(extra: Record<string, string>, cwd: string = CWD_VAZIO): Promise<{ codigo: number | null; saida: string }> {
    return new Promise((resolve) => {
        const filho = spawn(process.execPath, ['--import', TSX, ENTRADA], {
            cwd,
            env: {
                PATH: process.env.PATH ?? '',
                PORT: '0',
                ZAPO_PG_URL: '',
                SUPABASE_URL: 'http://127.0.0.1:9',
                SUPABASE_SERVICE_KEY: 'chave-de-teste',
                WEBHOOK_URL: 'http://127.0.0.1:9/functions/v1/whatsapp-webhook',
                QR_WEBHOOK_SECRET: 'segredo-de-teste',
                ...extra,
            },
        });
        let saida = '';
        const acumular = (c: Buffer) => {
            saida += c.toString();
            // Subiu: o serviço escreve a linha de boot; encerra o filho de forma limpa.
            if (/running on port/.test(saida)) filho.kill('SIGTERM');
        };
        filho.stdout.on('data', acumular);
        filho.stderr.on('data', acumular);
        const limite = setTimeout(() => filho.kill('SIGKILL'), 25_000);
        filho.on('exit', (codigo) => {
            clearTimeout(limite);
            resolve({ codigo, saida });
        });
    });
}

test('ECHO_PUBLIC_URL que não é http(s): exit 1 com a variável na mensagem', async () => {
    const r = await subir({ ECHO_PUBLIC_URL: 'ftp://echo.exemplo.com' });
    assert.equal(r.codigo, 1, r.saida);
    assert.match(r.saida, /\[FATAL\] ECHO_PUBLIC_URL precisa começar com http/);
});

test('ECHO_PUBLIC_URL com texto qualquer: exit 1', async () => {
    const r = await subir({ ECHO_PUBLIC_URL: 'echo.exemplo.com' });
    assert.equal(r.codigo, 1, r.saida);
    assert.match(r.saida, /ECHO_PUBLIC_URL não é uma URL válida/);
});

test('ECHO_PUBLIC_URL válida e ausente: o serviço sobe', async () => {
    for (const extra of [{ ECHO_PUBLIC_URL: 'http://localhost:8088' }, {}]) {
        const r = await subir(extra);
        assert.match(r.saida, /running on port/, JSON.stringify(extra) + r.saida);
        assert.doesNotMatch(r.saida, /\[FATAL\]/);
        // Isolamento: nada de .env nem de sessão guardada, então o restore não tem o que conectar.
        assert.doesNotMatch(r.saida, /stored session\(s\), restoring/, r.saida);
    }
});

test('sessions/ sem escrita (volume antigo com dono root): exit 1 com o chown na mensagem', { skip: process.getuid?.() === 0 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'echo-qr-boot-ro-'));
    const sessoes = join(cwd, 'sessions');
    mkdirSync(sessoes);
    chmodSync(sessoes, 0o555);
    try {
        const r = await subir({}, cwd);
        assert.equal(r.codigo, 1, r.saida);
        assert.match(r.saida, /\[FATAL\] o diretório de sessões .* não aceita escrita/);
        assert.match(r.saida, /chown/);
        assert.doesNotMatch(r.saida, /running on port/);
    } finally {
        chmodSync(sessoes, 0o755);
        rmSync(cwd, { recursive: true, force: true });
    }
});
