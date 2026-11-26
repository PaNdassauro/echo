import { describe, expect, it, vi } from "vitest";
import type { CallUpdate } from "./voiceCall";
import { describeCallState } from "./voiceCall";

// O módulo importa o client do Supabase pela cadeia do qrService; aqui só
// interessa a função pura de texto.
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: {} } }));

function call(overrides: Partial<CallUpdate> = {}): CallUpdate {
    return {
        callId: "CALL-1",
        peerJid: "5511988887777@s.whatsapp.net",
        direction: "outgoing",
        isVideo: false,
        state: "ended",
        endReason: "user_ended",
        startedAt: 1_700_000_000_000,
        muted: false,
        ...overrides,
    };
}

describe("describeCallState em ligação encerrada", () => {
    /**
     * O plugin carimba `user_ended` em toda terminação (o motivo do stanza é
     * descartado), então recusa e desligamento chegam iguais. `connectedAt` é o
     * único dado que separa "aconteceu" de "não aconteceu".
     */
    it("saída que nunca conectou é 'Não atendida', não 'Ligação encerrada'", () => {
        expect(describeCallState(call())).toBe("Não atendida");
    });

    it("entrada que nunca conectou é 'Chamada perdida'", () => {
        expect(describeCallState(call({ direction: "incoming" }))).toBe("Chamada perdida");
    });

    it("ligação que conectou e acabou é 'Ligação encerrada'", () => {
        expect(describeCallState(call({ connectedAt: 1_700_000_005_000 }))).toBe("Ligação encerrada");
    });

    it("motivo explícito continua valendo mesmo sem conectar", () => {
        expect(describeCallState(call({ endReason: "declined" }))).toBe("Ligação recusada");
        expect(describeCallState(call({ endReason: "failed" }))).toBe("Falha na ligação");
        expect(describeCallState(call({ endReason: "do_not_disturb" }))).toBe("Contato em modo não perturbe");
    });

    it("sem motivo nenhum e sem conectar ainda diferencia a direção", () => {
        expect(describeCallState(call({ endReason: undefined }))).toBe("Não atendida");
    });

    it("estados em andamento seguem no vocabulário do WhatsApp", () => {
        expect(describeCallState(call({ state: "ringing" }))).toBe("Tocando…");
        expect(describeCallState(call({ state: "active" }))).toBe("Em ligação");
        expect(describeCallState(null)).toBe("Preparando…");
    });
});
