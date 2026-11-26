import { ReactNode } from "react";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
    Archive,
    ArchiveRestore,
    ArrowRightLeft,
    Bell,
    BellOff,
    CheckCircle2,
    Download,
    Loader2,
    Mail,
    MailOpen,
    Pin,
    PinOff,
    UserPlus,
} from "lucide-react";

interface ConversationContextMenuProps {
    children: ReactNode;
    /** Estado composto da linha (contador OU marcação manual) — ver src/lib/unread.ts. */
    isUnread: boolean;
    /** Só faz sentido oferecer "Assumir" em conversa sem responsável. */
    canAssign: boolean;
    /** Fora na aba Encerrados: reencerrar reescreve closed_at/closed_by. */
    canClose: boolean;
    /** Bloqueia o clique repetido enquanto o assumir anterior está em voo. */
    isAssigning: boolean;
    /** Bloqueia o clique repetido enquanto a planilha anterior está sendo gerada. */
    isExporting: boolean;
    // Preferências POR USUÁRIO (conversation_prefs) — paridade WhatsApp
    isPinned: boolean;
    isArchived: boolean;
    isMuted: boolean;
    onToggleUnread: () => void;
    onExport: () => void;
    onAssign: () => void;
    onTransfer: () => void;
    onCloseConversation: () => void;
    onTogglePinned: () => void;
    onToggleArchived: () => void;
    /** ISO, "infinity" (sempre) ou null para reativar o som. */
    onSetMutedUntil: (until: string | null) => void;
}

/** Durações do submenu Silenciar (mesmas opções do WhatsApp). */
const MUTE_OPTIONS: Array<{ label: string; hours: number | "forever" }> = [
    { label: "8 horas", hours: 8 },
    { label: "1 semana", hours: 24 * 7 },
    { label: "Sempre", hours: "forever" },
];

/**
 * Menu de botão direito da linha de conversa.
 *
 * Só é montado no desktop (ver o gate em ConversationsList): no mobile o Radix
 * abriria com toque longo e brigaria com o pan do SwipeableRow, que já entrega
 * arquivar e marcar-lido pelo gesto.
 *
 * Nenhuma ação daqui é nova — todas reaproveitam os caminhos que a lista e o
 * ChatArea já usam. O menu é o affordance que faltava no desktop, não uma
 * segunda implementação delas.
 */
export const ConversationContextMenu = ({
    children,
    isUnread,
    canAssign,
    canClose,
    isAssigning,
    isExporting,
    isPinned,
    isArchived,
    isMuted,
    onToggleUnread,
    onExport,
    onAssign,
    onTransfer,
    onCloseConversation,
    onTogglePinned,
    onToggleArchived,
    onSetMutedUntil,
}: ConversationContextMenuProps) => (
    <ContextMenu>
        {/* asChild: o trigger não pode inserir um wrapper próprio, senão a linha
            perde o papel de option da listbox e a navegação por teclado quebra. */}
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-56">
            {/* Vale também na conversa aberta: quem chama fecha o painel antes
                de marcar (senão o auto-lido do ChatArea apagaria na hora). */}
            <ContextMenuItem onSelect={onToggleUnread}>
                {isUnread ? (
                    <MailOpen className="mr-2 h-4 w-4" />
                ) : (
                    <Mail className="mr-2 h-4 w-4" />
                )}
                {isUnread ? "Marcar como lida" : "Marcar como não lida"}
            </ContextMenuItem>

            <ContextMenuSeparator />

            {/* Preferências pessoais — não mexem no estado da conversa para o time */}
            <ContextMenuItem onSelect={onTogglePinned}>
                {isPinned ? (
                    <PinOff className="mr-2 h-4 w-4" />
                ) : (
                    <Pin className="mr-2 h-4 w-4" />
                )}
                {isPinned ? "Desafixar" : "Fixar"}
            </ContextMenuItem>

            <ContextMenuItem onSelect={onToggleArchived}>
                {isArchived ? (
                    <ArchiveRestore className="mr-2 h-4 w-4" />
                ) : (
                    <Archive className="mr-2 h-4 w-4" />
                )}
                {isArchived ? "Desarquivar" : "Arquivar"}
            </ContextMenuItem>

            {isMuted ? (
                <ContextMenuItem onSelect={() => onSetMutedUntil(null)}>
                    <Bell className="mr-2 h-4 w-4" />
                    Reativar som
                </ContextMenuItem>
            ) : (
                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <BellOff className="mr-2 h-4 w-4" />
                        Silenciar
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-40">
                        {MUTE_OPTIONS.map((opt) => (
                            <ContextMenuItem
                                key={opt.label}
                                onSelect={() =>
                                    onSetMutedUntil(
                                        opt.hours === "forever"
                                            ? "infinity"
                                            : new Date(Date.now() + opt.hours * 3_600_000).toISOString()
                                    )
                                }
                            >
                                {opt.label}
                            </ContextMenuItem>
                        ))}
                    </ContextMenuSubContent>
                </ContextMenuSub>
            )}

            {/* Exportar é leitura: fica fora do bloco de ações de atendimento.
                O onSelect fecha o menu na hora, então o Loader2 só aparece se o
                usuário reabrir o menu com o export em voo — quem dá o retorno
                visível é o toast de quem chama. */}
            <ContextMenuItem disabled={isExporting} onSelect={onExport}>
                {isExporting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                    <Download className="mr-2 h-4 w-4" />
                )}
                Exportar conversa (.xlsx)
            </ContextMenuItem>

            <ContextMenuSeparator />

            {canAssign && (
                <ContextMenuItem disabled={isAssigning} onSelect={onAssign}>
                    <UserPlus className="mr-2 h-4 w-4" />
                    Assumir conversa
                </ContextMenuItem>
            )}

            <ContextMenuItem onSelect={onTransfer}>
                <ArrowRightLeft className="mr-2 h-4 w-4" />
                Transferir conversa
            </ContextMenuItem>

            {/* Terminal como no ChatHeader, e com o mesmo par ícone+cor de lá:
                encerrar é a única ação daqui que fecha o atendimento. */}
            {canClose && (
                <ContextMenuItem
                    onSelect={onCloseConversation}
                    className="text-destructive focus:text-destructive"
                >
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Encerrar conversa
                </ContextMenuItem>
            )}
        </ContextMenuContent>
    </ContextMenu>
);
