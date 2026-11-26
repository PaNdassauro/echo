import type { ConnectionLine, ProspectingRow } from "@/hooks/useConnectionHealth";
import type { LineCapping } from "@/hooks/useQrServiceHealth";

export type RiskLevel = "banned" | "down" | "penalized" | "warn" | "ok";

export interface LineRisk {
    level: RiskLevel;
    label: string;
    /** Frase curta, em português, explicando por que a linha caiu nesse nível. */
    reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Classifica o risco de uma linha QR a partir do que a RPC devolve.
 *
 * Ordem importa: a assinatura de ban (403 "Connection Failure" repetido) vence
 * tudo; depois a linha fora do ar; depois a penalidade por add em grupo
 * (401/440 conflict nas últimas 24h); depois os sinais de aviso documentados
 * em bans observados (adds em grupo, prospecção 1:1 sem resposta).
 */
/**
 * `serviceStatus`: estado ao vivo no SessionManager do qr-service.
 *   - undefined → serviço não consultado/indisponível: cai no último evento do log
 *   - null      → consultado e a linha NÃO está no serviço: fora do ar, seja o que o log diga
 *   - string    → status do serviço ('connected' é o único que conta como viva)
 */
export function classifyLineRisk(
    line: ConnectionLine,
    prospecting: ProspectingRow | undefined,
    serviceStatus: string | null | undefined = undefined,
    now = Date.now(),
    /** Cota de conversas novas ao vivo (qr-service). CAPPED = o servidor recusa contato frio. */
    capping: LineCapping | undefined = undefined,
): LineRisk {
    const lastEventAt = line.last_event_at ? new Date(line.last_event_at).getTime() : null;
    const lastConflictAt = line.last_conflict_at ? new Date(line.last_conflict_at).getTime() : null;
    const isDown = serviceStatus === undefined ? line.last_event === "close" : serviceStatus !== "connected";

    // O 403 não é o último evento por muito tempo: depois dele vêm reconnects e
    // closes 401/∅ que empurrariam a linha de volta para "Fora do ar" e apagariam
    // a assinatura do ban. Por isso o 403 recente também vale, não só o último code.
    const lastForbiddenAt = line.last_forbidden_at ? new Date(line.last_forbidden_at).getTime() : null;
    const forbiddenRecently = lastForbiddenAt !== null && now - lastForbiddenAt < DAY_MS;
    if (line.forbidden > 0 && isDown && (line.last_status_code === 403 || forbiddenRecently)) {
        const reason = line.last_status_code === 403
            ? `${line.forbidden}× 403 Connection Failure; última tentativa recusada`
            : `${line.forbidden}× 403 Connection Failure nas últimas 24h e a linha segue fora do ar`;
        return { level: "banned", label: "Banido?", reason };
    }

    if (isDown) {
        if (serviceStatus === null) {
            return { level: "down", label: "Fora do ar", reason: "sem sessão no serviço; precisa reconectar" };
        }
        if (serviceStatus !== undefined) {
            return { level: "down", label: "Fora do ar", reason: `serviço: ${serviceStatus}` };
        }
        const code = line.last_status_code ?? "∅";
        const reason = line.last_reason ?? "sem motivo";
        return { level: "down", label: "Fora do ar", reason: `close ${code}/${reason}` };
    }

    if (lastConflictAt !== null && now - lastConflictAt < DAY_MS) {
        return { level: "penalized", label: "Penalizado", reason: "conflict (401/440) nas últimas 24h; não adicionar em grupo" };
    }

    if (capping?.status === "CAPPED") {
        const quota = `${capping.used_quota ?? "?"}/${capping.total_quota ?? "?"}`;
        return { level: "penalized", label: "Cota esgotada", reason: `WhatsApp esgotou a cota de conversas novas (${quota}); contato frio é recusado até o fim do ciclo` };
    }

    const started = prospecting?.started_by_us_7d ?? 0;
    const unanswered = prospecting?.unanswered_7d ?? 0;
    const warnings: string[] = [];
    if (capping && capping.status !== "NONE" && capping.status !== "CAPPED") {
        warnings.push(`aviso de cota de conversas novas (${capping.used_quota ?? "?"}/${capping.total_quota ?? "?"})`);
    }
    if (line.conflicts_7d >= 2) warnings.push(`${line.conflicts_7d} conflicts em 7d`);
    if (line.group_adds_7d >= 10) warnings.push(`${line.group_adds_7d} adds em grupo em 7d`);
    if (started >= 15) warnings.push(`${started} contatos novos iniciados por nós em 7d`);
    if (started >= 5 && unanswered / started >= 0.6) warnings.push(`${unanswered} de ${started} prospecções sem resposta`);
    if (warnings.length > 0) {
        return { level: "warn", label: "Atenção", reason: warnings.join("; ") };
    }

    if (lastEventAt === null) {
        return { level: "ok", label: "Sem eventos", reason: "nenhum registro de conexão na janela" };
    }
    return { level: "ok", label: "Conectada", reason: "sem sinais de risco" };
}

export const RISK_ORDER: Record<RiskLevel, number> = { banned: 0, down: 1, penalized: 2, warn: 3, ok: 4 };
