import { line, plain, strTok, tok } from "../tokens";
import type { ResolvedRequest, SnippetLine } from "../types";
import { JS_DIALECT, tokenizeLiteral } from "../valueLiteral";

/** `--data` do cURL recebe JSON de verdade — e o dialeto JS já é JSON válido. */
export function buildCurlLines(request: ResolvedRequest): SnippetLine[] {
    const { method, url, headers, body, multipartOnly } = request;
    const lines: SnippetLine[] = [];
    const hasBody = body !== undefined;

    lines.push(line(tok("function", "curl"), plain(" "), tok("flag", "--request"), plain(" "), tok("keyword", method), plain(" \\")));
    lines.push(line(plain("  "), tok("flag", "--url"), plain(" "), tok("url", url), plain(headers.length || hasBody ? " \\" : "")));

    headers.forEach((header, idx) => {
        const isLast = idx === headers.length - 1 && !hasBody;
        lines.push(
            line(
                plain("  "),
                tok("flag", "--header"),
                plain(" "),
                strTok(`${header.name}: ${header.value}`, "'"),
                plain(isLast ? "" : " \\"),
            ),
        );
    });

    if (hasBody) {
        lines.push(
            ...tokenizeLiteral(body, JS_DIALECT, {
                baseIndent: "  ",
                prefix: [tok("flag", "--data"), plain(" "), tok("punctuation", "'")],
                suffix: [tok("punctuation", "'")],
            }),
        );
    }

    if (multipartOnly) {
        lines.push(line(plain("")));
        lines.push(line(tok("comment", "# Este endpoint recebe o arquivo por multipart/form-data:")));
        lines.push(line(tok("comment", "#   --form 'file=@caminho/do/arquivo'")));
    }

    return lines;
}
