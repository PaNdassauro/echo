import { z } from "zod";

/**
 * Contrato dos gatilhos de automação, compartilhado entre a lista, o builder e
 * o painel de propriedades. O executor (`supabase/functions/automation-execute`)
 * lê exatamente estas chaves em `automation_triggers.trigger_config`.
 */

export const KEYWORD_MATCH_TYPES = ["exact", "contains"] as const;
export type KeywordMatchType = (typeof KEYWORD_MATCH_TYPES)[number];

/**
 * Novos gatilhos nascem em `exact`: resposta de botão chega como a mensagem
 * inteira, e o `contains` fazia campanhas diferentes com textos parecidos se
 * atropelarem. Fluxos já salvos mantêm o que está no banco.
 */
export const DEFAULT_MATCH_TYPE: KeywordMatchType = "exact";

export const KEYWORD_MATCH_TYPE_LABELS: Record<KeywordMatchType, string> = {
    exact: "Frase exata",
    contains: "Contém",
};

export const TRIGGER_TYPES = [
    "keyword",
    "message_received",
    "message_sent",
    "conversation_created",
] as const;
export type AutomationTriggerType = (typeof TRIGGER_TYPES)[number];

const triggerConfigSchema = z
    .object({
        keywords: z.array(z.string()).optional(),
        match_type: z.enum(KEYWORD_MATCH_TYPES).optional(),
    })
    .passthrough();

export const automationTriggerSchema = z.object({
    type: z.enum(TRIGGER_TYPES),
    config: triggerConfigSchema.default({}),
});

export type AutomationTriggerDraft = z.infer<typeof automationTriggerSchema>;

/** Mesma normalização do executor: só caixa e espaço, pontuação preservada. */
export function normalizeKeyword(value: string): string {
    return value.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Remove vazias e duplicadas (case/espaço-insensível), preservando a ordem. */
export function sanitizeKeywords(keywords: string[]): string[] {
    const seen = new Set<string>();
    const cleaned: string[] = [];

    for (const raw of keywords) {
        const trimmed = raw.trim().replace(/\s+/g, " ");
        if (!trimmed) continue;

        const key = normalizeKeyword(trimmed);
        if (seen.has(key)) continue;

        seen.add(key);
        cleaned.push(trimmed);
    }

    return cleaned;
}

export interface SanitizeTriggersResult {
    triggers: AutomationTriggerDraft[];
    /** Mensagem pronta para o toast; `null` quando está tudo válido. */
    error: string | null;
}

/**
 * Valida e limpa os gatilhos antes de persistir. O caso que motivou isto: um
 * fluxo de palavra-chave salvo com `keywords: []` (a frase tinha ficado só no
 * nome do gatilho) ficou ATIVO e nunca disparou, silenciosamente.
 */
export function sanitizeTriggers(input: unknown): SanitizeTriggersResult {
    const parsed = z.array(automationTriggerSchema).min(1).safeParse(input);

    if (!parsed.success) {
        return { triggers: [], error: "Configuração de gatilho inválida. Reabra o nó de gatilho e revise." };
    }

    const triggers: AutomationTriggerDraft[] = [];

    for (let i = 0; i < parsed.data.length; i++) {
        const trigger = parsed.data[i];

        if (trigger.type !== "keyword") {
            triggers.push({ type: trigger.type, config: {} });
            continue;
        }

        const keywords = sanitizeKeywords(trigger.config.keywords ?? []);
        if (keywords.length === 0) {
            return {
                triggers: [],
                error:
                    parsed.data.length > 1
                        ? `Gatilho ${i + 1} é de palavra-chave e não tem nenhuma palavra: o fluxo nunca dispararia.`
                        : "Gatilho de palavra-chave sem nenhuma palavra: o fluxo nunca dispararia.",
            };
        }

        triggers.push({
            type: "keyword",
            config: {
                keywords,
                match_type: trigger.config.match_type ?? DEFAULT_MATCH_TYPE,
            },
        });
    }

    return { triggers, error: null };
}

/** Um gatilho de palavra-chave sem palavra: fluxo mudo, precisa de aviso na UI. */
export function hasEmptyKeywordTrigger(
    triggers: Array<{ trigger_type?: string; type?: string; trigger_config?: unknown; config?: unknown }>,
): boolean {
    return triggers.some((trigger) => {
        const type = trigger.trigger_type ?? trigger.type;
        if (type !== "keyword") return false;

        const config = (trigger.trigger_config ?? trigger.config) as { keywords?: unknown } | null | undefined;
        const keywords = Array.isArray(config?.keywords) ? (config?.keywords as unknown[]) : [];

        return sanitizeKeywords(keywords.filter((k): k is string => typeof k === "string")).length === 0;
    });
}
