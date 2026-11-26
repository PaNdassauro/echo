import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guarda do bug de grupo no echo-api.
 *
 * O envio para grupo caía numa conversa fantasma porque
 * `findOrCreateConversation` mandava o JID para `normalizePhoneNumber`
 * (`replace(/\D/g,'')` → perde o "@g.us") e inseria sem `is_group`. O trigger
 * `trg_normalize_conversation_phone` só preserva `contact_phone` quando
 * `is_group = true`, então o registro nascia órfão da thread real do grupo.
 *
 * A função é Deno-only (Deno.env no topo do módulo), então não dá para importá-la
 * daqui — o teste lê a fonte e afirma as invariantes que consertam o bug.
 */
const source = readFileSync("supabase/functions/echo-api/index.ts", "utf8");

const bodyOf = (name: string) => {
    const from = source.indexOf(`async function ${name}`);
    expect(from, `não achei ${name}`).toBeGreaterThan(-1);
    return source.slice(from, from + source.slice(from).indexOf("\n}\n"));
};

describe("echo-api: conversa de grupo", () => {
    it("findOrCreateConversation desvia JID antes de normalizar", () => {
        const body = bodyOf("findOrCreateConversation");
        const guard = body.indexOf("GROUP_JID_SUFFIX");
        const normalize = body.indexOf("normalizePhoneNumber(");
        expect(guard, "sem checagem de JID de grupo").toBeGreaterThan(-1);
        // A ordem é o que importa: o desvio precisa vir ANTES da normalização.
        expect(guard).toBeLessThan(normalize);
    });

    it("o insert de grupo marca is_group e group_jid", () => {
        const body = bodyOf("findOrCreateGroupConversation");
        expect(body).toContain("is_group: true");
        expect(body).toContain("group_jid: groupJid");
        // contact_phone tem de ser o JID cru — nada de limpar.
        expect(body).toContain("contact_phone: groupJid");
        expect(body).not.toMatch(/contact_phone:.*(cleanPhoneForStorage|normalize)/);
    });

    it("o lookup de grupo casa com o do whatsapp-webhook", () => {
        // Se os dois procurarem por chaves diferentes, cada lado cria a sua
        // conversa e o bug volta pela outra ponta.
        const body = bodyOf("findOrCreateGroupConversation");
        expect(body).toContain(".eq('group_jid', groupJid)");
        expect(body).toContain(".eq('phone_number_id', phoneNumberDbId)");

        const webhook = readFileSync("supabase/functions/whatsapp-webhook/index.ts", "utf8");
        expect(webhook).toContain(".eq('group_jid', group_jid)");
    });

    it("POST /conversations não limpa o JID nem esquece is_group", () => {
        const body = bodyOf("handleConversations");
        expect(body).toContain("endsWith(GROUP_JID_SUFFIX)");
        expect(body).toContain("is_group: true, group_jid: cleanedPhone");
        // cleanPhoneForStorage só pode rodar no ramo de não-grupo
        expect(body).toMatch(/isGroup \?[^:]*:\s*cleanPhoneForStorage/);
    });

    it("nenhum insert em conversations grava contact_phone sem tratar grupo", () => {
        const inserts = [...source.matchAll(/contact_phone: (\w+)/g)].map((m) => m[1]);
        // Allowlist deliberadamente mais ampla que o bug original: casa QUALQUER
        // atribuição a contact_phone no arquivo, não só as de conversations.
        // Identificador novo aqui é para falhar até alguém justificar.
        //
        //  - groupJid ................ helper de grupo, JID cru
        //  - cleanedPhone/normalized . já ramificados por is_group
        //  - convData ................ createScheduledMessage lê
        //    convData.contact_phone da conversa já resolvida em vez de copiar o
        //    `to` do integrador. É a forma canônica (JID com @g.us em grupo,
        //    número com 55 em 1:1), então é a fonte group-safe por construção —
        //    justamente para o agendamento não recriar a conversa fantasma.
        expect(new Set(inserts)).toEqual(
            new Set(["groupJid", "cleanedPhone", "normalized", "convData"]),
        );
    });
});
