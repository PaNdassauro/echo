#!/usr/bin/env node
/**
 * Sweep de disco do outbox — checks contra a classe REAL (dist/), com a edge
 * trocada por um servidor HTTP local que responde o que o teste mandar.
 *
 * Existe porque um único `qr-message-deleted` que a edge responde 404 represava a fila
 * de disco inteira: o 404 já tinha desfecho próprio (`discard`), mas só o caminho em
 * memória o tratava — no sweep ele caía no ramo do retryable, que reescreve o arquivo
 * e dá `break`.
 *
 * Uso:  npm run build && npm run test:outbox-sweep
 */
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key-nao-usar';

const { WebhookOutbox } = await import(new URL('../dist/lib/webhookOutbox.js', import.meta.url).href);

let fail = 0;
const check = (nome, real, esperado) => {
    const ok = JSON.stringify(real) === JSON.stringify(esperado);
    if (!ok) fail++;
    console.log(`${ok ? '  ok  ' : ' FALHA'} ${nome}${ok ? '' : `\n         esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(real)}`}`);
};

// Edge falsa: o status vem da rota, para o teste controlar o desfecho.
const STATUS = { 'qr-message': 200, 'qr-message-deleted': 404, 'qr-reaction': 500 };
const recebidos = [];
const server = createServer((req, res) => {
    const rota = req.url.replace(/^\//, '');
    recebidos.push(rota);
    res.writeHead(STATUS[rota] ?? 500, { 'content-type': 'application/json' });
    res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const webhookUrl = `http://127.0.0.1:${server.address().port}`;

const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'));
const outboxDir = path.join(sessionsDir, '_outbox');
const outbox = new WebhookOutbox({ getWebhookUrl: () => webhookUrl, sessionsDir });

const semear = (jobs) => {
    fs.rmSync(outboxDir, { recursive: true, force: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    jobs.forEach(({ route, attempts = 0 }, i) => {
        const enqueuedAt = Date.now() + i; // recente: o TTL de 7 dias não deve interferir
        const job = { v: 1, route, phoneNumberId: 'pn', toJid: 'unknown', wamid: `w${i}`, enqueuedAt, attempts, timeoutMs: 5000, body: { message_id: `w${i}` } };
        fs.writeFileSync(path.join(outboxDir, `${enqueuedAt}-${String(i).padStart(6, '0')}-${route}.json`), JSON.stringify(job));
    });
};
const emDisco = () => fs.readdirSync(outboxDir).length;

// --- 1. o bug do 404 na frente: 404 na frente não pode segurar a fila ---
semear([{ route: 'qr-message-deleted' }, { route: 'qr-message' }]);
await outbox.replayFromDisk();
check('404 na frente sai da fila e o resto passa', emDisco(), 0);
check('a mensagem atrás do 404 foi entregue', recebidos.includes('qr-message'), true);
check('fila não fica marcada como represada', outbox.stats().stalled, false);

// --- 2. falha retryable genuína ainda interrompe (a edge caiu mesmo) ---
semear([{ route: 'qr-reaction' }, { route: 'qr-message' }]);
recebidos.length = 0;
await outbox.replayFromDisk();
check('500 na frente interrompe o sweep', emDisco(), 2);
check('nada atrás do 500 foi tentado', recebidos, ['qr-reaction']);
check('fila marcada como represada', outbox.stats().stalled, true);

// --- 3. acima do teto, o veneno para de bloquear quem vem depois ---
semear([{ route: 'qr-reaction', attempts: 21 }, { route: 'qr-message' }]);
recebidos.length = 0;
await outbox.replayFromDisk();
check('veneno segue no disco (só o TTL o mata)', emDisco(), 1);
check('a mensagem atrás dele foi entregue', recebidos, ['qr-reaction', 'qr-message']);
check('fila deixa de ser reportada como represada', outbox.stats().stalled, false);
check('o pulo é contabilizado', outbox.stats().skipped, 1);

server.close();
fs.rmSync(sessionsDir, { recursive: true, force: true });
console.log(fail === 0 ? '\nTodos os checks passaram.' : `\n${fail} check(s) falharam.`);
process.exit(fail === 0 ? 0 : 1);
