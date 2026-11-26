/**
 * Registro de ligação na conversa.
 *
 * O qr-service grava uma mensagem `message_type = 'call'` quando a ligação
 * termina, com o resumo em `metadata.call`. O texto é montado aqui, no front,
 * para que a bolha e a prévia da lista digam a mesma coisa e para que mudar o
 * vocabulário não exija subir imagem nova do serviço.
 *
 * "Recusada" não aparece: o plugin de voz descarta o motivo do stanza e carimba
 * `user_ended` em tudo, então não dá para distinguir recusa de desistência. O
 * que o dado sustenta é se a ligação foi atendida — ver [describeCallState].
 */

export interface CallMeta {
    direction?: "incoming" | "outgoing" | null;
    connected?: boolean | null;
    durationSecs?: number | null;
}

export interface CallMessage {
    content?: string | null;
    metadata?: unknown;
}

/** Segundos em "38s" ou "1:23" — o formato curto lê melhor numa pílula. */
export function formatCallDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}

export function readCallMeta(message: CallMessage): CallMeta | null {
    const metadata = message.metadata;
    if (!metadata || typeof metadata !== "object") return null;
    const call = (metadata as Record<string, unknown>).call;
    if (!call || typeof call !== "object") return null;
    const raw = call as Record<string, unknown>;
    return {
        direction: raw.direction === "incoming" || raw.direction === "outgoing" ? raw.direction : null,
        connected: typeof raw.connected === "boolean" ? raw.connected : null,
        durationSecs: typeof raw.duration_secs === "number" ? raw.duration_secs : null,
    };
}

/**
 * Texto da bolha. Sem metadata (registro antigo ou truncado) cai no `content`
 * que o serviço gravou, e só então num rótulo genérico — a bolha nunca fica vazia.
 */
export function buildCallText(message: CallMessage): string {
    const meta = readCallMeta(message);
    if (!meta) return message.content?.trim() || "Chamada de voz";

    if (meta.connected) {
        const duration = meta.durationSecs && meta.durationSecs > 0 ? ` · ${formatCallDuration(meta.durationSecs)}` : "";
        return `Chamada de voz${duration}`;
    }
    return meta.direction === "outgoing" ? "Chamada não atendida" : "Chamada perdida";
}
