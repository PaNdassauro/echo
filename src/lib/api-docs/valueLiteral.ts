import { escapeForQuote, plain, tok } from "./tokens";
import type { BodyValue, SnippetLine, Token } from "./types";

/**
 * Como cada linguagem escreve um literal de objeto/array. Um só percurso
 * recursivo serve as três, em vez de reformatar uma string JSON pronta com
 * regex (frágil) ou duplicar a lógica por gerador.
 */
export interface LiteralDialect {
    quote: '"' | "'";
    nullKeyword: string;
    trueKeyword: string;
    falseKeyword: string;
    /** Abre/fecha objeto. PHP usa array associativo. */
    objectOpen: string;
    objectClose: string;
    arrayOpen: string;
    arrayClose: string;
    /** Separador entre chave e valor. */
    keyValue: string;
    /** Chaves entre aspas ou identificador nu quando possível. */
    quoteKeys: boolean;
    indentUnit: string;
}

export const JS_DIALECT: LiteralDialect = {
    quote: '"',
    nullKeyword: "null",
    trueKeyword: "true",
    falseKeyword: "false",
    objectOpen: "{",
    objectClose: "}",
    arrayOpen: "[",
    arrayClose: "]",
    keyValue: ": ",
    quoteKeys: true,
    indentUnit: "  ",
};

export const PYTHON_DIALECT: LiteralDialect = {
    quote: '"',
    nullKeyword: "None",
    trueKeyword: "True",
    falseKeyword: "False",
    objectOpen: "{",
    objectClose: "}",
    arrayOpen: "[",
    arrayClose: "]",
    keyValue: ": ",
    quoteKeys: true,
    indentUnit: "    ",
};

export const PHP_DIALECT: LiteralDialect = {
    quote: "'",
    nullKeyword: "null",
    trueKeyword: "true",
    falseKeyword: "false",
    objectOpen: "[",
    objectClose: "]",
    arrayOpen: "[",
    arrayClose: "]",
    keyValue: " => ",
    quoteKeys: true,
    indentUnit: "    ",
};

const scalarToken = (value: string | number | boolean | null, d: LiteralDialect): Token => {
    if (value === null) return tok("null", d.nullKeyword);
    if (typeof value === "boolean") return tok("boolean", value ? d.trueKeyword : d.falseKeyword);
    if (typeof value === "number") return tok("number", String(value));
    return tok("string", `${d.quote}${escapeForQuote(value, d.quote)}${d.quote}`);
};

const isScalar = (v: BodyValue): v is string | number | boolean | null =>
    v === null || typeof v !== "object";

/**
 * Serializa um `BodyValue` em linhas tokenizadas no dialeto pedido.
 *
 * `prefix` são os tokens que abrem a primeira linha (ex. `const body = `), e
 * `suffix` o que fecha a última (ex. `;`). Toda linha produzida já vem com o
 * recuo aplicado, então o chamador só concatena.
 */
export function tokenizeLiteral(
    value: BodyValue,
    dialect: LiteralDialect,
    options: { baseIndent?: string; prefix?: Token[]; suffix?: Token[] } = {},
): SnippetLine[] {
    const { baseIndent = "", prefix = [], suffix = [] } = options;
    const lines: SnippetLine[] = [];

    const walk = (val: BodyValue, indent: string, head: Token[], tail: Token[]): void => {
        if (isScalar(val)) {
            lines.push({ tokens: [plain(indent), ...head, scalarToken(val, dialect), ...tail] });
            return;
        }

        const isArray = Array.isArray(val);
        const open = isArray ? dialect.arrayOpen : dialect.objectOpen;
        const close = isArray ? dialect.arrayClose : dialect.objectClose;
        const entries: [string | null, BodyValue][] = isArray
            ? val.map((v) => [null, v] as [null, BodyValue])
            : Object.entries(val);

        if (entries.length === 0) {
            lines.push({
                tokens: [plain(indent), ...head, tok("punctuation", open + close), ...tail],
            });
            return;
        }

        lines.push({ tokens: [plain(indent), ...head, tok("punctuation", open)] });

        const inner = indent + dialect.indentUnit;
        entries.forEach(([key, child], idx) => {
            const isLast = idx === entries.length - 1;
            const childTail: Token[] = isLast ? [] : [tok("punctuation", ",")];
            const childHead: Token[] =
                key === null
                    ? []
                    : [
                          tok(
                              "property",
                              dialect.quoteKeys
                                  ? `${dialect.quote}${escapeForQuote(key, dialect.quote)}${dialect.quote}`
                                  : key,
                          ),
                          tok("punctuation", dialect.keyValue),
                      ];
            walk(child, inner, childHead, childTail);
        });

        lines.push({ tokens: [plain(indent), tok("punctuation", close), ...tail] });
    };

    walk(value, baseIndent, prefix, suffix);
    return lines;
}
