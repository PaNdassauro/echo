import type { EndpointItem } from "@/data/apiDocsData";
import { resolveRequest } from "../resolveRequest";
import { linesToText } from "../tokens";
import type { RequestContext, SnippetGenerator, SnippetLanguage, SnippetLine } from "../types";
import { buildCurlLines } from "./curl";
import { buildJavaScriptLines } from "./javascript";
import { buildPhpLines } from "./php";
import { buildPythonLines } from "./python";

export const SNIPPET_GENERATORS: Record<SnippetLanguage, SnippetGenerator> = {
    curl: buildCurlLines,
    javascript: buildJavaScriptLines,
    python: buildPythonLines,
    php: buildPhpLines,
};

/** Fonte da verdade: tokens, usados para colorir. */
export function buildSnippetLines(
    language: SnippetLanguage,
    endpoint: EndpointItem | null,
    ctx: RequestContext,
): SnippetLine[] {
    return SNIPPET_GENERATORS[language](resolveRequest(endpoint, ctx));
}

/** Derivado dos tokens: texto puro, usado no botão de copiar. */
export function buildSnippet(
    language: SnippetLanguage,
    endpoint: EndpointItem | null,
    ctx: RequestContext,
): string {
    return linesToText(buildSnippetLines(language, endpoint, ctx));
}
