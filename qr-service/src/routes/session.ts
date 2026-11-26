import { Router, Request, Response } from 'express';
import { sessionManager } from '../lib/session.js';
import { ConnectRefusedError } from '../services/SessionManager.js';
import { buildInfo } from '../lib/version.js';
import { requirePhoneAccess } from '../middleware/auth.js';

export const sessionRouter = Router();

// Routes with a :phoneNumberId param: enforce the caller's org owns the number.
sessionRouter.param('phoneNumberId', requirePhoneAccess);

// Start a new QR session (phoneNumberId is in the body, so guard explicitly)
sessionRouter.post('/connect', requirePhoneAccess, async (req: Request, res: Response) => {
    const { phoneNumberId, forceNew = true, usePairingCode = false, phoneNumber } = req.body; // Default forceNew to true

    if (!phoneNumberId) {
        res.status(400).json({ error: 'phoneNumberId is required' });
        return;
    }

    let pairingDigits: string | undefined;
    if (usePairingCode) {
        pairingDigits = String(phoneNumber ?? '').replace(/\D/g, '');
        if (pairingDigits.length < 10 || pairingDigits.length > 15) {
            res.status(400).json({ error: 'valid phoneNumber (E.164 with country code) is required for pairing code' });
            return;
        }
    }

    try {
        const result = await sessionManager.connect(phoneNumberId, forceNew, {
            usePairingCode,
            phoneNumber: pairingDigits,
        });
        res.json({ status: result, phoneNumberId });
    } catch (error) {
        if (error instanceof ConnectRefusedError) {
            res.status(429).json({ error: error.message, code: error.code });
            return;
        }
        console.error('Error starting session:', error);
        res.status(500).json({ error: 'Failed to start session' });
    }
});

// Get QR code (Server-Sent Events for real-time updates)
sessionRouter.get('/qr/:phoneNumberId', (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Cabeçalhos e um 1º byte já: sem isto o Express só os manda junto do 1º evento, e um
    // proxy (o gateway do Docker, um nginx, um túnel) que espera cabeçalho antes de ligar o
    // fluxo cortaria a conexão de uma linha que ainda não tem QR. O flushHeaders sozinho não
    // basta atrás do Caddy (medido): o proxy só repassa os cabeçalhos com o 1º byte do corpo.
    // Comentário SSE: o EventSource ignora.
    res.flushHeaders();
    res.write(': conectado\n\n');

    // Send current QR if available
    const currentQR = sessionManager.getQRCode(phoneNumberId);
    if (currentQR) {
        res.write(`data: ${JSON.stringify({ event: 'qr', qrCode: currentQR })}\n\n`);
    }

    // Send current pairing code if available (reconnecting EventSource gets it immediately)
    const currentPairingCode = sessionManager.getPairingCode(phoneNumberId);
    if (currentPairingCode) {
        res.write(`data: ${JSON.stringify({ event: 'pairing_code', pairingCode: currentPairingCode })}\n\n`);
    }

    // Listen for updates
    const listener = (event: string, data: unknown) => {
        res.write(`data: ${JSON.stringify({ event, ...(data as object) })}\n\n`);
    };

    sessionManager.addListener(phoneNumberId, listener);

    // Comentário SSE a cada 25 s para o proxy não fechar a conexão ociosa (como o /call/:id/events).
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

    // Cleanup on disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        sessionManager.removeListener(phoneNumberId, listener);
    });
});

// Get QR code (Snapshot/Polling fallback)
sessionRouter.get('/qr-code/:phoneNumberId', (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const qrCode = sessionManager.getQRCode(phoneNumberId);

    if (qrCode) {
        res.json({ qrCode });
    } else {
        res.status(404).json({ error: 'QR code not found' });
    }
});

// Get pairing code (Snapshot/Polling fallback)
sessionRouter.get('/pairing-code/:phoneNumberId', (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const pairingCode = sessionManager.getPairingCode(phoneNumberId);

    if (pairingCode) {
        res.json({ pairingCode });
    } else {
        res.status(404).json({ error: 'Pairing code not found' });
    }
});

// Resolve LIDs em lote para telefone (cache + store do Baileys). Usado pelo
// saneamento de conversas criadas com o LID cru como contact_phone
// (`scripts/resolve-lid-conversations.mjs`, na raiz deste repositório).
sessionRouter.post('/lid-map/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const lids = Array.isArray(req.body?.lids) ? req.body.lids.map(String) : null;
    // Telefones suspeitos de serem os donos dos LIDs (caminho inverso pelo servidor, opcional).
    const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates.map(String) : [];

    if (!lids || lids.length === 0 || lids.length > 500) {
        res.status(400).json({ error: 'lids must be a non-empty array (max 500)' });
        return;
    }
    if (candidates.length > 500) {
        res.status(400).json({ error: 'candidates must have at most 500 phones' });
        return;
    }

    try {
        const result = await sessionManager.resolveLids(phoneNumberId, lids, candidates);
        if (!result.success) {
            res.status(409).json({ error: result.error });
            return;
        }
        res.json({ mappings: result.mappings, reverse: result.reverse ?? null });
    } catch (error) {
        console.error('Error resolving LIDs:', error);
        res.status(500).json({ error: 'Failed to resolve LIDs' });
    }
});

// Get session status
sessionRouter.get('/status/:phoneNumberId', (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const session = sessionManager.getStatus(phoneNumberId);

    if (!session) {
        res.json({ status: 'not_found', phoneNumberId });
        return;
    }

    res.json({
        status: session.status,
        phoneNumberId,
        hasQR: !!session.qrCode,
        hasPairingCode: !!session.pairingCode,
    });
});

/**
 * Troca a lib que atende a linha sem re-parear (export → import de credenciais).
 * Body: { to: 'baileys' | 'zapo' | ... }. Rollback = chamar com o provider antigo.
 */
sessionRouter.post('/migrate-provider/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (!to) {
        res.status(400).json({ error: "body.to (nome do provider) é obrigatório" });
        return;
    }
    try {
        const result = await sessionManager.migrateProvider(phoneNumberId, to);
        res.json({ success: true, phoneNumberId, ...result });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[MigrateProvider] ${phoneNumberId} → ${to} falhou:`, message);
        res.status(message.startsWith('Provider desconhecido') ? 400 : 500).json({ success: false, error: message });
    }
});

// Health check for all sessions. Mapa completo (ids de todos os números, JIDs de contatos nos
// reachout_locks): só a chave de serviço, senão um login de qualquer organização enxergaria as outras.
sessionRouter.get('/health', (req: Request, res: Response) => {
    if (!req.isServiceRole) {
        res.status(403).json({ error: 'service key required' });
        return;
    }
    const statuses = sessionManager.getAllSessionsStatus();
    const mem = process.memoryUsage();
    res.json({
        service: 'echo-qr-service',
        ...buildInfo(),
        timestamp: new Date().toISOString(),
        sessions: statuses,
        total_sessions: Object.keys(statuses).length,
        providers: sessionManager.getSessionProviders(),
        registered_providers: sessionManager.getRegisteredProviders(),
        pending_webhooks: sessionManager.getPendingWebhooks(),
        reachout_locks: sessionManager.getReachoutLocks(),
        message_capping: sessionManager.getMessageCappings(),
        protection_limits: sessionManager.getProtectionLimits(),
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        uptime_s: Math.round(process.uptime()),
    });
});

// Aplica o toggle de presença numa sessão viva (sem reconectar). O front chama
// esta rota DEPOIS de gravar phone_numbers.keep_device_notifications — o banco é
// a fonte de verdade e o próximo connect lê de lá; isto só antecipa o efeito.
sessionRouter.post('/presence-mode/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { keepDeviceNotifications } = req.body ?? {};

    if (typeof keepDeviceNotifications !== 'boolean') {
        res.status(400).json({ error: 'keepDeviceNotifications must be a boolean' });
        return;
    }

    try {
        const result = await sessionManager.applyPresenceMode(phoneNumberId, keepDeviceNotifications);
        res.json(result);
    } catch (error) {
        console.error('Error applying presence mode:', error);
        res.status(500).json({ error: 'Failed to apply presence mode' });
    }
});

// Disconnect session
// Refetch on-demand de histórico de UMA conversa. Cobre a janela que a fila offline
// não alcança (queda longa), mas depende do aparelho principal responder.
// A âncora vem do chamador: o serviço não tenta adivinhar a conversa a partir do
// telefone — casar número BR por heurística gera OUTRO número (o 9º dígito).
sessionRouter.post('/sync/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { chatJid, anchorMessageId, anchorTimestampMs, anchorFromMe, count, sinceMs, waitMs } = req.body ?? {};

    if (typeof chatJid !== 'string' || !chatJid.includes('@')) {
        res.status(400).json({ error: 'chatJid (JID completo, ex.: 5511...@s.whatsapp.net) is required' });
        return;
    }
    if (typeof anchorMessageId !== 'string' || anchorMessageId.length === 0) {
        res.status(400).json({ error: 'anchorMessageId is required (wamid da primeira mensagem DEPOIS do gap)' });
        return;
    }
    const anchorTs = Number(anchorTimestampMs);
    if (!Number.isFinite(anchorTs) || anchorTs <= 0) {
        res.status(400).json({ error: 'anchorTimestampMs must be a positive epoch in milliseconds' });
        return;
    }

    try {
        const result = await sessionManager.syncMessageHistory(phoneNumberId, {
            chatJid,
            anchorMessageId,
            anchorTimestampMs: anchorTs,
            anchorFromMe: anchorFromMe === true,
            count: count === undefined ? undefined : Number(count),
            sinceMs: sinceMs === undefined ? undefined : Number(sinceMs),
            waitMs: waitMs === undefined ? undefined : Number(waitMs),
        });
        res.json({ success: true, ...result });
    } catch (error) {
        const code = error instanceof Error ? error.message : 'UNKNOWN';
        if (code === 'SESSION_NOT_CONNECTED') {
            res.status(409).json({ error: 'Sessão não está conectada — reconecte o número antes de pedir o histórico' });
            return;
        }
        if (code === 'HISTORY_UNSUPPORTED') {
            res.status(501).json({ error: 'A biblioteca desta linha não recupera histórico sob demanda' });
            return;
        }
        if (code === 'SYNC_ALREADY_RUNNING') {
            res.status(409).json({ error: 'Já existe um refetch de histórico em andamento para este número' });
            return;
        }
        console.error('Error syncing message history:', error);
        res.status(500).json({ error: 'Failed to sync message history' });
    }
});

// Dispara a varredura automática (todas as conversas ativas, grupo e 1:1) sob
// demanda, sem esperar uma reconexão real. Útil pra rodar depois de um deploy
// desta feature (a reconexão que teria disparado já passou) ou pra forçar numa
// queda que ficou abaixo do limiar automático.
sessionRouter.post('/auto-recover/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { sinceMs } = req.body ?? {};

    const since = sinceMs === undefined ? undefined : Number(sinceMs);
    if (since !== undefined && (!Number.isFinite(since) || since <= 0)) {
        res.status(400).json({ error: 'sinceMs must be a positive epoch in milliseconds' });
        return;
    }

    try {
        const result = await sessionManager.runManualAutoRecovery(phoneNumberId, since);
        res.json({ success: true, ...result });
    } catch (error) {
        const code = error instanceof Error ? error.message : 'UNKNOWN';
        if (code === 'SESSION_NOT_CONNECTED') {
            res.status(409).json({ error: 'Sessão não está conectada — reconecte o número antes de rodar a varredura' });
            return;
        }
        if (code === 'AUTO_RECOVERY_ALREADY_RUNNING') {
            res.status(409).json({ error: 'Já existe uma varredura de recuperação em andamento para este número' });
            return;
        }
        if (code === 'NO_DISCONNECT_WINDOW') {
            res.status(400).json({ error: 'Nenhuma janela de desconexão conhecida — informe sinceMs explicitamente' });
            return;
        }
        console.error('Error running manual auto-recovery:', error);
        res.status(500).json({ error: 'Failed to run auto-recovery' });
    }
});

// Varredura pausada das conversas sem foto de perfil.
//
// Trabalho em segundo plano com rota de status, e não lote síncrono: ~1.500
// conversas a 2s por foto passa de 50 min, muito além de qualquer timeout de proxy.
// Como produtora da mesma fila do tráfego vivo, a varredura herda de graça o
// disjuntor de 429 e a preempção pelo que chega ao vivo.
sessionRouter.post('/avatar-backfill/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { activeDays, limit, scope } = req.body ?? {};

    if (scope !== undefined && !['all', 'groups', 'individual'].includes(scope)) {
        res.status(400).json({ error: "scope must be 'all', 'groups' or 'individual'" });
        return;
    }
    for (const [name, value] of [['activeDays', activeDays], ['limit', limit]] as const) {
        if (value !== undefined && (!Number.isFinite(Number(value)) || Number(value) <= 0)) {
            res.status(400).json({ error: `${name} must be a positive number` });
            return;
        }
    }

    try {
        const state = await sessionManager.startAvatarBackfill(phoneNumberId, {
            activeDays: activeDays === undefined ? undefined : Number(activeDays),
            limit: limit === undefined ? undefined : Number(limit),
            scope,
        });
        res.status(202).json({ success: true, backfill: state });
    } catch (error) {
        const code = error instanceof Error ? error.message : 'UNKNOWN';
        if (code === 'SESSION_NOT_CONNECTED') {
            res.status(409).json({ error: 'Sessão não está conectada — reconecte o número antes de varrer as fotos' });
            return;
        }
        if (code === 'AVATAR_BACKFILL_ALREADY_RUNNING') {
            // Idempotente: devolve o que já está rodando em vez de abrir um segundo.
            res.status(409).json({
                error: 'Já existe uma varredura de fotos em andamento para este número',
                backfill: sessionManager.getAvatarBackfill(phoneNumberId),
            });
            return;
        }
        console.error('Error starting avatar backfill:', error);
        res.status(500).json({ error: 'Failed to start avatar backfill' });
    }
});

sessionRouter.get('/avatar-backfill/:phoneNumberId', (req: Request, res: Response) => {
    const state = sessionManager.getAvatarBackfill(req.params.phoneNumberId as string);
    if (!state) {
        res.status(404).json({ error: 'Nenhuma varredura de fotos para este número nesta instância' });
        return;
    }
    res.json({ success: true, backfill: state, queue: sessionManager.getAvatarQueueStats() });
});

sessionRouter.delete('/avatar-backfill/:phoneNumberId', (req: Request, res: Response) => {
    const state = sessionManager.cancelAvatarBackfill(req.params.phoneNumberId as string);
    if (!state) {
        res.status(404).json({ error: 'Nenhuma varredura de fotos para este número nesta instância' });
        return;
    }
    res.json({ success: true, backfill: state });
});

sessionRouter.delete('/disconnect/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;

    try {
        const success = await sessionManager.disconnect(phoneNumberId);
        res.json({ success, phoneNumberId });
    } catch (error) {
        console.error('Error disconnecting session:', error);
        res.status(500).json({ error: 'Failed to disconnect session' });
    }
});
