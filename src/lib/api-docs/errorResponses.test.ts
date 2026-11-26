import { describe, expect, it } from "vitest";
import type { EndpointItem } from "@/data/apiDocsData";
import { isSuccessStatus, resolveErrorBody } from "./errorResponses";

const base: EndpointItem = {
    method: "GET",
    path: "/conversations",
    slug: "list-conversations",
    description: "",
    response: "{}",
    responses: [
        { status: 200, description: "ok" },
        { status: 401, description: "API Key inválida ou não fornecida" },
    ],
};

describe("resolveErrorBody", () => {
    it("usa o corpo real da Echo API, não um objeto sintético", () => {
        const body = JSON.parse(resolveErrorBody(base, 401));
        expect(body).toEqual({ error: "Invalid API key" });
        // O formato antigo, inventado pelo painel, não pode voltar
        expect(body).not.toHaveProperty("status");
        expect(body).not.toHaveProperty("message");
    });

    it("usa as mensagens do QR Service nas rotas internas", () => {
        const qr: EndpointItem = { ...base, baseUrl: "__QR_SERVICE__" };
        expect(JSON.parse(resolveErrorBody(qr, 401))).toEqual({ error: "Missing bearer token" });
    });

    it("reflete a assimetria real do 500 do echo-api", () => {
        expect(JSON.parse(resolveErrorBody(base, 500))).toEqual({
            success: false,
            error: "Erro interno. Tente novamente.",
        });
    });

    it("override por endpoint tem precedência", () => {
        const withOverride: EndpointItem = {
            ...base,
            responses: [{ status: 409, description: "x", body: '{ "error": "User is already the primary assignee" }' }],
        };
        expect(resolveErrorBody(withOverride, 409)).toContain("primary assignee");
    });

    it("status desconhecido cai na descrição declarada", () => {
        const odd: EndpointItem = { ...base, responses: [{ status: 418, description: "Sou um bule" }] };
        expect(JSON.parse(resolveErrorBody(odd, 418))).toEqual({ error: "Sou um bule" });
    });
});

describe("isSuccessStatus", () => {
    it.each([
        [200, true],
        [201, true],
        [299, true],
        [400, false],
        [500, false],
    ])("%i → %s", (status, expected) => {
        expect(isSuccessStatus(status)).toBe(expected);
    });
});
