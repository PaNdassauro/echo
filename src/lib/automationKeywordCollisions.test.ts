import { describe, expect, it } from "vitest";
import { findKeywordCollisions, toKeywordTriggerRefs } from "./automationKeywordCollisions";
import { sanitizeTriggers } from "./automationTriggers";

const LINHA_A = "00000000-0000-4000-8000-000000000003";
const OUTRA_LINHA = "00000000-0000-4000-8000-000000000005";

const fluxoBContains = [{
    flowId: "fluxo-b",
    flowName: "Fluxo B 2",
    phoneNumberId: LINHA_A,
    keywords: ["Sim, já comprei"],
    matchType: "contains" as const,
}];

describe("findKeywordCollisions", () => {
    it("acusa o caso real: minha frase com ponto dentro do contains do outro fluxo", () => {
        const collisions = findKeywordCollisions(
            {
                flowId: "fluxo-a",
                phoneNumberId: LINHA_A,
                triggers: [{ type: "keyword", config: { keywords: ["Sim, já comprei."], match_type: "exact" } }],
            },
            fluxoBContains,
        );

        expect(collisions).toEqual([{
            flowName: "Fluxo B 2",
            keyword: "Sim, já comprei.",
            otherKeyword: "Sim, já comprei",
            kind: "substring",
        }]);
    });

    it("não acusa quando os dois lados são exatos e o texto difere", () => {
        const collisions = findKeywordCollisions(
            {
                flowId: "fluxo-a",
                phoneNumberId: LINHA_A,
                triggers: [{ type: "keyword", config: { keywords: ["Sim, já comprei."], match_type: "exact" } }],
            },
            [{ ...fluxoBContains[0], matchType: "exact" }],
        );

        expect(collisions).toEqual([]);
    });

    it("acusa frase idêntica mesmo com caixa e espaço diferentes", () => {
        const collisions = findKeywordCollisions(
            {
                flowId: "fluxo-a",
                phoneNumberId: LINHA_A,
                triggers: [{ type: "keyword", config: { keywords: ["  SIM,   já comprei "], match_type: "exact" } }],
            },
            [{ ...fluxoBContains[0], matchType: "exact" }],
        );

        expect(collisions).toHaveLength(1);
        expect(collisions[0].kind).toBe("equal");
    });

    it("acusa quando o meu gatilho é contains e engole a palavra do outro", () => {
        const collisions = findKeywordCollisions(
            {
                flowId: "fluxo-a",
                phoneNumberId: LINHA_A,
                triggers: [{ type: "keyword", config: { keywords: ["comprei"], match_type: "contains" } }],
            },
            [{ ...fluxoBContains[0], matchType: "exact" }],
        );

        expect(collisions).toHaveLength(1);
        expect(collisions[0].kind).toBe("substring");
    });

    it("ignora fluxo de outra linha", () => {
        const collisions = findKeywordCollisions(
            {
                flowId: "fluxo-a",
                phoneNumberId: OUTRA_LINHA,
                triggers: [{ type: "keyword", config: { keywords: ["Sim, já comprei."], match_type: "exact" } }],
            },
            fluxoBContains,
        );

        expect(collisions).toEqual([]);
    });

    it("alcança fluxo sem linha definida (todos os números)", () => {
        const collisions = findKeywordCollisions(
            {
                flowId: "fluxo-a",
                phoneNumberId: OUTRA_LINHA,
                triggers: [{ type: "keyword", config: { keywords: ["Sim, já comprei."], match_type: "exact" } }],
            },
            [{ ...fluxoBContains[0], phoneNumberId: null }],
        );

        expect(collisions).toHaveLength(1);
    });

    it("ignora o próprio fluxo e gatilhos que não são de palavra-chave", () => {
        const collisions = findKeywordCollisions(
            {
                flowId: "fluxo-b",
                phoneNumberId: LINHA_A,
                triggers: [
                    { type: "keyword", config: { keywords: ["Sim, já comprei"], match_type: "exact" } },
                    { type: "message_received", config: {} },
                ],
            },
            fluxoBContains,
        );

        expect(collisions).toEqual([]);
    });
});

describe("toKeywordTriggerRefs", () => {
    it("prefere automation_triggers ativos e descarta gatilho sem palavra", () => {
        const refs = toKeywordTriggerRefs([
            {
                id: "fluxo-a",
                name: "Fluxo A",
                phone_number_id: null,
                trigger_type: "keyword",
                trigger_config: { keywords: [], match_type: "contains" },
                automation_triggers: [
                    { trigger_type: "keyword", trigger_config: { keywords: [] }, is_active: true },
                ],
            },
            {
                id: "fluxo-b",
                name: "Fluxo B 2",
                phone_number_id: LINHA_A,
                trigger_type: "keyword",
                trigger_config: { keywords: ["ignorar"], match_type: "contains" },
                automation_triggers: [
                    { trigger_type: "keyword", trigger_config: { keywords: ["Sim, já comprei"], match_type: "contains" }, is_active: true },
                    { trigger_type: "message_received", trigger_config: {}, is_active: true },
                ],
            },
        ]);

        expect(refs).toEqual([{
            flowId: "fluxo-b",
            flowName: "Fluxo B 2",
            phoneNumberId: LINHA_A,
            keywords: ["Sim, já comprei"],
            matchType: "contains",
        }]);
    });

    it("cai no trigger_config legado quando não há automation_triggers", () => {
        const refs = toKeywordTriggerRefs([{
            id: "fluxo-legado",
            name: "Tarifário",
            phone_number_id: OUTRA_LINHA,
            trigger_type: "keyword",
            trigger_config: { keywords: ["tarifário"], match_type: "contains" },
            automation_triggers: [],
        }]);

        expect(refs).toHaveLength(1);
        expect(refs[0].keywords).toEqual(["tarifário"]);
    });
});

describe("sanitizeTriggers", () => {
    it("bloqueia gatilho de palavra-chave sem palavra", () => {
        const result = sanitizeTriggers([{ type: "keyword", config: { keywords: ["", "   "] } }]);

        expect(result.triggers).toEqual([]);
        expect(result.error).toContain("nunca dispararia");
    });

    it("limpa vazias, duplicadas e aplica o default exact", () => {
        const result = sanitizeTriggers([
            { type: "keyword", config: { keywords: [" Sim, já comprei. ", "", "sim,  JÁ comprei."] } },
        ]);

        expect(result.error).toBeNull();
        expect(result.triggers).toEqual([
            { type: "keyword", config: { keywords: ["Sim, já comprei."], match_type: "exact" } },
        ]);
    });

    it("preserva o match_type escolhido e zera config de gatilho sem palavra-chave", () => {
        const result = sanitizeTriggers([
            { type: "keyword", config: { keywords: ["tarifário"], match_type: "contains" } },
            { type: "message_sent", config: { keywords: ["ruído"] } },
        ]);

        expect(result.error).toBeNull();
        expect(result.triggers).toEqual([
            { type: "keyword", config: { keywords: ["tarifário"], match_type: "contains" } },
            { type: "message_sent", config: {} },
        ]);
    });

    it("recusa lista vazia ou tipo desconhecido", () => {
        expect(sanitizeTriggers([]).error).toBeTruthy();
        expect(sanitizeTriggers([{ type: "webhook", config: {} }]).error).toBeTruthy();
    });
});
