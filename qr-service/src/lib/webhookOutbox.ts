import fs from 'fs';
import path from 'path';
import { postJson } from './httpClient.js';

/**
 * Outbox de entrega ao webhook: "recebeu = vai persistir".
 *
 * Antes, o POST à edge era fire-and-forget: o status HTTP era descartado, timeout
 * virava console.error e o backpressure (MAX_PENDING_WEBHOOKS) DESCARTAVA mensagem
 * recebida — o WhatsApp já tinha recebido o recibo de entrega, então cada uma
 * dessas perdas era definitiva e invisível.
 *
 * Desenho (retry em memória + spill em disco):
 *  - fila FIFO em memória com workers de concorrência limitada;
 *  - falha retryável (5xx/408/429/rede/timeout) → backoff 2s/8s/30s em memória;
 *  - esgotou, ou fila cheia, ou shutdown → o job vira arquivo em
 *    `<sessionsDir>/_outbox/` (volume persistente; o restore de sessões ignora
 *    diretórios sem creds.json) e um sweeper de 60s + replay no boot reentregam;
 *  - 4xx permanente (a edge recusou o payload) → `_outbox_dead/` + linha
 *    `webhook_dead` em qr_message_log com o payload — DLQ consultável por SQL;
 *  - 404 → descartado em silêncio: não é payload inválido, é a edge dizendo que
 *    não conhece a mensagem referenciada (ver Outcome.discard).
 *
 * Por que disco local e não uma tabela: a DLQ moraria no MESMO Supabase cuja
 * indisponibilidade é a principal causa de falha do POST — cairiam juntos. O
 * disco é o único destino que falha independente.
 *
 * Duplicata em replay é segura por construção: a edge faz upsert no unique
 * composto (whatsapp_message_id, conversation_id) e o last_message_at só avança.
 */

export type OutboxRoute =
    | 'qr-message'
    | 'qr-group-event'
    | 'qr-poll-vote'
    | 'qr-reaction'
    | 'qr-delivery-update'
    | 'qr-message-receipt'
    | 'qr-message-deleted'
    | 'qr-message-edited';

/**
 * Desfecho de um POST. `discard` é o 404: a edge não conhece a mensagem
 * referenciada — sai da fila em silêncio, sem dead file e sem rastro, ao
 * contrário de `permanent` (400/422), que é contrato quebrado e vira DLQ.
 */
type Outcome = 'ok' | 'retryable' | 'permanent' | 'discard';

export interface OutboxEnqueueArgs {
    route: OutboxRoute;
    phoneNumberId: string;
    /** JID/telefone de destino, só para o rastro em qr_message_log. */
    toJid: string;
    wamid?: string | null;
    body: Record<string, unknown>;
    timeoutMs?: number;
    /**
     * false = efêmero (recibo de leitura): ganha os retries em memória, mas não
     * vira arquivo — numa outage longa seriam milhares de arquivos sem valor.
     */
    spillable?: boolean;
}

interface OutboxJob extends Required<Omit<OutboxEnqueueArgs, 'wamid'>> {
    v: 1;
    wamid: string | null;
    enqueuedAt: number;
    attempts: number;
}

interface PersistedJob {
    v: 1;
    route: OutboxRoute;
    phoneNumberId: string;
    toJid: string;
    wamid: string | null;
    enqueuedAt: number;
    attempts: number;
    timeoutMs: number;
    body: Record<string, unknown>;
}

type DebugLogFn = (
    phoneNumberId: string,
    action: string,
    toJid: string,
    payload: Record<string, unknown>,
    messageId?: string | null
) => void;

/** Backoff entre tentativas em memória; depois da última, spill. */
const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];
const SWEEP_INTERVAL_MS = 60_000;
const DEAD_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Tentativas em disco antes de o arquivo deixar de ser tratado como sinal de
 * saúde da edge. Um job chega ao disco com ~4 tentativas (as de memória), e o
 * sweep só tenta o bloqueador uma vez por ciclo — então 20 são ~16 minutos
 * parado. Uma outage real é sobrevivida pelo `break`, que continua valendo
 * para todo arquivo abaixo deste teto; o que passa dele é veneno individual.
 */
const STOP_BLOCKING_AFTER = 20;

export class WebhookOutbox {
    private queue: OutboxJob[] = [];
    /** Jobs vivos (na fila, em voo ou em backoff) — o "pending" do /health. */
    private live = new Set<OutboxJob>();
    private activeWorkers = 0;
    private seq = 0;
    private sweeping = false;
    /**
     * Desfecho do último sweep. `stalled` é o sinal que distingue "fila drenando"
     * de "fila represada": o sweep terminou no `break` sem entregar nada, ou seja,
     * a edge recusou o arquivo da frente e ninguém atrás dele passou. Só a
     * contagem em disco não serve para isso — um job acima de STOP_BLOCKING_AFTER
     * fica no diretório até o TTL sem estar bloqueando coisa alguma.
     */
    private lastSweep = { stalled: false, skipped: 0, at: 0 };
    private sweepTimer: ReturnType<typeof setInterval>;
    private readonly outboxDir: string;
    private readonly deadDir: string;
    /** Resolvers pendentes por job — enqueue() resolve na disposição final. */
    private settlers = new Map<OutboxJob, () => void>();

    constructor(
        private readonly opts: {
            /** Lido por chamada: o singleton nasce antes do dotenv.config(). */
            getWebhookUrl: () => string | undefined;
            sessionsDir: string;
            concurrency?: number;
            /** Acima disso, enqueue vai direto pro disco (era o antigo MAX_PENDING_WEBHOOKS). */
            memCap?: number;
            debugLog?: DebugLogFn;
        }
    ) {
        this.outboxDir = path.join(opts.sessionsDir, '_outbox');
        this.deadDir = path.join(opts.sessionsDir, '_outbox_dead');
        this.sweepTimer = setInterval(() => void this.sweepDisk(), SWEEP_INTERVAL_MS);
        this.sweepTimer.unref();
    }

    private get concurrency(): number {
        return this.opts.concurrency ?? 8;
    }

    private get memCap(): number {
        return this.opts.memCap ?? 500;
    }

    /** Jobs em memória ainda sem disposição (fila + voo + backoff). */
    memCount(): number {
        return this.live.size;
    }

    stats(): { queue_mem: number; queue_disk: number; oldest_disk_age_s: number | null; stalled: boolean; skipped: number } {
        let files: string[] = [];
        try {
            files = fs.existsSync(this.outboxDir) ? fs.readdirSync(this.outboxDir) : [];
        } catch { /* stats nunca lança */ }
        let oldest: number | null = null;
        for (const f of files) {
            const ts = Number(f.split('-')[0]);
            if (Number.isFinite(ts) && (oldest === null || ts < oldest)) oldest = ts;
        }
        return {
            queue_mem: this.live.size,
            queue_disk: files.length,
            oldest_disk_age_s: oldest === null ? null : Math.round((Date.now() - oldest) / 1000),
            stalled: this.lastSweep.stalled,
            skipped: this.lastSweep.skipped,
        };
    }

    /**
     * Entrega o job ao webhook. A promise resolve na disposição final — entregue,
     * spillado ou dead — e NUNCA rejeita: quem recebe mensagem não pode falhar
     * por causa do transporte.
     */
    enqueue(args: OutboxEnqueueArgs): Promise<void> {
        const job: OutboxJob = {
            v: 1,
            route: args.route,
            phoneNumberId: args.phoneNumberId,
            toJid: args.toJid,
            wamid: args.wamid ?? null,
            body: args.body,
            timeoutMs: args.timeoutMs ?? 10_000,
            spillable: args.spillable !== false,
            enqueuedAt: Date.now(),
            attempts: 0,
        };

        // Fila cheia: direto pro disco (o que era descarte virou spill).
        if (this.live.size >= this.memCap) {
            if (job.spillable) {
                this.spill(job, `fila em memória cheia (${this.live.size})`);
            } else {
                console.warn(`[Outbox] fila cheia — descartando ${job.route} efêmero ${job.wamid ?? ''}`);
            }
            return Promise.resolve();
        }

        this.live.add(job);
        this.queue.push(job);
        const done = new Promise<void>((resolve) => this.settlers.set(job, resolve));
        this.pump();
        return done;
    }

    /** Dispara workers até o teto de concorrência. */
    private pump(): void {
        while (this.activeWorkers < this.concurrency && this.queue.length > 0) {
            const job = this.queue.shift()!;
            this.activeWorkers++;
            void this.attempt(job).finally(() => {
                this.activeWorkers--;
                this.pump();
            });
        }
    }

    private settle(job: OutboxJob): void {
        this.live.delete(job);
        const resolve = this.settlers.get(job);
        this.settlers.delete(job);
        resolve?.();
    }

    private async attempt(job: OutboxJob): Promise<void> {
        const outcome = await this.post(job);
        job.attempts++;

        if (outcome === 'ok') {
            this.settle(job);
            return;
        }

        // 404: a edge não conhece a mensagem referenciada. Estado esperado, não
        // defeito — sai sem dead file e sem rastro, em rota efêmera ou não.
        if (outcome === 'discard') {
            this.settle(job);
            return;
        }

        if (outcome === 'permanent') {
            if (!job.spillable) {
                // Efêmero (delivery-update): recusa da edge não merece dead file
                // — numa outage seriam milhares de arquivos sem valor.
                console.warn(`[Outbox] ${job.route} efêmero recusado pela edge (4xx) — descartado sem rastro`);
            } else {
                this.kill(job, 'edge recusou (4xx permanente)');
            }
            this.settle(job);
            return;
        }

        // retryável
        const delay = RETRY_DELAYS_MS[job.attempts - 1];
        if (delay === undefined) {
            if (job.spillable) {
                this.spill(job, `retries esgotados (${job.attempts})`);
            } else {
                console.warn(`[Outbox] ${job.route} efêmero descartado após ${job.attempts} tentativas`);
            }
            this.settle(job);
            return;
        }

        const timer = setTimeout(() => {
            this.queue.push(job);
            this.pump();
        }, delay);
        timer.unref();
    }

    /** POST único. 'ok' | 'retryable' | 'permanent' | 'discard'. */
    private async post(job: PersistedJob): Promise<Outcome> {
        const webhookUrl = this.opts.getWebhookUrl();
        if (!webhookUrl) {
            // O boot valida WEBHOOK_URL, então isto é um estado impossível em
            // produção — mas se acontecer, é retryável, nunca descarte.
            console.error('[Outbox] WEBHOOK_URL ausente — job segue na fila');
            return 'retryable';
        }
        try {
            const res = await postJson(`${webhookUrl}/${job.route}`, job.body, job.timeoutMs);
            if (res.ok) return 'ok';
            // 408/429 são retryáveis mesmo sendo 4xx; o resto do 4xx é a edge
            // dizendo "esse payload nunca vai entrar" (400 Zod, 422 permanente).
            if (res.status >= 500 || res.status === 408 || res.status === 429) {
                console.warn(`[Outbox] ${job.route} ${job.wamid ?? ''} → HTTP ${res.status} (retryável, tentativa ${job.attempts + 1})`);
                return 'retryable';
            }
            // 404 é o único 4xx que NÃO é defeito: a edge está dizendo "não
            // conheço essa mensagem". Acontece o tempo todo em rotas que
            // referenciam uma mensagem anterior (revoke/edição/reação/voto) de
            // algo que o CRM nunca salvou — canal, mensagem pré-cutoff, mídia
            // descartada na entrada. Tratar como DLQ enchia qr_message_log de
            // webhook_dead e acendia banner+e-mail+push por nada (os
            // qr-message-deleted eram isso).
            if (res.status === 404) {
                console.warn(`[Outbox] ${job.route} ${job.wamid ?? ''} → 404 (a edge não conhece a mensagem) — descartado sem rastro`);
                return 'discard';
            }
            console.error(`[Outbox] ${job.route} ${job.wamid ?? ''} → HTTP ${res.status} (permanente)`);
            return 'permanent';
        } catch (err) {
            console.warn(`[Outbox] ${job.route} ${job.wamid ?? ''} → erro de rede/timeout (retryável):`, (err as Error)?.message ?? err);
            return 'retryable';
        }
    }

    private persistedShape(job: OutboxJob | PersistedJob): PersistedJob {
        return {
            v: 1,
            route: job.route,
            phoneNumberId: job.phoneNumberId,
            toJid: job.toJid,
            wamid: job.wamid,
            enqueuedAt: job.enqueuedAt,
            attempts: job.attempts,
            timeoutMs: job.timeoutMs,
            body: job.body,
        };
    }

    /** Grava o job em disco para o sweeper/replay. Nunca lança. */
    private spill(job: OutboxJob, reason: string): void {
        try {
            fs.mkdirSync(this.outboxDir, { recursive: true });
            const file = path.join(this.outboxDir, `${job.enqueuedAt}-${String(this.seq++).padStart(6, '0')}-${job.route}.json`);
            fs.writeFileSync(file, JSON.stringify(this.persistedShape(job)));
            console.warn(`[Outbox] spill: ${job.route} ${job.wamid ?? ''} → ${path.basename(file)} (${reason})`);
            this.opts.debugLog?.(job.phoneNumberId, 'webhook_spilled', job.toJid, {
                route: job.route,
                reason,
                attempts: job.attempts,
            }, job.wamid);
        } catch (err) {
            // Disco falhou: última linha de defesa é o log estruturado com o payload.
            console.error('[Outbox] SPILL FALHOU — payload só no rastro:', err);
            this.opts.debugLog?.(job.phoneNumberId, 'webhook_dead', job.toJid, {
                route: job.route,
                reason: `spill falhou: ${(err as Error)?.message ?? err}`,
                payload: job.body,
            }, job.wamid);
        }
    }

    /** Falha permanente: arquivo em _outbox_dead + rastro com o payload completo. */
    private kill(job: OutboxJob | PersistedJob, reason: string, sourceFile?: string): void {
        try {
            fs.mkdirSync(this.deadDir, { recursive: true });
            const name = sourceFile
                ? path.basename(sourceFile)
                : `${job.enqueuedAt}-${String(this.seq++).padStart(6, '0')}-${job.route}.json`;
            fs.writeFileSync(path.join(this.deadDir, name), JSON.stringify(this.persistedShape(job)));
            if (sourceFile) fs.unlinkSync(sourceFile);
        } catch (err) {
            console.error('[Outbox] falha ao mover para dead:', err);
        }
        console.error(`[Outbox] DEAD: ${job.route} ${job.wamid ?? ''} (${reason})`);
        this.opts.debugLog?.(job.phoneNumberId, 'webhook_dead', job.toJid, {
            route: job.route,
            reason,
            attempts: job.attempts,
            payload: job.body,
        }, job.wamid);
    }

    /** Replay no boot: uma varredura imediata do disco. */
    async replayFromDisk(): Promise<void> {
        await this.sweepDisk();
    }

    /**
     * Varre `_outbox/` em ordem (nome = timestamp) e tenta reentregar,
     * SEQUENCIAL de propósito: preserva a ordem de chegada por conversa no
     * cenário que importa (rajada represada de uma outage). Na primeira falha
     * retryável a varredura para — a edge está fora, martelar não ajuda.
     */
    private async sweepDisk(): Promise<void> {
        if (this.sweeping) return;
        this.sweeping = true;
        try {
            if (!fs.existsSync(this.outboxDir)) return;
            const files = fs.readdirSync(this.outboxDir).filter((f) => f.endsWith('.json')).sort();
            if (files.length === 0) return;
            console.log(`[Outbox] sweep: ${files.length} arquivo(s) em disco`);

            let replayed = 0;
            let skipped = 0;
            let blocked = false;
            for (const name of files) {
                const file = path.join(this.outboxDir, name);
                let job: PersistedJob;
                try {
                    job = JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedJob;
                    if (job?.v !== 1 || !job.route || !job.body) throw new Error('shape inválido');
                } catch (err) {
                    console.error(`[Outbox] arquivo ilegível ${name} — movendo para dead:`, err);
                    try {
                        fs.mkdirSync(this.deadDir, { recursive: true });
                        fs.renameSync(file, path.join(this.deadDir, name));
                    } catch { /* melhor esforço */ }
                    continue;
                }

                if (Date.now() - job.enqueuedAt > DEAD_AFTER_MS) {
                    this.kill(job, 'expirado no disco (>7 dias)', file);
                    continue;
                }

                const outcome = await this.post(job);
                if (outcome === 'ok' || outcome === 'discard') {
                    // `discard` (404) sai da fila igual a `ok`. Sem esta cláusula ele
                    // caía no `else` de baixo: o arquivo era reescrito com attempts+1 e
                    // o `break` represava TODA a fila de disco até o TTL de 7 dias,
                    // porque um 404 de mensagem que o CRM nunca teve é 404 para sempre.
                    try { fs.unlinkSync(file); } catch { /* já foi */ }
                    if (outcome === 'ok') replayed++;
                } else if (outcome === 'permanent') {
                    this.kill(job, 'edge recusou no replay (4xx permanente)', file);
                } else {
                    job.attempts++;
                    try { fs.writeFileSync(file, JSON.stringify(job)); } catch { /* mantém o anterior */ }
                    // Acima do teto o arquivo para de representar a edge: segue na
                    // fila (o TTL é quem o mata), mas deixa de barrar os que vêm
                    // depois. Sem isto, um único job que falha sempre represa tudo
                    // por 7 dias.
                    if (job.attempts > STOP_BLOCKING_AFTER) {
                        skipped++;
                        continue;
                    }
                    console.warn(`[Outbox] sweep interrompido em ${name} (edge indisponível, tentativa ${job.attempts}); próximo em ${SWEEP_INTERVAL_MS / 1000}s`);
                    blocked = true;
                    break;
                }
            }
            if (replayed > 0) console.log(`[Outbox] sweep: ${replayed} job(s) reentregue(s)`);
            if (skipped > 0) console.warn(`[Outbox] sweep: ${skipped} job(s) ultrapassaram ${STOP_BLOCKING_AFTER} tentativas e deixaram de bloquear a fila`);
            this.lastSweep = { stalled: blocked && replayed === 0, skipped, at: Date.now() };
        } catch (err) {
            console.error('[Outbox] sweep error:', err);
        } finally {
            this.sweeping = false;
        }
    }

    /** Espera a fila em memória esvaziar, até maxMs. Para o shutdown. */
    async drain(maxMs: number): Promise<void> {
        const deadline = Date.now() + maxMs;
        while (this.live.size > 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 250));
        }
    }

    /**
     * Spilla tudo que ainda está vivo em memória — síncrono, para o shutdown e o
     * uncaughtException. Job em voo pode duplicar no replay; o dedup da edge cobre.
     */
    persistPendingSync(): number {
        let spilled = 0;
        for (const job of [...this.live]) {
            if (!job.spillable) {
                this.settle(job);
                continue;
            }
            this.spill(job, 'shutdown');
            this.settle(job);
            spilled++;
        }
        this.queue = [];
        return spilled;
    }
}
