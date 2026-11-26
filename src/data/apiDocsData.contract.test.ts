import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findEndpointBySlug } from "./apiDocsData";

/**
 * Guarda de contrato: a doc não pode omitir campo que o backend aceita.
 *
 * `echo-api/index.ts` declara `required: [...]` / `optional: [...]` por handler
 * para validar o body. Essa lista é a fonte da verdade — a doc derivou dela e
 * ficou sem `conversation_id`/`user_id` em /send-message e /send-template sem
 * ninguém notar. Aqui a divergência falha o teste em vez de virar bug de
 * integração.
 */
const source = readFileSync("supabase/functions/echo-api/index.ts", "utf8");

const namesIn = (arrayLiteral: string) =>
    [...arrayLiteral.matchAll(/'([^']+)'/g)].map((x) => x[1]);

/**
 * Contrato de um handler.
 *
 * `/send-image` e `/send-voice` validam em DOIS ramos — JSON exige `media_url`,
 * multipart exige `file`. Então:
 *  - `accepted` é a união de tudo que qualquer ramo aceita;
 *  - `alwaysRequired` é a interseção dos `required`, ou seja, o que é
 *    obrigatório independente de como você envia. É isso que a doc marca.
 */
function contractOf(handler: string): { accepted: string[]; alwaysRequired: string[] } {
    const body = source.slice(source.indexOf(`async function ${handler}`));
    const block = body.slice(0, body.indexOf("\n}\n"));

    const requiredBranches = [...block.matchAll(/required: \[([^\]]*)\]/g)].map((m) => namesIn(m[1]));
    const optional = [...block.matchAll(/optional: \[([^\]]*)\]/g)].flatMap((m) => namesIn(m[1]));

    const alwaysRequired = requiredBranches.length
        ? requiredBranches.reduce((acc, branch) => acc.filter((n) => branch.includes(n)))
        : [];

    return {
        accepted: [...new Set([...requiredBranches.flat(), ...optional])],
        alwaysRequired,
    };
}

const CASES: { slug: string; handler: string; /** campos só de multipart */ extra?: string[] }[] = [
    { slug: "send-message", handler: "handleSendMessage" },
    { slug: "send-template", handler: "handleSendTemplate" },
    { slug: "send-media", handler: "handleSendImage", extra: ["file"] },
    { slug: "send-voice", handler: "handleSendVoice", extra: ["file"] },
    { slug: "send-sticker", handler: "handleSendSticker" },
    { slug: "send-reaction", handler: "handleReact" },
    { slug: "send-typing", handler: "handleTyping" },
    { slug: "create-scheduled-message", handler: "createScheduledMessage" },
    { slug: "create-broadcast", handler: "createBroadcast" },
];

describe("apiDocsData x echo-api", () => {
    it.each(CASES)("$slug documenta tudo que $handler aceita", ({ slug, handler }) => {
        const { accepted } = contractOf(handler);
        expect(accepted.length, `não achei o contrato de ${handler}`).toBeGreaterThan(0);

        const documented = new Set(
            (findEndpointBySlug(slug)?.endpoint.bodyFields ?? []).map((f) => f.name),
        );
        const missing = accepted.filter((name) => !documented.has(name));
        expect(missing, `campos aceitos e não documentados em /${slug}`).toEqual([]);
    });

    it.each(CASES)("$slug não documenta campo que $handler ignora", ({ slug, handler, extra = [] }) => {
        const accepted = new Set([...contractOf(handler).accepted, ...extra]);
        const documented = (findEndpointBySlug(slug)?.endpoint.bodyFields ?? []).map((f) => f.name);
        const phantom = documented.filter((name) => !accepted.has(name));
        // organization_id em POST /phone-numbers era exatamente este caso:
        // documentado como obrigatório, ignorado pelo handler.
        expect(phantom, `campos documentados que o handler ignora em /${slug}`).toEqual([]);
    });

    it.each(CASES)("$slug marca como obrigatório o que sempre é", ({ slug, handler }) => {
        const { alwaysRequired } = contractOf(handler);
        const docRequired = (findEndpointBySlug(slug)?.endpoint.bodyFields ?? [])
            .filter((f) => f.required)
            .map((f) => f.name);
        expect(docRequired.sort()).toEqual([...alwaysRequired].sort());
    });
});
