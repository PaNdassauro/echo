/**
 * Tipos da geração de snippets da página /api-docs.
 *
 * A ideia central: os geradores emitem TOKENS na hora de montar a linha, em vez
 * de devolver uma string que depois alguém tenta colorir com regex. Como somos
 * os autores de 100% da gramática que renderizamos, não existe ambiguidade a
 * resolver (aspas escapadas, template literals, strings multi-linha) — e isso
 * dispensa uma dependência de syntax highlighting no bundle.
 */

export type SnippetLanguage = "curl" | "javascript" | "python" | "php";

export const SNIPPET_LANGUAGES: readonly SnippetLanguage[] = [
    "curl",
    "javascript",
    "python",
    "php",
] as const;

export const SNIPPET_LANGUAGE_LABELS: Record<SnippetLanguage, string> = {
    curl: "cURL",
    javascript: "JavaScript",
    python: "Python",
    php: "PHP",
};

/** Valor representável no corpo de uma requisição, sem passar por `unknown`. */
export type BodyValue =
    | string
    | number
    | boolean
    | null
    | BodyValue[]
    | { [key: string]: BodyValue };

export interface RequestContext {
    /** Base da Echo API (…/functions/v1/echo-api). */
    baseUrl: string;
    /** Base do QR Service (`qrServiceUrl` da configuração de runtime). */
    qrServiceUrl: string;
    /** Chave digitada pelo usuário. Vazia → placeholder no snippet. */
    apiKey: string;
    /** Valores dos campos, chaveados como `${prefix}_${name}`. */
    paramValues: Record<string, string>;
}

export interface ResolvedHeader {
    name: string;
    value: string;
}

export interface ResolvedRequest {
    method: string;
    /** Path params já substituídos e query string já anexada. */
    url: string;
    /** Ordem estável: auth primeiro, Content-Type depois (só se houver body). */
    headers: ResolvedHeader[];
    /** `undefined` quando o endpoint não tem corpo representável em JSON. */
    body?: BodyValue;
    /** O endpoint só aceita upload multipart — o snippet avisa em vez de mentir. */
    multipartOnly: boolean;
    /** QR Service: `Authorization: Bearer`, e nunca uma chave real no exemplo. */
    usesQrAuth: boolean;
}

export type TokenType =
    | "keyword"
    | "function"
    | "string"
    | "number"
    | "boolean"
    | "null"
    | "punctuation"
    | "operator"
    | "comment"
    | "flag"
    | "url"
    | "property"
    | "variable"
    | "plain";

export interface Token {
    type: TokenType;
    text: string;
}

export interface SnippetLine {
    tokens: Token[];
}

export type SnippetGenerator = (request: ResolvedRequest) => SnippetLine[];
