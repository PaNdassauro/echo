import { plain, tok } from "./tokens";
import type { SnippetLine, Token } from "./types";

/**
 * Tokeniza os exemplos de resposta, que chegam como texto já escrito em
 * `apiDocsData.ts` (não são gerados por nós, ao contrário dos snippets).
 *
 * Contrato: NUNCA lança. Trecho que o scanner não reconhece vira texto sem cor.
 * Vários exemplos no data file não são JSON puro — começam com linhas de
 * comentário `//` ou trazem `...` no meio — e degradar é melhor que quebrar.
 */
export function highlightJson(source: string): SnippetLine[] {
    try {
        return source.split("\n").map((line) => ({ tokens: tokenizeLine(line) }));
    } catch {
        return source.split("\n").map((line) => ({ tokens: [plain(line)] }));
    }
}

const isDigit = (c: string) => c >= "0" && c <= "9";

function tokenizeLine(line: string): Token[] {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) {
        return [tok("comment", line)];
    }

    const tokens: Token[] = [];
    let buffer = "";

    const flush = () => {
        if (buffer) {
            tokens.push(plain(buffer));
            buffer = "";
        }
    };

    let i = 0;
    while (i < line.length) {
        const char = line[i];

        // String (com escapes). Vira `property` se o próximo não-branco for ':'.
        if (char === '"') {
            flush();
            let j = i + 1;
            let closed = false;
            while (j < line.length) {
                if (line[j] === "\\") {
                    j += 2;
                    continue;
                }
                if (line[j] === '"') {
                    closed = true;
                    break;
                }
                j++;
            }
            if (!closed) {
                // Aspas sem par: não é JSON válido, devolve como texto e sai.
                buffer += line.slice(i);
                break;
            }
            const text = line.slice(i, j + 1);
            const rest = line.slice(j + 1).trimStart();
            tokens.push(tok(rest.startsWith(":") ? "property" : "string", text));
            i = j + 1;
            continue;
        }

        if (isDigit(char) || (char === "-" && isDigit(line[i + 1] ?? ""))) {
            flush();
            let j = i + 1;
            while (j < line.length && /[0-9.eE+-]/.test(line[j])) j++;
            tokens.push(tok("number", line.slice(i, j)));
            i = j;
            continue;
        }

        const word = line.slice(i);
        if (word.startsWith("true") || word.startsWith("false")) {
            flush();
            const literal = word.startsWith("true") ? "true" : "false";
            tokens.push(tok("boolean", literal));
            i += literal.length;
            continue;
        }
        if (word.startsWith("null")) {
            flush();
            tokens.push(tok("null", "null"));
            i += 4;
            continue;
        }

        if ("{}[]:,".includes(char)) {
            flush();
            tokens.push(tok("punctuation", char));
            i++;
            continue;
        }

        buffer += char;
        i++;
    }

    flush();
    return tokens;
}
