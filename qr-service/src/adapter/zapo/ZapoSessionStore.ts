import type { WaStore } from 'zapo-js';
import { migrate, type LibInput, type LibOutput } from 'wa-store-migrate';
import type { AuthSnapshot, SessionStore } from '../types.js';

type ZapoOut = LibOutput<'zapo'>;

/**
 * Sessão da zapo dentro de um `WaStore` (memória nos testes, Postgres em produção).
 * A zapo persiste as credenciais sozinha; aqui só olhamos/limpamos e importamos
 * um `AuthSnapshot` (formato Baileys) via wa-store-migrate — sem re-parear.
 */
export class ZapoSessionStore implements SessionStore {
    constructor(
        readonly store: WaStore,
        readonly sessionId: string,
        readonly kind: string,
        readonly locator: string,
    ) {}

    async exists(): Promise<boolean> {
        const creds = await this.store.session(this.sessionId).auth.load();
        return !!creds;
    }

    async isPaired(): Promise<boolean> {
        const creds = await this.store.session(this.sessionId).auth.load();
        return !!creds?.meJid;
    }

    async wipe(): Promise<void> {
        const s = this.store.session(this.sessionId);
        await Promise.all([
            s.auth.clear(), s.preKey.clear(), s.session.clear(), s.identity.clear(),
            s.senderKey.clear(), s.appState.clear?.(), s.privacyToken.clear(),
        ].map((p) => Promise.resolve(p).catch(() => undefined)));
    }

    /** Escreve um snapshot Baileys convertido. Devolve as perdas reportadas pela conversão. */
    async importSnapshot(snapshot: AuthSnapshot): Promise<{ losses: string[] }> {
        if (snapshot.format !== 'baileys-v1') {
            throw new Error(`Formato de snapshot não suportado: ${snapshot.format}`);
        }
        const { data, losses } = migrate<'baileys', 'zapo'>({
            from: 'baileys',
            to: 'zapo',
            data: { creds: snapshot.creds, keys: snapshot.keys } as unknown as LibInput<'baileys'>,
        });
        await this.writeZapoSnapshot(data as ZapoOut);
        return { losses: losses.map((l) => `[${l.severity}] ${l.domain} x${l.count}: ${l.reason}`) };
    }

    private async writeZapoSnapshot(data: ZapoOut): Promise<void> {
        const s = this.store.session(this.sessionId);
        await this.wipe();
        await s.auth.save(data.credentials as unknown as Parameters<typeof s.auth.save>[0]);
        for (const k of data.preKeys ?? []) await s.preKey.putPreKey(k as unknown as Parameters<typeof s.preKey.putPreKey>[0]);
        if (data.identities?.length) {
            await s.identity.setRemoteIdentities(
                data.identities.map((i) => ({ address: i.address, identityKey: i.identityKey })) as unknown as Parameters<typeof s.identity.setRemoteIdentities>[0],
            );
        }
        if (data.sessions?.length) {
            await s.session.setSessionsBatch(
                data.sessions.map((x) => ({ address: x.address, session: x.record })) as unknown as Parameters<typeof s.session.setSessionsBatch>[0],
            );
        }
        for (const sk of data.senderKeys ?? []) {
            await s.senderKey.upsertSenderKey(sk.record as unknown as Parameters<typeof s.senderKey.upsertSenderKey>[0]);
        }
        if (data.appState?.keys?.length) {
            await s.appState.upsertSyncKeys(data.appState.keys as unknown as Parameters<typeof s.appState.upsertSyncKeys>[0]);
        }
        if (data.privacyTokens?.length) {
            await s.privacyToken.upsertBatch(data.privacyTokens as unknown as Parameters<typeof s.privacyToken.upsertBatch>[0]);
        }
    }
}
