import { describe, expect, it } from "vitest";
import type { ConnectionLine } from "@/hooks/useConnectionHealth";
import { classifyLineRisk } from "./connectionRisk";

const NOW = new Date("2026-09-18T12:00:00Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function line(overrides: Partial<ConnectionLine> = {}): ConnectionLine {
    return {
        id: "11111111-1111-1111-1111-111111111111",
        display_name: "Comercial",
        phone_number: "5511999999999",
        is_active: true,
        qr_session_status: "connected",
        last_event: "close",
        last_status_code: 403,
        last_reason: "Connection Failure",
        last_event_at: hoursAgo(1),
        last_open_at: hoursAgo(30),
        last_inbound_at: hoursAgo(30),
        closes: 12,
        closes_24h: 12,
        conflicts: 0,
        conflicts_7d: 0,
        last_conflict_at: null,
        forbidden: 3,
        last_forbidden_at: hoursAgo(2),
        group_adds: 0,
        group_adds_7d: 0,
        ...overrides,
    };
}

describe("classifyLineRisk — assinatura de ban", () => {
    it("acusa o ban quando o 403 é o último close", () => {
        const risk = classifyLineRisk(line(), undefined, null, NOW);
        expect(risk.level).toBe("banned");
    });

    it("mantém o ban quando closes posteriores empurraram o 403 para trás", () => {
        // O que acontece de verdade: depois do 403 o serviço tenta reconectar e
        // grava 401/∅. Antes, a linha voltava a ser só "Fora do ar".
        const risk = classifyLineRisk(
            line({ last_status_code: 401, last_reason: "conflict", last_forbidden_at: hoursAgo(5) }),
            undefined,
            null,
            NOW,
        );
        expect(risk.level).toBe("banned");
        expect(risk.reason).toContain("24h");
    });

    it("não acusa ban por 403 antigo na janela", () => {
        const risk = classifyLineRisk(
            line({ last_status_code: 401, last_reason: "conflict", last_forbidden_at: hoursAgo(72) }),
            undefined,
            null,
            NOW,
        );
        expect(risk.level).toBe("down");
    });

    it("não acusa ban com a linha no ar", () => {
        const risk = classifyLineRisk(line({ last_event: "open" }), undefined, "connected", NOW);
        expect(risk.level).not.toBe("banned");
    });
});
