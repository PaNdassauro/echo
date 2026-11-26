import { memo, forwardRef, useImperativeHandle, useRef, useCallback, useMemo, useState, useEffect } from "react";
import { Virtuoso, VirtuosoHandle, Components, type ListRange } from "react-virtuoso";
import { format, isSameDay, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { senderColorIndex, senderColorKey } from "@/lib/senderColor";
import type { AggregatedReaction } from "@/components/chat/bubbles/ReactionPills";
import { Calendar, Trash2, Loader2, PhoneMissed, Phone } from "lucide-react";
import MessageBubble from "../MessageBubble";
import TypingBubble from "./TypingBubble";
import { PendingUploads } from "./PendingUploadBubble";
import { Message } from "@/hooks/chat/useMessages";
import { Note } from "@/hooks/chat/useNotes";
import {
  buildTimeline,
  computeDayStarts,
  nextFirstIndex,
  tailIds,
  timelineItemKey,
  type FirstIndexState,
  type TimelineItem,
} from "@/lib/timeline";
import { boxedMediaKind, createMediaBoxLocks, resolveMediaBox } from "@/lib/mediaBox";
import { useStickToBottom } from "@/hooks/chat/useStickToBottom";
import { createMediaPreloader } from "@/lib/mediaPreload";
import { formatParticipantPhone } from "@/lib/phone";
import { prefersReducedMotion } from "@/lib/accessibilityPrefs";
import { attachWheelLimiter } from "@/lib/wheelScroll";
import type { PollParticipantRef } from "@/lib/pollResults";
import { buildCallText, readCallMeta } from "@/lib/callMessage";
import { isForwardable, MAX_SELECTED_MESSAGES } from "@/lib/messageSelection";

export interface MessageListRef {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollToMessage: (messageId: string) => void;
}

// Builds the pt-BR text for a group participant event, resolving names via the
// same lookup used for mentions (alias > pushName > phone). Falls back to the
// pre-computed `content` when structured metadata is missing.
const buildGroupActionText = (
  message: Message,
  lookup?: Record<string, string>
): string => {
  const ga = message.metadata?.groupAction;
  if (!ga) return message.content || "";

  const nameFor = (p?: { phone?: string; name?: string; jid?: string }) => {
    if (!p) return "alguém";
    const bare = p.jid ? p.jid.split("@")[0] : undefined;
    const byLookup = (p.phone ? lookup?.[p.phone] : undefined) ?? (bare ? lookup?.[bare] : undefined);
    return byLookup || p.name || p.phone || "alguém";
  };

  const actor = nameFor(ga.actor);
  const targets = (ga.targets || []).map((t) => nameFor(t)).join(", ") || "alguém";

  switch (ga.action) {
    case "join":
      return `${targets} entrou`;
    case "leave":
      return `${targets} saiu`;
    case "remove":
      return `${actor} removeu ${targets}`;
    case "promote":
      return `${actor} promoveu ${targets} a admin`;
    case "demote":
      return `${actor} rebaixou ${targets}`;
    case "add":
      return `${actor} adicionou ${targets}`;
    case "group_joined":
      return ga.actor?.name || ga.actor?.phone
        ? `${actor} adicionou você`
        : "Você foi adicionado ao grupo";
    default:
      return message.content || "";
  }
};

/**
 * Nome de quem enviou, para o cabeçalho da bolha em grupo.
 *
 * Antes o cabeçalho recebia `message.sender_name` CRU: sem pushName a bolha
 * ficava sem nenhuma identificação (mensagens de participantes diferentes viravam
 * indistinguíveis) e um apelido salvo no painel do grupo nunca aparecia aqui.
 */
const senderLabel = (
  message: Pick<Message, "sender_jid" | "sender_name" | "sender_phone">,
  lookup?: Record<string, string>
): string | undefined => {
  const bare = message.sender_jid ? message.sender_jid.split("@")[0] : undefined;
  const byLookup =
    (message.sender_phone ? lookup?.[message.sender_phone] : undefined) ??
    (bare ? lookup?.[bare] : undefined);
  if (byLookup) return byLookup;
  if (message.sender_name) return message.sender_name;
  if (!message.sender_phone) return undefined;
  // LID não resolvido: o "telefone" gravado é o ID interno.
  const isLid = message.sender_jid?.endsWith("@lid") === true && message.sender_phone === bare;
  return formatParticipantPhone(message.sender_phone, isLid);
};

/** Autor da mensagem CITADA no shape que senderLabel/senderColor esperam. */
const quotedAsSender = (message: Message) => ({
  sender_jid: message.quoted_sender_jid ?? null,
  sender_name: message.quoted_sender_name ?? null,
  sender_phone: message.quoted_sender_phone ?? null,
});

const isOutboundMsg = (message: Message) => message.direction === "outbound";

/** Índice de cor estável (1..8) do remetente; undefined sem identificador. */
const colorIndexFor = (
  sender: Pick<Message, "sender_jid" | "sender_name" | "sender_phone">
): number | undefined => {
  const key = senderColorKey(sender);
  return key ? senderColorIndex(key) : undefined;
};

interface MessageListProps {
  /** Dona da lista: filtra os envios de mídia em andamento (rodapé). */
  conversationId?: string | null;
  messages: Message[];
  notes: Note[];
  conversation: {
    is_group?: boolean;
  } | null;
  isQrConnection?: boolean;
  participantLookup?: Record<string, string>;
  /** Participantes do grupo para a enquete ("ainda não votaram"). */
  groupParticipants?: PollParticipantRef[];
  searchTerm?: string;
  searchResults?: string[];
  currentSearchIndex?: number;
  /** Mensagem destacada temporariamente (citação clicada) — reusa o visual do match de busca. */
  highlightedMessageId?: string | null;
  isMobile?: boolean;
  isLoading?: boolean;
  isLoadingMore?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onReply: (message: Message) => void;
  onForward?: (message: Message) => void;
  /** Seleção múltipla para encaminhar em lote. */
  selectionMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (message: Message) => void;
  onEdit: (message: Message) => void;
  onDelete: (message: Message) => void;
  onReact: (message: Message, emoji: string) => void;
  /** Reagir vale para QR e Business API. */
  reactionsEnabled?: boolean;
  /** Card juntado (WhatsApp + Direct): cada bolha mostra o canal. */
  mostrarCanal?: boolean;
  /** Agregado por reator (message_reactions) — escalares são o fallback. */
  reactionsByMessage?: Map<string, AggregatedReaction[]>;
  onRetry?: (message: Message) => void;
  onDiscard?: (message: Message) => void;
  onQuotedClick: (messageId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onSaveSticker?: (message: Message) => void;
  /** Abre o lightbox da conversa na mensagem clicada (imagem). */
  onOpenLightbox?: (messageId: string) => void;
  /** Voto na enquete (QR only). */
  onPollVote?: (message: Message, options: string[]) => void;
  onNavigateToConversation?: (phone: string, name: string) => void;
  onAtBottom?: (atBottom: boolean) => void;
  /** Contato digitando/gravando. Renderiza no Footer da lista, logo abaixo da
   *  última mensagem. `name` só vem preenchido em grupo. */
  typing?: { name?: string; state: "typing" | "recording"; leaving?: boolean } | null;
  /** Divisor "N mensagens não lidas": renderiza acima da mensagem-âncora e a
   *  lista abre rolada até ela. Congelado por abertura (ChatArea decide). */
  unreadDivider?: { messageId: string; count: number } | null;
}

/** Altura estimada de uma linha ainda não medida. A sonda do último item (quase sempre uma imagem) distorcia a estimativa de todas as outras. */
const ESTIMATED_ROW_PX = 90;
/** Faixa do fim em que o Virtuoso não compensa mudanças de altura. Com 100 px sobrava um ponto cego de 100 px. */
const AT_BOTTOM_PX = 32;
/** Pede a página anterior com 40 linhas de antecedência, para o prepend cair fora da tela (no índice 0 o Virtuoso não compensa). */
const LOAD_AHEAD_ROWS = 40;
/**
 * O Virtuoso mede e compensa antes do quadro ser pintado. É constante de módulo
 * porque trocar a prop recria os ResizeObservers (index.mjs:289-295); o build
 * do harness define 'off' para comparar A/B.
 */
const SKIP_RAF_ENV: unknown = import.meta.env.VITE_SCROLL_SKIP_RAF;
const WHEEL_LIMITER = import.meta.env.VITE_SCROLL_WHEEL_LIMITER !== "off";
const SKIP_RAF = SKIP_RAF_ENV !== "off";

/**
 * O Virtuoso só aceita "auto" | "smooth" (o "instant" do DOM vira "auto"), e
 * o suave só vale sem movimento reduzido — do sistema ou das preferências.
 * Lido na hora do scroll: a preferência pode mudar com a conversa aberta.
 */
const virtuosoBehavior = (behavior: ScrollBehavior): "auto" | "smooth" =>
  behavior === "smooth" && !prefersReducedMotion() ? "smooth" : "auto";

// Skeleton com a geometria das bolhas reais — mostrado só depois de ~120ms de
// espera (delay-guard), para trocas rápidas de conversa não piscarem nada.
const MessageListSkeleton = () => (
  <div className="theme-chat-surface flex-1 overflow-hidden px-4 py-4 space-y-3" aria-hidden="true">
    {[64, 44, 72, 52, 60, 40].map((width, i) => (
      <div key={i} className={`flex ${i % 2 === 0 ? "justify-start" : "justify-end"}`}>
        <div
          className="h-11 rounded-2xl bg-muted/60 animate-pulse"
          style={{ width: `${width}%`, maxWidth: "420px" }}
        />
      </div>
    ))}
  </div>
);

interface ListContext {
  isLoadingMore: boolean;
  hasMore: boolean;
  /** Já houve histórico a paginar nesta conversa — mantém a reserva de altura
   *  mesmo depois de hasMore virar false (senão o topo salta 48px na última página). */
  hadMore: boolean;
  typing: { name?: string; state: "typing" | "recording"; leaving?: boolean } | null;
  conversationId: string | null;
  /** Pedido explícito de ir ao fim (envio de mídia do próprio usuário): passa pelo único escritor do fim. */
  requestEnd: () => void;
}

// Header estável (tipo definido no módulo, não dentro do render — um tipo novo a
// cada render remontava o header e saltava a lista durante a paginação). Altura
// fixa reservada enquanto há histórico, aparecendo só por opacidade.
const ListHeader = ({ context }: { context?: ListContext }) => {
  if (!context?.hadMore) return null;
  return (
    <div
      className={`flex h-12 items-center justify-center transition-opacity duration-150 ${
        context?.isLoadingMore ? "opacity-100" : "opacity-0"
      }`}
    >
      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
    </div>
  );
};

// Scroller focável (teclado rola o histórico). SEM role=log/aria-live: numa
// lista virtualizada, cada linha que entra na janela é uma "addition" — o
// leitor de tela anunciava histórico ao rolar e silenciava mensagens novas
// fora do viewport (role=log tem aria-live implícito). O anúncio de mensagem
// nova vive num announcer sr-only FORA do Virtuoso.
const LogScroller = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  (props, ref) => (
    <div
      {...props}
      ref={ref}
      tabIndex={0}
      role="region"
      aria-label="Histórico de mensagens"
      className={`${props.className ?? ""} focus-visible:outline-none`}
    />
  )
);
LogScroller.displayName = "LogScroller";

// Footer estável (mesmo motivo do ListHeader: tipo definido no módulo, não a cada
// render). É o slot do Virtuoso que fica logo depois do último item.
// Envios de mídia em andamento vêm antes do "digitando": são mensagens nossas
// que ainda não existem no banco, e a bolha do contato é sempre a última.
const ListFooter = ({ context }: { context?: ListContext }) => {
  if (!context) return null;
  return (
    <>
      <PendingUploads conversationId={context.conversationId} onGrow={context.requestEnd} />
      {context.typing && (
        <TypingBubble
          name={context.typing.name}
          state={context.typing.state}
          leaving={context.typing.leaving}
        />
      )}
    </>
  );
};

const LIST_COMPONENTS: Components<TimelineItem, ListContext> = {
  Header: ListHeader,
  Footer: ListFooter,
  Scroller: LogScroller,
};

const MessageList = memo(forwardRef<MessageListRef, MessageListProps>(({
  conversationId = null,
  messages,
  notes,
  conversation,
  isQrConnection,
  participantLookup,
  groupParticipants,
  searchTerm,
  searchResults = [],
  currentSearchIndex = 0,
  highlightedMessageId = null,
  isMobile,
  isLoading = false,
  isLoadingMore = false,
  hasMore = true,
  onLoadMore,
  onReply,
  onForward,
  selectionMode = false,
  selectedIds,
  onToggleSelect,
  onEdit,
  onDelete,
  onReact,
  reactionsEnabled,
  mostrarCanal,
  reactionsByMessage,
  onRetry,
  onDiscard,
  onQuotedClick,
  onDeleteNote,
  onSaveSticker,
  onOpenLightbox,
  onPollVote,
  onNavigateToConversation,
  onAtBottom,
  typing = null,
  unreadDivider = null,
}, ref) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // Scroller do Virtuoso em estado (não ref): o useStickToBottom precisa
  // re-assinar quando ele troca (troca de conversa remonta a lista).
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    setScrollerEl(el instanceof HTMLElement ? el : null);
  }, []);
  const { unpin, scrollToEnd } = useStickToBottom(scrollerEl);

  // Paridade com o WhatsApp Web: a roda do mouse rola a conversa mais devagar
  // que o nativo, dando tempo de a mídia pré-carregada chegar antes de entrar
  // na tela. Só os cliques da roda são limitados; trackpad, toque, teclado e
  // scroll programático seguem nativos. `VITE_SCROLL_WHEEL_LIMITER=off` desliga
  // (chave de emergência em produção; o harness mede a lista sem ele).
  useEffect(() => {
    if (!scrollerEl || !WHEEL_LIMITER) return;
    return attachWheelLimiter(scrollerEl);
  }, [scrollerEl]);

  // Entrada animada só para mensagens genuinamente novas (nunca o batch inicial
  // nem a paginação para cima) — decisão tomada em renderItem.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const entranceIdsRef = useRef<Set<string>>(new Set());
  const initialLoadRef = useRef(true);

  // Delay-guard: o skeleton só aparece após 120ms de loading real, para que
  // trocas de conversa com cache/rede rápida não tenham estado intermediário.
  const [showLoadingSkeleton, setShowLoadingSkeleton] = useState(false);
  useEffect(() => {
    if (!isLoading) {
      setShowLoadingSkeleton(false);
      return;
    }
    // Loading novo = troca de conversa: zera o rastreio de mensagens "novas".
    seenIdsRef.current = new Set();
    entranceIdsRef.current = new Set();
    initialLoadRef.current = true;
    const timer = setTimeout(() => setShowLoadingSkeleton(true), 120);
    return () => clearTimeout(timer);
  }, [isLoading]);

  // Combine messages and notes into a sorted timeline
  const combinedItems = useMemo<TimelineItem[]>(
    () => buildTimeline(messages, notes, hasMore),
    [messages, notes, hasMore],
  );
  // Índice virtual derivado NO MESMO render dos dados: com setState num effect, um quadro era pintado com as linhas erradas e toda bolha visível remontava duas vezes por página.
  const firstIndexRef = useRef<FirstIndexState | null>(null);
  firstIndexRef.current = nextFirstIndex(firstIndexRef.current, combinedItems);
  const firstItemIndex = firstIndexRef.current.firstIndex;
  const dayStarts = useMemo(() => computeDayStarts(combinedItems, hasMore), [combinedItems, hasMore]);
  const tail = useMemo(() => tailIds(combinedItems), [combinedItems]);
  // A caixa da mídia é decidida uma vez por mensagem e conversa: remontar, onLoad ou UPDATE de metadata nunca muda a altura da linha.
  const boxLocksRef = useRef({ conv: conversationId, locks: createMediaBoxLocks() });
  if (boxLocksRef.current.conv !== conversationId) {
    boxLocksRef.current = { conv: conversationId, locks: createMediaBoxLocks() };
  }

  // Batch inicial carregado: tudo que está na tela é "visto" — só o que chegar
  // depois disso ganha animação de entrada.
  useEffect(() => {
    if (!isLoading && initialLoadRef.current) {
      combinedItems.forEach((item) => seenIdsRef.current.add(item.id));
      initialLoadRef.current = false;
    }
  }, [isLoading, combinedItems]);

  // Expose scroll methods
  // ATENÇÃO (verificado no react-virtuoso 4.18): scrollToIndex recebe índice de
  // DADOS (0..length-1) — o firstItemIndex só entra na saída do itemContent.
  // NÃO "corrigir" somando firstItemIndex aqui: o offset de ~100000 estoura o
  // clamp e o scroll cai no lugar errado.
  useImperativeHandle(ref, () => ({
    // Fim REAL do scroller (DOM), não o último item: scrollToIndex mirava a
    // altura em cache da última bolha e parava no meio dela (useStickToBottom).
    scrollToBottom: (behavior: ScrollBehavior = "smooth") => {
      scrollToEnd(virtuosoBehavior(behavior));
    },
    scrollToMessage: (messageId: string) => {
      const arrayIndex = combinedItems.findIndex(
        item => item._type === 'message' && item.id === messageId
      );

      if (arrayIndex === -1) {
        if (import.meta.env.DEV) {
          console.warn(`[MessageList] Message ${messageId} not found in combinedItems`);
        }
        return;
      }

      // Um único comando de scroll — o polling + scrollIntoView antigo criava
      // duas animações concorrentes (salto-pausa-salto). O highlight é aplicado
      // via prop (highlightedMessageId), não por mutação de style inline.
      unpin();
      virtuosoRef.current?.scrollToIndex({
        index: arrayIndex,
        behavior: virtuosoBehavior("smooth"),
        align: "center",
      });
    },
  }), [combinedItems, scrollToEnd, unpin]);

  // Abre a conversa no divisor de não-lidas (uma vez por âncora). O mount abre
  // no fim (initialTopMostItemIndex); um único scrollToIndex costuma cair no
  // vazio porque o Virtuoso ainda está medindo/ancorando embaixo — a lista fica
  // no fundo e o divisor some acima da dobra ("não dá pra ver"). Repetimos o
  // scroll por alguns frames até a posição fixar, alinhando o divisor no topo.
  const scrolledToDividerRef = useRef<string | null>(null);
  useEffect(() => {
    if (!unreadDivider || isLoading) return;
    if (scrolledToDividerRef.current === unreadDivider.messageId) return;
    const arrayIndex = combinedItems.findIndex(
      (item) => item._type === 'message' && item.id === unreadDivider.messageId
    );
    if (arrayIndex === -1) return;
    scrolledToDividerRef.current = unreadDivider.messageId;
    unpin();

    let tries = 0;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      virtuosoRef.current?.scrollToIndex({ index: arrayIndex, behavior: "auto", align: "start" });
      tries += 1;
      if (tries < 6) timer = setTimeout(() => { raf = requestAnimationFrame(go); }, 80);
    };
    raf = requestAnimationFrame(go);
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [unreadDivider, isLoading, combinedItems, unpin]);

  // Format date for divider
  const formatDateDivider = useCallback((date: Date): string => {
    const now = new Date();
    if (isSameDay(date, now)) return "Hoje";
    // isYesterday é por dia de calendário — addHours(-24) errava o dia em virada de DST.
    if (isYesterday(date)) return "Ontem";
    return format(date, "EEEE, d 'de' MMMM", { locale: ptBR });
  }, []);

  // Render a single item (message or note)
  // When using data prop, Virtuoso passes (virtualIndex, item) automatically
  const renderItem = useCallback((_virtualIndex: number, item: TimelineItem) => {
    if (!item) return null;
    const showDateDivider = dayStarts.has(item.id);
    const date = new Date(item.created_at);

    const dateDivider = showDateDivider ? (
      <div className="flex justify-center my-4">
        <div className="bg-muted/60 text-muted-foreground text-xs px-3 py-1 rounded-full flex items-center gap-1.5 border">
          <Calendar className="w-3 h-3" />
          <span className="capitalize">{formatDateDivider(date)}</span>
        </div>
      </div>
    ) : null;

    // Divisor de não-lidas: dentro do item âncora (como o de data) — assim não
    // mexe na contagem/keys da lista virtualizada.
    const unreadDividerEl =
      unreadDivider && item._type === 'message' && item.id === unreadDivider.messageId ? (
        <div
          className="flex items-center gap-3 my-3 px-2"
          role="separator"
          aria-label={`${unreadDivider.count} mensagens não lidas`}
        >
          <div className="h-px flex-1 bg-primary/25" />
          <span className="text-primary text-2xs font-semibold uppercase tracking-wider whitespace-nowrap">
            {unreadDivider.count === 1
              ? "1 mensagem não lida"
              : `${unreadDivider.count} mensagens não lidas`}
          </span>
          <div className="h-px flex-1 bg-primary/25" />
        </div>
      ) : null;

    if (item._type === 'note') {
      const note = item;
      const authorName = note.profiles
        ? `${note.profiles.first_name || ''} ${note.profiles.last_name || ''}`.trim() || 'Usuário'
        : 'Usuário';

      return (
        <div className="px-4 py-2">
          {dateDivider}
          <div className="flex justify-center">
            <div className="bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 rounded-lg px-4 py-2 max-w-md text-center shadow-sm">
              <div className="flex items-center justify-center gap-2 mb-1">
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                  Nota interna
                </span>
                <button
                  onClick={() => onDeleteNote(note.id)}
                  className="text-amber-600 dark:text-amber-500 hover:text-destructive rounded transition-[color,transform] duration-150 ease-out active:scale-[0.96]"
                  title="Excluir nota"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              <p className="text-message text-amber-900 dark:text-amber-100 whitespace-pre-wrap">
                {note.content}
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                {authorName} • {format(new Date(note.created_at), "HH:mm", { locale: ptBR })}
              </p>
            </div>
          </div>
        </div>
      );
    }

    // Message item
    const message = item;

    // Group participant events render as a centered system pill, not a bubble.
    if (message.message_type === "group_action") {
      return (
        <div className="px-4 py-2">
          {dateDivider}
          <div className="flex justify-center">
            <div className="bg-muted text-muted-foreground rounded-full px-3 py-1 max-w-md text-center text-xs">
              {buildGroupActionText(message, conversation?.is_group ? participantLookup : undefined)}
            </div>
          </div>
        </div>
      );
    }

    // Ligação: mesma pílula de sistema do group_action. O registro é gravado pelo
    // qr-service quando a ligação termina, então existe mesmo para quem não estava
    // com o Echo aberto na hora.
    if (message.message_type === "call") {
      const connected = readCallMeta(message)?.connected;
      return (
        <div className="px-4 py-2">
          {dateDivider}
          <div className="flex justify-center">
            <div className="flex max-w-md items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">
              {connected === false
                ? <PhoneMissed className="h-3 w-3 shrink-0 text-destructive" aria-hidden />
                : <Phone className="h-3 w-3 shrink-0" aria-hidden />}
              {buildCallText(message)}
            </div>
          </div>
        </div>
      );
    }

    // Mensagem genuinamente nova (chegou depois do load inicial, perto do fim
    // da lista): anima a entrada UMA vez. Batch inicial e paginação não animam.
    // Identidade estável (clientKey sobrevive à reconciliação temp→real) e
    // consumo no onAnimationEnd: remontagens por virtualização não reanimam.
    const entranceKey = message.clientKey ?? message.id;
    let animateEntrance = entranceIdsRef.current.has(entranceKey);
    if (
      !animateEntrance &&
      !initialLoadRef.current &&
      !seenIdsRef.current.has(entranceKey) &&
      !seenIdsRef.current.has(message.id) &&
      (tail.has(entranceKey) || tail.has(message.id))
    ) {
      entranceIdsRef.current.add(entranceKey);
      animateEntrance = true;
    }
    seenIdsRef.current.add(message.id);
    seenIdsRef.current.add(entranceKey);

    const mediaKind = message.media_url ? boxedMediaKind(message.message_type) : null;
    const mediaBox =
      mediaKind && message.media_url
        ? boxLocksRef.current.locks.get(`${message.clientKey || message.id}|${message.media_url}`, () =>
            resolveMediaBox({ kind: mediaKind, url: message.media_url, metadata: message.metadata }),
          )
        : undefined;

    return (
      <div
        className={`px-4 py-2 ${animateEntrance ? "animate-in fade-in-0 slide-in-from-bottom-2" : ""}`}
        style={
          animateEntrance
            ? { animationDuration: "200ms", animationTimingFunction: "var(--ease-out-strong)" }
            : undefined
        }
        onAnimationEnd={
          animateEntrance
            ? (e) => {
                // Consome a animação (só a do próprio wrapper; animações de
                // filhos, ex. skeleton de mídia, borbulham até aqui).
                if (e.target === e.currentTarget) {
                  entranceIdsRef.current.delete(entranceKey);
                }
              }
            : undefined
        }
      >
        {dateDivider}
        {unreadDividerEl}
        <MessageBubble
          key={message.id}
          id={`message-${message.id}`}
          messageId={message.id}
          isGroup={conversation?.is_group}
          content={message.content}
          direction={message.direction}
          timestamp={message.created_at}
          status={message.status}
          error={message.error}
          message_type={message.message_type}
          media_url={message.media_url}
          media_mime_type={message.media_mime_type}
          media_filename={message.media_filename}
          senderName={
            conversation?.is_group ? senderLabel(message, participantLookup) : undefined
          }
          senderColorIndex={
            conversation?.is_group && !isOutboundMsg(message)
              ? colorIndexFor(message)
              : undefined
          }
          onReply={() => onReply(message)}
          onForward={
            onForward && isForwardable(message) ? () => onForward(message) : undefined
          }
          selectionMode={selectionMode}
          isSelected={selectedIds?.has(message.id) ?? false}
          // Fora do allowlist não dá para marcar; com o lote cheio, só as já
          // marcadas continuam clicáveis (para o usuário poder trocar).
          selectionDisabled={
            !isForwardable(message) ||
            ((selectedIds?.size ?? 0) >= MAX_SELECTED_MESSAGES && !selectedIds?.has(message.id))
          }
          onToggleSelect={onToggleSelect ? () => onToggleSelect(message) : undefined}
          quotedContent={message.quoted_content}
          quotedDirection={message.quoted_direction}
          quotedMediaUrl={message.quoted_media_url}
          quotedMessageType={message.quoted_message_type}
          quotedMessageId={message.quoted_message_id}
          quotedSenderLabel={
            conversation?.is_group && message.quoted_direction === "inbound"
              ? senderLabel(quotedAsSender(message), participantLookup)
              : undefined
          }
          quotedSenderColorIndex={
            conversation?.is_group && message.quoted_direction === "inbound"
              ? colorIndexFor(quotedAsSender(message))
              : undefined
          }
          onQuotedClick={onQuotedClick}
          isQrConnection={isQrConnection}
          onEdit={() => onEdit(message)}
          onDelete={() => onDelete(message)}
          onRetry={
            // Texto → whatsapp-send (retryMessageId); mídia com URL viva →
            // whatsapp-send-media reenvia do Storage. Template segue sem retry.
            onRetry &&
            ((!message.media_url && (!message.message_type || message.message_type === "text")) ||
              (!!message.media_url &&
                ["image", "video", "audio", "ptt", "document", "sticker"].includes(message.message_type || "")))
              ? () => onRetry(message)
              : undefined
          }
          onDiscard={onDiscard ? () => onDiscard(message) : undefined}
          onSaveSticker={
            onSaveSticker && message.message_type === "sticker" && message.media_url
              ? () => onSaveSticker(message)
              : undefined
          }
          flowResponseJson={message.flow_response_json as Record<string, unknown> | null}
          reaction={message.reaction}
          ourReaction={message.our_reaction}
          reactions={reactionsByMessage?.get(message.id) ?? null}
          onReact={(emoji) => onReact(message, emoji)}
          // Mensagem do Direct: a reação sairia pelo WhatsApp com o id do Instagram.
          reactionsEnabled={reactionsEnabled && message.metadata?.canal !== "instagram"}
          mostrarCanal={mostrarCanal}
          onOpenLightbox={onOpenLightbox ? () => onOpenLightbox(message.id) : undefined}
          onPollVote={
            onPollVote && message.message_type === "poll"
              ? (options) => onPollVote(message, options)
              : undefined
          }
          participantLookup={conversation?.is_group ? participantLookup : undefined}
          groupParticipants={conversation?.is_group ? groupParticipants : undefined}
          metadata={message.metadata}
          mediaBox={mediaBox}
          onStartConversation={onNavigateToConversation}
          searchTerm={searchTerm}
          isCurrentSearchMatch={
            searchResults[currentSearchIndex] === message.id || highlightedMessageId === message.id
          }
          isMobile={isMobile}
          is_edited={message.is_edited}
          editHistory={message.metadata?.edit_history}
          editContentUnavailable={message.metadata?.edit_content_unavailable}
          is_deleted={message.is_deleted}
        />
      </div>
    );
  }, [
    dayStarts,
    tail,
    formatDateDivider,
    unreadDivider,
    conversation?.is_group,
    isQrConnection,
    participantLookup,
    groupParticipants,
    searchTerm,
    searchResults,
    currentSearchIndex,
    highlightedMessageId,
    isMobile,
    onReply,
    onForward,
    // Sem estes três a lista virtualizada não repinta ao marcar/desmarcar.
    selectionMode,
    selectedIds,
    onToggleSelect,
    onEdit,
    onDelete,
    onReact,
    reactionsEnabled,
    mostrarCanal,
    reactionsByMessage,
    onRetry,
    onDiscard,
    onQuotedClick,
    onDeleteNote,
    onSaveSticker,
    onOpenLightbox,
    onPollVote,
    onNavigateToConversation,
  ]);

  // Handle bottom state changes
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    onAtBottom?.(atBottom);
  }, [onAtBottom]);

  // Handle reaching the top of the list
  const handleStartReached = useCallback(() => {
    if (hasMore && !isLoadingMore && onLoadMore) {
      onLoadMore();
    }
  }, [hasMore, isLoadingMore, onLoadMore]);

  const mediaPreloaderRef = useRef(createMediaPreloader());
  const prevRangeRef = useRef<{ start: number; end: number } | null>(null);
  const combinedItemsRef = useRef(combinedItems);
  combinedItemsRef.current = combinedItems;
  useEffect(() => {
    const preloader = mediaPreloaderRef.current;
    return () => preloader.cancel();
  }, []);

  // Pagina cedo: pede a página anterior quando faltam menos de LOAD_AHEAD_ROWS linhas para o topo.
  // O startIndex do rangeChanged inclui o firstItemIndex.
  const handleRangeChanged = useCallback(({ startIndex, endIndex }: ListRange) => {
    if (startIndex - firstItemIndex < LOAD_AHEAD_ROWS) handleStartReached();
    // Pré-carrega as imagens das próximas linhas no sentido da rolagem. Subindo,
    // o índice do topo cai primeiro; descendo, é o de baixo que sobe primeiro.
    const prev = prevRangeRef.current;
    prevRangeRef.current = { start: startIndex, end: endIndex };
    if (prev === null) return;
    const direction = startIndex < prev.start || endIndex < prev.end ? -1 : startIndex > prev.start || endIndex > prev.end ? 1 : 0;
    if (direction === 0) return;
    const from = (direction < 0 ? startIndex - 1 : endIndex + 1) - firstItemIndex;
    mediaPreloaderRef.current.preload(combinedItemsRef.current, from, direction, 10);
  }, [firstItemIndex, handleStartReached]);

  // ── Announcer de mensagem nova (região viva FORA do Virtuoso) ──────────
  // A virtualização monta/desmonta bolhas ao rolar — aria-live no scroller
  // anunciava histórico e silenciava chegadas fora do viewport. Aqui só
  // mensagens genuinamente novas viram anúncio.
  const [announcement, setAnnouncement] = useState("");
  const lastInboundIdRef = useRef<string | null>(null);
  useEffect(() => {
    let lastInbound: Message | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].direction === "inbound") {
        lastInbound = messages[i];
        break;
      }
    }
    const lastId = lastInbound?.id ?? null;
    const prev = lastInboundIdRef.current;
    lastInboundIdRef.current = lastId;
    if (prev === lastId || lastId === null) return;
    // Baseline (primeira carga / troca de conversa): o id anterior não existe
    // mais no array — não anunciar o histórico que acabou de montar.
    if (prev === null || !messages.some((m) => m.id === prev)) return;
    setAnnouncement("Nova mensagem recebida");
    const timer = setTimeout(() => setAnnouncement(""), 2000);
    return () => clearTimeout(timer);
  }, [messages]);

  // Já houve mais histórico nesta conversa? (reset junto com o loading da troca)
  const hadMoreRef = useRef(false);
  if (hasMore) hadMoreRef.current = true;
  if (isLoading) hadMoreRef.current = false;

  // Context do Virtuoso: mantém LIST_COMPONENTS estável (tipo de componente
  // constante) e ainda re-renderiza o header quando o estado de paginação muda.
  const requestEnd = useCallback(() => scrollToEnd(virtuosoBehavior("smooth")), [scrollToEnd]);

  const listContext = useMemo<ListContext>(
    () => ({
      isLoadingMore,
      hasMore,
      hadMore: hadMoreRef.current || hasMore,
      typing: typing ?? null,
      conversationId: conversationId ?? null,
      requestEnd,
    }),
    [isLoadingMore, hasMore, typing, conversationId, requestEnd],
  );

  // Nenhum scroll vive no TypingBubble nem no PendingUploads: enquanto a lista
  // está grudada no fim, o useStickToBottom acompanha o crescimento do Footer
  // pelo ResizeObserver; fora do fim, nada rola.
  const typingVisible = Boolean(typing);

  // Anúncio do "digitando" vai pelo announcer sr-only FORA do Virtuoso (mesmo
  // motivo do announcer de mensagem). Uma vez por início, não a cada refresh.
  const [typingAnnouncement, setTypingAnnouncement] = useState("");
  useEffect(() => {
    if (!typingVisible) {
      setTypingAnnouncement("");
      return;
    }
    setTypingAnnouncement("O contato está digitando");
    const timer = setTimeout(() => setTypingAnnouncement(""), 2000);
    return () => clearTimeout(timer);
  }, [typingVisible]);

  if (isLoading) {
    return showLoadingSkeleton ? (
      <MessageListSkeleton />
    ) : (
      <div className="theme-chat-surface flex-1" aria-hidden="true" />
    );
  }

  if (combinedItems.length === 0) {
    return (
      <div className="flex-1 flex flex-col justify-end overflow-y-auto">
        <div className="flex flex-1 items-center justify-center px-6 text-center text-muted-foreground">
          <p className="text-sm text-pretty">Nenhuma mensagem ainda. Envie a primeira para iniciar o atendimento.</p>
        </div>
        <PendingUploads conversationId={conversationId} />
      </div>
    );
  }

  return (
    <>
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
      <div aria-live="polite" role="status" className="sr-only">
        {typingAnnouncement}
      </div>
      <Virtuoso
      ref={virtuosoRef}
      scrollerRef={handleScrollerRef}
      data={combinedItems}
      firstItemIndex={firstItemIndex}
      initialTopMostItemIndex={combinedItems.length - 1}
      itemContent={renderItem}
      computeItemKey={timelineItemKey}
      // O Virtuoso nunca rola ao fim por índice: o useStickToBottom é a única autoridade.
      followOutput={false}
      atBottomStateChange={handleAtBottomStateChange}
      atBottomThreshold={AT_BOTTOM_PX}
      defaultItemHeight={ESTIMATED_ROW_PX}
      skipAnimationFrameInResizeObserver={SKIP_RAF}
      className="theme-chat-surface flex-1"
      increaseViewportBy={{ top: 600, bottom: 200 }}
      startReached={handleStartReached}
      rangeChanged={handleRangeChanged}
      context={listContext}
      components={LIST_COMPONENTS}
      />
    </>
  );
}));

MessageList.displayName = "MessageList";

export default MessageList;
