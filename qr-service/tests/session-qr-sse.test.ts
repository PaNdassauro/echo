/**
 * SSE do QR (GET /session/qr/:id): os cabeçalhos saem na hora, mesmo sem QR para mandar, e
 * um comentário `: ping` sai a cada 25 s. Sem isso um proxy que espera o cabeçalho antes de
 * ligar o fluxo (ou corta conexão ociosa) derrubaria a tela de conexão de uma linha nova.
 * Sobe o roteador de verdade atrás do requireAuth; a chave de serviço dispensa o Supabase.
 */
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const SERVICE_KEY = 'service-key-de-teste';
const PHONE_ID = '00000000-0000-4000-8000-0000000000aa';

let apiServer: http.Server;
let apiBase = '';

before(async () => {
    process.env.SUPABASE_URL = 'http://127.0.0.1:9';
    process.env.SUPABASE_SERVICE_KEY = SERVICE_KEY;
    process.env.WEBHOOK_URL ??= 'https://example.com/functions/v1/whatsapp-webhook';

    const { requireAuth } = await import('../src/middleware/auth.js');
    const { sessionRouter } = await import('../src/routes/session.js');
    const app = express();
    app.use('/session', requireAuth, sessionRouter);
    apiServer = http.createServer(app);
    await new Promise<void>((ok) => apiServer.listen(0, '127.0.0.1', ok));
    apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
});

after(async () => {
    apiServer.closeAllConnections();
    await new Promise((ok) => apiServer.close(ok));
});

test('cabeçalhos do SSE saem antes de qualquer evento e o ping vem a cada 25 s', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const abortar = new AbortController();
    try {
        const res = await fetch(`${apiBase}/session/qr/${PHONE_ID}`, {
            headers: { authorization: `Bearer ${SERVICE_KEY}` },
            signal: abortar.signal,
        });
        // Linha sem QR nem pairing code: nenhum evento foi escrito, e os cabeçalhos já chegaram.
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
        assert.equal(res.headers.get('cache-control'), 'no-cache');

        // 1º byte na hora (proxies como o Caddy só repassam os cabeçalhos com ele), e o ping a cada 25 s.
        const leitor = res.body!.getReader();
        const decodificador = new TextDecoder();
        const inicial = await leitor.read();
        assert.equal(decodificador.decode(inicial.value), ': conectado\n\n');
        const ping = leitor.read();
        mock.timers.tick(25_000);
        assert.equal(decodificador.decode((await ping).value), ': ping\n\n');
    } finally {
        abortar.abort();
        mock.timers.reset();
    }
});
