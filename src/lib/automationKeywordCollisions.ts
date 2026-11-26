import {
    DEFAULT_MATCH_TYPE,
    normalizeKeyword,
    sanitizeKeywords,
    type AutomationTriggerDraft,
    type KeywordMatchType,
} from "./automationTriggers";

/**
 * Detecção de palavras-chave que se atropelam entre fluxos ATIVOS.
 *
 * Dois fluxos com match `contains` ("Sim, já comprei." e "Sim, já comprei")
 * se atropelavam por substring: a resposta a um fluxo caía no outro.
 * Aqui o conflito aparece na hora de salvar, nomeando o outro fluxo.
 */

export interface KeywordTriggerRef {
    flowId: string;
    flowName: string;
    /** `null` = todos os números da organização. */
    phoneNumberId: string | null;
    keywords: string[];
    matchType: KeywordMatchType;
}

export interface KeywordCollision {
    flowName: string;
    /** Palavra do fluxo sendo salvo. */
    keyword: string;
    /** Palavra do outro fluxo. */
    otherKeyword: string;
    kind: "equal" | "substring";
}

/** Mesma regra do STEP 3 do executor: nulo em qualquer lado alcança o outro. */
function sharesLine(a: string | null, b: string | null): boolean {
    return !a || !b || a === b;
}

/** Shape mínimo lido do banco; `trigger_config` é `Json` nos tipos gerados. */
export interface FlowRow {
    id: string;
    name: string;
    phone_number_id: string | null;
    trigger_type?: string | null;
    trigger_config?: unknown;
    automation_triggers?: Array<{
        trigger_type: string;
        trigger_config: unknown;
        is_active: boolean | null;
    }> | null;
}

function readKeywordConfig(rawConfig: unknown) {
    const config = (rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
        ? rawConfig
        : {}) as { keywords?: unknown; match_type?: unknown };

    const rawKeywords = Array.isArray(config.keywords) ? (config.keywords as unknown[]) : [];
    const keywords = sanitizeKeywords(rawKeywords.filter((k): k is string => typeof k === "string"));
    const matchType: KeywordMatchType = config.match_type === "exact" || config.match_type === "contains"
        ? config.match_type
        : "contains"; // default do executor para fluxos legados

    return { keywords, matchType };
}

/**
 * Achata as linhas de `automation_flows` (com `automation_triggers` embutidos)
 * nos gatilhos de palavra-chave que valem para o executor. Espelha o fallback
 * legado: sem linha em `automation_triggers`, vale `trigger_type/config` do fluxo.
 */
export function toKeywordTriggerRefs(flows: FlowRow[]): KeywordTriggerRef[] {
    const refs: KeywordTriggerRef[] = [];

    for (const flow of flows) {
        const active = (flow.automation_triggers ?? []).filter((t) => t.is_active !== false);
        const triggers = active.length > 0
            ? active.map((t) => ({ type: t.trigger_type, config: t.trigger_config }))
            : flow.trigger_type
                ? [{ type: flow.trigger_type, config: flow.trigger_config }]
                : [];

        for (const trigger of triggers) {
            if (trigger.type !== "keyword") continue;

            const { keywords, matchType } = readKeywordConfig(trigger.config);
            if (keywords.length === 0) continue;

            refs.push({
                flowId: flow.id,
                flowName: flow.name,
                phoneNumberId: flow.phone_number_id,
                keywords,
                matchType,
            });
        }
    }

    return refs;
}

export function findKeywordCollisions(
    mine: { flowId: string; phoneNumberId: string | null; triggers: AutomationTriggerDraft[] },
    others: KeywordTriggerRef[],
): KeywordCollision[] {
    const collisions: KeywordCollision[] = [];
    const seen = new Set<string>();

    for (const trigger of mine.triggers) {
        if (trigger.type !== "keyword") continue;

        const myMatchType = trigger.config.match_type ?? DEFAULT_MATCH_TYPE;

        for (const keyword of trigger.config.keywords ?? []) {
            const mineKey = normalizeKeyword(keyword);
            if (!mineKey) continue;

            for (const other of others) {
                if (other.flowId === mine.flowId) continue;
                if (!sharesLine(mine.phoneNumberId, other.phoneNumberId)) continue;

                for (const otherKeyword of other.keywords) {
                    const otherKey = normalizeKeyword(otherKeyword);
                    if (!otherKey) continue;

                    let kind: KeywordCollision["kind"] | null = null;

                    if (mineKey === otherKey) {
                        kind = "equal";
                    } else if (myMatchType === "contains" && otherKey.includes(mineKey)) {
                        // Uma mensagem igual à palavra do outro fluxo também casaria a minha.
                        kind = "substring";
                    } else if (other.matchType === "contains" && mineKey.includes(otherKey)) {
                        // O caso "...comprei." x "...comprei".
                        kind = "substring";
                    }

                    if (!kind) continue;

                    const dedupKey = `${other.flowId}|${mineKey}|${otherKey}`;
                    if (seen.has(dedupKey)) continue;
                    seen.add(dedupKey);

                    collisions.push({
                        flowName: other.flowName,
                        keyword,
                        otherKeyword,
                        kind,
                    });
                }
            }
        }
    }

    return collisions;
}
