import { ChevronDown, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CopilotoEstado } from "@/hooks/chat/useCopiloto";
import { CopilotoChip } from "./CopilotoChip";
import { CopilotoBichinho } from "./CopilotoBichinho";

/** Stagger entre as sugestões que chegam juntas. */
const STAGGER_MS = 40;

export type CopilotoEstadoVisivel = Exclude<CopilotoEstado, { fase: "oculto" }>;

interface CopilotoFaixaProps {
  estado: CopilotoEstadoVisivel;
  recolhida: boolean;
  onAlternarRecolhida: () => void;
  onAtualizar: () => void;
  onInserir: (texto: string) => boolean;
  /** Mobile: sugestões numa linha só, com rolagem lateral. */
  compacta?: boolean;
}

/**
 * Faixa do copiloto, logo acima do composer. Monocromática (só foreground e
 * background): segue qualquer preset de tema. A linha de cima tem altura fixa
 * em todos os estados, então só a chegada das sugestões mexe no layout.
 */
export function CopilotoFaixa({
  estado,
  recolhida,
  onAlternarRecolhida,
  onAtualizar,
  onInserir,
  compacta = false,
}: CopilotoFaixaProps) {
  const lendo = estado.fase === "lendo";
  const sugestoes = estado.fase === "pronto" ? estado.sugestoes : [];
  const mostrarSugestoes = !recolhida && sugestoes.length > 0;
  // Lote novo = lista nova: a chave remonta a <ul> e a entrada roda uma vez por análise.
  const lote = sugestoes.map((s) => s.texto).join("\u0000");

  return (
    <section
      aria-label="Copiloto de respostas"
      className="border-t border-foreground/10 bg-background/80 px-3 py-1.5 backdrop-blur-sm md:px-4"
    >
      <div className="flex h-7 items-center gap-2">
        <CopilotoBichinho humor={estado.fase} className="shrink-0" />
        <span className="shrink-0 text-xs font-medium text-foreground">
          Copiloto
        </span>
        <span aria-hidden="true" className="text-xs text-muted-foreground/60">
          ·
        </span>
        <p
          aria-live="polite"
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
        >
          <Linha estado={estado} recolhida={recolhida} />
        </p>

        {estado.fase === "erro" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={onAtualizar}
          >
            Tentar de novo
          </Button>
        )}
        {estado.fase !== "erro" && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onAtualizar}
            disabled={lendo}
            aria-label={
              estado.fase === "pronto" ? "Sugerir de novo" : "Sugerir agora"
            }
            title={
              estado.fase === "pronto" ? "Sugerir de novo" : "Sugerir agora"
            }
          >
            <RotateCw className="size-3.5" />
          </Button>
        )}
        {sugestoes.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onAlternarRecolhida}
            aria-expanded={!recolhida}
            aria-label={recolhida ? "Mostrar sugestões" : "Recolher sugestões"}
            title={recolhida ? "Mostrar sugestões" : "Recolher sugestões"}
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-200 ease-out-strong",
                recolhida && "rotate-180",
              )}
            />
          </Button>
        )}
      </div>

      {mostrarSugestoes && (
        <ul
          key={lote}
          aria-label="Sugestões de resposta"
          className={cn(
            "mt-1 flex gap-1.5 pb-0.5",
            compacta
              ? "-mx-3 snap-x snap-mandatory overflow-x-auto scroll-px-3 px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              : "flex-wrap",
          )}
        >
          {sugestoes.map((sugestao, i) => (
            <li
              key={i}
              className={cn("copiloto-entra", !compacta && "max-w-full")}
              style={{ animationDelay: `${i * STAGGER_MS}ms` }}
            >
              <CopilotoChip
                sugestao={sugestao}
                onInserir={onInserir}
                compacta={compacta}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Linha({
  estado,
  recolhida,
}: {
  estado: CopilotoEstadoVisivel;
  recolhida: boolean;
}) {
  switch (estado.fase) {
    case "lendo":
      return <span className="copiloto-shimmer">Lendo a conversa…</span>;
    case "erro":
      return <>{estado.mensagem}</>;
    case "ocioso":
      return <>Aguardando o cliente</>;
    case "pronto": {
      const total = estado.sugestoes.length;
      if (total === 0) return <>{estado.momento || "Nada a sugerir agora"}</>;
      const contagem = total === 1 ? "1 sugestão" : `${total} sugestões`;
      if (recolhida)
        return (
          <>{estado.momento ? `${estado.momento} · ${contagem}` : contagem}</>
        );
      return <>{estado.momento || contagem}</>;
    }
  }
}
