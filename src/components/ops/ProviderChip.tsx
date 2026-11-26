import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { providerDivergence, providerLabel } from "@/lib/lineProvider";

// Tons neutros de propósito: o risco (RiskBadge) é quem grita na linha.
const STYLES: Record<string, string> = {
    baileys: "bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300",
    zapo: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
};
const FALLBACK_STYLE = "bg-muted text-foreground";

export interface ProviderChipProps {
    /** phone_numbers.qr_provider — o que vale na próxima conexão. */
    db: string;
    /** Provider da sessão viva no serviço; null/undefined = sem sessão ou não consultado. */
    live: string | null | undefined;
    /** Lib e versão em uso (ex.: 'zapo-js@1.8'), quando o serviço informou. */
    libraryId?: string | null;
    /** Renderiza como botão de menu (seta + estado de foco). */
    interactive?: boolean;
    className?: string;
}

export function ProviderChip({ db, live, libraryId, interactive = false, className }: ProviderChipProps) {
    const pending = providerDivergence(db, live).kind === "pending";
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap",
                STYLES[db] ?? FALLBACK_STYLE,
                interactive && "transition-colors hover:brightness-95 dark:hover:brightness-110",
                className,
            )}
        >
            {pending && <span className="h-1.5 w-1.5 rounded-full bg-amber-600 dark:bg-amber-400" aria-hidden />}
            {providerLabel(db)}
            {interactive && <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />}
        </span>
    );
}
