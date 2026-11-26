import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    bareJid,
    buildParticipantDisplayMap,
    resolveParticipantName,
    trustedSenderPhone,
} from "./participantDisplayName";

const PHONE = "5511999990001";
const FORMATTED = "+55 11 99999-0001";

describe("resolveParticipantName", () => {
    it("apelido do grupo ganha de tudo", () => {
        expect(
            resolveParticipantName(
                { alias: "Zé do Buffet", pushName: "Zé 🚀", contactName: "José Silva" },
                PHONE,
            ),
        ).toEqual({ name: "Zé do Buffet", origin: "alias" });
    });

    it("pushName ganha do contato 1:1 (política conservadora)", () => {
        // Decisão de produto: a camada de contato 1:1 só PREENCHE o vazio.
        // Nenhum nome que já aparecia antes da feature muda.
        expect(
            resolveParticipantName({ pushName: "Zé 🚀", contactName: "José Silva" }, PHONE),
        ).toEqual({ name: "Zé 🚀", origin: "pushName" });
    });

    it("contato 1:1 entra quando não há apelido nem pushName", () => {
        expect(resolveParticipantName({ contactName: "José Silva" }, PHONE)).toEqual({
            name: "José Silva",
            origin: "contact",
        });
    });

    it("sem nenhuma fonte, cai no telefone formatado", () => {
        expect(resolveParticipantName({}, PHONE)).toEqual({ name: FORMATTED, origin: "phone" });
    });

    it("LID sem nome cai no ID abreviado, não num telefone falso", () => {
        expect(resolveParticipantName({}, "260200000001001", true)).toEqual({
            name: "ID: 2602...1001",
            origin: "phone",
        });
    });

    it("valor vazio ou só espaço é pulado, não vira nome em branco", () => {
        expect(
            resolveParticipantName({ alias: "   ", pushName: "", contactName: "José" }, PHONE),
        ).toEqual({ name: "José", origin: "contact" });
        expect(resolveParticipantName({ alias: null, pushName: undefined }, PHONE).origin).toBe(
            "phone",
        );
    });

    it("name nunca é vazio — é a invariante que impede a bolha anônima", () => {
        expect(resolveParticipantName({}, PHONE).name).not.toBe("");
        expect(resolveParticipantName({}, "260200000001001", true).name).not.toBe("");
    });
});

describe("PRIORITY é uma linha só", () => {
    // Trocar a política para "contato 1:1 ganha do pushName" tem de ser a troca
    // de UMA linha. Este teste falha se a ordem virar lógica espalhada.
    const source = readFileSync("src/lib/participantDisplayName.ts", "utf8");

    it("a ordem está declarada num único array", () => {
        const matches = source.match(/^const PRIORITY = \[(.+)\] as const/m);
        expect(matches, "não achei a declaração única de PRIORITY").not.toBeNull();
        expect(matches![1]).toBe('"alias", "pushName", "contactName"');
    });

    it("a alternativa documentada está anotada junto", () => {
        expect(source).toContain('["alias","contactName","pushName"]');
    });
});

describe("bareJid", () => {
    it("tira os dois sufixos que o WhatsApp usa", () => {
        expect(bareJid("5511999990001@s.whatsapp.net")).toBe("5511999990001");
        expect(bareJid("260200000001001@lid")).toBe("260200000001001");
    });

    it("nulo/vazio devolve undefined em vez de string vazia", () => {
        expect(bareJid(null)).toBeUndefined();
        expect(bareJid(undefined)).toBeUndefined();
        expect(bareJid("")).toBeUndefined();
        expect(bareJid("@lid")).toBeUndefined();
    });
});

describe("trustedSenderPhone", () => {
    it("aceita telefone de JID normal", () => {
        expect(
            trustedSenderPhone({ sender_phone: PHONE, sender_jid: `${PHONE}@s.whatsapp.net` }),
        ).toBe(PHONE);
    });

    it("aceita @lid quando o telefone foi resolvido (difere do LID)", () => {
        expect(
            trustedSenderPhone({ sender_phone: PHONE, sender_jid: "260200000001001@lid" }),
        ).toBe(PHONE);
    });

    it("RECUSA @lid não resolvido — o 'telefone' é o próprio LID", () => {
        // O qr-service faz `senderPhone = altPhone || cache.get(lidId) || lidId`,
        // então sender_phone às vezes É o LID cru. Buscar contato com ele
        // produziria vínculo com a pessoa errada.
        const lid = "260200000001001";
        expect(trustedSenderPhone({ sender_phone: lid, sender_jid: `${lid}@lid` })).toBeUndefined();
    });

    it("linha legada sem sender_jid: aceita por comprimento plausível", () => {
        expect(trustedSenderPhone({ sender_phone: PHONE })).toBe(PHONE);
        expect(trustedSenderPhone({ sender_phone: "1199990001" })).toBe("1199990001");
    });

    it("linha legada com comprimento de LID é recusada", () => {
        expect(trustedSenderPhone({ sender_phone: "260200000001001" })).toBeUndefined();
    });

    it("vazio, nulo e não-dígito são recusados", () => {
        expect(trustedSenderPhone({})).toBeUndefined();
        expect(trustedSenderPhone({ sender_phone: null })).toBeUndefined();
        expect(trustedSenderPhone({ sender_phone: "  " })).toBeUndefined();
        expect(trustedSenderPhone({ sender_phone: "+55 11 99999-0001" })).toBeUndefined();
    });
});

describe("buildParticipantDisplayMap", () => {
    const participant = {
        id: "5511999990001@s.whatsapp.net",
        jid: "5511999990001@s.whatsapp.net",
        phone: PHONE,
    };

    it("grava a mesma entrada sob telefone e bare do jid", () => {
        const map = buildParticipantDisplayMap({
            participants: [participant],
            aliases: {},
            pushNames: {},
            contacts: {
                [PHONE]: {
                    conversationId: "conv-1",
                    name: "José Silva",
                    avatarUrl: null,
                    sameConnection: true,
                },
            },
        });

        expect(map[PHONE].name).toBe("José Silva");
        expect(map[PHONE].origin).toBe("contact");
        expect(map[PHONE].conversationId).toBe("conv-1");
        // Lookup por bare do JID tem de cair na MESMA entrada.
        expect(map["5511999990001"]).toBe(map[PHONE]);
    });

    it("participante @lid não resolvido não recebe vínculo de contato", () => {
        // O "telefone" dele é o LID cru: qualquer match seria falso positivo.
        const lid = "260200000001001";
        const map = buildParticipantDisplayMap({
            participants: [{ id: `${lid}@lid`, jid: `${lid}@lid`, phone: lid, isLid: true }],
            aliases: {},
            pushNames: {},
            contacts: {
                [lid]: {
                    conversationId: "conv-errada",
                    name: "Contato Errado",
                    avatarUrl: null,
                    sameConnection: true,
                },
            },
        });

        expect(map[lid].conversationId).toBeUndefined();
        expect(map[lid].name).toBe("ID: 2602...1001");
    });

    it("o nome do qr-service entra como pushName, não como camada separada", () => {
        // Era por tratá-lo como camada que um rebuild do lookup apagava
        // menções já renderizadas, voltando a número cru.
        const map = buildParticipantDisplayMap({
            participants: [{ ...participant, name: "Zé do qr-service" }],
            aliases: {},
            pushNames: {},
            contacts: {
                [PHONE]: {
                    conversationId: "conv-1",
                    name: "José Silva",
                    avatarUrl: null,
                    sameConnection: true,
                },
            },
        });

        expect(map[PHONE].name).toBe("Zé do qr-service");
        expect(map[PHONE].origin).toBe("pushName");
        // O vínculo sobrevive mesmo com o nome vindo de outra fonte.
        expect(map[PHONE].conversationId).toBe("conv-1");
    });

    it("pushName de mensagem ganha do nome do qr-service", () => {
        const map = buildParticipantDisplayMap({
            participants: [{ ...participant, name: "Nome antigo do cache" }],
            aliases: {},
            pushNames: { [PHONE]: "Nome da mensagem" },
            contacts: {},
        });

        expect(map[PHONE].name).toBe("Nome da mensagem");
    });

    it("resolve por chave de qualquer forma do JID (pushName gravado sob o bare)", () => {
        const map = buildParticipantDisplayMap({
            participants: [participant],
            aliases: {},
            pushNames: { "5511999990001": "Nome pelo bare" },
            contacts: {},
        });

        expect(map[PHONE].name).toBe("Nome pelo bare");
    });

    it("quem falou mas saiu do grupo ainda resolve", () => {
        // A lista do qr-service não traz ex-participante; sem essa passada as
        // mensagens antigas dele voltariam a ficar sem nome.
        const map = buildParticipantDisplayMap({
            participants: [],
            aliases: {},
            pushNames: { "5511988887777": "Ex-membro" },
            contacts: {},
        });

        expect(map["5511988887777"].name).toBe("Ex-membro");
    });

    it("contato de quem saiu do grupo também é vinculado", () => {
        const map = buildParticipantDisplayMap({
            participants: [],
            aliases: {},
            pushNames: {},
            contacts: {
                "5511988887777": {
                    conversationId: "conv-2",
                    name: "Maria",
                    avatarUrl: "https://x/y.jpg",
                    sameConnection: false,
                },
            },
        });

        expect(map["5511988887777"]).toEqual({
            name: "Maria",
            origin: "contact",
            conversationId: "conv-2",
            avatarUrl: "https://x/y.jpg",
            sameConnection: false,
        });
    });

    it("contato sem nome útil ainda carrega o vínculo", () => {
        // contact_name que é só o telefone chega como name: undefined, mas o
        // vínculo (abrir conversa, avatar) continua valendo.
        const map = buildParticipantDisplayMap({
            participants: [participant],
            aliases: {},
            pushNames: {},
            contacts: {
                [PHONE]: {
                    conversationId: "conv-1",
                    name: undefined,
                    avatarUrl: null,
                    sameConnection: true,
                },
            },
        });

        expect(map[PHONE].name).toBe(FORMATTED);
        expect(map[PHONE].origin).toBe("phone");
        expect(map[PHONE].conversationId).toBe("conv-1");
    });

    it("apelido do grupo ganha, e o vínculo continua exposto", () => {
        const map = buildParticipantDisplayMap({
            participants: [participant],
            aliases: { "5511999990001": "Apelido" },
            pushNames: { [PHONE]: "Zé 🚀" },
            contacts: {
                [PHONE]: {
                    conversationId: "conv-1",
                    name: "José Silva",
                    avatarUrl: null,
                    sameConnection: true,
                },
            },
        });

        expect(map[PHONE].name).toBe("Apelido");
        expect(map[PHONE].origin).toBe("alias");
        expect(map[PHONE].conversationId).toBe("conv-1");
    });
});
