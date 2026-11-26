import { useId } from "react";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useCopilotoPreferencia } from "@/hooks/useCopilotoPreferencia";
import { toUserMessage } from "@/lib/userFacingError";
import { CopilotoBichinho } from "@/components/chat/copiloto/CopilotoBichinho";

/** Chave pessoal do copiloto (Configurações > Perfil). Cada usuário liga para si. */
export function CopilotoPreferencia({ userId }: { userId: string }) {
  const { toast } = useToast();
  const { ligado, carregando, alterar, alterando } =
    useCopilotoPreferencia(userId);
  const tituloId = useId();
  const descricaoId = useId();

  const mudar = async (proximo: boolean) => {
    try {
      await alterar(proximo);
    } catch (erro) {
      console.error("[copiloto] falha ao salvar a preferência:", erro);
      toast({
        title: proximo
          ? "Não foi possível ligar o copiloto"
          : "Não foi possível desligar o copiloto",
        description: toUserMessage(erro, "Tente de novo em instantes."),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="bg-card border rounded-xl p-6">
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <h3 id={tituloId} className="flex items-center gap-2 font-medium">
            <CopilotoBichinho className="shrink-0" animado={false} />
            Copiloto de respostas
          </h3>
          <p id={descricaoId} className="text-sm text-muted-foreground">
            Lê a conversa aberta e sugere o que responder logo acima da caixa de
            mensagem. Clicar numa sugestão só coloca o texto na caixa: você
            confere e envia. Usa a chave de IA da organização.
          </p>
        </div>
        <Switch
          checked={ligado}
          onCheckedChange={(v) => void mudar(v)}
          disabled={carregando || alterando}
          aria-labelledby={tituloId}
          aria-describedby={descricaoId}
          className="mt-0.5 shrink-0"
        />
      </div>
    </div>
  );
}
