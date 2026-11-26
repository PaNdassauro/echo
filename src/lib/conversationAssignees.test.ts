import { describe, expect, it } from "vitest";
import { buildAssigneeOptions, initialsFor } from "./conversationAssignees";
import type { Conversation } from "@/types/conversation";

const conv = (overrides: Partial<Conversation>): Conversation => ({
    id: "conv-1",
    contact_name: "Contato",
    contact_phone: "5511999990001",
    last_message_at: "2026-08-18T12:00:00Z",
    status: "open",
    assigned_to: null,
    ...overrides,
});

const ANA = "11111111-1111-1111-1111-111111111111";
const BRUNO = "22222222-2222-2222-2222-222222222222";
const AGATA = "33333333-3333-3333-3333-333333333333";

describe("buildAssigneeOptions", () => {
    it("lista dono primário e co-responsável, sem duplicar", () => {
        const options = buildAssigneeOptions(
            [
                conv({ id: "a", assigned_to: ANA, co_assignee_ids: [BRUNO] }),
                conv({ id: "b", assigned_to: BRUNO, co_assignee_ids: [ANA] }),
            ],
            new Map([
                [ANA, "Ana Souza"],
                [BRUNO, "Bruno Lima"],
            ]),
        );
        expect(options.map((o) => o.id)).toEqual([ANA, BRUNO]);
    });

    it("ignora conversa sem responsável", () => {
        expect(buildAssigneeOptions([conv({ assigned_to: null })], new Map())).toEqual([]);
    });

    it("entrada vazia devolve lista vazia", () => {
        expect(buildAssigneeOptions([], new Map([[ANA, "Ana"]]))).toEqual([]);
    });

    it("prefere o mapa de membros ao profiles embutido na linha", () => {
        const [option] = buildAssigneeOptions(
            [conv({ assigned_to: ANA, profiles: { first_name: "A.", last_name: null, email: null } })],
            new Map([[ANA, "Ana Souza"]]),
        );
        expect(option.label).toBe("Ana Souza");
    });

    it("cai no profiles da linha quando o mapa não tem o id", () => {
        const [option] = buildAssigneeOptions(
            [
                conv({
                    assigned_to: ANA,
                    profiles: { first_name: "Ana", last_name: "Souza", email: "ana@x.com" },
                }),
            ],
            new Map(),
        );
        expect(option.label).toBe("Ana Souza");
    });

    it("cai no prefixo do email quando não há nome", () => {
        const [option] = buildAssigneeOptions(
            [conv({ assigned_to: ANA, profiles: { first_name: null, last_name: null, email: "ana@x.com" } })],
            new Map(),
        );
        expect(option.label).toBe("ana");
    });

    it("co-responsável fora do mapa vira 'Usuário' (perfil não é embutível pelo FK)", () => {
        const [option] = buildAssigneeOptions([conv({ co_assignee_ids: [BRUNO] })], new Map());
        expect(option).toEqual({ id: BRUNO, label: "Usuário", initials: "U" });
    });

    it("nome achado numa linha não regride para 'Usuário' por causa de outra", () => {
        const options = buildAssigneeOptions(
            [
                conv({
                    id: "a",
                    assigned_to: ANA,
                    profiles: { first_name: "Ana", last_name: "Souza", email: null },
                }),
                conv({ id: "b", co_assignee_ids: [ANA] }),
            ],
            new Map(),
        );
        expect(options.map((o) => o.label)).toEqual(["Ana Souza"]);
    });

    it("ordena alfabeticamente respeitando acento", () => {
        const options = buildAssigneeOptions(
            [conv({ id: "a", assigned_to: BRUNO }), conv({ id: "b", assigned_to: AGATA })],
            new Map([
                [BRUNO, "Bruno Lima"],
                [AGATA, "Ágata Costa"],
            ]),
        );
        expect(options.map((o) => o.label)).toEqual(["Ágata Costa", "Bruno Lima"]);
    });

    it("iniciais usam no máximo duas palavras", () => {
        const options = buildAssigneeOptions(
            [conv({ assigned_to: ANA })],
            new Map([[ANA, "ana maria souza"]]),
        );
        expect(options[0].initials).toBe("AM");
    });
});

describe("initialsFor", () => {
    it("nome simples", () => expect(initialsFor("Bruno")).toBe("B"));
    it("string vazia", () => expect(initialsFor("")).toBe("?"));
    it("ignora o separador do nome", () =>
        expect(initialsFor("Bruno - Acme Suporte")).toBe("BA"));
    it("só separadores cai no ?", () => expect(initialsFor("- -")).toBe("?"));
    it("acento vira inicial", () => expect(initialsFor("Ágata Costa")).toBe("ÁC"));
});
