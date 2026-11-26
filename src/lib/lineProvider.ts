/**
 * Regras puras do provider (lib) que atende uma linha QR no qr-service.
 * Sem React, sem rede: o que dá para testar no vitest.
 */

/** Providers que o serviço conhece hoje; usado quando a edge não devolve a lista. */
export const KNOWN_PROVIDERS = ["baileys", "zapo"] as const;

export type ProviderOption = {
    name: string;
    /** false = o serviço cairia no default (baileys) e avisaria no log. */
    registered: boolean;
};

/**
 * Lista para o menu: tudo que o serviço registrou, mais os conhecidos que ele
 * não registrou (desabilitados, para o operador ver que a opção existe mas o
 * ambiente não a tem — zapo sem ZAPO_PG_URL, por exemplo).
 */
export function providerOptions(registered: readonly string[]): ProviderOption[] {
    // Edge antiga ou serviço fora do ar: sem lista, assume os conhecidos como registrados.
    if (registered.length === 0) return KNOWN_PROVIDERS.map((name) => ({ name, registered: true }));
    const set = new Set(registered);
    const out: ProviderOption[] = registered.map((name) => ({ name, registered: true }));
    for (const name of KNOWN_PROVIDERS) {
        if (!set.has(name)) out.push({ name, registered: false });
    }
    return out;
}

export type ProviderDivergence =
    | { kind: "same" }
    /** Sessão viva ainda na lib antiga: o valor do banco só vale na próxima conexão. */
    | { kind: "pending"; live: string }
    /** Sem sessão no serviço: não há como saber a lib em uso. */
    | { kind: "unknown" };

export function providerDivergence(db: string, live: string | null | undefined): ProviderDivergence {
    if (live === null || live === undefined) return { kind: "unknown" };
    return live === db ? { kind: "same" } : { kind: "pending", live };
}

/** Rótulo curto para o chip. */
export function providerLabel(name: string): string {
    return name === "baileys" ? "Baileys" : name === "zapo" ? "zapo" : name;
}

/** Tooltip do chip: banco × sessão viva, com a lib/versão quando o serviço informou. */
export function providerChipTitle(db: string, live: string | null | undefined, libraryId?: string | null): string {
    const div = providerDivergence(db, live);
    const lib = libraryId ? ` · ${libraryId}` : "";
    if (div.kind === "pending") {
        return `Banco: ${db}. Sessão ainda na ${providerLabel(div.live)}${lib} — muda na próxima conexão.`;
    }
    if (div.kind === "unknown") return `Banco: ${db}. Sem sessão viva no serviço para confirmar.`;
    return `${providerLabel(db)}${lib}`;
}
