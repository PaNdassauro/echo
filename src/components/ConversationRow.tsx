import { memo, useMemo, useSyncExternalStore } from "react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { AlertCircle, BellOff, Check, CheckCheck, CheckCircle2, Loader2, Megaphone, Pencil, Pin, User as UserIcon, UserPlus, Users } from "lucide-react";
import type { Conversation } from "@/types/conversation";
import { SwipeableRow } from "@/components/ui/swipeable-row";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ehDirect, identificacaoDoContato, temDirect } from "@/lib/directDoInstagram";
import { SECTOR_FALLBACK_COLOR, type Sector } from "@/lib/sectors";
import { formatUnreadCount, isConversationUnread, unreadWeight } from "@/lib/unread";
import { subscribeMinute, getMinuteVersion } from "@/lib/minuteTicker";
import { AssigneeAvatarStack } from "./AssigneeAvatarStack";
import { ConversationContextMenu } from "./ConversationContextMenu";
import { ConversationTagPills, type TagData } from "./ConversationTagPills";
import { SeloDirect } from "./SeloDirect";
import { SeloNumero } from "./SeloNumero";

/** Nome com até isto de caracteres cabe inteiro com folga: não precisa de piso. */
const SELO_NUMERO_NOME_CURTO = 10;

/**
 * Largura do selo do número na linha. Nome longo leva piso (10 caracteres do nome mais o que
 * não é nome: ponto, gap, padding e borda) para nunca virar "● A.", e teto para truncar.
 * Nome curto ("Loja", "Suporte") fica na largura natural e não encolhe: com o piso a pílula
 * ganharia espaço vazio dentro da borda. O selo NUNCA vira só o ponto: na coluna estreita
 * (`sidebar-narrow:`, 240px) ele segue "● Nome". O que muda ali é só a folga: o piso e o
 * `shrink` caem para `min-w-0`, para o nome truncar dentro da pílula (o horário cede primeiro)
 * em vez de a linha estourar.
 */
function seloNumeroClasses(nome: string): string {
    return nome.length > SELO_NUMERO_NOME_CURTO
        ? "shrink min-w-[calc(10ch+2.25rem)] max-w-[18ch] sidebar-narrow:min-w-0"
        : "shrink-0 sidebar-narrow:shrink sidebar-narrow:min-w-0";
}

/**
 * Handlers da linha. O pai entrega UM objeto com identidade estável (padrão
 * latest-ref) para que o React.memo abaixo só re-renderize a linha cujos dados
 * mudaram — com 5k conversas, recriar closures por linha a cada render do pai
 * anulava a virtualização.
 */
export interface ConversationRowActions {
    select: (conversationId: string) => void;
    keyDown: (e: React.KeyboardEvent, conversationId: string) => void;
    addTag: (conversationId: string, tagId: string, e: React.MouseEvent) => void;
    removeTag: (conversationId: string, tagId: string, e: React.MouseEvent) => void;
    assignToMe: (conversationId: string, e: React.MouseEvent) => void;
    resolveAndAssign: (conversationId: string) => void;
    swipeClose: (conversationId: string) => void;
    swipeMarkRead: (conversationId: string) => void;
    toggleUnread: (conversationId: string, isCurrentlyUnread: boolean) => void;
    exportConversation: (conversationId: string) => void;
    transfer: (conversationId: string) => void;
    togglePinned: (conversationId: string) => void;
    toggleArchived: (conversationId: string) => void;
    setMutedUntil: (conversationId: string, until: string | null) => void;
}

export interface ConversationRowProps {
    conversation: Conversation;
    isLast: boolean;
    isSelected: boolean;
    viewMode: "normal" | "compact";
    isMobile: boolean;
    /** Aba Encerrados: sem swipe/menu de encerrar. */
    canClose: boolean;
    showAssignButton: boolean;
    sectorIsolationEnabled: boolean;
    /** Setor da conversa (já resolvido pelo pai); undefined = sem setor ou desconhecido. */
    sector: Sector | undefined;
    /** Tags da conversa (array do mapa do pai; referência estável entre fetches). */
    convTags: TagData[];
    /** Tags visíveis para a linha selecionada; a linha filtra as já aplicadas. */
    tagsForLine: TagData[];
    unreadCount: number;
    isMarkedUnread: boolean;
    failedCount: number;
    /** Na fila de Disparos (ver src/lib/abaDaConversa.ts): pílula do disparo e sem botão "Assumir". */
    emDisparos: boolean;
    /** Linha de Disparos mostrada em outra aba (busca em Todos). */
    seloDisparos: boolean;
    /** Linha de Com a IA mostrada em outra aba (busca em Todos). */
    seloIa: boolean;
    hasDraft: boolean;
    isPinned: boolean;
    isArchived: boolean;
    isMuted: boolean;
    isAssigning: boolean;
    isExporting: boolean;
    /**
     * Selo do número da conversa, só na caixa conjunta (nulo no modo número: nada é
     * renderizado). Primitivas, e não o objeto do número, para o memo valer.
     */
    numeroNome?: string | null;
    numeroHue?: number | null;
    actions: ConversationRowActions;
}

const ConversationRowInner = ({
    conversation,
    isLast,
    isSelected,
    viewMode,
    isMobile,
    canClose,
    showAssignButton,
    sectorIsolationEnabled,
    sector,
    convTags,
    tagsForLine,
    unreadCount,
    isMarkedUnread,
    failedCount,
    emDisparos,
    seloDisparos,
    seloIa,
    hasDraft,
    isPinned,
    isArchived,
    isMuted,
    isAssigning,
    isExporting,
    numeroNome = null,
    numeroHue = null,
    actions,
}: ConversationRowProps) => {
    // "há X minutos" envelhece sem prop nova: um relógio compartilhado, só as
    // linhas montadas assinam (ver src/lib/minuteTicker.ts).
    useSyncExternalStore(subscribeMinute, getMinuteVersion);

    // Filter tags by conversation's phone number AND exclude already assigned tags
    const availableTags = useMemo(
        () =>
            tagsForLine.filter(
                (t) => !convTags.find((ct) => ct.id === t.id) && t.phone_number_id === conversation.phone_number_id,
            ),
        [tagsForLine, convTags, conversation.phone_number_id],
    );

    // Duas fontes, uma leitura: contador do servidor + marcação
    // manual. É `isUnread` que comanda toda a ênfase da linha —
    // `unreadCount` sozinho só decide o formato do badge.
    const isUnread = isConversationUnread(unreadCount, isMarkedUnread);
    // Marcada à mão sem mensagem nova conta como 1: o badge é
    // sempre um número, nunca um desenho à parte.
    const unreadBadge = unreadWeight(unreadCount, isMarkedUnread);

    const rotuloDoDisparo = conversation.disparo_rotulo || "Disparo";
    const campanhasDoDisparo = emDisparos ? (conversation.disparo_campanhas ?? []).join(", ") : "";
    // Se a pessoa leu o último disparo (o status vem do recibo, pelo banco).
    const statusDoDisparo = !emDisparos ? null
        : conversation.disparo_status === "read" ? { Icone: CheckCheck, texto: "lida", cor: "text-blue-600 dark:text-blue-400" }
        : conversation.disparo_status === "delivered" ? { Icone: CheckCheck, texto: "entregue", cor: "text-muted-foreground" }
        : conversation.disparo_status === "sent" ? { Icone: Check, texto: "enviada", cor: "text-muted-foreground" }
        : conversation.disparo_status === "failed" ? { Icone: AlertCircle, texto: "não entregue", cor: "text-destructive" }
        : null;

    // Compact view
    const compactContent = (
        <div
            className={cn(
                // `group`: o botão "+" de tag só aparece no hover da row
                // em ponteiro fino (ver TagSelectorPopover size="sm").
                "group theme-conversation-row relative w-full px-3 py-2 text-left cursor-pointer bg-card transition-colors duration-150 ease-out",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                // Hover neutro só em linhas NÃO selecionadas — senão o cinza 4%
                // substituía o tint de seleção e a linha ativa "desmarcava" no hover.
                "data-[selected=false]:hover:bg-foreground/[0.04] data-[selected=false]:active:bg-foreground/[0.07]",
                isSelected &&
                    "bg-accent/10 dark:bg-accent/15 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary"
            )}
            id={`conv-row-${conversation.id}`}
            role="option"
            aria-selected={isSelected}
            tabIndex={-1}
            onKeyDown={(e) => actions.keyDown(e, conversation.id)}
            data-selected={isSelected}
            onClick={() => actions.select(conversation.id)}
        >
            <div className="flex items-center gap-2">
                {/* Avatar/Icon */}
                <Avatar className="w-8 h-8 shrink-0 sidebar-narrow:hidden">
                    {conversation.contact_avatar_url && (
                        <AvatarImage src={conversation.contact_avatar_url} alt={conversation.contact_name} />
                    )}
                    <AvatarFallback className="bg-muted text-muted-foreground text-xs">
                        {conversation.is_group ? (
                            <Users className="w-4 h-4" />
                        ) : (
                            conversation.contact_name.substring(0, 2).toUpperCase()
                        )}
                    </AvatarFallback>
                </Avatar>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                            <span
                                className={cn("text-sm truncate", isUnread ? "font-bold" : "font-medium")}
                                title={conversation.contact_name}
                            >
                                {conversation.contact_name}
                            </span>
                            {temDirect(conversation) && <SeloDirect junto={!ehDirect(conversation)} />}
                            {seloDisparos && (
                                <span className="shrink-0 rounded-full bg-slate-500/15 px-1.5 py-px text-2xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                                    Disparos
                                </span>
                            )}
                            {seloIa && (
                                <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 py-px text-2xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
                                    Com a IA
                                </span>
                            )}
                            {/* Compacta sem espaço para os dois: fora da aba fica só o selo. */}
                            {emDisparos && !seloDisparos && (
                                <span
                                    className="inline-flex items-center gap-0.5 min-w-0 rounded-full bg-slate-500/15 px-1.5 py-px text-2xs font-medium text-slate-600 dark:text-slate-300"
                                    title={rotuloDoDisparo}
                                >
                                    <Megaphone className="w-2.5 h-2.5 shrink-0" />
                                    <span className="truncate">{rotuloDoDisparo}</span>
                                </span>
                            )}
                        </div>
                        {/* Na visão compacta o selo do número entra antes do horário. Sem selo (modo número)
                            o horário é `shrink-0`, como sempre. Com selo o bloco tem teto de 55% e é o
                            horário que cede (`min-w-0 shrink-[4] truncate`), como na visão normal: "cerca de
                            3 horas" não é curto, e o selo tem piso (~10 caracteres do nome, ver
                            `seloNumeroClasses`). O bloco é `shrink-0`: quem absorve a falta de espaço é o
                            nome do contato, que já é `min-w-0`. 8 dos 16 números dividem a cor, então o
                            nome do número é o sinal principal. */}
                        <div className={cn("flex items-center gap-1.5 shrink-0", numeroNome && "max-w-[55%]")}>
                            {numeroNome && <SeloNumero nome={numeroNome} hue={numeroHue} className={seloNumeroClasses(numeroNome)} />}
                            <span className={cn("text-xs tabular-nums", numeroNome ? "min-w-0 shrink-[4] truncate" : "shrink-0 whitespace-nowrap", isUnread ? "text-primary font-medium" : "text-muted-foreground")}>
                                {formatDistanceToNow(new Date(conversation.last_message_at), {
                                    addSuffix: false,
                                    locale: ptBR,
                                })}
                            </span>
                        </div>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <p className={cn("text-xs truncate", isUnread ? "text-foreground font-medium" : "text-muted-foreground")}>
                            <span className="opacity-60">
                                {conversation.is_group ? 'Grupo' : identificacaoDoContato(conversation)}
                            </span>
                            {/* Em Disparos a prévia é o próprio disparo: as campanhas dizem mais. */}
                            {campanhasDoDisparo ? (
                                <>
                                    <span className="mx-1">·</span>
                                    {campanhasDoDisparo}
                                </>
                            ) : conversation.last_message_preview && (
                                <>
                                    <span className="mx-1">·</span>
                                    {conversation.last_message_direction === 'outbound' && (
                                        <span className="text-foreground/70">Você: </span>
                                    )}
                                    {conversation.last_message_preview}
                                </>
                            )}
                        </p>
                        {/* Tags antes do cluster de estado: assim os ícones
                            (rascunho/pin/mudo/falha/não-lidas) ficam colados
                            na borda direita e não dançam quando uma tag entra
                            ou sai. A pílula compacta tem leading-4 — a mesma
                            altura do preview —, então a linha não cresce. */}
                        <ConversationTagPills
                            compact
                            tags={convTags}
                            availableTags={availableTags}
                            onAdd={(tagId, e) => actions.addTag(conversation.id, tagId, e)}
                            onRemove={(tagId, e) => actions.removeTag(conversation.id, tagId, e)}
                        />
                        {hasDraft && (
                            <Pencil className="w-3 h-3 text-primary shrink-0" aria-label="Rascunho pendente" />
                        )}
                        {isPinned && (
                            <Pin className="w-3 h-3 text-muted-foreground shrink-0" aria-label="Fixada" />
                        )}
                        {isMuted && (
                            <BellOff className="w-3 h-3 text-muted-foreground shrink-0" aria-label="Silenciada" />
                        )}
                        {failedCount > 0 && (
                            <AlertCircle
                                className="w-4 h-4 text-destructive shrink-0"
                                aria-label="Falha no envio"
                            />
                        )}
                        {unreadBadge > 0 && (
                            <span className="flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-2xs font-medium tabular-nums shrink-0">
                                {formatUnreadCount(unreadBadge)}
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );

    // Normal view
    const conversationContent = (
        <div
            className={cn(
                "theme-conversation-row relative w-full px-3 py-2.5 text-left cursor-pointer bg-card transition-colors duration-150 ease-out",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                // Hover neutro só em linhas NÃO selecionadas — senão o cinza 4%
                // substituía o tint de seleção e a linha ativa "desmarcava" no hover.
                "data-[selected=false]:hover:bg-foreground/[0.04] data-[selected=false]:active:bg-foreground/[0.07]",
                isSelected &&
                    "bg-accent/10 dark:bg-accent/15 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary"
            )}
            id={`conv-row-${conversation.id}`}
            role="option"
            aria-selected={isSelected}
            tabIndex={-1}
            onKeyDown={(e) => actions.keyDown(e, conversation.id)}
            data-selected={isSelected}
            onClick={() => actions.select(conversation.id)}
        >
            <div className="flex gap-2">
                {/* Avatar */}
                <Avatar className="w-11 h-11 shrink-0 sidebar-narrow:hidden">
                    {conversation.contact_avatar_url && (
                        <AvatarImage src={conversation.contact_avatar_url} alt={conversation.contact_name} />
                    )}
                    <AvatarFallback className="bg-muted text-muted-foreground text-sm">
                        {conversation.is_group ? (
                            <Users className="w-5 h-5" />
                        ) : (
                            conversation.contact_name.substring(0, 2).toUpperCase()
                        )}
                    </AvatarFallback>
                </Avatar>

                {/* Conteúdo */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                            <span
                                className={cn("text-sm truncate", isUnread ? "font-bold" : "font-semibold")}
                                title={conversation.contact_name}
                            >
                                {conversation.contact_name}
                            </span>
                            {temDirect(conversation) && <SeloDirect junto={!ehDirect(conversation)} />}
                            {seloDisparos && (
                                <span className="shrink-0 rounded-full bg-slate-500/15 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                                    Disparos
                                </span>
                            )}
                            {seloIa && (
                                <span className="shrink-0 rounded-full bg-violet-500/15 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
                                    Com a IA
                                </span>
                            )}
                            {hasDraft && (
                                <Pencil className="w-3.5 h-3.5 text-primary shrink-0" aria-label="Rascunho pendente" />
                            )}
                            {isPinned && (
                                <Pin className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-label="Fixada" />
                            )}
                            {isMuted && (
                                <BellOff className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-label="Silenciada" />
                            )}
                            {failedCount > 0 && (
                                <AlertCircle
                                    className="w-4 h-4 text-destructive shrink-0"
                                    aria-label="Falha no envio"
                                />
                            )}
                            {unreadBadge > 0 && (
                                <span className="flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium tabular-nums shrink-0">
                                    {formatUnreadCount(unreadBadge)}
                                </span>
                            )}
                        </div>
                        {/* Só "Pendente" ganha pill — "Ativa"/"Fechada" eram redundantes
                            (a aba já diz isso) e roubavam o canto nobre da linha. */}
                        {/* O token de fill puro como texto dava ~1.8:1 sobre fundo claro:
                            por isso o texto usa amber-700/400. */}
                        {conversation.status === "pending" && (
                            <Badge
                                variant="outline"
                                className="text-xs shrink-0 bg-status-pending/15 text-amber-700 dark:text-amber-400 border-status-pending/30"
                            >
                                Pendente
                            </Badge>
                        )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {conversation.is_group ? 'Grupo' : identificacaoDoContato(conversation)}
                    </p>

                    {/* Last message preview */}
                    {conversation.last_message_preview && (
                        <p className={cn("text-xs truncate mb-2 flex items-center gap-1", isUnread ? "text-foreground font-medium" : "text-muted-foreground")}>
                            {conversation.last_message_direction === 'outbound' && (
                                <span className="font-medium text-foreground/70 shrink-0">Você:</span>
                            )}
                            <span className="truncate">{conversation.last_message_preview}</span>
                        </p>
                    )}
                    {!conversation.last_message_preview && <div className="mb-2" />}

                    {emDisparos && (
                        <div className="mb-2 min-w-0">
                            <span
                                className="inline-flex items-center gap-1 max-w-full rounded-full bg-slate-500/15 px-2 py-0.5 text-xs text-slate-600 dark:text-slate-300"
                                title={rotuloDoDisparo}
                            >
                                <Megaphone className="w-3 h-3 shrink-0" />
                                <span className="truncate">{rotuloDoDisparo}</span>
                            </span>
                            {(campanhasDoDisparo || statusDoDisparo) && (
                                <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                                    <p className="text-muted-foreground truncate" title={campanhasDoDisparo}>
                                        {campanhasDoDisparo}
                                    </p>
                                    {statusDoDisparo && (
                                        <span className={cn("inline-flex items-center gap-0.5 shrink-0", statusDoDisparo.cor)}>
                                            <statusDoDisparo.Icone className="w-3 h-3" />
                                            {statusDoDisparo.texto}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Setor e tags. O setor vem primeiro e é
                        contorno, não pílula cheia: classifica
                        como uma tag mas não se remove daqui —
                        muda por Assumir ou Encaminhar. */}
                    <div className="flex flex-wrap items-center gap-1 mb-2">
                        {sectorIsolationEnabled && (
                            conversation.sector_id ? (
                                <span
                                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border text-muted-foreground"
                                    title={`Setor: ${sector?.name ?? "desconhecido"}`}
                                >
                                    <span
                                        className="w-2 h-2 rounded-full shrink-0"
                                        style={{
                                            backgroundColor: sector?.color ?? SECTOR_FALLBACK_COLOR,
                                        }}
                                    />
                                    {sector?.name ?? "Outro setor"}
                                </span>
                            ) : (
                                <span
                                    className="inline-flex items-center text-xs px-2 py-0.5 rounded-full border border-dashed text-muted-foreground"
                                    title="Sem setor: aparece para todos os atendentes da linha até alguém assumir"
                                >
                                    Sem setor
                                </span>
                            )
                        )}

                        <ConversationTagPills
                            tags={convTags}
                            availableTags={availableTags}
                            onAdd={(tagId, e) => actions.addTag(conversation.id, tagId, e)}
                            onRemove={(tagId, e) => actions.removeTag(conversation.id, tagId, e)}
                        />
                    </div>

                    <div className="flex items-center justify-between gap-2">
                        {/* "há 5 min · ● Vendas API": o selo do número fica junto do horário (só na caixa conjunta). */}
                        {/* Com selo, o horário cede primeiro (encolhe e trunca) e o selo mantém o piso. */}
                        <div className={cn("flex items-center gap-1.5", numeroNome ? "min-w-0" : "shrink-0 sidebar-narrow:min-w-0 sidebar-narrow:shrink")}>
                            <p className={cn(
                                "text-xs",
                                numeroNome
                                    ? "min-w-0 shrink-[4] truncate whitespace-nowrap"
                                    : "shrink-0 sidebar-narrow:shrink sidebar-narrow:min-w-0 sidebar-narrow:truncate",
                                isUnread ? "text-primary font-medium" : "text-muted-foreground",
                            )}>
                                {formatDistanceToNow(new Date(conversation.last_message_at), {
                                    addSuffix: true,
                                    locale: ptBR,
                                })}
                            </p>
                            {numeroNome && (
                                <>
                                    <span aria-hidden className="text-xs text-muted-foreground sidebar-narrow:hidden">·</span>
                                    <SeloNumero nome={numeroNome} hue={numeroHue} className={seloNumeroClasses(numeroNome)} />
                                </>
                            )}
                        </div>
                        {conversation.assigned_to !== null && conversation.profiles && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1 min-w-0 truncate">
                                <UserIcon className="w-3 h-3 shrink-0" />
                                <span className="truncate">
                                    {conversation.profiles.first_name || conversation.profiles.email?.split('@')[0] || 'Usuário'}
                                </span>
                                {conversation.co_assignee_ids && conversation.co_assignee_ids.length > 0 && (
                                    <AssigneeAvatarStack
                                        coOwners={conversation.co_assignee_ids}
                                        max={2}
                                        compact
                                        className="ml-1"
                                    />
                                )}
                            </span>
                        )}
                        {/* Em Disparos o Assumir sai da linha (ninguém escreveu ainda);
                            o do botão direito e o do cabeçalho continuam. */}
                        {showAssignButton && conversation.assigned_to === null && !emDisparos && (
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs shrink-0 sidebar-narrow:w-7 sidebar-narrow:px-0"
                                title="Assumir"
                                disabled={isAssigning}
                                onClick={(e) => actions.assignToMe(conversation.id, e)}
                            >
                                {isAssigning ? (
                                    <Loader2 className="w-3 h-3 mr-1 sidebar-narrow:mr-0 animate-spin" />
                                ) : (
                                    <UserPlus className="w-3 h-3 mr-1 sidebar-narrow:mr-0" />
                                )}
                                {/* Coluna estreita: só o ícone; o texto segue para leitor de tela. */}
                                <span className="sidebar-narrow:sr-only">Assumir</span>
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );

    const contentToRender = viewMode === "compact" ? compactContent : conversationContent;

    // Mobile: swipe ação-por-threshold (encerrar ← / marcar lido →),
    // religado — o gesto do WhatsApp que estava desabilitado.
    // Sem motion.div/layout: dentro do Virtuoso a medição de layout
    // por linha custa caro e o exit nunca roda de verdade.
    if (isMobile) {
        return (
            <div className={cn("border-b", isLast && "border-b-0")}>
                {/* Na aba Encerrados o swipe de encerrar sai: reescrevia
                    closed_at/closed_by e o Desfazer corrompia o estado */}
                <SwipeableRow
                    leftAction={!canClose ? undefined : {
                        icon: <CheckCircle2 className="w-5 h-5" />,
                        label: "Encerrar",
                        color: "hsl(38 92% 50%)",
                        onClick: () => actions.swipeClose(conversation.id),
                    }}
                    rightAction={{
                        icon: <CheckCheck className="w-5 h-5" />,
                        label: "Lido",
                        color: "hsl(142 71% 45%)",
                        onClick: () => actions.swipeMarkRead(conversation.id),
                    }}
                >
                    {contentToRender}
                </SwipeableRow>
            </div>
        );
    }

    // Desktop: botão direito abre o menu da linha. O gate por
    // isMobile não é cosmético — o Radix também abre com toque
    // longo, que no celular brigaria com o pan do SwipeableRow.
    return (
        <div className={cn("border-b", isLast && "border-b-0")}>
            <ConversationContextMenu
                isUnread={isUnread}
                canAssign={conversation.assigned_to === null}
                canClose={canClose}
                isAssigning={isAssigning}
                isExporting={isExporting}
                isPinned={isPinned}
                isArchived={isArchived}
                isMuted={isMuted}
                onToggleUnread={() => actions.toggleUnread(conversation.id, isUnread)}
                onExport={() => actions.exportConversation(conversation.id)}
                onAssign={() => actions.resolveAndAssign(conversation.id)}
                onTransfer={() => actions.transfer(conversation.id)}
                onCloseConversation={() => actions.swipeClose(conversation.id)}
                onTogglePinned={() => actions.togglePinned(conversation.id)}
                onToggleArchived={() => actions.toggleArchived(conversation.id)}
                onSetMutedUntil={(until) => actions.setMutedUntil(conversation.id, until)}
            >
                {contentToRender}
            </ConversationContextMenu>
        </div>
    );
};

/**
 * Linha da lista de conversas, memoizada. Todas as props são primitivas ou
 * objetos estáveis por id (a Conversation vinda dos reducers preserva a
 * referência quando nada mudou), então um evento realtime em UMA conversa
 * re-renderiza só a linha dela.
 */
export const ConversationRow = memo(ConversationRowInner);
ConversationRow.displayName = "ConversationRow";
