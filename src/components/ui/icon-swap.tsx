import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Troca de ícone por estado SEM corte seco.
 *
 * Em vez de `{copied ? <Check/> : <Copy/>}` (desmonta/monta e o ícone
 * "teleporta"), todos os ícones ficam no DOM empilhados na mesma célula de um
 * grid; só o ativo é visível. A transição é a receita do better-ui:
 * opacity 0→1, scale 0.25→1, blur 4px→0, curva cubic-bezier(0.2, 0, 0, 1).
 *
 * O wrapper dimensiona pelo maior ícone — não precisa de tamanho fixo.
 *
 * @example
 * <IconSwap
 *   active={copied ? "check" : "copy"}
 *   icons={{ copy: <Copy className="h-4 w-4" />, check: <Check className="h-4 w-4 text-success" /> }}
 * />
 */
export interface IconSwapProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Chave do ícone visível. Se não existir em `icons`, nenhum aparece. */
  active: string;
  /** Mapa chave → ícone. Todos são renderizados; só o ativo fica visível. */
  icons: Record<string, React.ReactNode>;
  /** Duração da troca em ms. Padrão 200 (alta frequência: 150). */
  durationMs?: number;
}

export function IconSwap({ active, icons, className, durationMs = 200, ...props }: IconSwapProps) {
  return (
    <span
      className={cn(
        "relative inline-grid shrink-0 place-items-center align-middle [&>*]:col-start-1 [&>*]:row-start-1",
        className,
      )}
      {...props}
    >
      {Object.entries(icons).map(([key, icon]) => {
        const isActive = key === active;
        return (
          <span
            key={key}
            aria-hidden={!isActive}
            className={cn(
              "inline-flex items-center justify-center transition-[opacity,transform,filter] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
              isActive ? "opacity-100 scale-100 blur-0" : "pointer-events-none opacity-0 scale-[0.25] blur-[4px]",
            )}
            style={{ transitionDuration: `${durationMs}ms` }}
          >
            {icon}
          </span>
        );
      })}
    </span>
  );
}
