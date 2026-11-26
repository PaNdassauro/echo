import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { QrServiceHealth } from "@/hooks/useQrServiceHealth";
import { ServiceDiagnostics } from "./ServiceDiagnostics";
import { ServiceBar } from "./ServiceBar";

afterEach(cleanup);

function health(overrides: Partial<QrServiceHealth["service"]> = {}, rest: Partial<QrServiceHealth> = {}): QrServiceHealth {
    return {
        success: true,
        checked_at: "2026-10-19T12:39:00.000Z",
        service: {
            version: "2.5.8",
            commit: null,
            uptime_s: 7200,
            rss_mb: 733,
            total_sessions: 13,
            pending_webhooks: 0,
            outbox_stalled: false,
            heap_used_mb: 76,
            outbox_mem: 0,
            outbox_disk: 0,
            outbox_oldest_disk_age_s: null,
            outbox_skipped: 0,
            avatars: null,
            ...overrides,
        },
        sessions: {},
        capping: {},
        providers: {},
        registered_providers: [],
        reachout_locks: {},
        protection_limits: {},
        failures: null,
        ...rest,
    };
}

describe("ServiceDiagnostics", () => {
    it("abre sozinho e mostra a fila em disco quando há arquivos", () => {
        render(
            <ServiceDiagnostics
                health={health({ outbox_disk: 1067, outbox_oldest_disk_age_s: 2034 })}
                lineNames={new Map()}
            />,
        );
        expect(screen.getByText("1067")).toBeTruthy();
        expect(screen.getByText("33min")).toBeTruthy();
    });

    it("lista falhas por ação e o bloqueio de contato frio com o nome da linha", () => {
        render(
            <ServiceDiagnostics
                health={health(
                    {},
                    {
                        failures: { window_minutes: 60, spilled: 1660, by_action: { msg_drop_undecrypted: 40 }, truncated: false },
                        reachout_locks: { "line-1": { hits: 2, locked_until: "2099-01-01T00:00:00.000Z", source: "ack463", enforcement_type: null } },
                    },
                )}
                lineNames={new Map([["line-1", "Comercial"]])}
            />,
        );
        expect(screen.getByText("1660")).toBeTruthy();
        expect(screen.getByText("msg_drop_undecrypted")).toBeTruthy();
        expect(screen.getByText("Comercial")).toBeTruthy();
    });

    it("aceita payload de edge antiga (campos novos ausentes) sem quebrar", () => {
        render(
            <ServiceDiagnostics
                health={health({ outbox_disk: null, outbox_mem: null, heap_used_mb: null, outbox_skipped: null, avatars: null })}
                lineNames={new Map()}
            />,
        );
        expect(screen.getAllByText("—").length).toBeGreaterThan(0);
        expect(screen.getAllByText("sem dado").length).toBeGreaterThanOrEqual(3);
    });
});

describe("ServiceBar", () => {
    const noop = () => undefined;

    it("avisa a fila em disco mesmo com pending_webhooks em zero", () => {
        render(<ServiceBar health={health({ outbox_disk: 1120, outbox_oldest_disk_age_s: 1800 })} error={null} isLoading={false} onRetry={noop} />);
        expect(screen.getByText(/1120 arquivos na fila em disco/)).toBeTruthy();
    });

    it("avisa o reinício recente quando há sessões que reconectaram", () => {
        render(<ServiceBar health={health({ uptime_s: 180, total_sessions: 3 })} error={null} isLoading={false} onRetry={noop} />);
        expect(screen.getByText(/reiniciou há/)).toBeTruthy();
    });

    it("instalação nova, sem sessão nenhuma, não é reinício", () => {
        render(<ServiceBar health={health({ uptime_s: 180, total_sessions: 0 })} error={null} isLoading={false} onRetry={noop} />);
        expect(screen.queryByText(/reiniciou há/)).toBeNull();
    });

    it("não mostra chip de fila com disco vazio", () => {
        render(<ServiceBar health={health()} error={null} isLoading={false} onRetry={noop} />);
        expect(screen.queryByText(/na fila em disco/)).toBeNull();
    });
});
