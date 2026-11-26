/**
 * GET /session/health devolve o mapa de TODAS as sessões (ids de número, providers, JIDs de contato
 * em reachout_locks). Só a chave de serviço pode lê-lo: um login de usuário de qualquer organização
 * recebe 403. Sobe o roteador de verdade atrás do requireAuth, com um Supabase Auth falso local.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const SERVICE_KEY = 'service-key-de-teste';
const USER_JWT = 'jwt-de-usuario-de-teste';
const USER_ID = '00000000-0000-4000-8000-000000000001';

let authServer: http.Server;
let apiServer: http.Server;
let apiBase = '';

before(async () => {
    // Supabase Auth falso: só o GET /auth/v1/user que o supabase-js usa em getUser(token).
    authServer = http.createServer((req, res) => {
        const ok = req.url === '/auth/v1/user' && req.headers.authorization === `Bearer ${USER_JWT}`;
        res.setHeader('content-type', 'application/json');
        res.statusCode = ok ? 200 : 401;
        res.end(JSON.stringify(ok ? { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'agente@example.com' } : { message: 'invalid' }));
    });
    await new Promise<void>((ok) => authServer.listen(0, '127.0.0.1', ok));
    process.env.SUPABASE_URL = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`;
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
    await new Promise((ok) => apiServer.close(ok));
    await new Promise((ok) => authServer.close(ok));
});

const get = (token?: string) =>
    fetch(`${apiBase}/session/health`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test('sem token: 401', async () => {
    assert.equal((await get()).status, 401);
});

test('JWT de usuário (qualquer organização): 403 e nenhum dado do mapa de sessões', async () => {
    const res = await get(USER_JWT);
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, { error: 'service key required' });
});

test('chave de serviço: 200 com o mapa de sessões', async () => {
    const res = await get(SERVICE_KEY);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.service, 'echo-qr-service');
    for (const campo of ['sessions', 'providers', 'reachout_locks', 'message_capping']) assert.ok(campo in body, campo);
});
