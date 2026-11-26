import { memo, RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { IconSwap } from "@/components/ui/icon-swap";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CheckCircle2,
  Clock,
  Users,
  UserCircle,
  Search,
  Pencil,
  Check,
  X,
  ArrowLeft,
  MoreVertical,
  History,
  Loader2,
  Zap,
  Send,
  Phone,
  MessageSquare,
  Bell,
  Star,
  Heart,
  Bookmark,
  Share2,
  Upload,
  Download,
  FileText,
  User,
  Settings,
  Mail,
  Calendar,
  MapPin,
  Link,
  Globe,
  Briefcase,
  ShoppingCart,
  CreditCard,
  Plus,
  Handshake,
  LogOut,
  Building2,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { IdCopyButton } from "@/components/ui/id-copy-button";
import { nomeNoWhatsAppSeApelido, rotuloEditarNome } from "@/lib/nomeDoGrupo";
import { Conversation } from "@/hooks/chat";
import { ActionButtonConfig } from "@/hooks/useActionButton";
import { ehDirect, identificacaoDoContato, temDirect } from "@/lib/directDoInstagram";
import { SeloDirect } from "@/components/SeloDirect";
import { SeloNumero } from "@/components/SeloNumero";

// Icon mapping
const ICON_MAP: Record<string, LucideIcon> = {
  'plus': Plus,
  'zap': Zap,
  'send': Send,
  'phone': Phone,
  'message-square': MessageSquare,
  'bell': Bell,
  'star': Star,
  'heart': Heart,
  'bookmark': Bookmark,
  'share-2': Share2,
  'upload': Upload,
  'download': Download,
  'file-text': FileText,
  'user': User,
  'users': Users,
  'settings': Settings,
  'mail': Mail,
  'calendar': Calendar,
  'clock': Clock,
  'map-pin': MapPin,
  'link': Link,
  'globe': Globe,
  'briefcase': Briefcase,
  'shopping-cart': ShoppingCart,
  'credit-card': CreditCard,
};

const getIcon = (iconName: string): LucideIcon => ICON_MAP[iconName] || Zap;

interface WindowExpiration {
  isExpired: boolean;
  timeRemaining: number;
  expiresAt: Date;
}

interface ChatHeaderProps {
  conversation: Conversation;
  isMobile: boolean;
  isQrConnection: boolean;
  isFreeTextChannel?: boolean; // QR — channel with no 24h window
  /** Nome e cor do número da conversa, em qualquer modo (nulo só se o número ainda não resolveu: sem selo). */
  numeroNome?: string | null;
  numeroHue?: number | null;
  isUpdating: boolean;

  // Mobile back
  onMobileBack?: () => void;

  // Edit name
  isEditingName: boolean;
  editNameValue: string;
  setEditNameValue: (value: string) => void;
  editNameInputRef: RefObject<HTMLInputElement>;
  isSavingName: boolean;
  startEditName: () => void;
  saveContactName: () => void;
  cancelEditName: () => void;

  // Edit phone
  isEditingPhone: boolean;
  editPhoneValue: string;
  setEditPhoneValue: (value: string) => void;
  editPhoneInputRef: RefObject<HTMLInputElement>;
  isSavingPhone: boolean;
  startEditPhone: () => void;
  saveContactPhone: () => void;
  cancelEditPhone: () => void;

  // Search
  searchOpen: boolean;
  onOpenSearch: () => void;
  onCloseSearch: () => void;

  /** Ligação de voz pela linha QR (só 1:1; a linha precisa ter a capability no serviço). */
  onStartCall?: () => void;
  /** Motivo pelo qual não dá para ligar agora (linha ocupada). Mostra o botão desabilitado com a explicação, em vez de escondê-lo. */
  callBlockedReason?: string | null;

  // Actions
  /** Conversa sem dono e aberta: o botão "Assumir" aparece (mesmo caminho do Assumir da lista). */
  onAssign?: () => void;
  isAssigning?: boolean;
  onTransfer: () => void;
  onClose: () => void;
  onGroupInfo: () => void;

  // Setores: os controles só aparecem em linha com isolamento ligado
  // (phone_numbers.sector_isolation_enabled) — sem ele não há o que encaminhar.
  sectorIsolationEnabled?: boolean;
  /** Nome do setor atual, ou null quando a conversa está em triagem. */
  currentSectorName?: string | null;
  onForwardToSector?: () => void;

  // Shared custody
  userIsPrimary: boolean;
  userIsCoOwner: boolean;
  coOwners: string[];
  onShare: () => void;
  onLeaveShared: () => void;

  // 24h window (API only)
  windowExpiration: WindowExpiration | null;
  formatExpirationTime: (expiration: WindowExpiration) => string;

  // Action Buttons (multiple)
  actionButtons?: ActionButtonConfig[];
  onActionButtonClick?: (button: ActionButtonConfig) => void;
  loadingButtonId?: string | null;

  /** Refetch do histórico da janela desconectada (só QR). */
  onRefetchHistory?: () => void;
  isRefetchingHistory?: boolean;

  /** Perfil 1:1 — a foto abre o painel (antes abria um menu de um item só). */
  onOpenProfile?: () => void;
  profileOpen?: boolean;
}

const ChatHeader = memo(({
  conversation,
  isMobile,
  isQrConnection,
  isFreeTextChannel,
  numeroNome = null,
  numeroHue = null,
  isUpdating,
  onMobileBack,
  isEditingName,
  editNameValue,
  setEditNameValue,
  editNameInputRef,
  isSavingName,
  startEditName,
  saveContactName,
  cancelEditName,
  isEditingPhone,
  editPhoneValue,
  setEditPhoneValue,
  editPhoneInputRef,
  isSavingPhone,
  startEditPhone,
  saveContactPhone,
  cancelEditPhone,
  searchOpen,
  onOpenSearch,
  onCloseSearch,
  onStartCall,
  callBlockedReason,
  onAssign,
  isAssigning = false,
  onTransfer,
  sectorIsolationEnabled,
  currentSectorName,
  onForwardToSector,
  onClose,
  onGroupInfo,
  userIsPrimary,
  userIsCoOwner,
  coOwners,
  onShare,
  onLeaveShared,
  windowExpiration,
  formatExpirationTime,
  actionButtons = [],
  onActionButtonClick,
  loadingButtonId,
  onRefetchHistory,
  isRefetchingHistory = false,
  onOpenProfile,
  profileOpen = false,
}: ChatHeaderProps) => {
  // Grupo com apelido: o nome real (WhatsApp) vai no subtítulo, no lugar do JID.
  const nomeNoWhatsApp = nomeNoWhatsAppSeApelido(conversation);
  const iconeAssumir = (
    <IconSwap
      active={isAssigning ? "spinner" : "assumir"}
      durationMs={150}
      icons={{
        assumir: <UserPlus className="w-4 h-4" />,
        spinner: <Loader2 className="w-4 h-4 animate-spin" />,
      }}
    />
  );

  if (isMobile) {
    return (
      <header className="theme-chat-header sticky top-0 z-40 bg-background/95 backdrop-blur border-b border-border safe-area-top">
        <div className="flex items-center h-14 px-2 gap-2">
          {/* Back button */}
          {onMobileBack && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onMobileBack}
              className="h-11 w-11 shrink-0 touch-manipulation"
              aria-label="Voltar para a lista de conversas"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
          )}

          {/* Avatar - clickable for groups (opens members dialog) */}
          {conversation.is_group && isQrConnection ? (
            <button
              onClick={onGroupInfo}
              className="shrink-0 rounded-full transition-opacity active:opacity-70 touch-manipulation"
              title="Ver membros do grupo"
              aria-label="Ver membros do grupo"
            >
              <Avatar className="w-9 h-9">
                {conversation.contact_avatar_url && (
                  <AvatarImage src={conversation.contact_avatar_url} alt={conversation.contact_name} />
                )}
                <AvatarFallback className="bg-muted text-muted-foreground text-sm">
                  <Users className="w-4 h-4" />
                </AvatarFallback>
              </Avatar>
            </button>
          ) : onOpenProfile ? (
            // p-1 -m-1: alvo de toque de 44px sem crescer a foto.
            <button
              onClick={onOpenProfile}
              aria-haspopup="dialog"
              aria-expanded={profileOpen}
              className="shrink-0 rounded-full p-1 -m-1 transition-opacity active:opacity-70 touch-manipulation"
              title="Ver perfil do contato"
              aria-label={`Ver perfil de ${conversation.contact_name}`}
            >
              <Avatar className="w-9 h-9">
                {conversation.contact_avatar_url && (
                  <AvatarImage src={conversation.contact_avatar_url} alt={conversation.contact_name} />
                )}
                <AvatarFallback className="bg-muted text-muted-foreground text-sm">
                  {conversation.contact_name.substring(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
            </button>
          ) : (
            <Avatar className="w-9 h-9 shrink-0">
              {conversation.contact_avatar_url && (
                <AvatarImage src={conversation.contact_avatar_url} alt={conversation.contact_name} />
              )}
              <AvatarFallback className="bg-muted text-muted-foreground text-sm">
                {conversation.contact_name.substring(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}

          {/* Conversation name and phone - truncated */}
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold truncate leading-tight flex items-center gap-1.5" title={conversation.contact_name}>
              <span className="truncate">{conversation.contact_name}</span>
              {temDirect(conversation) && <SeloDirect junto={!ehDirect(conversation)} />}
            </h1>
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="min-w-0 truncate text-xs text-muted-foreground">
                {nomeNoWhatsApp ? `No WhatsApp: ${nomeNoWhatsApp}` : identificacaoDoContato(conversation)}
              </p>
              {numeroNome && <SeloNumero nome={numeroNome} hue={numeroHue} />}
            </div>
          </div>

          {/* Assumir fica fora do ⋮: numa conversa sem dono é A ação da tela,
              e some sozinho quando alguém assume. */}
          {onAssign && (
            <Button
              variant="outline"
              size="sm"
              onClick={onAssign}
              disabled={isUpdating || isAssigning}
              className="h-11 px-3 shrink-0 touch-manipulation"
            >
              {iconeAssumir}
              Assumir
            </Button>
          )}

          {/* Transferir/Encerrar moram no menu ⋮: 6 botões <44px disputando
              360px deixavam ~100px para o NOME do contato — a informação
              principal da tela. Sobram voltar + avatar + nome + ⋮, todos 44px. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 touch-manipulation"
                aria-label="Mais opções"
              >
                <MoreVertical className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => searchOpen ? onCloseSearch() : onOpenSearch()}>
                <Search className="w-4 h-4 mr-2" />
                Pesquisar
              </DropdownMenuItem>
              {onStartCall && (
                <DropdownMenuItem onClick={onStartCall} disabled={isUpdating || Boolean(callBlockedReason)}>
                  <Phone className="w-4 h-4 mr-2" />
                  {callBlockedReason ?? "Ligar"}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onTransfer} disabled={isUpdating}>
                <UserCircle className="w-4 h-4 mr-2" />
                Transferir conversa
              </DropdownMenuItem>
              {sectorIsolationEnabled && onForwardToSector && (
                <DropdownMenuItem onClick={onForwardToSector} disabled={isUpdating}>
                  <Building2 className="w-4 h-4 mr-2" />
                  Encaminhar para setor
                  <span className="ml-auto pl-2 text-xs text-muted-foreground">
                    {currentSectorName ?? "sem setor"}
                  </span>
                </DropdownMenuItem>
              )}
              {/* Action Buttons in mobile dropdown */}
              {actionButtons.map((btn) => {
                const Icon = getIcon(btn.icon);
                const isLoading = loadingButtonId === btn.id;
                return (
                  <DropdownMenuItem
                    key={btn.id}
                    onClick={() => onActionButtonClick?.(btn)}
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Icon className="w-4 h-4 mr-2" />
                    )}
                    {btn.label}
                  </DropdownMenuItem>
                );
              })}
              {/* Só QR: a Cloud API não tem fila offline nem history sync para pedir */}
              {isQrConnection && onRefetchHistory && (
                <DropdownMenuItem
                  onClick={onRefetchHistory}
                  disabled={isRefetchingHistory}
                >
                  {isRefetchingHistory ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <History className="w-4 h-4 mr-2" />
                  )}
                  Recuperar mensagens
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={startEditName}>
                <Pencil className="w-4 h-4 mr-2" />
                {rotuloEditarNome(conversation)}
              </DropdownMenuItem>
              {/* Grupo: o contact_phone é o JID, que é o destino do envio. Trocar
                  por um telefone mandava as mensagens do grupo para o privado. */}
              {!conversation.is_group && (
                <DropdownMenuItem onClick={startEditPhone}>
                  <Pencil className="w-4 h-4 mr-2" />
                  Editar número
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onShare}>
                <Handshake className="w-4 h-4 mr-2" />
                Compartilhar
              </DropdownMenuItem>
              {!userIsPrimary && userIsCoOwner && (
                <DropdownMenuItem
                  onClick={onLeaveShared}
                  disabled={isUpdating}
                >
                  <LogOut className="w-4 h-4 mr-2" />
                  Sair desta conversa
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onClose}
                disabled={isUpdating}
                className="text-destructive focus:text-destructive"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Encerrar atendimento
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
    );
  }

  // Desktop Header
  // A foto abre o perfil do contato, onde "Recuperar mensagens" agora mora (era
  // um dropdown de um item só na própria foto). Em grupo ela continua abrindo os
  // membros em UM clique.
  const contactAvatar = (
    <Avatar className="w-14 h-14 shrink-0">
      {conversation.contact_avatar_url && (
        <AvatarImage src={conversation.contact_avatar_url} alt={conversation.contact_name} />
      )}
      <AvatarFallback className="bg-muted text-muted-foreground text-base">
        {conversation.contact_name.substring(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );

  return (
    <div className="theme-chat-header border-b bg-card p-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        {/* Avatar - clickable for groups (opens members dialog) */}
        {conversation.is_group && isQrConnection ? (
          <button
            onClick={onGroupInfo}
            className="shrink-0 rounded-full transition-[opacity,transform] duration-150 ease-out active:scale-[0.96] hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            title="Ver membros do grupo"
            aria-label="Ver membros do grupo"
          >
            <Avatar className="w-14 h-14">
              {conversation.contact_avatar_url && (
                <AvatarImage src={conversation.contact_avatar_url} alt={conversation.contact_name} />
              )}
              <AvatarFallback className="bg-muted text-muted-foreground text-base">
                <Users className="w-6 h-6" />
              </AvatarFallback>
            </Avatar>
          </button>
        ) : onOpenProfile ? (
          <button
            onClick={onOpenProfile}
            aria-haspopup="dialog"
            aria-expanded={profileOpen}
            className="shrink-0 rounded-full transition-[opacity,transform] duration-150 ease-out active:scale-[0.96] hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            title="Ver perfil do contato"
            aria-label={`Ver perfil de ${conversation.contact_name}`}
          >
            {contactAvatar}
          </button>
        ) : (
          contactAvatar
        )}

        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {isEditingName ? (
              <div className="flex items-center gap-1">
                <Input
                  ref={editNameInputRef}
                  value={editNameValue}
                  onChange={(e) => setEditNameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveContactName();
                    if (e.key === 'Escape') cancelEditName();
                  }}
                  className="h-8 w-48 text-lg font-semibold"
                  disabled={isSavingName}
                />
                <button
                  onClick={saveContactName}
                  disabled={isSavingName || !editNameValue.trim()}
                  className="text-success hover:text-success/80 disabled:opacity-50 p-1 rounded transition-[color,transform] duration-150 ease-out active:scale-[0.96]"
                  title="Salvar"
                  aria-label={isSavingName ? "Salvando nome…" : "Salvar nome"}
                >
                  <IconSwap
                    active={isSavingName ? "spinner" : "check"}
                    durationMs={150}
                    icons={{
                      check: <Check className="w-4 h-4" />,
                      spinner: <Loader2 className="w-4 h-4 animate-spin" />,
                    }}
                  />
                </button>
                <button
                  onClick={cancelEditName}
                  className="text-muted-foreground hover:text-destructive p-1 rounded transition-[color,transform] duration-150 ease-out active:scale-[0.96]"
                  title="Cancelar"
                  aria-label="Cancelar edição do nome"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <>
                <h2 className="font-semibold text-lg truncate max-w-[250px]" title={conversation.contact_name}>{conversation.contact_name}</h2>
                {temDirect(conversation) && <SeloDirect junto={!ehDirect(conversation)} />}
                {/* Teto de largura: com nome de número longo o selo trunca (o nome inteiro segue no title), em vez de passar por baixo dos botões. */}
                {numeroNome && (
                  <span className="flex min-w-0 max-w-[200px]">
                    <SeloNumero nome={numeroNome} hue={numeroHue} />
                  </span>
                )}
                <button
                  onClick={startEditName}
                  className="shrink-0 text-muted-foreground hover:text-foreground p-1 rounded transition-[color,transform] duration-150 ease-out active:scale-[0.96]"
                  title={rotuloEditarNome(conversation)}
                  aria-label={rotuloEditarNome(conversation)}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </>
            )}
            <span className="shrink-0">
              <IdCopyButton id={conversation.id} label="ID da Conversa" />
            </span>
          </div>
          {isEditingPhone ? (
            <div className="flex items-center gap-1">
              <Input
                ref={editPhoneInputRef}
                value={editPhoneValue}
                onChange={(e) => setEditPhoneValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveContactPhone();
                  if (e.key === 'Escape') cancelEditPhone();
                }}
                className="h-6 w-40 text-sm"
                disabled={isSavingPhone}
              />
              <button
                onClick={saveContactPhone}
                disabled={isSavingPhone || !editPhoneValue.trim()}
                className="text-success hover:text-success/80 disabled:opacity-50 p-0.5 rounded transition-[color,transform] duration-150 ease-out active:scale-[0.96]"
                title="Salvar"
                aria-label={isSavingPhone ? "Salvando número…" : "Salvar número"}
              >
                <IconSwap
                  active={isSavingPhone ? "spinner" : "check"}
                  durationMs={150}
                  icons={{
                    check: <Check className="w-3.5 h-3.5" />,
                    spinner: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
                  }}
                />
              </button>
              <button
                onClick={cancelEditPhone}
                className="text-muted-foreground hover:text-destructive p-0.5 rounded transition-[color,transform] duration-150 ease-out active:scale-[0.96]"
                title="Cancelar"
                aria-label="Cancelar edição do número"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : ehDirect(conversation) || conversation.is_group ? (
            <p className="text-sm text-muted-foreground">
              {nomeNoWhatsApp ? `No WhatsApp: ${nomeNoWhatsApp}` : identificacaoDoContato(conversation)}
            </p>
          ) : (
            <div className="flex items-center gap-1">
              <p className="text-sm text-muted-foreground">{identificacaoDoContato(conversation)}</p>
              <button
                onClick={startEditPhone}
                className="text-muted-foreground hover:text-foreground p-0.5 rounded transition-[color,transform] duration-150 ease-out active:scale-[0.96]"
                title="Editar número"
                aria-label="Editar número"
              >
                <Pencil className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 items-center justify-end min-w-0">
        {/* Action Buttons - custom webhook/link - first (leftmost) */}
        {actionButtons.map((btn) => {
          const Icon = getIcon(btn.icon);
          const isLoading = loadingButtonId === btn.id;
          const displayLabel = btn.label.length > 15 ? btn.label.slice(0, 15) + '…' : btn.label;
          return (
            <Button
              key={btn.id}
              variant="outline"
              size="sm"
              onClick={() => onActionButtonClick?.(btn)}
              disabled={isLoading}
              title={btn.label}
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Icon className="w-4 h-4 mr-1" />
              )}
              {displayLabel}
            </Button>
          );
        })}
        {/* 24h window indicator - only for official API (not QR) */}
        {!isFreeTextChannel && windowExpiration && (
          <div
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border ${windowExpiration.isExpired
              ? 'bg-destructive/10 text-destructive border-destructive/20'
              : 'bg-muted text-muted-foreground border-border'
              }`}
            title="Janela de 24h para conversar"
          >
            <Clock className="w-3.5 h-3.5" />
            <span>{formatExpirationTime(windowExpiration)}</span>
          </div>
        )}
        {onAssign && (
          <Button
            variant="outline"
            size="sm"
            onClick={onAssign}
            disabled={isUpdating || isAssigning}
            title="Assumir conversa"
          >
            {iconeAssumir}
            Assumir
          </Button>
        )}
        {/* Liberar agora vive dentro do TransferConversationDialog.
            Só mantemos o botão "Sair" aqui para co-proprietários. */}
        {!userIsPrimary && userIsCoOwner && (
          <Button
            variant="outline"
            size="sm"
            onClick={onLeaveShared}
            disabled={isUpdating}
            title="Sair desta conversa compartilhada"
            className="px-2 2xl:px-3"
          >
            <LogOut className="w-4 h-4 2xl:mr-1" />
            <span className="sr-only 2xl:not-sr-only">Sair</span>
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onTransfer}
          disabled={isUpdating}
          title="Transferir conversa"
          className="px-2 2xl:px-3"
        >
          <UserCircle className="w-4 h-4 2xl:mr-1" />
          <span className="sr-only 2xl:not-sr-only">Transferir</span>
        </Button>
        {/* Sétimo botão da linha, e só em linha com isolamento ligado: sem
            setores não há encaminhamento, e a régua de espaço do header continua
            valendo para todo mundo que não usa a divisão. */}
        {sectorIsolationEnabled && onForwardToSector && (
          <Button
            variant="outline"
            size="sm"
            onClick={onForwardToSector}
            disabled={isUpdating}
            title={
              currentSectorName
                ? `Encaminhar para outro setor (atual: ${currentSectorName})`
                : "Encaminhar para um setor (esta conversa está sem setor)"
            }
            className="px-2 2xl:px-3"
          >
            <Building2 className="w-4 h-4 2xl:mr-1" />
            <span className="sr-only 2xl:not-sr-only">Setor</span>
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onShare}
          disabled={isUpdating}
          title="Compartilhar conversa"
          className="px-2 2xl:px-3"
        >
          <Handshake className="w-4 h-4 2xl:mr-1" />
          <span className="sr-only 2xl:not-sr-only">Compartilhar</span>
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={onClose}
          disabled={isUpdating}
          title="Encerrar atendimento"
          className="px-2 2xl:px-3"
        >
          <CheckCircle2 className="w-4 h-4 2xl:mr-1" />
          <span className="sr-only 2xl:not-sr-only">Encerrar</span>
        </Button>
        {onStartCall && (
          <Button
            variant="outline"
            size="sm"
            onClick={onStartCall}
            disabled={isUpdating || Boolean(callBlockedReason)}
            title={callBlockedReason ?? "Ligar para o contato"}
            aria-label={callBlockedReason ?? "Ligar para o contato"}
          >
            <Phone className="w-4 h-4" />
          </Button>
        )}
        {/* Search messages button - last on the right */}
        <Button
          variant={searchOpen ? "secondary" : "outline"}
          size="sm"
          onClick={() => searchOpen ? onCloseSearch() : onOpenSearch()}
          title="Pesquisar mensagens"
          aria-label="Pesquisar mensagens"
        >
          <Search className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
});

ChatHeader.displayName = "ChatHeader";

export default ChatHeader;
