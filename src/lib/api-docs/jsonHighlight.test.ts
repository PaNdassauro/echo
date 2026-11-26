import { describe, expect, it } from "vitest";
import { highlightJson } from "./jsonHighlight";
import { linesToText } from "./tokens";

/** O highlight nunca pode alterar o texto — só anotá-lo. */
const roundTrips = (src: string) => expect(linesToText(highlightJson(src))).toBe(src);

describe("highlightJson", () => {
    it("preserva o texto original exatamente", () => {
        roundTrips('{\n  "a": 1,\n  "b": [true, null]\n}');
    });

    it("distingue chave de valor string", () => {
        const [line] = highlightJson('  "name": "João"');
        const types = line.tokens.filter((t) => t.type !== "plain").map((t) => t.type);
        expect(types).toEqual(["property", "punctuation", "string"]);
    });

    it("reconhece números negativos e decimais", () => {
        const [line] = highlightJson('{"status": -1, "v": 1.5}');
        const numbers = line.tokens.filter((t) => t.type === "number").map((t) => t.text);
        expect(numbers).toEqual(["-1", "1.5"]);
    });

    it("trata linha de comentário // como comentário inteiro", () => {
        // Vários exemplos do data file abrem com um bloco de comentário.
        const lines = highlightJson('// Envio via JSON:\n{ "ok": true }');
        expect(lines[0].tokens).toHaveLength(1);
        expect(lines[0].tokens[0].type).toBe("comment");
        expect(lines[1].tokens.some((t) => t.type === "boolean")).toBe(true);
    });

    it("não quebra com aspas escapadas dentro da string", () => {
        const src = '{ "text": "ele disse \\"oi\\"" }';
        roundTrips(src);
        const [line] = highlightJson(src);
        expect(line.tokens.filter((t) => t.type === "string")).toHaveLength(1);
    });

    it("degrada para texto quando não é JSON válido", () => {
        const src = '{ "components": [...] }';
        roundTrips(src);
    });

    it("aspas sem par não lançam", () => {
        const src = '{ "quebrado: 1 }';
        expect(() => highlightJson(src)).not.toThrow();
        roundTrips(src);
    });

    it("sobrevive a string vazia", () => {
        expect(highlightJson("")).toEqual([{ tokens: [] }]);
    });
});
