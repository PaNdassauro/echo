import { describe, expect, it } from "vitest";
import {
    matchesSectorFilter,
    NO_SECTOR_FILTER_ID,
    resolveAssumeSector,
    sectorsForPhone,
    type Sector,
} from "./sectors";

const ORG = "00000000-0000-0000-0000-000000000000";
const LINHA_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LINHA_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const sector = (overrides: Partial<Sector> & { id: string }): Sector => ({
    name: `Setor ${overrides.id}`,
    color: null,
    organization_id: ORG,
    phone_number_id: LINHA_A,
    ...overrides,
});

const VENDAS = sector({ id: "vendas" });
const SUPORTE = sector({ id: "suporte" });
const OUTRA_LINHA = sector({ id: "financeiro", phone_number_id: LINHA_B });
const LEGADO = sector({ id: "legado", phone_number_id: null });

describe("sectorsForPhone", () => {
    it("mantém os setores da linha e os legados, descarta os de outra linha", () => {
        const result = sectorsForPhone([VENDAS, OUTRA_LINHA, LEGADO], LINHA_A);
        expect(result.map((s) => s.id)).toEqual(["vendas", "legado"]);
    });

    it("sem linha selecionada, só os legados passam", () => {
        expect(sectorsForPhone([VENDAS, LEGADO], null).map((s) => s.id)).toEqual(["legado"]);
    });
});

describe("matchesSectorFilter", () => {
    it("seleção vazia não filtra nada", () => {
        expect(matchesSectorFilter("vendas", [])).toBe(true);
        expect(matchesSectorFilter(null, [])).toBe(true);
    });

    it("a sentinela casa só a triagem", () => {
        expect(matchesSectorFilter(null, [NO_SECTOR_FILTER_ID])).toBe(true);
        expect(matchesSectorFilter("vendas", [NO_SECTOR_FILTER_ID])).toBe(false);
    });

    it("setor selecionado casa a conversa dele, e triagem fica fora", () => {
        expect(matchesSectorFilter("vendas", ["vendas"])).toBe(true);
        expect(matchesSectorFilter("suporte", ["vendas"])).toBe(false);
        expect(matchesSectorFilter(null, ["vendas"])).toBe(false);
    });

    it("triagem e setor juntos casam os dois", () => {
        const selected = [NO_SECTOR_FILTER_ID, "vendas"];
        expect(matchesSectorFilter(null, selected)).toBe(true);
        expect(matchesSectorFilter("vendas", selected)).toBe(true);
        expect(matchesSectorFilter("suporte", selected)).toBe(false);
    });

    it("undefined (conversa carregada antes da coluna existir) conta como triagem", () => {
        expect(matchesSectorFilter(undefined, [NO_SECTOR_FILTER_ID])).toBe(true);
        expect(matchesSectorFilter(undefined, ["vendas"])).toBe(false);
    });
});

describe("resolveAssumeSector", () => {
    it("um único setor meu na linha: usa sem perguntar", () => {
        expect(
            resolveAssumeSector({
                sectors: [VENDAS, SUPORTE],
                phoneNumberId: LINHA_A,
                mySectorIds: ["vendas"],
                defaultSectorId: null,
            }),
        ).toEqual({ sectorId: "vendas", needsChoice: false, options: [] });
    });

    it("vários setores meus: usa o padrão quando ele está entre eles", () => {
        expect(
            resolveAssumeSector({
                sectors: [VENDAS, SUPORTE],
                phoneNumberId: LINHA_A,
                mySectorIds: ["vendas", "suporte"],
                defaultSectorId: "suporte",
            }),
        ).toEqual({ sectorId: "suporte", needsChoice: false, options: [] });
    });

    it("vários setores meus e padrão de OUTRA linha: pergunta", () => {
        const result = resolveAssumeSector({
            sectors: [VENDAS, SUPORTE, OUTRA_LINHA],
            phoneNumberId: LINHA_A,
            mySectorIds: ["vendas", "suporte", "financeiro"],
            defaultSectorId: "financeiro",
        });
        expect(result.needsChoice).toBe(true);
        expect(result.sectorId).toBeNull();
        expect(result.options.map((s) => s.id)).toEqual(["vendas", "suporte"]);
    });

    it("vários setores meus e nenhum padrão: pergunta", () => {
        const result = resolveAssumeSector({
            sectors: [VENDAS, SUPORTE],
            phoneNumberId: LINHA_A,
            mySectorIds: ["vendas", "suporte"],
            defaultSectorId: null,
        });
        expect(result.needsChoice).toBe(true);
        expect(result.options.map((s) => s.id)).toEqual(["vendas", "suporte"]);
    });

    it("nenhum setor meu na linha (o caso do admin): assume sem setor, fica na triagem", () => {
        expect(
            resolveAssumeSector({
                sectors: [VENDAS, SUPORTE],
                phoneNumberId: LINHA_A,
                mySectorIds: [],
                defaultSectorId: "vendas",
            }),
        ).toEqual({ sectorId: null, needsChoice: false, options: [] });
    });

    it("padrão que não é vínculo não vale: só sector_members conta", () => {
        // defaultSectorId aponta para um setor de que o usuário NÃO é membro:
        // organization_members.sector_id sobrevive à remoção do vínculo.
        expect(
            resolveAssumeSector({
                sectors: [VENDAS, SUPORTE],
                phoneNumberId: LINHA_A,
                mySectorIds: ["vendas"],
                defaultSectorId: "suporte",
            }),
        ).toEqual({ sectorId: "vendas", needsChoice: false, options: [] });
    });
});
