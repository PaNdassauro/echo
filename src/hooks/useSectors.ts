/**
 * Setores da linha selecionada, meus vínculos e se o isolamento está ligado.
 *
 * As consultas de setor são da ORGANIZAÇÃO (setores, meus vínculos e o setor
 * padrão), então rodam uma vez por organização/usuário e NÃO refazem a cada
 * troca de linha: quem muda com a linha é só o recorte local (`sectorsForLine`)
 * e o `isolationEnabled`. O isolamento vem do mapa de números acessíveis
 * (`useAccessiblePhoneNumbers`, uma busca para todo mundo), sem consulta própria.
 * Só a linha que o mapa não lista (desativada, aberta por deep link) cai numa
 * leitura pela PK, e essa é uma query em cache dividida com o chat
 * (`useNumeroPorId`), não uma por hook.
 *
 * O hook NÃO é a autorização: quem recorta as conversas é a RLS
 * (políticas do baseline). `isolationEnabled` serve só para a UI decidir se
 * mostra o filtro de setor e a aba de triagem — com a flag desligada, esses
 * controles não têm o que fazer e somem.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useNumeroPorId } from "@/hooks/useAccessiblePhoneNumbers";
import { SECTOR_SELECT, sectorsForPhone, type Sector } from "@/lib/sectors";

export interface SectorsState {
    /** Todos os setores da organização, para telas de administração. */
    sectors: Sector[];
    /** Os que valem para a linha selecionada (dela + legados sem linha). */
    sectorsForLine: Sector[];
    /** Lookup por id, para o badge da lista e do cabeçalho da conversa. */
    byId: Map<string, Sector>;
    /** Vínculos do usuário atual (sector_members), não o setor padrão. */
    mySectorIds: string[];
    /** organization_members.sector_id — o padrão, usado ao assumir conversa. */
    defaultSectorId: string | null;
    /** phone_numbers.sector_isolation_enabled da linha selecionada. */
    isolationEnabled: boolean;
    /** phone_numbers.sector_follows_owner ("só quem assumiu vê") da linha selecionada. */
    followsOwner: boolean;
    loading: boolean;
    refresh: () => void;
}

export const useSectors = (
    phoneNumberId: string | null,
    userId: string | null,
): SectorsState => {
    const { currentOrganization } = useOrganization();
    const organizationId = currentOrganization?.id ?? null;
    // A linha vem do mapa ou, se ele não a listar, da leitura pela PK em cache. Não
    // revalida o mapa a cada montagem: o ChatArea monta a cada conversa aberta no
    // mobile, e cada GET renderizaria o Dashboard de novo (ver o hook).
    const { linha, isLoading: linesLoading } = useNumeroPorId(organizationId, phoneNumberId);

    const [sectors, setSectors] = useState<Sector[]>([]);
    const [mySectorIds, setMySectorIds] = useState<string[]>([]);
    const [defaultSectorId, setDefaultSectorId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [reloadToken, setReloadToken] = useState(0);

    const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

    useEffect(() => {
        if (!organizationId) {
            setSectors([]);
            setMySectorIds([]);
            setDefaultSectorId(null);
            return;
        }

        let active = true;
        setLoading(true);

        void (async () => {
            const [sectorsRes, membershipsRes, memberRes] = await Promise.all([
                supabase
                    .from("sectors")
                    .select(SECTOR_SELECT)
                    .eq("organization_id", organizationId)
                    .order("name"),
                userId
                    ? supabase.from("sector_members").select("sector_id").eq("user_id", userId)
                    : Promise.resolve({ data: [], error: null }),
                userId
                    ? supabase
                        .from("organization_members")
                        .select("sector_id")
                        .eq("organization_id", organizationId)
                        .eq("user_id", userId)
                        .maybeSingle()
                    : Promise.resolve({ data: null, error: null }),
            ]);

            if (!active) return;

            if (sectorsRes.error) {
                console.error("[useSectors] erro ao buscar setores:", sectorsRes.error);
            }
            setSectors((sectorsRes.data ?? []) as Sector[]);

            // sector_members é filtrada por usuário e pela RLS da org: os ids que
            // sobram e não são desta organização simplesmente não casam com
            // nenhum setor de `sectors`, então não precisam de filtro extra aqui.
            setMySectorIds(((membershipsRes.data ?? []) as { sector_id: string }[]).map((row) => row.sector_id));
            setDefaultSectorId((memberRes.data as { sector_id: string | null } | null)?.sector_id ?? null);

            setLoading(false);
        })();

        return () => {
            active = false;
        };
    }, [organizationId, userId, reloadToken]);

    // Linha sem dado (mapa ou PK ainda carregando, ou que nem a PK mostra) conta
    // como desligada: esconde o filtro, nunca abre dado. Quem recorta as conversas
    // é a RLS, então errar aqui só some com um controle.
    const isolationEnabled = linha?.sectorIsolationEnabled ?? false;
    const followsOwner = isolationEnabled && (linha?.sectorFollowsOwner ?? false);

    const sectorsForLine = useMemo(
        () => sectorsForPhone(sectors, phoneNumberId),
        [sectors, phoneNumberId],
    );

    const byId = useMemo(
        () => new Map(sectors.map((sector) => [sector.id, sector])),
        [sectors],
    );

    return {
        sectors,
        sectorsForLine,
        byId,
        mySectorIds,
        defaultSectorId,
        isolationEnabled,
        followsOwner,
        loading: loading || linesLoading,
        refresh,
    };
};
