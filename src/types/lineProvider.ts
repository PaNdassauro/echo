import { z } from "zod";

/**
 * Contrato do `POST /session/migrate-provider/:id` do qr-service.
 * Validado antes de qualquer uso: o serviço é externo ao front.
 */
export const migrateProviderResponseSchema = z.object({
    success: z.literal(true),
    phoneNumberId: z.string(),
    from: z.string(),
    to: z.string(),
    /** O que não sobreviveu à exportação/importação das credenciais (ex.: chaves de grupo). */
    losses: z.array(z.string()).default([]),
    /** Caminho do backup no disco do serviço; vazio quando nada mudou. */
    backup: z.string().default(""),
    /** Status da sessão após reconectar, ou 'already_on_provider'. */
    status: z.string(),
});
export type MigrateProviderResponse = z.infer<typeof migrateProviderResponseSchema>;

export const migrateProviderErrorSchema = z.object({
    success: z.literal(false).optional(),
    error: z.string(),
});
