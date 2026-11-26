import { line, plain, strTok, tok } from "../tokens";
import type { ResolvedRequest, SnippetLine } from "../types";
import { PYTHON_DIALECT, tokenizeLiteral } from "../valueLiteral";

const METHOD_FUNCTIONS: Record<string, string> = {
    GET: "get",
    POST: "post",
    PUT: "put",
    PATCH: "patch",
    DELETE: "delete",
};

export function buildPythonLines(request: ResolvedRequest): SnippetLine[] {
    const { method, url, headers, body, multipartOnly } = request;
    const lines: SnippetLine[] = [];
    const hasBody = body !== undefined;
    const fn = METHOD_FUNCTIONS[method] ?? "request";

    lines.push(line(tok("keyword", "import"), plain(" "), tok("variable", "requests")));
    lines.push(line(plain("")));

    lines.push(line(tok("variable", "response"), plain(" "), tok("operator", "="), plain(" "), tok("variable", "requests"), tok("punctuation", "."), tok("function", fn), tok("punctuation", "(")));
    lines.push(line(plain("    "), strTok(url), tok("punctuation", ",")));

    lines.push(line(plain("    "), tok("property", "headers"), tok("operator", "="), tok("punctuation", "{")));
    headers.forEach((header, idx) => {
        const isLast = idx === headers.length - 1;
        lines.push(
            line(
                plain("        "),
                strTok(header.name),
                tok("punctuation", ": "),
                strTok(header.value),
                tok("punctuation", isLast ? "" : ","),
            ),
        );
    });
    lines.push(line(plain("    "), tok("punctuation", "}"), tok("punctuation", hasBody ? "," : "")));

    if (hasBody) {
        lines.push(
            ...tokenizeLiteral(body, PYTHON_DIALECT, {
                baseIndent: "    ",
                prefix: [tok("property", "json"), tok("operator", "=")],
            }),
        );
    }

    lines.push(line(tok("punctuation", ")")));
    lines.push(line(plain("")));
    lines.push(line(tok("function", "print"), tok("punctuation", "("), tok("variable", "response"), tok("punctuation", "."), tok("function", "json"), tok("punctuation", "())")));

    if (multipartOnly) {
        lines.push(line(plain("")));
        lines.push(line(tok("comment", "# Este endpoint recebe o arquivo por multipart/form-data:")));
        lines.push(line(tok("comment", "#   files={'file': open('caminho/do/arquivo', 'rb')}")));
        lines.push(line(tok("comment", "#   e remova o header Content-Type.")));
    }

    return lines;
}
