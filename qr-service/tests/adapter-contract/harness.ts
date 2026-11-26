/**
 * Harness dos testes de contrato: um fake-server WhatsApp por suíte e um
 * cliente do provider sob teste, pareado por QR sem telefone.
 */
import { FakeWaServer, parsePairingQrString, type FakePeer, type WaFakeConnectionPipeline } from '@zapo-js/fake-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WhatsAppClient, WhatsAppClientFactory } from '../../src/adapter/WhatsAppClient.js';
import type { ClientEventMap, ClientEventName, TransportOverrides } from '../../src/adapter/types.js';

/** O que cada provider precisa fornecer para a suíte genérica rodar. */
export interface ContractDriver {
    name: string;
    /** Factory apontando para uma raiz temporária de sessões. */
    createFactory(sessionsRoot: string): WhatsAppClientFactory;
    /**
     * Como a lib monta a URL de mídia a partir do directPath. Baileys prefixa o host
     * (override para o fake); zapo aceita URL absoluta (é o que os testes dela fazem).
     */
    mediaDirectPath?: (server: FakeWaServer, path: string) => string;
}

export const DEVICE_JID = '5511999990000:7@s.whatsapp.net';
export const DEVICE_USER_JID = '5511999990000@s.whatsapp.net';

export function waitFor<E extends ClientEventName>(
    client: WhatsAppClient,
    event: E,
    predicate: (payload: ClientEventMap[E]) => boolean = () => true,
    timeoutMs = 15_000,
): Promise<ClientEventMap[E]> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            client.off(event, listener);
            reject(new Error(`timeout esperando '${event}' (${timeoutMs}ms)`));
        }, timeoutMs);
        const listener = (payload: ClientEventMap[E]) => {
            if (!predicate(payload)) return;
            clearTimeout(timer);
            client.off(event, listener);
            resolve(payload);
        };
        client.on(event, listener);
    });
}

export class ContractHarness {
    server!: FakeWaServer;
    pipeline!: WaFakeConnectionPipeline;
    client!: WhatsAppClient;
    factory!: WhatsAppClientFactory;
    private sessionsRoot!: string;
    private readonly errors: Array<{ scope: string; error: unknown }> = [];
    /** Um FakePeer por JID: recriar o peer zera a sessão Signal e quebra a decifração. */
    private readonly peers = new Map<string, FakePeer>();

    constructor(private readonly driver: ContractDriver) {}

    transport(): TransportOverrides {
        return {
            socketUrl: this.server.url,
            noiseRootCa: { publicKey: this.server.noiseRootCa.publicKey, serial: this.server.noiseRootCa.serial },
            mediaAgent: this.server.mediaProxyAgent,
            mediaHost: new URL(this.server.mediaUrl('/')).host,
            waVersion: [2, 3000, 1043857760],
        };
    }

    newClient(sessionId = 'contract'): WhatsAppClient {
        const client = this.factory.create({
            sessionId,
            store: this.factory.createStore(sessionId),
            transport: this.transport(),
            logLevel: (process.env.WA_CONTRACT_LOG as 'debug' | undefined) ?? 'silent',
        });
        client.on('error', (e) => this.errors.push(e));
        return client;
    }

    /** Sobe o servidor, cria o cliente, pareia por QR e espera 'open'. */
    async start(): Promise<void> {
        this.server = await FakeWaServer.start();
        this.sessionsRoot = mkdtempSync(join(tmpdir(), `wa-contract-${this.driver.name}-`));
        this.factory = this.driver.createFactory(this.sessionsRoot);
        this.client = this.newClient();

        const firstPipeline = this.server.waitForAuthenticatedPipeline(15_000);
        const qr = waitFor(this.client, 'qr');
        await this.client.connect();
        const pipeline = await firstPipeline;
        // O QR carrega ref, chave Noise, identidade e advSecret (formato do protocolo,
        // igual em toda lib): o fake-server "escaneia" a partir dele, como um celular.
        const material = qr.then(({ qr: text }) => {
            const parsed = parsePairingQrString(text);
            return { advSecretKey: parsed.advSecretKey, identityPublicKey: parsed.identityPublicKey };
        });

        // Depois do pair-success o WhatsApp real fecha com 515 e o serviço reconecta;
        // o fake-server segue no mesmo socket até 'open'. O contrato aceita os dois.
        const settled = waitFor(this.client, 'connection.update', (u) => u.state === 'open' || u.state === 'close', 30_000);
        // Algumas libs (zapo) reconectam por dentro depois do pair-success sem avisar:
        // o fake abre um pipeline novo e o antigo morre. Fica de olho nos dois.
        const nextPipeline = this.server.waitForNextAuthenticatedPipeline(20_000).catch(() => null);
        await Promise.all([
            qr,
            this.server.runPairing(pipeline, { deviceJid: DEVICE_JID }, () => material),
        ]);
        const outcome = await settled;
        if (outcome.state === 'open') {
            const replaced = await Promise.race([nextPipeline, new Promise<null>((r) => setTimeout(() => r(null), 3_000))]);
            this.pipeline = replaced ?? pipeline;
            return;
        }
        if (outcome.cause !== 'restart_required' && outcome.cause !== 'connection_lost') {
            throw new Error(`fechamento inesperado após pareamento: ${outcome.cause} (${outcome.statusCode})`);
        }
        await this.reconnect();
    }

    async reconnect(): Promise<void> {
        const nextPipeline = this.server.waitForNextAuthenticatedPipeline(15_000);
        const open = waitFor(this.client, 'connection.update', (u) => u.state === 'open');
        await this.client.connect();
        this.pipeline = await nextPipeline;
        await open;
    }

    async peer(jid: string, displayName = 'Alice'): Promise<FakePeer> {
        const existing = this.peers.get(jid);
        if (existing) return existing;
        const created = await this.server.createFakePeer({ jid, displayName }, this.pipeline);
        this.peers.set(jid, created);
        return created;
    }

    /** Publica bytes no armazenamento de mídia do fake e devolve os campos do proto. */
    async publishMedia(plaintext: Buffer, mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker') {
        const blob = await this.server.publishMediaBlob({ plaintext, mediaType });
        const path = this.driver.mediaDirectPath ? this.driver.mediaDirectPath(this.server, blob.path) : blob.path;
        return { ...blob, path };
    }

    drainErrors(): Array<{ scope: string; error: unknown }> {
        return this.errors.splice(0);
    }

    async stop(): Promise<void> {
        try { await this.client?.close(); } catch { /* já fechado */ }
        await this.server?.stop();
        rmSync(this.sessionsRoot, { recursive: true, force: true });
    }
}
