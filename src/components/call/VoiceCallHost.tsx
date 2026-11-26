import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useVoiceCalls, type ActiveCall, type IncomingRing } from "@/contexts/VoiceCallContext";
import ActiveCallPanel from "./ActiveCallPanel";
import IncomingCallCard from "./IncomingCallCard";

/** Saída: curta, e o card fica montado só o tempo dela. */
const EXIT_MS = 150;

type Content =
    | { kind: "panel"; call: ActiveCall }
    | { kind: "card"; ringing: IncomingRing; pendingCount: number };

/**
 * Único lugar do app onde a ligação aparece. Montado no App, acima das rotas e
 * do breakpoint — é o que permite atravessar troca de conversa, troca de linha e
 * navegação sem derrubar a ligação.
 *
 * `safe-area-inset` porque o Echo roda como PWA instalado: o card é `fixed` e
 * sem as insets do sistema encostaria no notch.
 *
 * `pointer-events-auto`: quando um Dialog do Radix está aberto ele põe
 * `pointer-events: none` no body, e sem isto o card ficaria visível e inclicável
 * — a ligação chegaria e não daria para atender.
 *
 * Movimento: entra deslizando da borda (300 ms) e sai com um deslocamento curto
 * de 8 px (150 ms) — saída mais suave e mais rápida que a entrada, as duas em
 * ease-out, e só `transform` e `opacity` transicionam. Durante a saída a ligação
 * já sumiu do contexto, então o último conteúdo é preservado (`lastRef`); sem
 * isso a animação de saída seria a de uma caixa vazia.
 */
export default function VoiceCallHost() {
    const { activeCall, ringing, pendingCount, inCall } = useVoiceCalls();

    // Uma ligação nova entrando tem precedência sobre o resumo da que acabou —
    // senão o card de "encerrada" a esconderia pelos 5 s até sumir sozinho.
    const live: Content | null = activeCall && (inCall || !ringing)
        ? { kind: "panel", call: activeCall }
        : ringing
            ? { kind: "card", ringing, pendingCount }
            : null;

    const lastRef = useRef<Content | null>(null);
    if (live) lastRef.current = live;

    const visible = live !== null;
    const [leaving, setLeaving] = useState(false);
    const [entered, setEntered] = useState(false);

    useEffect(() => {
        if (visible) {
            setLeaving(false);
            const frame = requestAnimationFrame(() => setEntered(true));
            return () => cancelAnimationFrame(frame);
        }
        setEntered(false);
        setLeaving(true);
        const timer = window.setTimeout(() => setLeaving(false), EXIT_MS);
        return () => window.clearTimeout(timer);
    }, [visible]);

    const content = live ?? (leaving ? lastRef.current : null);
    if (!content) return null;

    return (
        <div
            className={cn(
                "pointer-events-auto fixed inset-x-4 top-4 z-[60] sm:inset-x-auto sm:right-4 sm:top-auto sm:bottom-4 sm:w-80",
                // PWA instalado: sem isto o card fica sob o notch/barra de status
                // (topo no celular) e sob o recorte lateral no modo paisagem.
                "safe-area-inset",
                "transition-[transform,opacity] ease-out-strong motion-reduce:transition-[opacity]",
                entered && "translate-y-0 opacity-100 duration-300",
                // Antes de entrar, fora da borda; ao sair, só um passo curto.
                !entered && (visible
                    ? "-translate-y-[calc(100%+1rem)] opacity-0 duration-300 motion-reduce:translate-y-0 sm:translate-y-[calc(100%+1rem)] sm:motion-reduce:translate-y-0"
                    : "-translate-y-2 opacity-0 duration-150 motion-reduce:translate-y-0 sm:translate-y-2 sm:motion-reduce:translate-y-0"),
            )}
        >
            {content.kind === "panel"
                ? <ActiveCallPanel call={content.call} />
                : <IncomingCallCard ringing={content.ringing} pendingCount={content.pendingCount} />}
        </div>
    );
}
