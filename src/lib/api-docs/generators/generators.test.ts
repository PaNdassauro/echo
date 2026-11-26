import { describe, expect, it } from "vitest";
import type { EndpointItem } from "@/data/apiDocsData";
import { linesToText } from "../tokens";
import type { RequestContext, SnippetLanguage } from "../types";
import { buildSnippet, SNIPPET_GENERATORS } from "./index";
import { resolveRequest } from "../resolveRequest";

const ctx: RequestContext = {
    baseUrl: "https://api.example.com/echo-api",
    qrServiceUrl: "https://qr.example.com",
    apiKey: "wc_secret",
    paramValues: {},
};

const postWithBody: EndpointItem = {
    method: "POST",
    path: "/send-message",
    slug: "send-message",
    description: "",
    response: "{}",
    bodyFields: [
        { name: "to", type: "string", description: "", defaultValue: "5584999999999" },
        { name: "message", type: "string", description: "", defaultValue: "Olá!" },
        { name: "typing_ms", type: "number", description: "", defaultValue: "2500" },
    ],
};

const getNoBody: EndpointItem = {
    method: "GET",
    path: "/conversations",
    slug: "list-conversations",
    description: "",
    response: "{}",
};

const qrEndpoint: EndpointItem = {
    method: "POST",
    path: "/message/send/:phoneNumberId",
    slug: "qr-send-text",
    baseUrl: "__QR_SERVICE__",
    description: "",
    response: "{}",
    pathParams: [{ name: "phoneNumberId", type: "string", description: "", defaultValue: "PHONE" }],
    bodyFields: [{ name: "to", type: "string", description: "", defaultValue: "5511" }],
};

const LANGUAGES: SnippetLanguage[] = ["curl", "javascript", "python", "php"];

describe.each(LANGUAGES)("gerador %s", (lang) => {
    it("inclui método, URL e a chave nos endpoints da Echo API", () => {
        const out = buildSnippet(lang, postWithBody, ctx);
        expect(out).toContain("https://api.example.com/echo-api/send-message");
        expect(out).toContain("wc_secret");
        expect(out.toUpperCase()).toContain("POST");
    });

    it("serializa o corpo com os tipos convertidos", () => {
        const out = buildSnippet(lang, postWithBody, ctx);
        expect(out).toContain("5584999999999");
        // typing_ms é número: nunca deve sair entre aspas
        expect(out).toContain("2500");
        expect(out).not.toContain('"2500"');
        expect(out).not.toContain("'2500'");
    });

    it("GET sem corpo não emite Content-Type nem corpo vazio", () => {
        const out = buildSnippet(lang, getNoBody, ctx);
        expect(out).not.toContain("Content-Type");
        expect(out).not.toContain("{}");
    });

    it("rota do QR Service usa Bearer e nunca a chave real", () => {
        const out = buildSnippet(lang, qrEndpoint, ctx);
        expect(out).toContain("Authorization");
        expect(out).toContain("YOUR_SESSION_TOKEN");
        expect(out).not.toContain("wc_secret");
        expect(out).not.toContain("x-api-key");
        expect(out).toContain("https://qr.example.com/message/send/PHONE");
    });

    it("uma linha de token nunca contém quebra de linha crua", () => {
        const lines = SNIPPET_GENERATORS[lang](
            resolveRequest(
                { ...postWithBody, bodyFields: [{ name: "message", type: "string", description: "", defaultValue: "linha1\nlinha2" }] },
                ctx,
            ),
        );
        for (const line of lines) {
            for (const token of line.tokens) {
                expect(token.text).not.toContain("\n");
            }
        }
        expect(linesToText(lines)).toContain("\\n");
    });
});

describe("dialetos", () => {
    it("Python usa True/None, JS e PHP usam true/null", () => {
        const withBool: EndpointItem = {
            ...postWithBody,
            bodyFields: [{ name: "is_active", type: "boolean", description: "", defaultValue: "true" }],
        };
        expect(buildSnippet("python", withBool, ctx)).toContain("True");
        expect(buildSnippet("javascript", withBool, ctx)).toContain("true");
        expect(buildSnippet("php", withBool, ctx)).toContain("true");
    });

    it("PHP usa => nas chaves e aspas simples", () => {
        const out = buildSnippet("php", postWithBody, ctx);
        expect(out).toContain("'to' => ");
    });

    it("cURL emite JSON válido em --data", () => {
        const out = buildSnippet("curl", postWithBody, ctx);
        const match = out.match(/--data '([\s\S]*)'/);
        expect(match).not.toBeNull();
        expect(() => JSON.parse(match![1])).not.toThrow();
    });
});
