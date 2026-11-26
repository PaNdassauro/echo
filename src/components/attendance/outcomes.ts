import { CheckCheck, CalendarClock, Hourglass, MessageSquareX, type LucideIcon } from "lucide-react";

export type OutcomeKey = "same_day" | "other_day" | "open" | "unanswered";

export interface OutcomeDef {
    key: OutcomeKey;
    label: string;
    short: string;
    /** CSS var de src/index.css — status fixo, não segue o preset de tema */
    color: string;
    icon: LucideIcon;
}

/**
 * Ordem = ordem de empilhamento nos gráficos. Os dois verdes ficam lado a lado
 * de propósito: são o mesmo desfecho ("resolvido"), separados por luminosidade.
 */
export const OUTCOMES: OutcomeDef[] = [
    { key: "same_day", label: "Resolvidos no mesmo dia", short: "Mesmo dia", color: "var(--outcome-same-day)", icon: CheckCheck },
    { key: "other_day", label: "Resolvidos em outro dia", short: "Outro dia", color: "var(--outcome-other-day)", icon: CalendarClock },
    { key: "open", label: "Em aberto", short: "Em aberto", color: "var(--outcome-open)", icon: Hourglass },
    { key: "unanswered", label: "Sem resposta", short: "Sem resposta", color: "var(--outcome-unanswered)", icon: MessageSquareX },
];

export type OutcomeCounts = Record<OutcomeKey, number>;
