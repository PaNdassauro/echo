/**
 * "Assumir" uma conversa: o mesmo caminho para o botão da linha, o item do
 * menu de botão direito e o botão do cabeçalho da conversa aberta.
 *
 * Otimista na lista do contexto (a conversa aparece como minha na hora, com
 * rollback no erro) e com a escolha de setor quando a linha tem isolamento e
 * o atendente atende mais de um setor nela. O diálogo dessa escolha vem pronto
 * em `dialogoDeSetor`: quem usa o hook só o renderiza.
 */

import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useNotifications } from "@/contexts/NotificationContext";
import { useToast } from "@/hooks/use-toast";
import type { SectorsState } from "@/hooks/useSectors";
import { resolveAssumeSector, type Sector } from "@/lib/sectors";
import { toUserMessage } from "@/lib/userFacingError";
import type { Conversation } from "@/types/conversation";
import SectorPickerDialog from "@/components/SectorPickerDialog";

interface UseAssumirConversaOptions {
    userId: string;
    /** Número de reserva (phone_numbers.id), para a conversa que não diz o dela. */
    phoneNumberId: string | null;
    /** O useSectors que quem chama já tem: o hook não busca setores de novo. */
    setores: Pick<SectorsState, "sectors" | "byId" | "mySectorIds" | "defaultSectorId">;
    /** O número tem isolamento por setor ligado? Na caixa conjunta cada número tem o seu. */
    comIsolamento: (phoneNumberId: string | null) => boolean;
    /** Perfil de um membro, para o nome do responsável entrar já no otimista. */
    perfilDe?: (userId: string) => Conversation["profiles"] | undefined;
    /** Avisa quem reconcilia a lista que esta conversa mudou localmente. */
    aoTocar?: (conversationId: string) => void;
}

export function useAssumirConversa({ userId, phoneNumberId, setores, comIsolamento, perfilDe, aoTocar }: UseAssumirConversaOptions) {
    const { toast } = useToast();
    const { findConversation, setConversations, refreshConversationById } = useNotifications();
    const [assigningId, setAssigningId] = useState<string | null>(null);
    // Numa fila disputada, um assumir por vez. Ref além do estado: dois cliques
    // no mesmo frame ainda veriam o estado antigo.
    const emVooRef = useRef<string | null>(null);
    // Setor ambíguo: o atendente tem dois ou mais setores na linha e nenhum é o
    // padrão dele, então a conversa espera a escolha.
    const [pendente, setPendente] = useState<{ conversationId: string; options: Sector[] } | null>(null);

    /**
     * Assumir de fato. `sectorId` só vem preenchido quando a conversa está em
     * triagem E a linha tem isolamento ligado — ver resolveAndAssign.
     */
    const assignToMe = async (conversationId: string, sectorId: string | null) => {
        if (emVooRef.current) return;
        emVooRef.current = conversationId;
        setAssigningId(conversationId);

        const previousSector = findConversation(conversationId)?.sector_id ?? null;
        const perfil = perfilDe?.(userId);

        aoTocar?.(conversationId);
        setConversations((prev) =>
            prev.map((c) =>
                c.id === conversationId
                    ? {
                          ...c,
                          assigned_to: userId,
                          // O UPDATE realtime não traz o embed profiles e o reducer só
                          // o troca quando assigned_to MUDA — como já mudou aqui no
                          // otimista, o nome tem de entrar agora ou fica vazio.
                          profiles: perfil ?? null,
                          ...(sectorId ? { sector_id: sectorId } : {}),
                      }
                    : c,
            ),
        );

        const { error } = await supabase
            .from("conversations")
            .update(sectorId ? { assigned_to: userId, sector_id: sectorId } : { assigned_to: userId })
            .eq("id", conversationId);

        emVooRef.current = null;
        setAssigningId(null);

        if (error) {
            setConversations((prev) =>
                prev.map((c) =>
                    c.id === conversationId
                        ? { ...c, assigned_to: null, profiles: null, sector_id: previousSector }
                        : c,
                ),
            );
            toast({
                title: "Não foi possível assumir conversa",
                description: toUserMessage(error, "Verifique a conexão e tente novamente."),
                variant: "destructive",
            });
            return;
        }

        // Sem o perfil em mãos (cabeçalho da conversa), a linha rebusca com o
        // embed para o nome do responsável não ficar vazio.
        if (perfil === undefined) void refreshConversationById(conversationId);

        const sectorName = sectorId ? setores.byId.get(sectorId)?.name : undefined;
        toast({
            title: "Conversa assumida",
            description: sectorName
                ? `Você é responsável por esta conversa, agora no setor ${sectorName}`
                : "Você agora é responsável por esta conversa",
        });
    };

    /** Decide o setor e assume. Ponto único de todos os gatilhos de "Assumir". */
    const resolveAndAssign = (conversationId: string) => {
        if (emVooRef.current) return;

        const conversation = findConversation(conversationId);

        // Duas guardas antes de mexer em setor:
        //
        // 1. Linha sem isolamento não tem UI de setor nenhuma (nem filtro, nem
        //    badge). Gravar setor aqui seria classificação invisível, e ligar o
        //    switch depois esconderia conversas por ação que ninguém viu
        //    acontecer. Classificar histórico é trabalho do backfill.
        // 2. Conversa que JÁ tem setor não é triagem — é fila de um setor. Um
        //    atendente de dois setores não pode movê-la para o padrão dele só
        //    por clicar em "Assumir"; para mudar de setor existe o encaminhar.
        //
        // As duas valem para o número DA CONVERSA: na caixa conjunta cada número tem o próprio
        // isolamento e os próprios setores.
        const numeroDaConversa = conversation?.phone_number_id ?? phoneNumberId;
        if (!comIsolamento(numeroDaConversa) || conversation?.sector_id) {
            void assignToMe(conversationId, null);
            return;
        }

        const resolution = resolveAssumeSector({
            sectors: setores.sectors,
            phoneNumberId: numeroDaConversa,
            mySectorIds: setores.mySectorIds,
            defaultSectorId: setores.defaultSectorId,
        });

        if (resolution.needsChoice) {
            setPendente({ conversationId, options: resolution.options });
            return;
        }

        void assignToMe(conversationId, resolution.sectorId);
    };

    const dialogoDeSetor = (
        <SectorPickerDialog
            open={pendente !== null}
            onOpenChange={(open) => {
                if (!open) setPendente(null);
            }}
            title="Assumir em qual setor?"
            description="Você atende mais de um setor neste número. A conversa fica com o setor escolhido, e os atendentes dos outros setores deixam de vê-la."
            sectors={pendente?.options ?? []}
            confirmLabel="Assumir"
            pending={assigningId !== null}
            onConfirm={(sectorId) => {
                const escolha = pendente;
                setPendente(null);
                if (escolha) void assignToMe(escolha.conversationId, sectorId);
            }}
        />
    );

    return { assigningId, resolveAndAssign, dialogoDeSetor };
}
