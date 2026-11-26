import type { SnippetLine, Token, TokenType } from "./types";

/** Cria um token. Atalho para deixar os geradores legíveis. */
export const tok = (type: TokenType, text: string): Token => ({ type, text });

export const plain = (text: string): Token => tok("plain", text);

export const line = (...tokens: Token[]): SnippetLine => ({ tokens });

export const lineToText = (l: SnippetLine): string => l.tokens.map((t) => t.text).join("");

export const linesToText = (lines: SnippetLine[]): string => lines.map(lineToText).join("\n");

/**
 * Escapa um valor para virar conteúdo de string literal.
 *
 * Newline vira `\n` literal, nunca quebra de linha real: uma linha visual é
 * sempre um SnippetLine, e um `\n` cru dentro de um token desalinharia a
 * numeração do bloco.
 */
export const escapeForQuote = (value: string, quote: '"' | "'"): string =>
    value
        .replace(/\\/g, "\\\\")
        .replace(new RegExp(quote, "g"), `\\${quote}`)
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");

/** Token de string já com as aspas incluídas e o conteúdo escapado. */
export const strTok = (value: string, quote: '"' | "'" = '"'): Token =>
    tok("string", `${quote}${escapeForQuote(value, quote)}${quote}`);
