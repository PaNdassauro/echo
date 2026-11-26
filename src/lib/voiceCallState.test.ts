import { describe, expect, it } from "vitest";
import type { CallUpdate } from "@/lib/voiceCall";
import { deriveCallState } from "./voiceCallState";

function call(overrides: Partial<CallUpdate> = {}): CallUpdate {
    return {
        callId: "CALL-1",
        peerJid: "5511999999999@s.whatsapp.net",
        direction: "incoming",
        isVideo: false,
        state: "incoming_ringing",
        startedAt: 1_700_000_000_000,
        muted: false,
        ...overrides,
    };
}

describe("deriveCallState", () => {
    it("linha livre quando não há ligação", () => {
        const state = deriveCallState([], null);
        expect(state).toEqual({ busy: false, busyByOther: false, myCall: null, incoming: [] });
    });

    it("entrante tocando NÃO ocupa a linha — senão ninguém poderia atender", () => {
        const state = deriveCallState([call()], null);
        expect(state.busy).toBe(false);
        expect(state.busyByOther).toBe(false);
        expect(state.incoming).toHaveLength(1);
    });

    it("ligação ativa de outro atendente ocupa e não vira aviso", () => {
        const state = deriveCallState([call({ state: "active" })], null);
        expect(state.busy).toBe(true);
        expect(state.busyByOther).toBe(true);
        expect(state.myCall).toBeNull();
        expect(state.incoming).toEqual([]);
    });

    it("minha ligação ocupa a linha, mas não é 'ocupada por outro'", () => {
        const state = deriveCallState([call({ state: "active" })], "CALL-1");
        expect(state.busy).toBe(true);
        expect(state.busyByOther).toBe(false);
        expect(state.myCall?.callId).toBe("CALL-1");
    });

    it("discagem de saída de outro atendente ocupa a linha", () => {
        for (const state of ["initiating", "ringing", "connecting", "on_hold"] as const) {
            const derived = deriveCallState([call({ direction: "outgoing", state })], null);
            expect(derived.busyByOther, `estado ${state}`).toBe(true);
        }
    });

    it("entrante que eu já assumi sai da lista de avisos e vira myCall", () => {
        const state = deriveCallState([call()], "CALL-1");
        expect(state.incoming).toEqual([]);
        expect(state.myCall?.callId).toBe("CALL-1");
    });

    it("ligação encerrada não ocupa nem aparece", () => {
        const state = deriveCallState([call({ state: "ended", endReason: "user_ended" })], "CALL-1");
        expect(state.busy).toBe(false);
        expect(state.myCall).toBeNull();
        expect(state.incoming).toEqual([]);
    });

    it("entrante durante ligação minha: ocupa por mim e não vira aviso novo", () => {
        const state = deriveCallState(
            [call({ callId: "MINHA", state: "active" }), call({ callId: "NOVA" })],
            "MINHA",
        );
        expect(state.busy).toBe(true);
        expect(state.busyByOther).toBe(false);
        // a nova continua listada; quem decide escondê-la é a regra de exibição,
        // que suprime aviso enquanto existe myCall
        expect(state.incoming.map((c) => c.callId)).toEqual(["NOVA"]);
    });

    it("preserva a ordem de chegada das entrantes", () => {
        const state = deriveCallState([call({ callId: "A" }), call({ callId: "B" }), call({ callId: "C" })], null);
        expect(state.incoming.map((c) => c.callId)).toEqual(["A", "B", "C"]);
    });
});
