import { describe, expect, it } from "vitest";
import { extractInviteCode, inviteErrorMessage } from "./groupInvite";

const CODE = "Ab1Cd2Ef3Gh4Ij5Kl6Mn7o"; // 22 caracteres, o tamanho de todo código de convite
const FALLBACK = "Confira se o link está completo e ainda é válido.";

describe("extractInviteCode", () => {
    it.each([
        ["código puro", CODE],
        ["código com espaço em volta", `  ${CODE}\n`],
        ["URL limpa", `https://chat.whatsapp.com/${CODE}`],
        // Sufixos que o app anexa ao copiar o link
        ["?s=cl&p=i&ilr=4&iam=2", `https://chat.whatsapp.com/${CODE}?s=cl&p=i&ilr=4&iam=2`],
        ["?s=sw&p=a&mlu=4", `https://chat.whatsapp.com/${CODE}?s=sw&p=a&mlu=4`],
        ["?mode=ems_copy_t", `https://chat.whatsapp.com/${CODE}?mode=ems_copy_t`],
        ["barra final", `https://chat.whatsapp.com/${CODE}/`],
        ["fragmento", `https://chat.whatsapp.com/${CODE}#x`],
        ["/invite/", `https://chat.whatsapp.com/invite/${CODE}`],
        ["http e host em maiúsculas", `http://CHAT.WHATSAPP.COM/${CODE}`],
        ["sem esquema", `chat.whatsapp.com/${CODE}`],
        ["texto antes do link", `Entre no grupo do evento: https://chat.whatsapp.com/${CODE}`],
        ["texto depois do link em outra linha", `https://chat.whatsapp.com/${CODE}?s=cl&p=i\nAté já`],
    ])("%s", (_caso, input) => {
        expect(extractInviteCode(input)).toBe(CODE);
    });

    it.each([
        ["vazio", ""],
        ["texto qualquer", "abc"],
        ["código curto", "Ab1Cd2Ef3G"],
        ["palavra longa sem link", "Paralelepipedoaaaaaaaa com espaço"],
        ["link de outro serviço", "https://wa.me/5511999999999"],
        ["código com sufixo sem link", `${CODE}?mode=ems_copy_t`],
    ])("devolve null: %s", (_caso, input) => {
        expect(extractInviteCode(input)).toBeNull();
    });
});

describe("inviteErrorMessage", () => {
    it("troca o 'Erro 400' cru do serviço por um próximo passo", () => {
        expect(inviteErrorMessage("Erro 400", FALLBACK)).toMatch(/^Link de convite inválido/);
    });

    it("convite revogado ou expirado", () => {
        expect(inviteErrorMessage("Erro 410", FALLBACK)).toMatch(/expirou ou foi revogado/);
        expect(inviteErrorMessage("Erro 404", FALLBACK)).toMatch(/expirou ou foi revogado/);
    });

    it("status sem tradução cai no fallback, nunca no número cru", () => {
        expect(inviteErrorMessage("Erro 500", FALLBACK)).toBe(FALLBACK);
    });

    it("sessão caída", () => {
        expect(inviteErrorMessage("Session not connected", FALLBACK)).toMatch(/desconectado/);
    });

    it("mensagem já escrita para gente passa direto", () => {
        expect(inviteErrorMessage("Já é participante do grupo", FALLBACK)).toBe("Já é participante do grupo");
    });

    it("sem erro, usa o fallback", () => {
        expect(inviteErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
    });
});
