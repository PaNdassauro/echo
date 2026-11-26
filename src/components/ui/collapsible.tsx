import * as React from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";

import { cn } from "@/lib/utils";

const Collapsible = CollapsiblePrimitive.Root;

const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger;

/**
 * Expand/collapse animado por grid-template-rows (interruptível — keyframes de
 * height travam no meio se o usuário clicar de novo). forceMount mantém o
 * conteúdo no DOM para a saída animar; `invisible` no fechado tira os filhos
 * da ordem de tabulação (visibility respeita a transição ao sair).
 */
const CollapsibleContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleContent>
>(({ className, children, ...props }, ref) => (
  <CollapsiblePrimitive.CollapsibleContent
    ref={ref}
    forceMount
    className={cn(
      "grid grid-rows-[0fr] opacity-0 invisible",
      "data-[state=open]:grid-rows-[1fr] data-[state=open]:opacity-100 data-[state=open]:visible",
      "transition-[grid-template-rows,opacity,visibility] duration-200 ease-out-strong"
    )}
    {...props}
  >
    <div className="min-h-0 overflow-hidden">
      {/* className do caller AQUI dentro: no grid externo, space-y-* virava
          no-op (1 filho só) e padding ficava ocupando 12px com o painel
          fechado (track 0fr não encolhe padding do próprio elemento) */}
      <div className={className}>{children}</div>
    </div>
  </CollapsiblePrimitive.CollapsibleContent>
));
CollapsibleContent.displayName = CollapsiblePrimitive.CollapsibleContent.displayName;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
