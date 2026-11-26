import { useCallback, useState } from "react";
import { useCopiloto } from "@/hooks/chat/useCopiloto";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useCopilotoPreferencia } from "@/hooks/useCopilotoPreferencia";
import type { CopilotoMensagem } from "@/lib/copiloto";
import { CopilotoFaixa } from "./CopilotoFaixa";

/** Conveniência por navegador: faixa recolhida ou aberta. */
const CHAVE_RECOLHIDA = "echo:copiloto:recolhida";

function lerRecolhida(): boolean {
  try {
    return window.localStorage.getItem(CHAVE_RECOLHIDA) === "1";
  } catch {
    return false;
  }
}

function gravarRecolhida(valor: boolean) {
  try {
    window.localStorage.setItem(CHAVE_RECOLHIDA, valor ? "1" : "0");
  } catch {
    // Armazenamento bloqueado (aba privada): a preferência só não persiste.
  }
}

interface CopilotoDaConversaProps {
  conversationId: string | null;
  userId: string | null | undefined;
  messages: readonly CopilotoMensagem[];
  onInserir: (texto: string) => boolean;
  compacta?: boolean;
}

/**
 * Copiloto ligado à conversa aberta: preferência do usuário + gatilho + faixa.
 * Não renderiza nada com o copiloto desligado (Configurações > Perfil).
 */
export function CopilotoDaConversa({
  conversationId,
  userId,
  messages,
  onInserir,
  compacta,
}: CopilotoDaConversaProps) {
  const { ligado } = useCopilotoPreferencia(userId);
  const { currentOrganization } = useOrganization();
  const { estado, atualizar } = useCopiloto({
    conversationId,
    messages,
    ligado,
    organizacaoId: currentOrganization?.id ?? null,
  });
  const [recolhida, setRecolhida] = useState(lerRecolhida);
  const alternar = useCallback(() => {
    setRecolhida((atual) => {
      gravarRecolhida(!atual);
      return !atual;
    });
  }, []);

  if (estado.fase === "oculto") return null;
  return (
    <CopilotoFaixa
      estado={estado}
      recolhida={recolhida}
      onAlternarRecolhida={alternar}
      onAtualizar={atualizar}
      onInserir={onInserir}
      compacta={compacta}
    />
  );
}
