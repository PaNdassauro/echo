/**
 * Liga/desliga o isolamento por setor de UMA linha.
 *
 * Vive num componente próprio porque "Números" não é um painel só: são duas
 * abas com componentes independentes — PhoneNumbersSettings (Business API) e
 * QRCodeConnect (Baileys). A flag é da linha
 * (`phone_numbers.sector_isolation_enabled`) e não sabe nada de tipo de conexão,
 * então o controle tem de existir nas duas, e o UPDATE + os toasts moram aqui em
 * vez de duplicados.
 *
 * O que a flag faz de verdade está na RLS (políticas do baseline): com ela
 * ligada, o atendente só enxerga as conversas dos setores dele mais as que ainda
 * estão sem setor (a triagem). Desligar NÃO apaga `conversations.sector_id` —
 * religar devolve a mesma divisão, e é por isso que este switch é o rollback de
 * primeira instância da feature.
 *
 * ADMIN ONLY, e a checagem mora AQUI e não nos call sites: a aba "Números" é
 * visível para qualquer membro (só "Equipe" é gated em Settings.tsx), e são três
 * painéis independentes que renderizam este switch — gate por call site seria
 * esquecido no quarto. Não é a fronteira de segurança: a policy
 * `phone_numbers_manage` já exige admin da org ou super admin. O gate existe
 * porque um UPDATE barrado por RLS no PostgREST **não devolve erro**, devolve
 * zero linhas — o agente veria o switch virar e o toast confirmar sem nada ter
 * mudado no banco.
 *
 * A invalidação do mapa de números (`useAccessiblePhoneNumbers`, de onde o chat
 * tira o isolamento da linha) também mora AQUI, pelo mesmo motivo do gate: com
 * ela nos call sites, o terceiro painel (a visão por número de Configurações >
 * Equipe) a esqueceria, e o chat de uma linha desativada, lido pela PK com cache
 * de 5 min, seguiria com a flag velha.
 *
 * Com o isolamento ligado aparece a segunda chave, "Só quem assumiu vê a
 * conversa" (`phone_numbers.sector_follows_owner`):
 * o setor da conversa passa a acompanhar o dono (gatilho no banco), e com um
 * setor por atendente cada um vê só a conversa sem dono e a dele. Sem o
 * isolamento ela não faz nada, então fica escondida.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/contexts/OrganizationContext";
import { invalidarNumerosAcessiveis } from "@/hooks/useAccessiblePhoneNumbers";
import { toUserMessage } from "@/lib/userFacingError";

/** As duas chaves da linha que este controle grava. */
export interface IsolamentoDaLinha {
    sector_isolation_enabled: boolean;
    sector_follows_owner: boolean;
}

interface SectorIsolationSwitchProps {
    /** `phone_numbers.id` — a linha, não o id externo da Meta. */
    phoneNumberId: string;
    enabled: boolean;
    /** `phone_numbers.sector_follows_owner`. */
    followsOwner: boolean;
    /** Pintar o estado novo na hora (cada painel guarda a própria lista). */
    onOptimisticChange: (patch: Partial<IsolamentoDaLinha>) => void;
    /** Falhou: o painel refaz o fetch e volta ao estado do banco. */
    onFailure: () => void;
    /** -1 enquanto o painel está recolhido, para o switch sair da ordem de Tab. */
    tabIndex?: number;
}

const SectorIsolationSwitch = ({
    phoneNumberId,
    enabled,
    followsOwner,
    onOptimisticChange,
    onFailure,
    tabIndex,
}: SectorIsolationSwitchProps) => {
    const { toast } = useToast();
    const { userRole, isSuperAdmin } = useOrganization();
    // Antes do return condicional: hook depois dele mudaria a ordem dos hooks.
    const queryClient = useQueryClient();

    if (!isSuperAdmin && userRole !== "admin") return null;

    /** Grava uma das chaves; o texto de erro e de sucesso vem de quem chama. */
    const gravar = async (
        patch: Partial<IsolamentoDaLinha>,
        erro: string,
        sucesso: { title: string; description: string },
    ) => {
        onOptimisticChange(patch);

        const { error } = await supabase.from("phone_numbers").update(patch).eq("id", phoneNumberId);

        if (error) {
            toast({ title: erro, description: toUserMessage(error), variant: "destructive" });
            onFailure();
            return;
        }

        void invalidarNumerosAcessiveis(queryClient);
        toast(sucesso);
    };

    const handleChange = (checked: boolean) =>
        gravar({ sector_isolation_enabled: checked }, "Não foi possível atualizar isolamento por setor", {
            title: checked ? "Isolamento por setor ativado" : "Isolamento por setor desativado",
            description: checked
                ? "Cada atendente passa a ver só as conversas dos setores dele e as que ainda estão sem setor."
                : "Todos os atendentes da linha voltam a ver todas as conversas dela.",
        });

    const handleFollowsOwnerChange = (checked: boolean) =>
        gravar({ sector_follows_owner: checked }, "Não foi possível atualizar quem vê a conversa", {
            title: checked ? "Só quem assumiu vê a conversa" : "O setor não acompanha mais o dono",
            description: checked
                ? "Ao assumir ou receber uma conversa, ela vai para o setor da pessoa. Ao liberar, volta a aparecer para todos."
                : "Transferir e assumir deixam de mudar o setor da conversa. A divisão atual fica como está.",
        });

    return (
        <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                    <Label htmlFor={`sector-isolation-${phoneNumberId}`} className="text-sm font-medium">
                        Isolar conversas por setor
                    </Label>
                    <p className="text-xs text-muted-foreground">
                        Cada atendente vê só as conversas dos setores dele. Conversa nova fica sem setor
                        e aparece para todos até alguém assumir. Desligar não apaga a classificação:
                        religar devolve a mesma divisão.
                    </p>
                </div>
                <Switch
                    id={`sector-isolation-${phoneNumberId}`}
                    checked={enabled}
                    onCheckedChange={handleChange}
                    tabIndex={tabIndex}
                />
            </div>
            {enabled && (
                <div className="flex items-start justify-between gap-3 border-l-2 border-border pl-3">
                    <div className="space-y-0.5">
                        <Label htmlFor={`sector-follows-owner-${phoneNumberId}`} className="text-sm font-medium">
                            Só quem assumiu vê a conversa
                        </Label>
                        <p className="text-xs text-muted-foreground">
                            O setor da conversa acompanha o dono: ao assumir ou receber uma transferência, ela
                            vai para o setor da pessoa, e ao liberar volta a aparecer para todos. Use com um
                            setor por atendente. Compartilhar mantém a conversa visível para as duas pessoas.
                        </p>
                    </div>
                    <Switch
                        id={`sector-follows-owner-${phoneNumberId}`}
                        checked={followsOwner}
                        onCheckedChange={handleFollowsOwnerChange}
                        tabIndex={tabIndex}
                    />
                </div>
            )}
        </div>
    );
};

export default SectorIsolationSwitch;
