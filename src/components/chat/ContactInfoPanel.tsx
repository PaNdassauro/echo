import { History, Loader2, User, X } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AssigneeAvatarStack } from "@/components/AssigneeAvatarStack";
import { useIsMobile } from "@/hooks/use-mobile";
import { ConversationMediaTabs } from "./media/ConversationMediaTabs";

interface ContactInfoPanelProps {
    conversationId: string;
    contactName: string;
    contactPhone: string;
    contactAvatarUrl: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** "closed" = conversa encerrada; qualquer outro valor conta como aberta. */
    status: string | null;
    /** null = triagem (conversa nasce sem setor). */
    sectorName: string | null;
    primaryAssigneeId: string | null;
    coOwnerIds: string[];
    /** Abre o diálogo de compartilhar (mesmo destino do stack no header). */
    onShare?: () => void;
    /** Só em linha QR: a Cloud API não tem fila offline para pedir. */
    onRefetchHistory?: () => void;
    isRefetchingHistory?: boolean;
}

/**
 * Perfil do contato em 1:1 — identidade, posse e toda a mídia da conversa.
 *
 * Terceira coluna in-flow no desktop (o chat continua utilizável ao lado) e Sheet inferior no mobile.
 */
export function ContactInfoPanel({
    conversationId,
    contactName,
    contactPhone,
    contactAvatarUrl,
    open,
    onOpenChange,
    status,
    sectorName,
    primaryAssigneeId,
    coOwnerIds,
    onShare,
    onRefetchHistory,
    isRefetchingHistory,
}: ContactInfoPanelProps) {
    const isMobile = useIsMobile();
    const isClosed = status === "closed";
    // O stack aceita uma lista só; o responsável principal vem primeiro.
    const assignees = [primaryAssigneeId, ...coOwnerIds].filter(
        (id): id is string => Boolean(id),
    );

    const identity = (
        <div className="flex flex-col items-center gap-3 border-b p-6 text-center">
            <Avatar className="h-20 w-20">
                {contactAvatarUrl && <AvatarImage src={contactAvatarUrl} alt={contactName} />}
                <AvatarFallback className="bg-muted text-lg text-muted-foreground">
                    {contactName.substring(0, 2).toUpperCase()}
                </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
                <h2 className="truncate text-base font-semibold" title={contactName}>{contactName}</h2>
                <p className="truncate text-sm text-muted-foreground" title={contactPhone}>{contactPhone}</p>
            </div>
        </div>
    );

    const meta = (
        <div className="flex flex-col gap-3 border-b p-4">
            <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                    {assignees.length > 1 ? "Responsáveis" : "Responsável"}
                </span>
                <div className="ml-auto">
                    {assignees.length > 0 ? (
                        <AssigneeAvatarStack coOwners={assignees} onClick={onShare} compact />
                    ) : (
                        <span className="text-xs text-muted-foreground">Ninguém atribuído</span>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Status</span>
                <div className="ml-auto flex items-center gap-2">
                    <Badge variant={isClosed ? "secondary" : "default"}>
                        {isClosed ? "Encerrada" : "Aberta"}
                    </Badge>
                    <Badge variant="outline">{sectorName ?? "Triagem"}</Badge>
                </div>
            </div>

            {onRefetchHistory && (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={onRefetchHistory}
                    disabled={isRefetchingHistory}
                    className="w-full"
                >
                    {isRefetchingHistory ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                        <History className="mr-2 h-4 w-4" />
                    )}
                    Recuperar mensagens
                </Button>
            )}
        </div>
    );

    const body = (
        <>
            {identity}
            {meta}
            <ConversationMediaTabs conversationId={conversationId} active={open} />
        </>
    );

    if (isMobile) {
        return (
            <Sheet open={open} onOpenChange={onOpenChange}>
                <SheetContent
                    side="bottom"
                    className="flex h-[85dvh] w-full max-w-full flex-col p-0"
                >
                    <SheetHeader className="shrink-0 border-b p-4 safe-area-top">
                        <SheetTitle className="flex items-center gap-2 pr-8">
                            <User className="h-5 w-5" />
                            <span className="truncate">Perfil do contato</span>
                        </SheetTitle>
                    </SheetHeader>
                    {body}
                </SheetContent>
            </Sheet>
        );
    }

    // Desktop: coluna fixa, sem overlay — o chat continua utilizável ao lado.
    if (!open) return null;

    return (
        <aside className="flex w-[360px] shrink-0 flex-col overflow-hidden border-l bg-card min-h-0 xl:w-[400px]">
            <div className="flex shrink-0 items-center gap-2 border-b p-4">
                <User className="h-5 w-5" />
                <h2 className="truncate text-sm font-semibold">Perfil do contato</h2>
                <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-8 w-8"
                    onClick={() => onOpenChange(false)}
                    title="Fechar painel"
                    aria-label="Fechar painel"
                >
                    <X className="h-4 w-4" />
                </Button>
            </div>
            {body}
        </aside>
    );
}

export default ContactInfoPanel;
