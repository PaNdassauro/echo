import { describe, expect, it } from "vitest";
import {
    composePhoneDigits,
    emptyPhoneInput,
    formatBrNational,
    sanitizeBrNational,
    splitPhoneDigits,
    validatePhoneInput,
} from "./phoneInput";

const br = (national: string) => ({ international: false, dialCode: "55", national });
const intl = (dialCode: string, national: string) => ({ international: true, dialCode, national });

describe("composePhoneDigits", () => {
    it("prefixa 55 no número nacional brasileiro", () => {
        expect(composePhoneDigits(br("11999999999"))).toBe("5511999999999");
        expect(composePhoneDigits(br("1133334444"))).toBe("551133334444");
    });

    it("não duplica o 55 quando o número completo é colado no modo Brasil", () => {
        expect(composePhoneDigits(br("5511999999999"))).toBe("5511999999999");
        expect(composePhoneDigits(br("551133334444"))).toBe("551133334444");
    });

    it("preserva o DDD 55 de Santa Maria/RS", () => {
        // 11 dígitos começando com 55 são DDD + número, não DDI + número.
        expect(composePhoneDigits(br("55999998888"))).toBe("5555999998888");
    });

    it("usa o DDI informado e nunca encosta no 55", () => {
        expect(composePhoneDigits(intl("34", "612345678"))).toBe("34612345678");
        expect(composePhoneDigits(intl("351", "912345678"))).toBe("351912345678");
        expect(composePhoneDigits(intl("1", "2125551234"))).toBe("12125551234");
    });

    it("fica vazio enquanto falta uma das partes", () => {
        expect(composePhoneDigits(emptyPhoneInput())).toBe("");
        expect(composePhoneDigits(intl("", "612345678"))).toBe("");
        expect(composePhoneDigits(intl("34", ""))).toBe("");
    });

    it("ignora máscara e caractere solto", () => {
        expect(composePhoneDigits(br("(11) 99999-9999"))).toBe("5511999999999");
        expect(composePhoneDigits(br("+55 11 99999-9999"))).toBe("5511999999999");
    });
});

describe("validatePhoneInput", () => {
    it("aceita 10 e 11 dígitos no Brasil", () => {
        expect(validatePhoneInput(br("11999999999"))).toEqual({
            ok: true,
            phone: "5511999999999",
            error: null,
        });
        expect(validatePhoneInput(br("1133334444")).ok).toBe(true);
    });

    it("recusa nacional brasileiro incompleto sem falar de DDI", () => {
        const check = validatePhoneInput(br("119999"));
        expect(check.ok).toBe(false);
        expect(check.phone).toBe("");
        expect(check.error).toBe("Informe DDD + número (10 ou 11 dígitos)");
    });

    it("exige o DDI no modo internacional", () => {
        expect(validatePhoneInput(intl("", "612345678")).error).toBe(
            "Informe o código do país (DDI)"
        );
    });

    it("cobra o número antes de qualquer outra coisa", () => {
        expect(validatePhoneInput(emptyPhoneInput()).error).toBe("Informe o número");
        expect(validatePhoneInput(intl("34", "")).error).toBe("Informe o número");
    });

    it("aplica o teto do E.164 no número internacional", () => {
        const check = validatePhoneInput(intl("34", "6"));
        expect(check.ok).toBe(false);
        expect(check.error).toContain("incompleto");
    });

    it("valida um número espanhol sem nenhum 55 no meio", () => {
        const check = validatePhoneInput(intl("34", "612345678"));
        expect(check.ok).toBe(true);
        expect(check.phone).toBe("34612345678");
        expect(check.phone.startsWith("55")).toBe(false);
    });
});

describe("splitPhoneDigits", () => {
    it("reconhece brasileiro de 12 e 13 dígitos", () => {
        expect(splitPhoneDigits("5511999999999")).toEqual({
            international: false,
            dialCode: "55",
            national: "11999999999",
        });
        expect(splitPhoneDigits("551133334444")).toEqual({
            international: false,
            dialCode: "55",
            national: "1133334444",
        });
    });

    it("mantém no Brasil um valor parcial começando com 55", () => {
        // Senão o campo abriria em "Outro país · Brasil" e cobraria o DDI.
        expect(splitPhoneDigits("55119")).toEqual({
            international: false,
            dialCode: "55",
            national: "119",
        });
    });

    it("separa o DDI pelo prefixo mais longo da tabela", () => {
        expect(splitPhoneDigits("351912345678")).toEqual({
            international: true,
            dialCode: "351",
            national: "912345678",
        });
        expect(splitPhoneDigits("34612345678")).toEqual({
            international: true,
            dialCode: "34",
            national: "612345678",
        });
    });

    it("volta ao estado vazio (Brasil) sem dígito nenhum", () => {
        expect(splitPhoneDigits("")).toEqual(emptyPhoneInput());
    });

    it("faz round-trip com composePhoneDigits", () => {
        for (const digits of ["5511999999999", "551133334444", "34612345678", "351912345678"]) {
            expect(composePhoneDigits(splitPhoneDigits(digits))).toBe(digits);
        }
    });
});

describe("sanitizeBrNational", () => {
    it("tira o 55 de um número completo colado", () => {
        expect(sanitizeBrNational("5511999999999")).toBe("11999999999");
        expect(sanitizeBrNational("+55 (11) 99999-9999")).toBe("11999999999");
    });

    it("corta no tamanho do nacional brasileiro", () => {
        expect(sanitizeBrNational("119999999999999")).toBe("11999999999");
    });
});

describe("formatBrNational", () => {
    it("aplica a máscara progressivamente", () => {
        expect(formatBrNational("11")).toBe("11");
        expect(formatBrNational("119")).toBe("(11) 9");
        expect(formatBrNational("1199999")).toBe("(11) 99999");
        expect(formatBrNational("11999999999")).toBe("(11) 99999-9999");
        expect(formatBrNational("1133334444")).toBe("(11) 3333-4444");
        // O hífen só entra quando o número local fecha (8 dígitos) e fica sempre
        // a 4 do fim, então nunca muda de lugar no meio da digitação.
        expect(formatBrNational("113333444")).toBe("(11) 3333444");
        expect(formatBrNational("1133334444")).toBe("(11) 3333-4444");
        expect(formatBrNational("11333344445")).toBe("(11) 33334-4445");
    });
});
