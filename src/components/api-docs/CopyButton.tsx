import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
    value: string;
    /** Descrição do que é copiado, para leitor de tela. */
    label: string;
    className?: string;
}

/**
 * Confirmação inline, sem toast.
 *
 * O botão que a pessoa acabou de clicar já é o lugar onde ela está olhando —
 * um toast do Sonner é peso de notificação para um evento que o próprio
 * controle confirma. O anúncio para leitor de tela vai num live region, que
 * não ocupa espaço visual.
 */
export function CopyButton({ value, label, className }: CopyButtonProps) {
    const [copied, setCopied] = useState(false);
    const timeout = useRef<ReturnType<typeof setTimeout>>();

    useEffect(() => () => clearTimeout(timeout.current), []);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            return; // clipboard negado — não finge que copiou
        }
        setCopied(true);
        clearTimeout(timeout.current);
        timeout.current = setTimeout(() => setCopied(false), 2000);
    };

    return (
        <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? `${label} copiado` : `Copiar ${label}`}
            className={cn(
                "relative inline-flex h-7 w-7 items-center justify-center rounded-md",
                "text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out-strong",
                // O recuo no press é a única parte que some com reduced motion;
                // a troca de cor continua, porque ela é o feedback, não enfeite.
                "hover:bg-muted hover:text-foreground active:scale-[0.96] motion-reduce:active:scale-100",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                className,
            )}
        >
            {/* Os dois ícones ficam empilhados e fazem crossfade: trocar o nó
                cortaria a transição, e o ícone apareceria do nada. */}
            <Copy
                aria-hidden
                className={cn(
                    "absolute h-3.5 w-3.5 transition-[opacity,transform] duration-150 ease-out-strong",
                    "motion-reduce:transition-[opacity] motion-reduce:!scale-100",
                    copied ? "scale-90 opacity-0" : "scale-100 opacity-100",
                )}
            />
            <Check
                aria-hidden
                className={cn(
                    "absolute h-3.5 w-3.5 text-emerald-600 transition-[opacity,transform] duration-150 ease-out-strong dark:text-emerald-400",
                    "motion-reduce:transition-[opacity] motion-reduce:!scale-100",
                    copied ? "scale-100 opacity-100" : "scale-90 opacity-0",
                )}
            />
            <span aria-live="polite" className="sr-only">
                {copied ? "Copiado" : ""}
            </span>
        </button>
    );
}
