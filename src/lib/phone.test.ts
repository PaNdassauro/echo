import { describe, expect, it } from "vitest";
import { formatParticipantPhone, getLookupVariations } from "./phone";

describe("formatParticipantPhone", () => {
    it("formata BR de 13 dígitos (com o 9)", () => {
        expect(formatParticipantPhone("5511999990001")).toBe("+55 11 99999-0001");
    });

    it("formata BR de 12 dígitos (sem o 9)", () => {
        expect(formatParticipantPhone("551199990001")).toBe("+55 11 9999-0001");
    });

    it("aceita entrada já formatada (tira máscara antes)", () => {
        expect(formatParticipantPhone("+55 (11) 99999-0001")).toBe("+55 11 99999-0001");
    });

    it("números fora da faixa BR ganham só o +", () => {
        expect(formatParticipantPhone("1199990001")).toBe("+1199990001");
    });

    it("string vazia não vira '+'", () => {
        expect(formatParticipantPhone("")).toBe("");
        expect(formatParticipantPhone("abc")).toBe("");
    });

    describe("LID (o WhatsApp não expôs o telefone)", () => {
        it("abrevia como ID em vez de fingir telefone", () => {
            // A cópia antiga do MessageBubble não conhecia isLid e renderizava
            // este mesmo valor como "+260200000001001".
            expect(formatParticipantPhone("260200000001001", true)).toBe("ID: 2602...1001");
        });

        it("LID curto sai inteiro", () => {
            expect(formatParticipantPhone("1234567890", true)).toBe("ID: 1234567890");
        });
    });
});

describe("getLookupVariations", () => {
    it("BR de 13 dígitos gera as 4 formas equivalentes", () => {
        expect(getLookupVariations("5511999990001").sort()).toEqual(
            ["5511999990001", "551199990001", "11999990001", "1199990001"].sort(),
        );
    });

    it("BR de 12 dígitos gera as mesmas 4 formas", () => {
        expect(getLookupVariations("551199990001").sort()).toEqual(
            ["551199990001", "5511999990001", "1199990001", "11999990001"].sort(),
        );
    });

    it("não expande número internacional — a guarda contra corromper DDI", () => {
        // 11 dígitos que NÃO começam com 55 é internacional com DDI (+1 202…).
        // Expandir inventaria o brasileiro plausível 5512925550123 — a corrupção
        // que a normalização atual evita.
        expect(getLookupVariations("12025550123")).toEqual(["12025550123"]);
        expect(getLookupVariations("34612345678")).toEqual(["34612345678"]);
    });

    it("nunca prefixa 55", () => {
        for (const variation of getLookupVariations("12025550123")) {
            expect(variation.startsWith("55")).toBe(false);
        }
    });

    it("13 dígitos com 55 mas sem 9 no local não é tratado como celular", () => {
        // 55 + DDD + 8 dígitos que não começam com 9: só a forma exata.
        expect(getLookupVariations("5541899990001")).toEqual(["5541899990001"]);
    });

    it("os dígitos exatos são sempre a primeira variação", () => {
        expect(getLookupVariations("5511999990001")[0]).toBe("5511999990001");
    });
});
