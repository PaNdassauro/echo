import { z } from "zod";

/**
 * Telefone para pareamento por código: aceita qualquer formatação e
 * normaliza para dígitos E.164 (com DDI, sem '+'), ex: "5511912345678".
 */
export const pairingPhoneSchema = z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .pipe(
        z
            .string()
            .min(10, "Número incompleto — inclua o DDI (ex: 55) e o DDD")
            .max(15, "Número muito longo")
    );

/** Formata o código de 8 caracteres como "XXXX-XXXX" para exibição. */
export const formatPairingCode = (code: string): string =>
    code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
