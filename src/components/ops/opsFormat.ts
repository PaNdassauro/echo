import { format, formatDistanceToNowStrict } from "date-fns";
import { ptBR } from "date-fns/locale";

export function relativeTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    return formatDistanceToNowStrict(new Date(iso), { locale: ptBR, addSuffix: true });
}

export function shortDateTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    return format(new Date(iso), "dd/MM HH:mm:ss", { locale: ptBR });
}

export function closeLabel(code: number | null, reason: string | null): string {
    const c = code === null ? "∅" : String(code);
    return reason ? `${c} · ${reason}` : c;
}

/** Segundos entre o add em grupo e o close; negativo quando o add veio depois. */
export function secondsBetween(a: string, b: string): number {
    return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 1000);
}

/** Uptime curto do serviço: "<1min", "38min", "6h", "3d". */
export function formatUptime(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined) return "?";
    if (seconds < 60) return "<1min";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

/** Duração em ms para limites de proteção: "800ms", "1,5s", "2min". */
export function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${Number((ms / 1000).toFixed(1)).toLocaleString("pt-BR")}s`;
    return `${Math.round(ms / 60_000)}min`;
}
