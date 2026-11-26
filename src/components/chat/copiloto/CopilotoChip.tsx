import { useEffect, useId, useRef, useState } from "react";
import { Check } from "lucide-react";
import { IconSwap } from "@/components/ui/icon-swap";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { COPILOTO_INTENCAO_LABEL, type CopilotoSugestao } from "@/lib/copiloto";

/** Quanto tempo o ✓ fica no chip depois de inserir. */
const INSERIDO_MS = 1200;

interface CopilotoChipProps {
  sugestao: CopilotoSugestao;
  /** Põe o texto no composer. Devolve false quando não deu (conversa trocou, composer fechado). */
  onInserir: (texto: string) => boolean;
  compacta?: boolean;
}

/**
 * Uma sugestão. Clicar INSERE no composer (nunca envia): o atendente confere e manda.
 * O "porque" aparece no hover/foco e vai para leitor de tela pelo aria-describedby.
 */
export function CopilotoChip({
  sugestao,
  onInserir,
  compacta = false,
}: CopilotoChipProps) {
  const descricaoId = useId();
  const [inserido, setInserido] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const inserir = () => {
    if (!onInserir(sugestao.texto)) return;
    setInserido(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setInserido(false), INSERIDO_MS);
  };

  const rotulo = COPILOTO_INTENCAO_LABEL[sugestao.intencao];

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={inserir}
            aria-describedby={descricaoId}
            className={cn(
              "flex min-h-8 items-start gap-2 rounded-[18px] border border-foreground/10 bg-foreground/[0.04] px-3 py-1.5 text-left text-sm leading-snug text-foreground",
              "transition-[background-color,border-color,transform] duration-150 ease-out hover:border-foreground/20 hover:bg-foreground/[0.08] active:scale-[0.96]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              compacta
                ? "w-[78vw] max-w-[320px] shrink-0 snap-start"
                : "max-w-full",
            )}
          >
            <IconSwap
              active={inserido ? "ok" : "marca"}
              durationMs={150}
              className="mt-[3px] size-3.5 text-muted-foreground"
              icons={{
                marca: (
                  <span className="size-1.5 rounded-full bg-foreground/35" />
                ),
                ok: (
                  <Check
                    className="size-3.5 text-foreground"
                    strokeWidth={2.5}
                  />
                ),
              }}
            />
            <span className="line-clamp-2 min-w-0">{sugestao.texto}</span>
          </button>
        </TooltipTrigger>
        {sugestao.porque && (
          <TooltipContent side="top" align="start" className="max-w-xs">
            <p className="text-xs">
              <span className="font-medium">{rotulo}</span>
              <span className="text-muted-foreground">
                {" "}
                · {sugestao.porque}
              </span>
            </p>
          </TooltipContent>
        )}
      </Tooltip>
      {/* Fora do botão: dentro, o texto entraria também no nome acessível. */}
      <span id={descricaoId} className="sr-only">
        {sugestao.porque ? `${rotulo}. ${sugestao.porque}` : rotulo}
      </span>
    </>
  );
}
