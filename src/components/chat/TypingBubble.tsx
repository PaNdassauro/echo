import { cn } from "@/lib/utils";

interface TypingBubbleProps {
  /** Nome de quem digita. Só em grupo — em 1:1 o dono da bolha é óbvio. */
  name?: string;
  state: "typing" | "recording";
  /** Saindo: o nó continua montado durante o animate-out. */
  leaving?: boolean;
}

/**
 * Bolha de "digitando" no rodapé da lista, com a mesma geometria da bolha de
 * mensagem recebida (MessageBubble) — é o que a faz ler como "a próxima mensagem
 * está vindo" em vez de um aviso do sistema.
 *
 * Não rola nada: a bolha mora no Footer do Virtuoso e, enquanto a lista está
 * grudada no fim, o useStickToBottom acompanha o crescimento do Footer pelo
 * ResizeObserver. Fora do fim, nada rola.
 *
 * A entrada reusa o mesmo animate-in das mensagens (200ms, --ease-out-strong):
 * coerência importa mais aqui do que ter uma curva própria.
 */
const DOT_DELAYS = ["0ms", "160ms", "320ms"];

const TypingBubble = ({ name, state, leaving }: TypingBubbleProps) => {
  const label = state === "recording"
    ? `${name ? `${name} está g` : "G"}ravando um áudio`
    : `${name ? `${name} está d` : "D"}igitando`;

  return (
    <div className="flex flex-col items-start px-4 pb-2">
      <div
        className={cn(
          "max-w-[85%] sm:max-w-[70%] rounded-2xl px-4 py-2 shadow-sm",
          "bg-chat-bubble-contact text-chat-bubble-contact-foreground",
          // Sai pelo mesmo caminho por onde entrou (de baixo), que é de onde vêm
          // as mensagens novas. fill-mode-forwards é obrigatório: o animate-out
          // do plugin não fixa o estado final, e sem ele o nó volta a opacidade
          // 1 por um frame antes de desmontar — um flash no fim de cada saída.
          leaving
            ? "animate-out fade-out-0 slide-out-to-bottom-2 fill-mode-forwards"
            : "animate-in fade-in-0 slide-in-from-bottom-2",
        )}
        style={{
          animationDuration: leaving ? "150ms" : "200ms",
          animationTimingFunction: "var(--ease-out-strong)",
        }}
      >
        {/* O texto carrega o significado; os pontinhos são só o pulso visual.
            Em 1:1 fica só a animação, como no WhatsApp. */}
        <div className="flex items-center gap-2">
          {name && (
            <span className="text-xs font-medium opacity-70">{name}</span>
          )}
          <span className="flex items-center gap-1" aria-hidden="true">
            {DOT_DELAYS.map((delay) => (
              <span
                key={delay}
                className={cn(
                  "h-1.5 w-1.5 rounded-full bg-current opacity-35",
                  "motion-safe:animate-typing-dot",
                  // Reduced motion sem animação: o animate-pulse anima a
                  // opacidade até .5, sobrescrevia o opacity-35 e deixava os
                  // pontinhos MAIS claros que no modo normal — invertia a
                  // intenção. Um estado estático legível comunica o mesmo.
                  "motion-reduce:opacity-60",
                )}
                style={{ animationDelay: delay }}
              />
            ))}
          </span>
          <span className="sr-only">{label}</span>
        </div>
      </div>
    </div>
  );
};

export default TypingBubble;
