import { describe, expect, it } from "vitest";
import { classificarLote, normalizarTelefone } from "./bulk-add-group-members.mjs";

// Telefones de teste. A é 55 11 9 1111 2222 — o mesmo número sem o nono dígito
// seria 55 11 1111 2222, e os dois compartilham os 8 dígitos finais.
const A = "5511911112222";
const B = "5521933334444";
const C = "5531955556666";
const LOTE = [A, B, C];

const buckets = (resultado) =>
    Object.fromEntries([...resultado.porTelefone].map(([telefone, r]) => [telefone, r.bucket]));

describe("normalizarTelefone", () => {
    it("acrescenta o DDI em número nacional de 10 ou 11 dígitos", () => {
        expect(normalizarTelefone("(11) 99999-9999").telefone).toBe("5511999999999");
        expect(normalizarTelefone("1133334444").telefone).toBe("551133334444");
    });

    it("deixa E.164 intacto, seja lá como estiver formatado", () => {
        expect(normalizarTelefone("+55 21 98888-7777").telefone).toBe("5521988887777");
    });

    // Chutar o nono dígito produz OUTRO telefone — e adicionar um estranho a um
    // grupo de cliente é pior do que a linha simplesmente falhar.
    it("não inventa o nono dígito", () => {
        expect(normalizarTelefone("11 8888-7777").telefone).toBe("551188887777");
    });

    // Sem podar o zero, "011999990003" tem 12 dígitos, cai na faixa do E.164 e
    // passa como se já tivesse DDI — virando um telefone que não existe.
    it("descarta zero à esquerda antes de decidir se falta DDI", () => {
        expect(normalizarTelefone("011999990003").telefone).toBe("5511999990003");
        expect(normalizarTelefone("00 55 11 99999-0003").telefone).toBe("5511999990003");
    });

    it("nacional de 10 dígitos com DDD alto continua ganhando o 55", () => {
        expect(normalizarTelefone("4499990004").telefone).toBe("554499990004");
    });

    // Um espanhol tem 11 dígitos com DDI e cairia na regra brasileira: sem olhar
    // o "+", +34600000005 viraria 5534600000005 — outra pessoa, em outro país.
    it("respeita o DDI declarado com + e não prefixa 55", () => {
        expect(normalizarTelefone("+34600000005").telefone).toBe("34600000005");
        expect(normalizarTelefone("+351 912 345 678").telefone).toBe("351912345678");
    });

    it("rejeita entrada sem dígitos ou fora de 12–15 dígitos", () => {
        expect(normalizarTelefone("abc").erro).toBeTruthy();
        expect(normalizarTelefone("1234").erro).toBeTruthy();
        expect(normalizarTelefone("5511999999999999").erro).toBeTruthy();
    });
});

describe("classificarLote", () => {
    it("sem menção nenhuma e success: todos entraram", () => {
        expect(buckets(classificarLote({ success: true }, LOTE)))
            .toEqual({ [A]: "ok", [B]: "ok", [C]: "ok" });
    });

    it("separa convite, já-participante e sucesso no mesmo lote", () => {
        const data = {
            success: true,
            inviteRequired: [{ phone: A, jid: `${A}@s.whatsapp.net`, code: "XYZ", expiration: 0 }],
            details: { [B]: "Já é participante do grupo" },
        };
        expect(buckets(classificarLote(data, LOTE)))
            .toEqual({ [A]: "convite_pendente", [B]: "ja_estava", [C]: "ok" });
    });

    it("408 vira nao_whatsapp, que é definitivo e não abortável", () => {
        const r = classificarLote({ success: true, details: { [C]: "Número não existe no WhatsApp" } }, LOTE);
        expect(r.porTelefone.get(C).bucket).toBe("nao_whatsapp");
        expect(r.porTelefone.get(C).abortavel).toBeUndefined();
    });

    // A checagem de admin acontece antes do primeiro add, então 403 aqui não é
    // configuração de grupo: é a cara da penalidade de anti-abuso do WhatsApp.
    it("403 num grupo onde a linha é admin é falha abortável", () => {
        const erro = "Sem permissão (você não é admin)";
        const r = classificarLote({ success: false, error: erro, details: { [A]: erro } }, LOTE);
        expect(r.porTelefone.get(A).abortavel).toBe(true);
        expect(buckets(r)).toEqual({ [A]: "falhou", [B]: "falhou", [C]: "falhou" });
    });

    it("sessão fora do ar vira bucket próprio, para o loop parar na hora", () => {
        const r = classificarLote({ success: false, error: "Session not connected" }, LOTE);
        expect(r.porTelefone.get(A).bucket).toBe("sessao");
    });

    it("casa a chave pelos 8 dígitos finais quando o WhatsApp responde outro formato", () => {
        const semNono = "551111112222";
        const r = classificarLote({ success: true, details: { [semNono]: "Já é participante do grupo" } }, [A, B]);
        expect(buckets(r)).toEqual({ [A]: "ja_estava", [B]: "ok" });
    });

    it("chave que não bate com o lote vira aviso, sem contaminar quem entrou", () => {
        const r = classificarLote({ success: true, details: { "17205551234567": "Erro 500" } }, LOTE);
        expect(r.orfaos).toHaveLength(1);
        expect(buckets(r)).toEqual({ [A]: "ok", [B]: "ok", [C]: "ok" });
    });
});
