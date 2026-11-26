import { describe, expect, it } from "vitest";
import { providerDivergence, providerOptions } from "./lineProvider";

describe("providerOptions", () => {
    it("sem lista do serviço, oferece os conhecidos como registrados", () => {
        expect(providerOptions([])).toEqual([
            { name: "baileys", registered: true },
            { name: "zapo", registered: true },
        ]);
    });

    it("mantém a ordem do serviço e marca o conhecido ausente como não registrado", () => {
        expect(providerOptions(["baileys"])).toEqual([
            { name: "baileys", registered: true },
            { name: "zapo", registered: false },
        ]);
    });

    it("inclui provider desconhecido do front quando o serviço o registrou", () => {
        expect(providerOptions(["baileys", "zapo", "evolution"])).toEqual([
            { name: "baileys", registered: true },
            { name: "zapo", registered: true },
            { name: "evolution", registered: true },
        ]);
    });
});

describe("providerDivergence", () => {
    it("sem sessão viva não afirma nada", () => {
        expect(providerDivergence("zapo", undefined)).toEqual({ kind: "unknown" });
        expect(providerDivergence("zapo", null)).toEqual({ kind: "unknown" });
    });

    it("banco e sessão iguais", () => {
        expect(providerDivergence("zapo", "zapo")).toEqual({ kind: "same" });
    });

    it("banco já trocado mas sessão ainda na lib antiga", () => {
        expect(providerDivergence("zapo", "baileys")).toEqual({ kind: "pending", live: "baileys" });
    });
});
