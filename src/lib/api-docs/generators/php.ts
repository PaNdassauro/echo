import { line, plain, strTok, tok } from "../tokens";
import type { ResolvedRequest, SnippetLine } from "../types";
import { PHP_DIALECT, tokenizeLiteral } from "../valueLiteral";

/**
 * cURL nativo em vez de Guzzle: não assume dependência instalada, e é a forma
 * que a maioria dos devs PHP espera encontrar num "exemplo em PHP" de doc.
 */
export function buildPhpLines(request: ResolvedRequest): SnippetLine[] {
    const { method, url, headers, body, multipartOnly } = request;
    const lines: SnippetLine[] = [];
    const hasBody = body !== undefined;

    lines.push(line(tok("punctuation", "<?php")));
    lines.push(line(plain("")));

    if (hasBody) {
        lines.push(
            ...tokenizeLiteral(body, PHP_DIALECT, {
                prefix: [tok("variable", "$body"), plain(" "), tok("operator", "="), plain(" ")],
                suffix: [tok("punctuation", ";")],
            }),
        );
        lines.push(line(plain("")));
    }

    lines.push(line(tok("variable", "$ch"), plain(" "), tok("operator", "="), plain(" "), tok("function", "curl_init"), tok("punctuation", "("), strTok(url, "'"), tok("punctuation", ");")));
    lines.push(line(tok("function", "curl_setopt_array"), tok("punctuation", "("), tok("variable", "$ch"), tok("punctuation", ", [")));
    lines.push(line(plain("    "), tok("keyword", "CURLOPT_RETURNTRANSFER"), tok("punctuation", " => "), tok("boolean", "true"), tok("punctuation", ",")));
    lines.push(line(plain("    "), tok("keyword", "CURLOPT_CUSTOMREQUEST"), tok("punctuation", " => "), strTok(method, "'"), tok("punctuation", ",")));

    lines.push(line(plain("    "), tok("keyword", "CURLOPT_HTTPHEADER"), tok("punctuation", " => [")));
    headers.forEach((header, idx) => {
        const isLast = idx === headers.length - 1;
        lines.push(
            line(
                plain("        "),
                strTok(`${header.name}: ${header.value}`, "'"),
                tok("punctuation", isLast ? "" : ","),
            ),
        );
    });
    lines.push(line(plain("    "), tok("punctuation", "],")));

    if (hasBody) {
        lines.push(
            line(
                plain("    "),
                tok("keyword", "CURLOPT_POSTFIELDS"),
                tok("punctuation", " => "),
                tok("function", "json_encode"),
                tok("punctuation", "("),
                tok("variable", "$body"),
                tok("punctuation", "),"),
            ),
        );
    }

    lines.push(line(tok("punctuation", "]);")));
    lines.push(line(plain("")));
    lines.push(line(tok("variable", "$response"), plain(" "), tok("operator", "="), plain(" "), tok("function", "curl_exec"), tok("punctuation", "("), tok("variable", "$ch"), tok("punctuation", ");")));
    lines.push(line(tok("function", "curl_close"), tok("punctuation", "("), tok("variable", "$ch"), tok("punctuation", ");")));
    lines.push(line(tok("function", "print_r"), tok("punctuation", "("), tok("function", "json_decode"), tok("punctuation", "("), tok("variable", "$response"), tok("punctuation", ", "), tok("boolean", "true"), tok("punctuation", "));")));

    if (multipartOnly) {
        lines.push(line(plain("")));
        lines.push(line(tok("comment", "// Este endpoint recebe o arquivo por multipart/form-data:")));
        lines.push(line(tok("comment", "//   CURLOPT_POSTFIELDS => ['file' => new CURLFile('/caminho')]")));
        lines.push(line(tok("comment", "//   e remova o header Content-Type.")));
    }

    return lines;
}
