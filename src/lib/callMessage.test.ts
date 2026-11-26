import { describe, expect, it } from "vitest";
import { buildCallText, formatCallDuration } from "./callMessage";

const meta = (call: Record<string, unknown>) => ({ metadata: { call }, content: "ignorado" });

describe("formatCallDuration", () => {
    it("abaixo de um minuto usa segundos", () => {
        expect(formatCallDuration(9)).toBe("9s");
        expect(formatCallDuration(59)).toBe("59s");
    });

    it("a partir de um minuto usa m:ss", () => {
        expect(formatCallDuration(60)).toBe("1:00");
        expect(formatCallDuration(83)).toBe("1:23");
        expect(formatCallDuration(600)).toBe("10:00");
    });
});

describe("buildCallText", () => {
    it("atendida mostra a duração", () => {
        expect(buildCallText(meta({ connected: true, duration_secs: 38, direction: "incoming" }))).toBe("Chamada de voz · 38s");
    });

    it("atendida sem duração não inventa número", () => {
        expect(buildCallText(meta({ connected: true, duration_secs: 0, direction: "outgoing" }))).toBe("Chamada de voz");
    });

    it("saída não atendida e entrada perdida são textos diferentes", () => {
        expect(buildCallText(meta({ connected: false, direction: "outgoing" }))).toBe("Chamada não atendida");
        expect(buildCallText(meta({ connected: false, direction: "incoming" }))).toBe("Chamada perdida");
    });

    it("sem metadata cai no content gravado pelo serviço", () => {
        expect(buildCallText({ content: "Chamada de voz · 12s", metadata: null })).toBe("Chamada de voz · 12s");
    });

    it("sem metadata e sem content ainda diz alguma coisa", () => {
        expect(buildCallText({ content: "   ", metadata: undefined })).toBe("Chamada de voz");
    });

    it("metadata de outro tipo de mensagem não é confundido com ligação", () => {
        expect(buildCallText({ content: "Chamada de voz · 5s", metadata: { groupAction: { action: "add" } } }))
            .toBe("Chamada de voz · 5s");
    });
});
