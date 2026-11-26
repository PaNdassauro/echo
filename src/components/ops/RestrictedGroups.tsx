import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldAlert } from "lucide-react";
import type { RestrictedGroup } from "@/hooks/useConnectionHealth";
import { relativeTime, shortDateTime } from "./opsFormat";

interface RestrictedGroupsProps {
    groups: RestrictedGroup[];
    lineNames: Map<string, string>;
    selectedId: string | null;
}

function restrictionLabel(g: RestrictedGroup): string {
    const parts: string[] = [];
    if (g.suspended) parts.push("suspenso pelo WhatsApp");
    if (g.growth_locked_until) parts.push(`entrada de membros travada até ${shortDateTime(g.growth_locked_until)}`);
    if (g.appeal_status && g.appeal_status !== "none") parts.push(`apelo: ${g.appeal_status.replace(/_/g, " ")}`);
    return parts.join(" · ") || "restrito";
}

/**
 * Grupos que o WhatsApp penalizou. É o aviso antes do 401/403 da sessão: o mesmo
 * anti-abuso que suspende um grupo é o que depois derruba o número.
 * Só aparece quando há algo a mostrar.
 */
export function RestrictedGroups({ groups, lineNames, selectedId }: RestrictedGroupsProps) {
    const visible = selectedId ? groups.filter((g) => g.phone_number_id === selectedId) : groups;
    if (visible.length === 0) return null;

    return (
        <Card className="border-orange-500/40 bg-card shadow-sm">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                    <ShieldAlert className="h-4 w-4 text-orange-600 dark:text-orange-400" aria-hidden />
                    Grupos restritos pelo WhatsApp
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                    Suspensão ou trava de crescimento vistas ao abrir o grupo. Parar de adicionar participantes por essa linha.
                </p>
            </CardHeader>
            <CardContent className="p-0">
                <ul className="divide-y divide-border">
                    {visible.map((g) => (
                        <li key={`${g.phone_number_id}:${g.group_jid}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
                            <div className="min-w-0">
                                <div className="truncate font-medium">{g.subject ?? g.group_jid}</div>
                                <div className="text-xs text-muted-foreground">
                                    {lineNames.get(g.phone_number_id) ?? "—"} · {restrictionLabel(g)}
                                </div>
                            </div>
                            <span className="text-xs text-muted-foreground" title={shortDateTime(g.seen_at)}>
                                visto {relativeTime(g.seen_at)}
                            </span>
                        </li>
                    ))}
                </ul>
            </CardContent>
        </Card>
    );
}
