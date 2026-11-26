import { describe, expect, it } from "vitest";
import type { EndpointItem } from "@/data/apiDocsData";
import { resolveRequest } from "./resolveRequest";
import type { RequestContext } from "./types";

const ctx: RequestContext = {
    baseUrl: "https://api.example.com/echo-api",
    qrServiceUrl: "https://qr.example.com",
    apiKey: "wc_realkey123",
    paramValues: {},
};

const endpoint = (over: Partial<EndpointItem>): EndpointItem => ({
    method: "GET",
    path: "/things",
    slug: "things",
    description: "",
    response: "{}",
    ...over,
});

describe("resolveRequest", () => {
    it("usa x-api-key com a chave digitada na Echo API", () => {
        const r = resolveRequest(endpoint({}), ctx);
        expect(r.usesQrAuth).toBe(false);
        expect(r.headers).toEqual([{ name: "x-api-key", value: "wc_realkey123" }]);
    });

    it("cai no placeholder quando não há chave digitada", () => {
        const r = resolveRequest(endpoint({}), { ...ctx, apiKey: "" });
        expect(r.headers[0].value).toBe("YOUR_API_KEY");
    });

    it("usa Authorization: Bearer no QR Service", () => {
        const r = resolveRequest(
            endpoint({
                baseUrl: "__QR_SERVICE__",
                path: "/groups/:id",
                pathParams: [{ name: "id", type: "string", description: "", defaultValue: "PHONE" }],
            }),
            ctx,
        );
        expect(r.usesQrAuth).toBe(true);
        expect(r.headers[0].name).toBe("Authorization");
        expect(r.url).toBe("https://qr.example.com/groups/PHONE");
    });

    it("NUNCA imprime a chave real numa rota interna do QR Service", () => {
        const r = resolveRequest(endpoint({ baseUrl: "__QR_SERVICE__" }), ctx);
        expect(r.headers[0].value).toBe("Bearer YOUR_SESSION_TOKEN");
        expect(JSON.stringify(r)).not.toContain("wc_realkey123");
    });

    it("substitui path params e anexa query params com valor", () => {
        const r = resolveRequest(
            endpoint({
                path: "/conversations/:id/tags",
                method: "DELETE",
                pathParams: [{ name: "id", type: "string", description: "", defaultValue: "CONV" }],
                queryParams: [
                    { name: "tag_id", type: "string", description: "", defaultValue: "TAG" },
                    { name: "vazio", type: "string", description: "", defaultValue: "" },
                ],
            }),
            ctx,
        );
        expect(r.url).toBe("https://api.example.com/echo-api/conversations/CONV/tags?tag_id=TAG");
    });

    it("GET sem corpo não manda Content-Type", () => {
        const r = resolveRequest(endpoint({}), ctx);
        expect(r.body).toBeUndefined();
        expect(r.headers.map((h) => h.name)).not.toContain("Content-Type");
    });

    it("converte tipos declarados em vez de mandar tudo como string", () => {
        const r = resolveRequest(
            endpoint({
                method: "POST",
                bodyFields: [
                    { name: "to", type: "string", description: "", defaultValue: "5511" },
                    { name: "typing_ms", type: "number", description: "", defaultValue: "2500" },
                    { name: "is_active", type: "boolean", description: "", defaultValue: "true" },
                    { name: "participants", type: "array", description: "", defaultValue: '["5511"]' },
                ],
            }),
            ctx,
        );
        expect(r.body).toEqual({
            to: "5511",
            typing_ms: 2500,
            is_active: true,
            participants: ["5511"],
        });
        expect(r.headers.map((h) => h.name)).toContain("Content-Type");
    });

    it("array malformado vira texto em vez de sumir do exemplo", () => {
        const r = resolveRequest(
            endpoint({
                method: "POST",
                bodyFields: [{ name: "participants", type: "array", description: "", defaultValue: '["551' }],
            }),
            ctx,
        );
        expect(r.body).toEqual({ participants: '["551' });
    });

    it("campo File não entra no JSON e marca multipartOnly quando é o único", () => {
        const r = resolveRequest(
            endpoint({
                method: "POST",
                bodyFields: [{ name: "file", type: "File", description: "", defaultValue: "" }],
            }),
            ctx,
        );
        expect(r.body).toBeUndefined();
        expect(r.multipartOnly).toBe(true);
    });

    it("com alternativa por URL preenchida não é multipartOnly", () => {
        const r = resolveRequest(
            endpoint({
                method: "POST",
                bodyFields: [
                    { name: "media_url", type: "string", description: "", defaultValue: "https://x/y.jpg" },
                    { name: "file", type: "File", description: "", defaultValue: "" },
                ],
            }),
            ctx,
        );
        expect(r.multipartOnly).toBe(false);
        expect(r.body).toEqual({ media_url: "https://x/y.jpg" });
    });

    it("valor digitado tem precedência sobre o default", () => {
        const r = resolveRequest(
            endpoint({
                method: "POST",
                bodyFields: [{ name: "to", type: "string", description: "", defaultValue: "5511" }],
            }),
            { ...ctx, paramValues: { body_to: "5599" } },
        );
        expect(r.body).toEqual({ to: "5599" });
    });

    it("sem endpoint devolve o health check", () => {
        const r = resolveRequest(null, ctx);
        expect(r.url).toBe("https://api.example.com/echo-api/health");
        expect(r.headers).toEqual([]);
    });
});
