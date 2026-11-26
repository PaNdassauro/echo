import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { sessionRouter } from './routes/session.js';
import { messageRouter } from './routes/message.js';
import { groupsRouter } from './routes/groups.js';
import { profileRouter } from './routes/profile.js';
import { stickerRouter } from './routes/sticker.js';
import { attachCallAudioSocket, callRouter } from './routes/call.js';
import { sessionManager } from './lib/session.js';
import { buildInfo } from './lib/version.js';
import { requireAuth } from './middleware/auth.js';
import { basePublica } from './lib/publicUrl.js';
import { assertSessionsDirWritable, SessionsDirNotWritableError } from './lib/sessionsDir.js';

dotenv.config();

// Fail-fast: sem WEBHOOK_URL, TODA mensagem recebida seria descartada em silêncio
// (o forward retornava cedo, para sempre). Melhor recusar o boot do que operar surdo.
if (!process.env.WEBHOOK_URL) {
    console.error('[FATAL] WEBHOOK_URL não configurada — o serviço não pode persistir mensagens. Abortando o boot.');
    process.exit(1);
}

// Fail-fast: a edge whatsapp-webhook recusa (503) as rotas /qr-* quando não tem QR_WEBHOOK_SECRET,
// e sem o header x-qr-secret igual a ela toda chamada deste serviço seria rejeitada.
if (!process.env.QR_WEBHOOK_SECRET) {
    console.error('[FATAL] QR_WEBHOOK_SECRET não configurada — o webhook do Echo recusaria toda chamada do serviço. Abortando o boot.');
    process.exit(1);
}

// Fail-fast: ECHO_PUBLIC_URL (ou SUPABASE_URL) que não é uma URL http(s) faria TODO upload de mídia
// falhar mais tarde, só quando chegasse a primeira mensagem com anexo.
try {
    basePublica();
} catch (err) {
    console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}. Abortando o boot.`);
    process.exit(1);
}

// Fail-fast: sessions/ sem escrita (volume antigo com dono root) deixaria o serviço "healthy" sem conseguir
// guardar credenciais nem o spill do outbox: a falha só apareceria como log, depois de perder dado.
try {
    assertSessionsDirWritable(sessionManager.getSessionsDir());
} catch (err) {
    if (!(err instanceof SessionsDirNotWritableError)) throw err;
    console.error(`[FATAL] ${err.message}. Abortando o boot.`);
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err);
    // Melhor esforço: spilla os webhooks pendentes para sessions/_outbox/ antes de
    // morrer — o replay do próximo boot reentrega (dedup na edge cobre duplicata).
    try {
        const spilled = sessionManager.persistOutboxSync();
        if (spilled > 0) console.error(`[FATAL] ${spilled} webhook(s) pendentes spillados para disco`);
    } catch { /* morrer é inevitável; não piorar */ }
    // Sair em vez de continuar em estado podre. O orquestrador (restart policy do Docker ou PaaS) reinicia o
    // container e os auth files persistem em ./sessions/.
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

// CORS restrito aos domínios do app (server-to-server não passa por CORS)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ??
    'http://localhost:8080,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

// Middleware
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// Routes (auth obrigatória: JWT de usuário Supabase ou service-role key)
app.use('/session', requireAuth, sessionRouter);
app.use('/message', requireAuth, messageRouter);
app.use('/groups', requireAuth, groupsRouter);
app.use('/profile', requireAuth, profileRouter);
app.use('/sticker', requireAuth, stickerRouter);
app.use('/call', requireAuth, callRouter);

// Health check com métricas pra detectar leak/backpressure
app.get('/health', (_req, res) => {
    const mem = process.memoryUsage();
    const outbox = sessionManager.getOutboxStats();
    res.json({
        status: 'ok',
        ...buildInfo(),
        timestamp: new Date().toISOString(),
        uptime_s: Math.round(process.uptime()),
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        sessions: sessionManager.getSessionCount(),
        pending_webhooks: sessionManager.getPendingWebhooks(),
        outbox_mem: outbox.queue_mem,
        outbox_disk: outbox.queue_disk,
        // Fila de fotos: sem isto, só o log do container mostraria o disjuntor de 429 agindo.
        avatars: sessionManager.getAvatarQueueStats(),
        outbox_oldest_disk_age_s: outbox.oldest_disk_age_s,
        // `stalled` é o que um alerta externo deve observar: a fila de disco parou
        // de andar porque a edge recusa o arquivo da frente. Contagem e idade
        // sozinhas não distinguem isso de um job pulado esperando o TTL.
        outbox_stalled: outbox.stalled,
        outbox_skipped: outbox.skipped,
    });
});

// Start server
const server = app.listen(PORT, async () => {
    console.log(`🚀 WhatsApp QR Service running on port ${PORT}`);

    // Reentrega o que ficou spillado em disco (crash/shutdown anterior) em
    // paralelo ao restore das sessões — são independentes.
    void sessionManager.replayOutbox().catch((err) => console.error('[Outbox] replay no boot falhou:', err));

    // Restore sessions on startup
    await sessionManager.initProviders();
    await sessionManager.restoreAllSessions();
});

// Ponte de áudio das ligações (upgrade HTTP → WebSocket, auth própria).
attachCallAudioSocket(server);

// Graceful shutdown: o orquestrador envia SIGTERM no redeploy. Sem isso, sockets
// Baileys ficam pendurados e auth files podem corromper.
let shuttingDown = false;
async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] ${signal} received, draining...`);
    server.close(() => console.log('[Shutdown] HTTP server closed'));
    try {
        await sessionManager.shutdownAll();
    } catch (e) {
        console.error('[Shutdown] Error during sessionManager.shutdownAll:', e);
    }
    // Dreno do outbox: até 8s para os webhooks em voo saírem; o que sobrar vira
    // arquivo em sessions/_outbox/ e o replay do próximo boot reentrega. Antes,
    // cada redeploy descartava tudo que estava em voo (até 200 mensagens).
    try {
        await sessionManager.drainOutbox(8_000);
        const spilled = sessionManager.persistOutboxSync();
        if (spilled > 0) console.log(`[Shutdown] ${spilled} webhook(s) pendentes spillados para o próximo boot`);
    } catch (e) {
        console.error('[Shutdown] Error draining outbox:', e);
    }
    // Hard exit após 5s pro caso de algum handle pendurado
    setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
