import { Router, Request, Response } from 'express';
import type { Server as HttpServer } from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { sessionManager } from '../lib/session.js';
import { authenticateToken, requirePhoneAccess, userCanAccessPhone } from '../middleware/auth.js';
import { WhatsAppClientError } from '../adapter/index.js';
import type { CallUpdate } from '../adapter/index.js';

/**
 * Ligação de voz (capability 'voice_call' — hoje só zapo com o plugin carregado).
 *
 *   POST /call/:phoneNumberId/start           { to, tone? }   → { callId, to }
 *   POST /call/:phoneNumberId/:callId/end     { reason? }
 *   POST /call/:phoneNumberId/:callId/accept
 *   GET  /call/:phoneNumberId/capability      → { voice_call: boolean }
 *   GET  /call/:phoneNumberId/:callId         → CallUpdate
 *   WS   /call/:phoneNumberId/:callId/audio?access_token=…  (ver attachCallAudioSocket)
 *
 * `tone: true` toca um tom de 8 s gerado pelo ffmpeg — serve para validar a
 * sinalização por curl antes de existir front. Sem áudio nenhum, a ligação
 * conecta em silêncio.
 */
export const callRouter = Router();
callRouter.param('phoneNumberId', requirePhoneAccess);

const execFileAsync = promisify(execFile);
const TONE_PATH = path.join(os.tmpdir(), 'echo-call-tone-16k.wav');

async function ensureTone(): Promise<string> {
    if (fs.existsSync(TONE_PATH)) return TONE_PATH;
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '16000', '-ac', '1', TONE_PATH]);
    return TONE_PATH;
}

function statusFor(code: string | undefined): number {
    switch (code) {
        case 'not_found': return 404;
        case 'not_connected': return 409;
        case 'unsupported_by_provider': return 501;
        case 'blocked': return 423;
        case 'bad_request': return 400;
        default: return 500;
    }
}

callRouter.get('/:phoneNumberId/capability', (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    res.json({ voice_call: sessionManager.hasVoiceCall(phoneNumberId) });
});

/**
 * SSE com o estado das ligações da linha — é como o front descobre uma ligação
 * ENTRANDO (o WebSocket de áudio só existe depois de atender). Mesmo padrão do
 * SSE do QR: token na query, um evento por linha JSON, comentário a cada 25 s
 * para o proxy não fechar a conexão ociosa.
 */
callRouter.get('/:phoneNumberId/events', (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: 'calls', calls: sessionManager.listCalls(phoneNumberId), voice_call: sessionManager.hasVoiceCall(phoneNumberId) })}\n\n`);
    const onUpdate = (pid: string, call: CallUpdate) => {
        if (pid === phoneNumberId) res.write(`data: ${JSON.stringify({ type: 'state', call })}\n\n`);
    };
    sessionManager.callEvents.on('update', onUpdate);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
        clearInterval(heartbeat);
        sessionManager.callEvents.off('update', onUpdate);
    });
});

callRouter.post('/:phoneNumberId/start', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { to, tone } = (req.body ?? {}) as { to?: unknown; tone?: unknown };
    if (typeof to !== 'string' || to.replace(/\D/g, '').length < 8) {
        res.status(400).json({ success: false, error: 'to (telefone ou JID) is required' });
        return;
    }
    try {
        const audioFile = tone === true ? await ensureTone() : undefined;
        const result = await sessionManager.startCall(phoneNumberId, to, { audioFile });
        if (!result.success) {
            res.status(statusFor(result.code)).json(result);
            return;
        }
        res.json(result);
    } catch (error) {
        console.error('[Call] start failed:', error);
        res.status(500).json({ success: false, error: 'Failed to start call' });
    }
});

callRouter.post('/:phoneNumberId/:callId/end', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const callId = req.params.callId as string;
    const reason = (req.body ?? {}).reason as 'user_ended' | 'declined' | 'busy' | undefined;
    try {
        const result = await sessionManager.endCall(phoneNumberId, callId, reason);
        res.status(result.success ? 200 : statusFor(result.code)).json(result);
    } catch (error) {
        console.error('[Call] end failed:', error);
        res.status(500).json({ success: false, error: 'Failed to end call' });
    }
});

callRouter.post('/:phoneNumberId/:callId/accept', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const callId = req.params.callId as string;
    try {
        const result = await sessionManager.acceptCall(phoneNumberId, callId);
        res.status(result.success ? 200 : statusFor(result.code)).json(result);
    } catch (error) {
        console.error('[Call] accept failed:', error);
        res.status(500).json({ success: false, error: 'Failed to accept call' });
    }
});

callRouter.get('/:phoneNumberId/:callId', (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const callId = req.params.callId as string;
    const call = sessionManager.getCall(phoneNumberId, callId);
    if (!call) {
        res.status(404).json({ success: false, error: 'Call not found' });
        return;
    }
    res.json({ success: true, call });
});

// ---------------------------------------------------------------------------
// Ponte de áudio por WebSocket
//
// Quadros binários: PCM Float32 little-endian, mono, 16 kHz — do front para o
// serviço vira `feedLiveAudio`; do serviço para o front é a voz do contato.
// Quadros de texto: JSON. Serviço → front: {type:'state', call} e
// {type:'buffer', ms} (fila de envio, para o front segurar o microfone).
// Front → serviço: {type:'end'}, {type:'mute', muted}.
// Fechar o socket encerra a ligação: quem fechou a janela desligou.
// ---------------------------------------------------------------------------

const AUDIO_PATH = /^\/call\/([^/]+)\/([^/]+)\/audio$/;

export function attachCallAudioSocket(server: HttpServer): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const match = AUDIO_PATH.exec(url.pathname);
        if (!match) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }
        const [, phoneNumberId, callId] = match;
        const token = url.searchParams.get('access_token');
        void (async () => {
            const principal = token ? await authenticateToken(token).catch(() => null) : null;
            if (!principal) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
            if (!principal.isServiceRole) {
                const access = await userCanAccessPhone(principal.userId, phoneNumberId);
                if (access !== 'ok') {
                    socket.write(access === 'not_found' ? 'HTTP/1.1 404 Not Found\r\n\r\n' : 'HTTP/1.1 403 Forbidden\r\n\r\n');
                    socket.destroy();
                    return;
                }
            }
            wss.handleUpgrade(req, socket, head, (ws) => handleAudioSocket(ws, phoneNumberId, callId));
        })();
    });
}

function handleAudioSocket(ws: WebSocket, phoneNumberId: string, callId: string): void {
    const current = sessionManager.getCall(phoneNumberId, callId);
    if (!current) {
        ws.close(4404, 'call not found');
        return;
    }
    try {
        sessionManager.setCallLiveAudio(phoneNumberId, callId, true);
    } catch (error) {
        const status = error instanceof WhatsAppClientError ? error.statusCode ?? 500 : 500;
        ws.close(4000 + status, (error as Error).message.slice(0, 120));
        return;
    }

    const sendJson = (payload: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload)); };
    sendJson({ type: 'state', call: current });

    let lastBufferReport = 0;
    const onUpdate = (pid: string, call: CallUpdate) => {
        if (pid !== phoneNumberId || call.callId !== callId) return;
        sendJson({ type: 'state', call });
        if (call.state === 'ended') ws.close(1000, 'ended');
    };
    const onAudio = (pid: string, cid: string, pcm: Float32Array) => {
        if (pid !== phoneNumberId || cid !== callId || ws.readyState !== ws.OPEN) return;
        ws.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), { binary: true });
    };
    sessionManager.callEvents.on('update', onUpdate);
    sessionManager.callEvents.on('audio', onAudio);

    ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) {
            const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return;
            // Cópia alinhada: o Buffer do ws pode vir com offset não múltiplo de 4.
            const pcm = new Float32Array(buf.byteLength / 4);
            new Uint8Array(pcm.buffer).set(buf);
            const bufferedMs = sessionManager.feedCallAudio(phoneNumberId, callId, pcm);
            const now = Date.now();
            if (now - lastBufferReport > 500) {
                lastBufferReport = now;
                sendJson({ type: 'buffer', ms: bufferedMs });
            }
            return;
        }
        try {
            const msg = JSON.parse(String(data)) as { type?: string; muted?: boolean };
            if (msg.type === 'end') void sessionManager.endCall(phoneNumberId, callId).catch(() => undefined);
            else if (msg.type === 'mute') sessionManager.setCallMuted(phoneNumberId, callId, msg.muted === true);
        } catch { /* quadro de texto inválido: ignora */ }
    });

    ws.on('close', () => {
        sessionManager.callEvents.off('update', onUpdate);
        sessionManager.callEvents.off('audio', onAudio);
        const call = sessionManager.getCall(phoneNumberId, callId);
        if (call && call.state !== 'ended') void sessionManager.endCall(phoneNumberId, callId).catch(() => undefined);
    });
    ws.on('error', (error) => console.warn('[Call] websocket error:', error.message));
}
