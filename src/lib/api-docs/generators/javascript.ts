import { line, plain, strTok, tok } from "../tokens";
import type { ResolvedRequest, SnippetLine } from "../types";
import { JS_DIALECT, tokenizeLiteral } from "../valueLiteral";

export function buildJavaScriptLines(request: ResolvedRequest): SnippetLine[] {
    const { method, url, headers, body, multipartOnly } = request;
    const lines: SnippetLine[] = [];
    const hasBody = body !== undefined;

    lines.push(line(tok("keyword", "const"), plain(" "), tok("variable", "response"), plain(" "), tok("operator", "="), plain(" "), tok("keyword", "await"), plain(" "), tok("function", "fetch"), tok("punctuation", "(")));
    lines.push(line(plain("  "), strTok(url), tok("punctuation", ",")));
    lines.push(line(plain("  "), tok("punctuation", "{")));
    lines.push(line(plain("    "), tok("property", "method"), tok("punctuation", ": "), strTok(method), tok("punctuation", ",")));

    lines.push(line(plain("    "), tok("property", "headers"), tok("punctuation", ": {")));
    headers.forEach((header, idx) => {
        const isLast = idx === headers.length - 1;
        lines.push(
            line(
                plain("      "),
                strTok(header.name),
                tok("punctuation", ": "),
                strTok(header.value),
                tok("punctuation", isLast ? "" : ","),
            ),
        );
    });
    lines.push(line(plain("    "), tok("punctuation", "}"), tok("punctuation", hasBody ? "," : "")));

    if (hasBody) {
        const bodyLines = tokenizeLiteral(body, JS_DIALECT, {
            baseIndent: "    ",
            prefix: [
                tok("property", "body"),
                tok("punctuation", ": "),
                tok("variable", "JSON"),
                tok("punctuation", "."),
                tok("function", "stringify"),
                tok("punctuation", "("),
            ],
            suffix: [tok("punctuation", ")")],
        });
        lines.push(...bodyLines);
    }

    lines.push(line(plain("  "), tok("punctuation", "}")));
    lines.push(line(tok("punctuation", ");")));
    lines.push(line(plain("")));
    lines.push(line(tok("keyword", "const"), plain(" "), tok("variable", "data"), plain(" "), tok("operator", "="), plain(" "), tok("keyword", "await"), plain(" "), tok("variable", "response"), tok("punctuation", "."), tok("function", "json"), tok("punctuation", "();")));

    if (multipartOnly) {
        lines.push(line(plain("")));
        lines.push(line(tok("comment", "// Este endpoint recebe o arquivo por multipart/form-data:")));
        lines.push(line(tok("comment", "//   const form = new FormData(); form.append('file', file);")));
        lines.push(line(tok("comment", "//   passe `body: form` e não defina Content-Type.")));
    }

    return lines;
}
