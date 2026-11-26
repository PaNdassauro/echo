import { CheckCircle, XCircle, Clock, Loader2, Send, Ban, FileEdit, CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Single source of truth for broadcast status presentation.
 *
 * This table used to be copy-pasted three times (Broadcasts.tsx, BroadcastDetails.tsx,
 * ScheduledMessagesList.tsx), each with hardcoded palette colours like
 * `bg-yellow-500/10 text-yellow-600` and no dark variant — so every status was
 * low-contrast in dark mode and off-brand under the four `data-app-theme` presets.
 * These use the semantic tokens, which already define separate dark values.
 *
 * Note the explicit `variant="outline"`: the default Badge variant carries
 * `hover:bg-primary/80`, and tailwind-merge cannot drop a modified variant when the
 * override only replaces the base `bg-primary`. Omitting it made every status badge
 * flash solid teal on hover.
 */

type StatusMeta = {
    label: string;
    Icon: typeof CheckCircle;
    /** Tint + text colour, both token-based so light/dark/presets all work. */
    className: string;
    spin?: boolean;
};

const RECIPIENT_STATUS: Record<string, StatusMeta> = {
    sent: { label: "Enviado", Icon: CheckCircle, className: "bg-success/10 text-success border-success/20" },
    failed: { label: "Falhou", Icon: XCircle, className: "bg-destructive/10 text-destructive border-destructive/20" },
    sending: { label: "Enviando", Icon: Loader2, className: "bg-info/10 text-info border-info/20", spin: true },
    pending: { label: "Pendente", Icon: Clock, className: "bg-warning/10 text-warning border-warning/20" },
};

// Also covers scheduled_messages, whose statuses are the same set plus 'sent'.
const BROADCAST_STATUS: Record<string, StatusMeta> = {
    draft: { label: "Rascunho", Icon: FileEdit, className: "bg-muted text-muted-foreground border-border" },
    scheduled: { label: "Agendado", Icon: CalendarClock, className: "bg-info/10 text-info border-info/20" },
    processing: { label: "Enviando", Icon: Loader2, className: "bg-warning/10 text-warning border-warning/20", spin: true },
    sent: { label: "Enviado", Icon: CheckCircle, className: "bg-success/10 text-success border-success/20" },
    completed: { label: "Concluído", Icon: CheckCircle, className: "bg-success/10 text-success border-success/20" },
    failed: { label: "Falhou", Icon: XCircle, className: "bg-destructive/10 text-destructive border-destructive/20" },
    cancelled: { label: "Cancelado", Icon: Ban, className: "bg-muted text-muted-foreground border-border" },
};

const FALLBACK: StatusMeta = { label: "—", Icon: Send, className: "bg-muted text-muted-foreground border-border" };

export function recipientStatusMeta(status: string): StatusMeta {
    return RECIPIENT_STATUS[status] ?? { ...FALLBACK, label: status };
}

export function broadcastStatusMeta(status: string): StatusMeta {
    return BROADCAST_STATUS[status] ?? { ...FALLBACK, label: status };
}

function StatusBadge({ meta, className }: { meta: StatusMeta; className?: string }) {
    const { label, Icon, spin } = meta;
    return (
        <Badge variant="outline" className={cn("gap-1 font-medium", meta.className, className)}>
            <Icon className={cn("h-3 w-3", spin && "animate-spin motion-reduce:animate-none")} />
            {label}
        </Badge>
    );
}

export function RecipientStatusBadge({ status, className }: { status: string; className?: string }) {
    return <StatusBadge meta={recipientStatusMeta(status)} className={className} />;
}

export function BroadcastStatusBadge({ status, className }: { status: string; className?: string }) {
    return <StatusBadge meta={broadcastStatusMeta(status)} className={className} />;
}
