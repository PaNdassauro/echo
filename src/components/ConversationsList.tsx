import { Conversation } from "@/types/conversation";
import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore, forwardRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useNavigate } from "react-router-dom";

// List do Virtuoso com papel de listbox. O CONTAINER é o único tab stop
// (tabIndex=0): a linha canônica desmonta na virtualização, e um tabIndex=0
// roving em linha desmontada faria o Tab pular a lista inteira. Ao receber
// foco vindo de FORA, redireciona para a linha canônica (rolando antes se
// preciso); Shift+Tab vindo de uma linha interna não redireciona (senão loop).
interface ListboxContext {
    onEnterFocus: () => void;
    /** Páginas 2..N ainda chegando depois do primeiro paint. */
    isLoadingMore: boolean;
}
const ConversationListbox = forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & { context?: ListboxContext }
>(({ context, ...props }, ref) => (
    <div
        {...props}
        ref={ref}
        role="listbox"
        aria-label="Conversas"
        tabIndex={0}
        onFocus={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            context?.onEnterFocus();
        }}
        className={`${props.className ?? ""} focus-visible:outline-none`}
    />
));
ConversationListbox.displayName = "ConversationListbox";
// Rodapé "carregando mais…": a página 1 já está na tela enquanto as outras
// chegam em paralelo — o skeleton só vale quando não há nada para pintar.
const ConversationListFooter = ({ context }: { context?: ListboxContext }) =>
    context?.isLoadingMore ? (
        <div className="text-xs text-muted-foreground py-2 text-center" aria-live="polite">
            Carregando mais…
        </div>
    ) : null;
const VIRTUOSO_LIST_COMPONENTS = { List: ConversationListbox, Footer: ConversationListFooter };
const WAKE_REFETCH_AFTER_MS = 5 * 60_000;
// Um fetch completo que passa disto em voo está preso (requisição pendurada depois de
// uma queda de rede): a revalidação de fundo deixa de esperar por ele e o refaz.
const COMPLETO_PRESO_APOS_MS = 60_000;
const NO_TAGS: TagData[] = [];
// Referência estável: seleção de filtro vazia (sem [] novo a cada render nos deps).
const NO_IDS: string[] = [];

// O que um pedido de busca da lista pode dizer.
interface OpcoesDeBusca {
    /** Skeleton no lugar da lista vazia enquanto o escopo carrega (a menos que haja cache dele). */
    showLoading?: boolean;
    /**
     * `completo` (o padrão) baixa os números inteiros. `incremental` é a revalidação de
     * fundo: busca só o que mudou, e vira completo quando não há marca d'água, quando o
     * último completo é velho ou quando a resposta pode estar truncada.
     */
    modo?: ModoDaBusca;
    /**
     * Sem gesto da pessoa (poll, volta da aba, `online`, canal reassinado, pedido do contexto):
     * se falhar, só o banner da lista avisa, sem toast.
     */
    silencioso?: boolean;
    /**
     * Refaz o completo só destes números (os que falharam), sem tocar nos outros do escopo.
     * É o que a faixa de erro e a revalidação de fundo usam: um número que falha não pode
     * rebaixar o escopo inteiro a cada tentativa.
     */
    somente?: readonly string[];
    /**
     * Aba escondida: o completo periódico espera a volta da aba, mas o incremental segue
     * (ver `decidirModo`).
     */
    adiarCompleto?: boolean;
    /** O canal realtime reassinou: houve um intervalo sem entrega (ver `decidirModo`). */
    aposQueda?: boolean;
}

/** O que uma busca devolve a quem a pediu: os números que não carregaram. */
interface ResultadoDaLista {
    falhas: readonly string[];
}
const SEM_FALHAS: ResultadoDaLista = { falhas: [] };

/** Mesma lista de ids, na mesma ordem. */
const mesmaLista = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

// Coluna da lista arrastada abaixo de 368px no desktop (variante
// sidebar-narrow:, ver ResizableListColumn): botões e ícones encolhem.
const SIDEBAR_ICON = "w-4 h-4 sidebar-narrow:w-3.5 sidebar-narrow:h-3.5";
const SIDEBAR_TOP_BUTTON = "theme-sidebar-top-button h-8 w-8 sidebar-narrow:h-7 sidebar-narrow:w-7 text-muted-foreground";
const SIDEBAR_ACTION_BUTTON = "theme-sidebar-action-button h-9 w-9 sidebar-narrow:h-8 sidebar-narrow:w-8 shrink-0";

// Uma falha transitória (JWT expirado com a aba dormindo, rede oscilando,
// timeout da RLS) deixava as tags vazias para SEMPRE: fetchTags só rodava no
// mount e no pull-to-refresh, então o "+" sumia da row e só um F5 trazia de
// volta. Três tentativas com backoff; o erro só chega ao usuário se esgotar.
type RetryableQuery<T> = () => PromiseLike<{ data: T | null; error: { message: string } | null }>;
const withRetry = async <T,>(
    label: string,
    run: RetryableQuery<T>,
): Promise<{ data: T | null; error: { message: string } | null }> => {
    let result: { data: T | null; error: { message: string } | null } = { data: null, error: null };
    for (let attempt = 1; attempt <= 3; attempt++) {
        result = await run();
        if (!result.error) return result;
        console.warn(`[tags] ${label} falhou (${attempt}/3):`, result.error.message);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
    return result;
};
import { PullToRefresh } from "@/components/ui/pull-to-refresh";
import { useIsMobile } from "@/hooks/use-mobile";
import { CheckCheck, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useNotifications } from "@/contexts/NotificationContext";
import { useVoiceCalls } from "@/contexts/VoiceCallContext";
import { useVoiceCallsEnabled } from "@/hooks/useVoiceCallsEnabled";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Search,
    MessageCircle,
    Users,
    Clock,
    User as UserIcon,
    Tag,
    Plus,
    Filter,
    CheckCircle2,
    MessageSquarePlus,
    Settings,
    LogOut,
    TrendingUp,
    Workflow,
    Send,
    RefreshCw,
    ArrowUpDown,
    Bell,
    ArrowDown,
    LayoutList,
    LayoutGrid,
    MoreVertical,
    Handshake,
    Volume2,
    Archive,
    ChevronLeft,
    PhoneIncoming,
    Megaphone,
    Bot
} from "lucide-react";
import { ToastAction } from "@/components/ui/toast";
import { hasDraft, subscribeDrafts, getDraftsVersion } from "@/lib/messageDrafts";
import { captureUnreadAtOpen } from "@/lib/unreadDividerStore";
import { subscribeWithBackoff } from "@/lib/realtimeReconnect";
import { ensureNotificationPermission, notificationPermission } from "@/lib/nativeNotification";
import StartConversationDialog from "./StartConversationDialog";
import CreateGroupDialog from "./CreateGroupDialog";
import { ConversationFilterPopover, type FilterGroup, type FilterOption } from "./ConversationFilterPopover";
import { buildAssigneeOptions, type MemberNames } from "@/lib/conversationAssignees";
import { ConversationExportError, exportConversationToXlsx } from "@/lib/conversationExportClient";
import { useSectors } from "@/hooks/useSectors";
import { useAssumirConversa } from "@/hooks/useAssumirConversa";
import { contarNumerosAtivos, useAccessiblePhoneNumbers } from "@/hooks/useAccessiblePhoneNumbers";
import {
    matchesSectorFilter,
    NO_SECTOR_FILTER_ID,
    SECTOR_FALLBACK_COLOR,
    sectorsForPhone,
} from "@/lib/sectors";
import { abasDaConversa, estaNaAba, filaDaConversa, iaContandoRede } from "@/lib/abaDaConversa";
import PhoneNumberSelector from "./PhoneNumberSelector";
import { StatusIndicator } from "./StatusIndicator";
import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { User } from "@supabase/supabase-js";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuCheckboxItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TransferConversationDialog } from "./TransferConversationDialog";
import { useConversation } from "@/hooks/chat/useConversation";
import { isConversationUnread, unreadWeight } from "@/lib/unread";
import type { TagData } from "./ConversationTagPills";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { COLUNAS_CO_RESPONSAVEIS, LIST_COLUMNS, LIST_PAGE_SIZE } from "@/lib/conversationListQuery";
import { casaFiltroDeCanal, temDirect, type CanalDoFiltro } from "@/lib/directDoInstagram";
import { casaFiltroDeTipo, ehTipoDaConversa, type TipoDaConversa } from "@/lib/tipoDeConversa";
import {
    applyAssigneeEvent,
    applyAssigneeSnapshot,
    applyConversationEvent,
    linhaNoEscopo,
    reconcileFetched,
    type ConversationEventContext,
} from "@/lib/conversationListReducer";
import { assigneeOldRowSchema, assigneeRowSchema, conversationRowSchema } from "@/lib/conversationRealtime";
import { conversationListCache, MAX_LINES } from "@/lib/conversationListCache";
import {
    buscarCoResponsaveis,
    buscarEscopoCompleto,
    buscarIncremental,
    decidirModo,
    maisRecente,
    type ModoDaBusca,
    type RetratoDeCoResponsaveis,
} from "@/lib/conversationListFetch";
import { chaveEscopo, expandirSelecao, idsDaChave, listarNomes, opcoesAgrupadas } from "@/lib/caixaConjunta";
import {
    buscarTagsDosNumeros,
    idDaConversaDoEventoDeTag,
    mesclarTagsDosNumeros,
} from "@/lib/conversationTagsFetch";
import { useRealtimeFallbackPoll } from "@/hooks/useRealtimeFallbackPoll";
import { ConversationRow, type ConversationRowActions, type ConversationRowProps } from "./ConversationRow";

// Referência estável: filtro de canal vazio (sem [] novo a cada render nos deps).
const NO_CHANNELS: CanalDoFiltro[] = [];
const NO_TIPOS: TipoDaConversa[] = [];

interface ConversationTag {
    conversation_id: string;
    tag_id: string;
    tag?: TagData;
}

interface ConversationsListProps {
    userId: string;
    user: User;
    onSignOut: () => void;
    selectedConversationId: string | null;
    /**
     * `phoneNumberId` é o número DA CONVERSA (a linha da lista já o traz): o
     * chat usa ele, e não o número selecionado, que pode ser outro.
     */
    onSelectConversation: (id: string, name?: string, phoneNumberId?: string | null) => void;
    /** Fecha o painel da conversa aberta (mesmo caminho do Escape e do voltar). */
    onDeselectConversation?: () => void;
    refreshTrigger?: number;
    /** Conversa a que o último refreshTrigger se refere (capturada antes de limpar a seleção). */
    refreshConversationId?: string | null;
    /**
     * Os números (phone_numbers.id) cujas conversas a lista mostra: o conjunto, e a
     * ÚNICA coisa que decide o que se busca. Qualquer array serve; o que dispara uma
     * busca nova é o conteúdo (`chaveEscopo`), não a identidade.
     */
    escopo: readonly string[];
    /**
     * O número selecionado no modo número; null quando a lista junta vários (nunca um
     * valor sentinela: um não-uuid em `.eq('phone_number_id')` dá 22P02). É o que o
     * seletor mostra e a base de tudo que ainda é de UM número: tags, setores,
     * busca global e os diálogos de criar conversa e grupo.
     */
    numeroUnico: string | null;
    metaPhoneNumberId?: string | null;
    onPhoneSelect: (id: string) => void;
    isQrConnection?: boolean;
    isMobileView?: boolean;
    /**
     * A caixa conjunta está ativa (o escopo junta vários números). Liga o selo do número em
     * cada conversa, o item e o botão de escolha no seletor, e os diálogos de criar conversa
     * e grupo pedem "Enviar pelo número". No modo número é falso e nada disso aparece.
     */
    conjunta?: boolean;
    /** Os números que entram na caixa conjunta (pontos e contagem do item do seletor). */
    numerosDaConjunta?: readonly string[];
    /** Escolheu o item "Caixa conjunta" no seletor. */
    onSelecionarConjunta?: () => void;
    /** Abre a escolha dos números da caixa conjunta. */
    onEscolherNumeros?: () => void;
    /**
     * O número da conversa aberta (o que o chat usa), vindo do Dashboard. É o padrão de
     * "Nova conversa" e "Criar grupo" na caixa conjunta: não depende de a conversa já estar
     * na lista (deep link) nem de a busca daquele número ter dado certo.
     */
    numeroDaConversaAberta?: string | null;
    /**
     * A caixa conjunta espera o mapa de números e a busca dele falhou: o escopo vai vazio e
     * não há o que buscar. A lista mostra a falha com "Tentar novamente" (em vez de um
     * skeleton eterno ou de um "Nenhuma conversa" falso) e não confere a contagem de números.
     */
    numerosEmErro?: boolean;
    /**
     * A caixa conjunta espera o mapa de números (o escopo vai vazio só por isso). Enquanto
     * espera, a lista não conta não-lidos nem busca: não há número para filtrar, e a contagem
     * da org inteira seria descartada assim que o mapa chegasse.
     */
    escopoPendente?: boolean;
    /** Refaz a busca do mapa de números (o "Tentar novamente" do estado acima). */
    onTentarNumerosNovamente?: () => void;
}

// Skeleton com a geometria da linha real (avatar 44px + 2 barras): aparece no
// primeiro fetch e nas trocas de org/conexão — nunca mais "Nenhuma conversa"
// falso enquanto os dados carregam.
const ConversationListSkeleton = () => (
    <div className="divide-y" aria-hidden="true">
        {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex gap-2 px-3 py-2.5">
                <div className="w-11 h-11 rounded-full bg-muted animate-pulse shrink-0" />
                <div className="flex-1 space-y-2 py-1">
                    <div className="h-3.5 w-1/2 rounded bg-muted animate-pulse" />
                    <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
                </div>
            </div>
        ))}
    </div>
);

const ConversationsList = ({
    userId,
    user,
    onSignOut,
    selectedConversationId,
    onSelectConversation,
    onDeselectConversation,
    refreshTrigger,
    refreshConversationId,
    escopo,
    numeroUnico,
    metaPhoneNumberId,
    onPhoneSelect,
    isQrConnection,
    isMobileView = false,
    conjunta = false,
    numerosDaConjunta,
    onSelecionarConjunta,
    onEscolherNumeros,
    numeroDaConversaAberta = null,
    numerosEmErro = false,
    escopoPendente = false,
    onTentarNumerosNovamente,
}: ConversationsListProps) => {
    const { toast } = useToast();
    const { currentOrganization } = useOrganization();
    const isMobile = useIsMobile();
    // const [conversations, setConversations] = useState<Conversation[]>([]); // Removed: Using context
    // O escopo vem da CHAVE, nunca da identidade do array da prop: o pai pode recriá-lo
    // a cada render sem o conjunto ter mudado, e tudo o que refaz a busca ao trocar de
    // número é chaveado por ela.
    const escopoKey = chaveEscopo(escopo);
    const escopoIds = useMemo(() => idsDaChave(escopoKey), [escopoKey]);
    const escopoSet = useMemo<ReadonlySet<string>>(() => new Set(escopoIds), [escopoIds]);
    // O mesmo mapa do Dashboard (uma busca só, no React Query); sem revalidar a cada montagem desta lista.
    const { phoneNumbers: numerosAcessiveis } = useAccessiblePhoneNumbers(currentOrganization?.id, true, {
        revalidarAoMontar: false,
    });
    const numerosEmErroRef = useRef(numerosEmErro);
    numerosEmErroRef.current = numerosEmErro;
    const escopoPendenteRef = useRef(escopoPendente);
    escopoPendenteRef.current = escopoPendente;
    // Nome e cor de cada número: o nome diz qual número falhou, e o selo da linha e da busca usa os dois.
    // Também os números por onde uma conversa ou grupo novo pode sair (só os do escopo; grupo só existe em número QR).
    const numerosPorId = useMemo(
        () => new Map(numerosAcessiveis.map((numero) => [numero.id, { nome: numero.displayName, hue: numero.themeHue }])),
        [numerosAcessiveis],
    );
    const numerosDeEnvio = useMemo(
        () => numerosAcessiveis.filter((numero) => escopoSet.has(numero.id)),
        [numerosAcessiveis, escopoSet],
    );
    const numerosQrDeEnvio = useMemo(
        () => numerosDeEnvio.filter((numero) => numero.connectionType === "qr"),
        [numerosDeEnvio],
    );
    // "neste número" / "nestes números": o texto da lista acompanha o escopo.
    const rotuloDoEscopo = conjunta ? "nestes números" : "neste número";
    const { conversations, setConversations, unreadCounts, markedUnread, resetUnread, markConversationUnread, markAllAsRead, refreshUnreadCounts, setUnreadScope, conversationRefreshRequest, refreshConversationById, findConversation, failedCounts, resetFailed, conversationPrefs, togglePinned, toggleArchived, setMutedUntil, isMuted } = useNotifications();

    // Arquivadas ficam fora da lista principal; esta flag troca a lista pela
    // visão só-arquivadas (linha "Arquivadas (N)" acima da lista alterna).
    const [showArchived, setShowArchived] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [activeTab, setActiveTab] = useState("all");
    const [tags, setTags] = useState<TagData[]>([]);
    const [conversationTags, setConversationTags] = useState<Map<string, TagData[]>>(new Map());
    // Filtros multi-select: OR dentro de cada um, AND entre os dois. Nenhum vai
    // para o localStorage (ao contrário de sortMode/viewMode logo abaixo) porque
    // as opções são escopadas pela linha selecionada — um id persistido voltaria
    // como "lista vazia" sem causa visível.
    const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
    const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
    const [selectedSectorIds, setSelectedSectorIds] = useState<string[]>([]);
    const [selectedChannels, setSelectedChannels] = useState<CanalDoFiltro[]>([]);
    const [selectedTipos, setSelectedTipos] = useState<TipoDaConversa[]>([]);
    // Filtros que só existem na aba Disparos (ver o effect que os limpa ao sair).
    const [selectedCampanhas, setSelectedCampanhas] = useState<string[]>([]);
    const [selectedRotulos, setSelectedRotulos] = useState<string[]>([]);
    const [selectedErroEnvio, setSelectedErroEnvio] = useState<string[]>([]);
    // Nome dos membros da org, para rotular quem é só co-responsável: o embed
    // profiles da linha existe apenas para o dono primário.
    const [memberNames, setMemberNames] = useState<MemberNames>(new Map());
    const [sortMode, setSortMode] = useState<"notifications-first" | "chronological">(() => {
        const saved = localStorage.getItem("conversationSortMode");
        return saved === "chronological" ? "chronological" : "notifications-first";
    });
    const [viewMode, setViewMode] = useState<"normal" | "compact">(() => {
        const saved = localStorage.getItem("conversationViewMode");
        return saved === "compact" ? "compact" : "normal";
    });

    // Setores da organização, meus vínculos e o padrão. Quem recorta as conversas de
    // verdade é a RLS (políticas do baseline); isto aqui só decide se os controles de
    // setor aparecem e para onde vai o "Assumir". O isolamento é POR NÚMERO e sai do mapa de
    // números acessíveis (`numerosComIsolamento`, abaixo); o do `useSectors` só cobre a linha
    // que o mapa não lista (desativada, deep link), que ele lê pela PK.
    const setores = useSectors(numeroUnico || null, userId);
    const { sectors, byId: sectorsById, isolationEnabled: isolamentoDoNumeroUnico } = setores;

    // Os números do escopo com isolamento por setor ligado. Vazio = sem filtro de setor.
    const numerosComIsolamento = useMemo<ReadonlySet<string>>(() => {
        const ligados = new Set(
            numerosAcessiveis.filter((numero) => numero.sectorIsolationEnabled).map((numero) => numero.id),
        );
        const out = new Set(escopoIds.filter((id) => ligados.has(id)));
        if (numeroUnico && isolamentoDoNumeroUnico && escopoSet.has(numeroUnico)) out.add(numeroUnico);
        return out;
    }, [numerosAcessiveis, escopoIds, escopoSet, numeroUnico, isolamentoDoNumeroUnico]);

    const [showWaitingAlert, setShowWaitingAlert] = useState<boolean>(() => {
        const saved = localStorage.getItem("showWaitingAlert");
        return saved !== "false"; // Default: true (ativado)
    });
    const [showMyAlert, setShowMyAlert] = useState<boolean>(() => {
        const saved = localStorage.getItem("showMyAlert");
        return saved !== "false"; // Default: true (ativado)
    });
    const [showSharedAlert, setShowSharedAlert] = useState<boolean>(() => {
        const saved = localStorage.getItem("showSharedAlert");
        return saved !== "false"; // Default: true (ativado)
    });
    const [notificationSoundEnabled, setNotificationSoundEnabled] = useState<boolean>(() => {
        const saved = localStorage.getItem("notificationSoundEnabled");
        return saved !== "false"; // Default: true (ativado)
    });
    // "Receber ligações" fica aqui, junto dos outros avisos, porque é disso que
    // se trata: se esta pessoa é chamada ou não. A linha continua podendo ligar.
    const { canCall } = useVoiceCalls();
    const [voiceCallsEnabled, setVoiceCallsEnabled] = useVoiceCallsEnabled(userId);
    const [showStartConversation, setShowStartConversation] = useState(false);
    const [showCreateGroup, setShowCreateGroup] = useState(false);
    const [showGlobalSearch, setShowGlobalSearch] = useState(false);

    // Ciclo de vida do fetch: empty state só depois de um fetch bem-sucedido.
    const [isLoadingConversations, setIsLoadingConversations] = useState(true);
    // Números cujo último fetch completo falhou (em ordem). Com a lista vazia vira o
    // estado de erro de sempre; com conversas na tela, uma faixa acima da lista. A ref é
    // a verdade síncrona (a revalidação de fundo decide por ela logo depois de um await,
    // onde o estado do render ainda estaria velho); o estado só existe para renderizar.
    const [linhasComFalha, setLinhasComFalhaNoEstado] = useState<string[]>([]);
    const linhasComFalhaRef = useRef<string[]>([]);
    const atualizarLinhasComFalha = useCallback((atualizar: (prev: string[]) => string[]) => {
        const prev = linhasComFalhaRef.current;
        const next = atualizar(prev);
        if (next === prev) return;
        linhasComFalhaRef.current = next;
        setLinhasComFalhaNoEstado(next);
    }, []);
    // Descarta respostas antigas que chegariam depois de um fetch mais novo.
    const fetchIdRef = useRef(0);
    // Sempre a versão mais recente do fetch — para callbacks de vida longa
    // (canal realtime, pull-to-refresh) não usarem closures velhas.
    const fetchConversationsRef = useRef<(opts?: OpcoesDeBusca) => Promise<ResultadoDaLista>>();
    // Segunda carga em andamento (páginas 2..N depois do primeiro paint) —
    // vira o Footer "carregando mais…" do Virtuoso.
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    // Espelho síncrono da lista para callbacks de vida longa (troca de escopo,
    // ressincronização de assignees) lerem sem entrar em deps.
    const conversationsRef = useRef<Conversation[]>(conversations);
    conversationsRef.current = conversations;
    // O escopo em refs para o que vive além do render (canal realtime, fetch em voo).
    const escopoIdsRef = useRef(escopoIds);
    escopoIdsRef.current = escopoIds;
    const escopoSetRef = useRef(escopoSet);
    escopoSetRef.current = escopoSet;
    const escopoKeyRef = useRef(escopoKey);
    escopoKeyRef.current = escopoKey;
    // De que escopo (a chave) é o array em memória: o estado vive no contexto e
    // sobrevive à troca de números até o primeiro commit do fetch novo.
    const chaveEmMemoriaRef = useRef<string | null>(null);
    // Metadados do último commit de cada número do escopo em memória (para o espelho
    // no cache). Número sem entrada aqui nunca foi carregado nem veio do cache: o que
    // houver dele no array são só inserts do realtime, e não é um retrato a guardar.
    const metaPorNumeroRef = useRef(new Map<string, { fetchedAt: number; complete: boolean }>());
    // Marca d'água do SERVIDOR: o maior updated_at já visto neste escopo. A
    // revalidação incremental busca daí em diante; nunca é o relógio do cliente.
    const maiorUpdatedAtRef = useRef<string | null>(null);
    // Quando terminou o último fetch completo do escopo (0 = nenhum).
    const ultimoCompletoEmRef = useRef(0);
    // Fetch completo em voo (o id dele, e quando começou) e revalidação incremental em voo.
    const completoEmVooRef = useRef<number | null>(null);
    const completoIniciadoEmRef = useRef(0);
    const incrementalEmVooRef = useRef<Promise<void> | null>(null);
    // Org do render anterior; `undefined` = primeiro mount (nunca limpa).
    const prevOrgIdRef = useRef<string | undefined>(undefined);
    const touchedSinceFetchRef = useRef<Set<string>>(new Set());
    // Ids que o realtime tirou da lista (DELETE, ou saída do escopo) depois do início da busca em
    // andamento: o snapshot do servidor pode ter sido lido antes e ainda trazê-los (ver `reconcileFetched`).
    const removidosDuranteBuscaRef = useRef<Set<string>>(new Set());
    const selectedConversationIdRef = useRef<string | null>(selectedConversationId);
    selectedConversationIdRef.current = selectedConversationId;
    const refreshConversationByIdRef = useRef(refreshConversationById);
    refreshConversationByIdRef.current = refreshConversationById;
    const findConversationRef = useRef(findConversation);
    findConversationRef.current = findConversation;
    // Perfis dos membros da org (first_name/last_name/email) por user_id: o
    // realtime não traz o embed `profiles`, então um UPDATE de assigned_to
    // monta o rótulo do responsável a partir daqui.
    const memberProfilesRef = useRef<Map<string, Conversation["profiles"]>>(new Map());
    // Instante em que a aba ficou oculta (refetch só se passou muito tempo).
    const hiddenSinceRef = useRef<number | null>(null);
    // Debounce genérico por chave: junta uma RAJADA de eventos (disparo em
    // massa marcando tags, DELETE em massa de assignees) num refetch só.
    const debounceTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    // Busca de tags em voo: o contador e, por número, a última busca que o pediu (uma busca
    // mais nova do mesmo número descarta a resposta da antiga).
    const tagsBuscaRef = useRef(0);
    const tagsBuscaPorNumeroRef = useRef(new Map<string, number>());
    // O que o realtime de `conversation_tags` pediu desde o último refetch: os números das
    // conversas que mudaram, ou "tudo" quando não dá para saber de qual número é o evento.
    const tagsPendentesRef = useRef<{ numeros: Set<string>; tudo: boolean }>({ numeros: new Set(), tudo: false });
    const debounce = useCallback((key: string, fn: () => void, ms = 400) => {
        const timers = debounceTimersRef.current;
        const pending = timers.get(key);
        if (pending) clearTimeout(pending);
        timers.set(key, setTimeout(() => {
            timers.delete(key);
            fn();
        }, ms));
    }, []);
    useEffect(() => () => {
        debounceTimersRef.current.forEach((timer) => clearTimeout(timer));
        debounceTimersRef.current.clear();
    }, []);
    // O retrato dos co-responsáveis do escopo (uma consulta paginada, não uma por conversa).
    // `conversation_assignees` não move `conversations.updated_at`, então a revalidação
    // incremental só os vê por aqui. null = a leitura falhou: a lista fica como está (é
    // segundo plano, o próximo disparo tenta de novo).
    const lerCoResponsaveis = useCallback(async (numeros: readonly string[]): Promise<RetratoDeCoResponsaveis | null> => {
        try {
            return await buscarCoResponsaveis({
                escopo: numeros,
                buscar: (numerosDaBusca, from) =>
                    supabase
                        .from("conversation_assignees")
                        .select(COLUNAS_CO_RESPONSAVEIS)
                        .in("conversations.phone_number_id", numerosDaBusca)
                        .order("id")
                        .range(from, from + LIST_PAGE_SIZE - 1),
            });
        } catch (error) {
            console.warn("[ConversationsList] retrato de co-responsáveis falhou:", error);
            return null;
        }
    }, []);

    // Reconstrói `co_assignee_ids` das conversas do escopo em memória a partir do retrato.
    // Conversa que o retrato cita e a lista não tem (compartilhada comigo agora, e antes
    // fora do meu escopo) entra com o select completo, como no `onAssigneeChange`.
    const aplicarCoResponsaveis = useCallback(
        (retrato: RetratoDeCoResponsaveis, { escopo, ignorar }: { escopo: ReadonlySet<string>; ignorar?: ReadonlySet<string> }) => {
            const porConversa = new Map<string, readonly string[]>(
                Array.from(retrato, ([id, { userIds }]) => [id, userIds] as const),
            );
            const emMemoria = new Set(conversationsRef.current.map((c) => c.id));
            setConversations((prev) => applyAssigneeSnapshot(prev, porConversa, { escopo, ignorar }));
            for (const [id, { numeroId }] of retrato) {
                if (emMemoria.has(id) || ignorar?.has(id)) continue;
                // Só de número que a lista já carregou: o que falhou é refeito por inteiro e traz estas junto.
                if (!numeroId || !escopo.has(numeroId) || !metaPorNumeroRef.current.has(numeroId)) continue;
                void refreshConversationByIdRef.current(id);
            }
        },
        [setConversations],
    );

    // DELETE de conversation_assignees sem conversation_id (REPLICA IDENTITY DEFAULT): não há
    // como saber de qual conversa saiu o co-responsável, então refaz o retrato do escopo
    // (a revalidação incremental usa o mesmo, a cada disparo).
    const resyncAssignees = useCallback(async () => {
        const chave = escopoKeyRef.current;
        const retrato = await lerCoResponsaveis(escopoIdsRef.current);
        // O escopo mudou durante a leitura: o retrato é de outros números.
        if (!retrato || chave !== escopoKeyRef.current) return;
        aplicarCoResponsaveis(retrato, { escopo: escopoSetRef.current });
    }, [lerCoResponsaveis, aplicarCoResponsaveis]);
    const resyncAssigneesRef = useRef(resyncAssignees);
    resyncAssigneesRef.current = resyncAssignees;
    // Congela a posição da conversa clicada: se ela tinha não-lidas, continua
    // ordenando como não-lida enquanto estiver selecionada (a lista não se
    // reordena embaixo do cursor no fluxo de triagem). Guardado POR ID: seleção
    // que não passa pelo clique (busca global, deep-link) não herda o freeze.
    const selectedFreezeRef = useRef<{ id: string | null; hadUnread: boolean }>({
        id: null,
        hadUnread: false,
    });
    // Re-renderiza quando um rascunho nasce/morre (indicador de lápis na linha).
    useSyncExternalStore(subscribeDrafts, getDraftsVersion);
    // Assumir (botão da linha e menu de contexto): mesmo caminho do cabeçalho da
    // conversa aberta. O estado pendente evita duplo-clique numa fila disputada.
    const { assigningId, resolveAndAssign, dialogoDeSetor } = useAssumirConversa({
        userId,
        phoneNumberId: numeroUnico,
        setores,
        comIsolamento: (numero) => !!numero && numerosComIsolamento.has(numero),
        perfilDe: (id) => memberProfilesRef.current.get(id),
        aoTocar: (id) => touchedSinceFetchRef.current.add(id),
    });
    // Export de conversa em voo (um por vez, como o assumir).
    const [exportingId, setExportingId] = useState<string | null>(null);
    // Permissão de notificação do SO — visível e reativável pelo menu de alertas
    // (quem negou uma vez ficava sem alertas para sempre, sem saber).
    const [osNotifPermission, setOsNotifPermission] = useState<NotificationPermission>(() =>
        notificationPermission(),
    );
    // Scroller do PullToRefresh no mobile — vira o customScrollParent do Virtuoso.
    const [mobileScrollEl, setMobileScrollEl] = useState<HTMLDivElement | null>(null);
    // const { unreadCounts, resetUnread, refreshUnreadCounts } = useNotifications(); // Merged above
    const navigate = useNavigate();

    // Global keyboard shortcut Ctrl+K for global search
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "k") {
                e.preventDefault();
                setShowGlobalSearch(true);
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, []);

    // Handle global search result selection
    const handleGlobalSearchResult = useCallback((conversationId: string, messageId: string) => {
        // Navigate to the conversation with messageId as query param
        navigate(`/dashboard/${conversationId}?messageId=${messageId}`);
    }, [navigate]);

    const getInitials = (email: string) => {
        return email.substring(0, 2).toUpperCase();
    };

    // Os números da contagem de não-lido são os mesmos da lista. Fica ANTES do efeito
    // de organização (que já pede a contagem): no mount o escopo é ajustado primeiro e
    // a busca sai uma vez só, já com os números certos — não uma sem filtro e outra
    // com ele.
    useEffect(() => {
        setUnreadScope(escopoIds);
    }, [escopoIds, setUnreadScope]);

    // Reset state when organization changes. A lista em si é buscada pelo
    // effect de escopo (o Dashboard escolhe o número da nova org e ele dispara).
    useEffect(() => {
        // Só em troca REAL de org: no mount (voltar de /settings, cruzar o
        // breakpoint mobile/desktop) o cache e o array precisam sobreviver —
        // é exatamente o remount que o cache por linha existe para cobrir.
        // A barreira entre usuários é o clear() no signOut do Dashboard.
        const orgId = currentOrganization?.id;
        if (prevOrgIdRef.current !== undefined && prevOrgIdRef.current !== orgId) {
            setConversations([]);
            conversationListCache.clear();
            // O array em memória era da org anterior: nada dele se espelha no cache.
            chaveEmMemoriaRef.current = null;
            metaPorNumeroRef.current = new Map();
        }
        prevOrgIdRef.current = orgId;
        setConversationTags(new Map());
        // Os dois filtros são escopados por org/linha: um id de outra org filtra
        // para zero sem nenhuma pista visível de por quê.
        setSelectedTagIds([]);
        setSelectedUserIds([]);

        fetchTags();
        fetchConversationTags();
        // Com o escopo pendente não há número para contar: o efeito de escopo conta quando o mapa chegar.
        if (!escopoPendenteRef.current) refreshUnreadCounts();

        // Callbacks do canal vivem além deste render: leem refs para nunca usar
        // uma closure velha (conexão/org anterior). Cada evento é aplicado EM
        // MEMÓRIA pelos reducers puros — nada aqui refaz a lista inteira.
        // Reconexão com backoff pelo subscribeWithBackoff: este canal não tinha
        // NENHUM callback de status — quando caía, a lista congelava em silêncio
        // até um F5.

        const eventContext = (): ConversationEventContext => ({
            numeros: escopoSetRef.current,
            memberProfiles: memberProfilesRef.current,
        });

        const onConversationChange = (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
            if (payload.eventType === "DELETE") {
                // REPLICA IDENTITY FULL em conversations: `old` traz a linha inteira.
                const id = payload.old.id;
                if (typeof id === "string") {
                    touchedSinceFetchRef.current.add(id);
                    // Um fetch lido antes do DELETE ainda a traz: a marca impede o commit de ressuscitá-la.
                    removidosDuranteBuscaRef.current.add(id);
                    setConversations((prev) => applyConversationEvent(prev, { type: "delete", id }, eventContext()));
                }
                return;
            }
            const parsed = conversationRowSchema.safeParse(payload.new);
            if (parsed.success) {
                touchedSinceFetchRef.current.add(parsed.data.id);
                // Saiu do escopo (foi para outro número): para o fetch em voo é como o DELETE. Voltou
                // ao escopo, a marca cai — senão ela barraria a conversa que acabou de voltar.
                if (linhaNoEscopo(parsed.data.phone_number_id, escopoSetRef.current)) {
                    removidosDuranteBuscaRef.current.delete(parsed.data.id);
                } else {
                    removidosDuranteBuscaRef.current.add(parsed.data.id);
                }
                setConversations((prev) =>
                    applyConversationEvent(prev, { type: "upsert", row: parsed.data }, eventContext()),
                );
                return;
            }
            // Payload fora do contrato: rebusca só esta conversa, nunca a lista.
            const id = payload.new.id;
            if (typeof id === "string") void refreshConversationByIdRef.current(id);
            // Nota: um UPDATE que tira a linha do escopo RLS deste usuário (mudou
            // de setor isolado/linha) NÃO chega pelo walrus. Esse caso é coberto
            // por refreshConversationById via refreshTrigger/broadcast do contexto.
        };

        const onAssigneeChange = (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
            if (payload.eventType === "DELETE") {
                const old = assigneeOldRowSchema.safeParse(payload.old);
                if (old.success && old.data.conversation_id && old.data.user_id) {
                    const { conversation_id: conversationId, user_id: userIdRemoved } = old.data;
                    touchedSinceFetchRef.current.add(conversationId);
                    setConversations((prev) =>
                        applyAssigneeEvent(prev, { type: "remove", conversationId, userId: userIdRemoved }),
                    );
                    return;
                }
                // REPLICA IDENTITY DEFAULT: só o id da linha apagada — não há como
                // saber de qual conversa. Refaz o retrato dos co-responsáveis de todos
                // os números do escopo (debounced: um DELETE em massa vira uma
                // leitura só).
                debounce("assignees", () => void resyncAssigneesRef.current?.());
                return;
            }
            const row = assigneeRowSchema.safeParse(payload.new);
            if (!row.success) return;
            const { conversation_id: conversationId, user_id: userIdAdded } = row.data;
            if (!findConversationRef.current(conversationId)) {
                // Conversa que ainda não está em memória (compartilhada comigo
                // agora e antes fora do meu escopo): entra com o select completo.
                void refreshConversationByIdRef.current(conversationId);
                return;
            }
            touchedSinceFetchRef.current.add(conversationId);
            setConversations((prev) => applyAssigneeEvent(prev, { type: "add", conversationId, userId: userIdAdded }));
        };

        const createChannel = () =>
            supabase
                .channel(`conversations-changes-${currentOrganization?.id || 'none'}`)
                .on(
                    "postgres_changes",
                    {
                        event: "*",
                        schema: "public",
                        table: "conversations",
                    },
                    onConversationChange,
                )
                .on(
                    "postgres_changes",
                    {
                        event: "*",
                        schema: "public",
                        table: "conversation_tags",
                    },
                    (payload: { new?: unknown; old?: unknown }) => {
                        // Só o número da conversa que mudou: marcar uma tag não refaz as dos outros.
                        // DELETE não traz o id da conversa (com RLS, o Realtime manda só a chave
                        // primária da tag), então cai sempre no refetch de todo o escopo. Conversa
                        // fora da lista também não diz de que número é: refaz tudo. Mapear o id da
                        // tag para a conversa exige a RPC devolver `conversation_tags.id` (pendência).
                        const conversationId = idDaConversaDoEventoDeTag(payload);
                        const numeroId = conversationId
                            ? conversationsRef.current.find((conv) => conv.id === conversationId)?.phone_number_id
                            : null;
                        const pendentes = tagsPendentesRef.current;
                        if (numeroId) pendentes.numeros.add(numeroId);
                        else pendentes.tudo = true;
                        debounce("conversation_tags", () => {
                            const { numeros, tudo } = tagsPendentesRef.current;
                            const refazer = tudo ? undefined : Array.from(numeros);
                            tagsPendentesRef.current = { numeros: new Set(), tudo: false };
                            void fetchConversationTagsRef.current?.(refazer);
                        });
                    }
                )
                .on(
                    "postgres_changes",
                    {
                        event: "*",
                        schema: "public",
                        table: "conversation_assignees",
                    },
                    onAssigneeChange,
                );

        const cleanupSubscription = subscribeWithBackoff({
            healthKey: "conversations-list",
            createChannel,
            onSubscribed: (recovered) => {
                // Recupera eventos perdidos enquanto o canal esteve fora —
                // inclusive o rejoin silencioso do socket (SUBSCRIBED de
                // novo sem CHANNEL_ERROR antes). Sem skeleton: o que está em
                // memória segura a lista enquanto a revalidação corre.
                // Reassinar é um intervalo sem entrega, e o que ele deixa passar
                // inclui o que o incremental não enxerga (conversa apagada, saída
                // do escopo da RLS): depois de uma queda vale o completo (ver
                // `decidirModo`: só se o último tem mais de 2 min, e com a aba
                // escondida ele espera a volta).
                if (!recovered) return;
                fetchConversationsRef.current?.({
                    modo: "incremental",
                    silencioso: true,
                    aposQueda: true,
                    adiarCompleto: document.hidden,
                });
            },
        });

        return cleanupSubscription;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId, currentOrganization?.id, setConversations, debounce]);

    // Rede de segurança do realtime. Com o Realtime do Supabase instável, o
    // UPDATE de conversations (prévia, ordem) pode não chegar, inclusive com o
    // canal SUBSCRIBED: a lista é revalidada a cada 15 s com canal caído e a
    // cada 60 s com ele saudável. O não-lido tem a própria busca no
    // GlobalNotificationListener (que também cuida do som).
    //
    // A revalidação é incremental: busca só o que mudou desde a marca d'água do
    // servidor, e só vira completa quando precisa (ver `decidirModo`). Com a aba
    // escondida o poll NÃO para: ele segue no incremental (uma requisição pequena) e só
    // adia o completo periódico, que espera a volta da aba. A lista em memória é o que o
    // gate de notificação lê para saber o dono e os co-responsáveis de cada conversa, e
    // congelá-la deixaria mudo quem acabou de receber uma conversa por um UPDATE que o
    // realtime perdeu.
    useRealtimeFallbackPoll(
        () => fetchConversationsRef.current?.({ modo: "incremental", silencioso: true, adiarCompleto: document.hidden }),
        {
            degradedMs: 15_000,
            healthyMs: 60_000,
        },
    );

    // Acordar a aba / voltar a ficar online. O canal realtime sobrevive a uma
    // troca rápida de aba, então só uma ausência longa (> 5 min, quando o
    // browser já pode ter derrubado o socket) ou o evento `online` justificam
    // refazer a lista inteira; numa ausência curta, a volta busca só o que mudou
    // (o poll escondido só adiou o completo, ver acima). As tags seguem a regra do completo:
    // não têm canal próprio para a LISTA, e sem isto uma falha transitória ficava
    // congelada até o próximo F5.
    useEffect(() => {
        const refetchAll = () => {
            // Sem rede não há o que buscar: o `online` refaz tudo quando ela voltar.
            if (navigator.onLine === false) return;
            // Volta da aba ou `online` não é gesto da pessoa: a falha vira faixa, sem toast.
            fetchConversationsRef.current?.({ modo: "completo", silencioso: true });
            void fetchTagsRef.current?.();
            void fetchConversationTagsRef.current?.();
        };
        const onVisibility = () => {
            if (document.visibilityState === "hidden") {
                hiddenSinceRef.current = Date.now();
                return;
            }
            const hiddenFor = hiddenSinceRef.current ? Date.now() - hiddenSinceRef.current : 0;
            hiddenSinceRef.current = null;
            if (hiddenFor > WAKE_REFETCH_AFTER_MS) refetchAll();
            else fetchConversationsRef.current?.({ modo: "incremental", silencioso: true });
        };
        const onOnline = () => {
            if (document.visibilityState !== "visible") return;
            refetchAll();
        };
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("online", onOnline);
        return () => {
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("online", onOnline);
        };
    }, []);

    // `refreshTrigger` vem de ações na conversa ABERTA (ChatArea: transferir,
    // encerrar, renomear). Só ela precisa ser rebuscada — refazer a lista
    // inteira por causa de uma linha era o custo que este componente pagava.
    useEffect(() => {
        if (!refreshTrigger || refreshTrigger <= 0) return;
        // O Dashboard limpa a seleção no mesmo batch em que bumpa o trigger
        // (encerrar, transferir, encaminhar): a ref já está null aqui. Por isso
        // ele manda o id junto; a ref é só o fallback de quem não manda.
        const id = refreshConversationId ?? selectedConversationIdRef.current;
        if (id) void refreshConversationByIdRef.current(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refreshTrigger]);

    // Pedido de refresh vindo do contexto (broadcast de transferência/setor).
    // Com conversationId, só aquela conversa; sem, a linha inteira.
    useEffect(() => {
        if (conversationRefreshRequest.seq <= 0) return;
        if (conversationRefreshRequest.conversationId) {
            void refreshConversationByIdRef.current(conversationRefreshRequest.conversationId);
        } else {
            // Vem de outra pessoa (broadcast), não de um gesto desta: falha é de fundo.
            fetchConversationsRef.current?.({ modo: "completo", silencioso: true });
        }
    }, [conversationRefreshRequest]);


    // Grava o array em memória no cache, um retrato por número — e só dos números
    // que já têm commit (do fetch ou do próprio cache). Particiona o array UMA vez,
    // não um filter por número. O que o realtime inseriu num número que ainda não
    // carregou não é um retrato: gravá-lo como cache faria a volta a ele pintar uma
    // lista quase vazia como se estivesse pronta. Os metadados (`fetchedAt`,
    // `complete`) são os do último commit de cada número.
    const espelharNoCache = useCallback((rows: readonly Conversation[]) => {
        const meta = metaPorNumeroRef.current;
        if (meta.size === 0) return;
        const porNumero = new Map<string, Conversation[]>();
        for (const row of rows) {
            const numeroId = row.phone_number_id;
            if (!numeroId || !meta.has(numeroId)) continue;
            const grupo = porNumero.get(numeroId);
            if (grupo) grupo.push(row);
            else porNumero.set(numeroId, [row]);
        }
        for (const [numeroId, { fetchedAt, complete }] of meta) {
            conversationListCache.set(numeroId, { rows: porNumero.get(numeroId) ?? [], fetchedAt, complete });
        }
    }, []);

    // Refaz a busca quando o ESCOPO muda — a chave, e não a identidade do array: cada
    // número é buscado no servidor pelo próprio phone_number_id, então trocar de
    // números exige consultar de novo. showLoading: durante a troca a lista filtrada
    // fica vazia — skeleton no lugar de um "Nenhuma conversa" falso (a menos que
    // algum número do escopo esteja em cache).
    useEffect(() => {
        // Antes de trocar, espelha o array atual no cache dos números que saem — os
        // patches de realtime aplicados desde o último fetch deles não se perdem.
        espelharNoCache(conversationsRef.current);
        // Os números que entram vão para o fim do LRU antes de a capacidade mudar:
        // se o escopo encolhe, o que sai do cache são os que NÃO vamos usar.
        for (const numeroId of escopoIds) {
            const emCache = conversationListCache.get(numeroId);
            if (emCache) conversationListCache.set(numeroId, emCache);
        }
        // Uma lista conjunta mostra todos os números de uma vez: com o LRU em 4, os
        // primeiros a chegar seriam expulsos pelos últimos.
        conversationListCache.setCapacity(Math.max(MAX_LINES, escopoIds.length + 1));

        // Nada do que está em memória vale como "deste escopo" até o primeiro commit
        // (ou a pintura do cache): a marca d'água e os metadados eram do anterior.
        chaveEmMemoriaRef.current = null;
        metaPorNumeroRef.current = new Map();
        maiorUpdatedAtRef.current = null;
        ultimoCompletoEmRef.current = 0;
        atualizarLinhasComFalha((prev) => (prev.length === 0 ? prev : []));

        // Tag pertence a UMA linha e as opções de usuário saem das conversas da
        // linha: manter a seleção ao trocar de número esvaziava a lista em silêncio.
        setSelectedTagIds([]);
        setSelectedUserIds([]);
        // Campanhas e rótulos de disparo também são do escopo.
        setSelectedCampanhas([]);
        setSelectedRotulos([]);
        setSelectedErroEnvio([]);
        // O mesmo vale para setor: uma opção de grupo (mesmo nome em vários números) não
        // existe mais no escopo novo.
        setSelectedSectorIds([]);
        // A contagem de não-lido acompanha os mesmos números da lista: o badge só é
        // renderizado nas linhas daqui, e buscar os outros números era o que
        // aproximava um admin com acesso a todos do teto de linhas do PostgREST.
        // Escopo pendente: sem número não há contagem a fazer (ver `escopoPendente`).
        if (!escopoPendenteRef.current) void refreshUnreadCounts();
        fetchConversations({ showLoading: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [escopoKey]);

    // Revalidação incremental: UMA requisição com o que mudou nos números do escopo
    // desde a marca d'água do servidor (o maior updated_at já visto). É upsert, e
    // nunca remove: uma conversa apagada, ou que saiu do escopo da RLS, só some no
    // completo periódico (`decidirModo`) ou pelos canais que já cuidam disso. Não
    // invalida um fetch completo em voo e não se acumula com outro incremental.
    //
    // Os co-responsáveis saem numa segunda leitura, junto: incluir ou tirar um não move
    // `conversations.updated_at`, e o incremental, que busca por ele, nunca os veria.
    const revalidarIncremental = useCallback((): Promise<void> => {
        if (incrementalEmVooRef.current) return incrementalEmVooRef.current;

        const desde = maiorUpdatedAtRef.current;
        const numeros = escopoIdsRef.current;
        if (!desde || numeros.length === 0) return Promise.resolve();

        // Pega o id atual SEM somar: um incremental não pode atropelar o completo que
        // comece depois dele, mas é descartado por ele (o completo traz tudo de novo).
        const fetchId = fetchIdRef.current;
        const isCurrent = () => fetchId === fetchIdRef.current;
        const escopoDaBusca = escopoSetRef.current;
        // Mesma regra do completo: no empate de last_message_at vale a versão local do
        // que foi tocado (realtime/otimista) depois do início da busca; o que o realtime
        // TIROU da lista nesse intervalo não volta pelo que o servidor leu antes.
        touchedSinceFetchRef.current = new Set();
        const touched = touchedSinceFetchRef.current;
        removidosDuranteBuscaRef.current = new Set();
        const removidos = removidosDuranteBuscaRef.current;

        const voo: Promise<void> = (async () => {
            try {
                const [resultado, retrato] = await Promise.all([
                    buscarIncremental({
                        escopo: numeros,
                        desde,
                        buscar: (numerosDaBusca, atualizadoApos) =>
                            supabase
                                .from("conversations")
                                .select(LIST_COLUMNS)
                                .in("phone_number_id", numerosDaBusca)
                                .gt("updated_at", atualizadoApos)
                                .order("updated_at", { ascending: false })
                                .range(0, LIST_PAGE_SIZE - 1),
                    }),
                    lerCoResponsaveis(numeros),
                ]);
                if (!isCurrent()) return;

                // Página cheia = pode haver mais do que veio: o completo refaz tudo (e traz o embed junto).
                if (resultado.precisaCompleto) {
                    await fetchConversationsRef.current?.({ modo: "completo", silencioso: true });
                    return;
                }

                maiorUpdatedAtRef.current = maisRecente(maiorUpdatedAtRef.current, resultado.maiorUpdatedAt);

                if (resultado.rows.length > 0) {
                    const fetched = new Map(resultado.rows.map((row) => [row.id, row] as const));
                    // complete=false: só acrescenta e atualiza, nunca tira o que não veio. Como não
                    // decide pela linha de origem, uma passada só cobre a resposta inteira (vários
                    // números) e devolve a mesma lista quando nada mudou.
                    setConversations((prev) =>
                        reconcileFetched(prev, fetched, { escopo: escopoDaBusca, startedAt: 0, complete: false, touched, removidos }),
                    );
                }

                if (retrato) {
                    // O que o realtime tocou durante a leitura é mais novo que o retrato, e o que o
                    // próprio incremental trouxe tem o embed lido na mesma hora: ficam como estão.
                    const ignorar = new Set<string>([...touched, ...removidos, ...resultado.rows.map((conv) => conv.id)]);
                    aplicarCoResponsaveis(retrato, { escopo: escopoDaBusca, ignorar });
                }
            } catch (error) {
                // Segundo plano: o próximo disparo tenta de novo, e o banner da lista só
                // fala de falha do carregamento completo.
                console.warn("[ConversationsList] revalidação incremental falhou:", error);
            } finally {
                if (incrementalEmVooRef.current === voo) incrementalEmVooRef.current = null;
            }
        })();
        incrementalEmVooRef.current = voo;
        return voo;
    }, [setConversations, lerCoResponsaveis, aplicarCoResponsaveis]);

    const fetchConversations = useCallback(async (opts?: OpcoesDeBusca): Promise<ResultadoDaLista> => {
        // Os números do escopo cujo último completo falhou. O estado vive numa ref para a
        // decisão valer logo depois de um await.
        const numerosComFalha = () => linhasComFalhaRef.current.filter((id) => escopoSetRef.current.has(id));

        // Revalidação de fundo (poll, volta da aba, canal reassinado): incremental
        // sempre que houver de onde partir. Um completo em voo já cobre o pedido, e
        // atropelá-lo o reiniciaria do zero.
        if (opts?.modo === "incremental") {
            if (escopoIdsRef.current.length === 0) return SEM_FALHAS;
            if (completoEmVooRef.current !== null) {
                // Esperar um completo preso seria nunca mais revalidar: depois do prazo o
                // pedido de fundo o refaz (cai no completo abaixo).
                if (Date.now() - completoIniciadoEmRef.current < COMPLETO_PRESO_APOS_MS) return SEM_FALHAS;
            } else {
                const decidido = decidirModo({
                    pedido: "incremental",
                    maiorUpdatedAt: maiorUpdatedAtRef.current,
                    ultimoCompletoEm: ultimoCompletoEmRef.current,
                    agora: Date.now(),
                    adiarCompleto: opts.adiarCompleto === true,
                    aposQueda: opts.aposQueda === true,
                });
                // Todos os números do escopo falharam no último completo: não há o que
                // incrementar, e o completo abaixo os refaz (é o poll de sempre).
                const todosFalharam = numerosComFalha().length >= escopoIdsRef.current.length;
                if (decidido === "incremental" && !todosFalharam) {
                    const idAntes = fetchIdRef.current;
                    await revalidarIncremental();
                    // Um incremental só enxerga o que mudou desde a marca d'água: o número que
                    // falhou no completo ficou sem as conversas antigas dele, e o próximo
                    // completo do escopo todo só viria em até 10 min. Refaz só ele, sem mexer
                    // nos que carregaram. Se um completo começou no meio (resposta cheia do
                    // incremental, pedido do usuário, troca de escopo), ele já cuida disso.
                    if (fetchIdRef.current !== idAntes || completoEmVooRef.current !== null) return SEM_FALHAS;
                    const pendentes = numerosComFalha();
                    if (pendentes.length === 0) return SEM_FALHAS;
                    return (await fetchConversationsRef.current?.({ silencioso: true, somente: pendentes })) ?? SEM_FALHAS;
                }
            }
        }

        // Sequência de fetch: respostas de um fetch antigo (ex.: realtime disparado
        // antes de uma troca de escopo) não podem sobrescrever o resultado mais novo.
        // Vale para o escopo inteiro, não por número.
        const chave = escopoKeyRef.current;
        const escopoDaBusca = escopoSetRef.current;
        const somente = opts?.somente;
        // O completo parcial refaz só os números pedidos (ainda do escopo): o reconcile
        // continua sendo do escopo inteiro, e as conversas dos outros passam intactas.
        const numeros = somente ? Array.from(new Set(somente.filter((id) => escopoDaBusca.has(id)))) : escopoIdsRef.current;
        if (somente && numeros.length === 0) return SEM_FALHAS;
        const fetchId = ++fetchIdRef.current;
        const isCurrent = () => fetchId === fetchIdRef.current;
        // Um incremental em voo foi superado por este (o id mudou): solta a vaga.
        incrementalEmVooRef.current = null;

        if (numeros.length === 0) {
            // Sem número selecionado: NÃO drenar a org inteira (eram dois drains
            // org-wide no mount, descartados assim que a linha era escolhida).
            // Só decide entre "org sem número" (lista vazia) e "aguardando o
            // Dashboard resolver a seleção" (este effect roda de novo quando ele
            // escolher; com a org sem número ele deixa a seleção nula). A contagem
            // é só de números ATIVOS, como o mapa que o Dashboard usa para decidir.
            // Um fetch do escopo anterior pode ter ficado para trás sem passar pelo
            // `finally`: o rodapé "carregando mais…" não pode ficar preso.
            setIsLoadingMore(false);
            if (!currentOrganization) {
                setConversations([]);
                setIsLoadingConversations(false);
                return SEM_FALHAS;
            }
            // Conjunta com o mapa em erro: a contagem não diz nada (falha junto com o mapa, ou
            // dá > 0 e deixaria o skeleton preso). A tela mostra o erro do mapa.
            if (numerosEmErroRef.current) return SEM_FALHAS;
            // Escopo pendente (o mapa ainda não chegou): o skeleton segue até o escopo chegar.
            if (escopoPendenteRef.current) return SEM_FALHAS;
            const count = await contarNumerosAtivos(currentOrganization.id);
            if (!isCurrent()) return SEM_FALHAS;
            if (!count) {
                setConversations([]);
                setIsLoadingConversations(false);
            }
            return SEM_FALHAS;
        }

        // SWR: o que há em cache pinta na hora e o fetch abaixo revalida por trás.
        // Só na carga do escopo — com o array já deste escopo em memória (um poll, um
        // refresh), repintar do cache seria desfazer à toa o que o realtime aplicou.
        // Cada número contribui com o que tem; número sem cache não entra. O completo
        // parcial nunca pinta do cache: o array em memória é do escopo inteiro, e pintar
        // só os números pedidos o trocaria pelo pedaço.
        const emCache = somente
            ? []
            : numeros.flatMap((numeroId) => {
                  const entrada = conversationListCache.get(numeroId);
                  return entrada ? [{ numeroId, entrada }] : [];
              });
        if (chaveEmMemoriaRef.current !== chave && emCache.length > 0) {
            // A conversa que mudou de número pode estar nos caches dos dois: do mais
            // velho para o mais novo, para a versão do cache mais fresco ficar.
            const porId = new Map<string, Conversation>();
            const meta = new Map<string, { fetchedAt: number; complete: boolean }>();
            for (const { numeroId, entrada } of [...emCache].sort((a, b) => a.entrada.fetchedAt - b.entrada.fetchedAt)) {
                meta.set(numeroId, { fetchedAt: entrada.fetchedAt, complete: entrada.complete });
                for (const row of entrada.rows) porId.set(row.id, row);
            }
            chaveEmMemoriaRef.current = chave;
            metaPorNumeroRef.current = meta;
            setConversations(Array.from(porId.values()));
            // O cache de um número vazio não prova que os outros também são: sem nada para
            // mostrar e com número ainda sem cache, o skeleton continua até a rede responder.
            setIsLoadingConversations(porId.size === 0 && emCache.length < numeros.length);
        } else if (emCache.length === 0 && opts?.showLoading) {
            setIsLoadingConversations(true);
        }
        setIsLoadingMore(true);
        // Busca que não é de fundo (troca de número, Tentar novamente, puxar para atualizar) começa do
        // zero: as falhas dos números que ela refaz não valem enquanto corre, como o antigo
        // `setFetchError(false)`. Quem falhar de novo volta pelo `aoFalhar` e pelo fim da busca. A
        // revalidação de fundo não mexe: a faixa dela só sai por número, no commit completo.
        if (!opts?.silencioso) {
            atualizarLinhasComFalha((prev) => {
                const proximo = prev.filter((id) => !numeros.includes(id));
                return proximo.length === prev.length ? prev : proximo;
            });
        }
        completoEmVooRef.current = fetchId;
        completoIniciadoEmRef.current = Date.now();

        // Ids tocados (realtime/otimista) DEPOIS do início deste fetch: no
        // empate de last_message_at o reconcile prefere a versão local deles —
        // fechar/assumir não mexe no timestamp e o snapshot da página venceria. O que o
        // realtime TIROU da lista nesse intervalo (DELETE, saída do escopo) não volta
        // por um snapshot lido antes.
        touchedSinceFetchRef.current = new Set();
        const touched = touchedSinceFetchRef.current;
        removidosDuranteBuscaRef.current = new Set();
        const removidos = removidosDuranteBuscaRef.current;
        // O contador de lista da tela só enxerga o que o React já renderizou: um commit
        // do mesmo instante ainda não chegou ao `conversationsRef`.
        let entregouConversas = false;
        // Números cuja página 1 já resolveu (chegou ou falhou). O skeleton só sai quando
        // TODOS resolveram: com a porta da primeira pintura aberta pelo prazo, o commit
        // de um número vazio não prova que a lista está vazia enquanto os outros esperam.
        const resolvidos = new Set<string>();
        const resolver = (numeroId: string) => {
            resolvidos.add(numeroId);
            return resolvidos.size >= numeros.length;
        };
        let falhasDoLote: readonly string[] = [];

        try {
            // Um fetch por número, em paralelo: `.eq` + `.range` usa o índice
            // (phone_number_id, last_message_at DESC, id DESC). Tamanho de página = o
            // max_rows do PostgREST. Ordem com desempate por id: last_message_at
            // empata entre conversas paradas e a página pularia linhas. `count` só na
            // página 1: é ela que diz quantas páginas disparar; nas demais seria uma
            // contagem extra por request sem uso.
            const resultado = await buscarEscopoCompleto({
                escopo: numeros,
                buscarPagina: (numeroId, from, comCount) =>
                    supabase
                        .from("conversations")
                        .select(LIST_COLUMNS, comCount ? { count: "exact" } : undefined)
                        .eq("phone_number_id", numeroId)
                        .order("last_message_at", { ascending: false })
                        .order("id", { ascending: false })
                        .range(from, from + LIST_PAGE_SIZE - 1),
                isCurrent,
                // Commit progressivo: a página 1 pinta sozinha, as demais entram
                // conforme chegam. `complete=false` até a última página: o reconcile
                // não pode descartar uma conversa local só porque ela ainda não veio.
                aoCommitar: (numeroId, fetched, { watermark, complete }) => {
                    const todosResolvidos = resolver(numeroId);
                    if (fetched.size > 0) entregouConversas = true;
                    chaveEmMemoriaRef.current = chave;
                    metaPorNumeroRef.current.set(numeroId, { fetchedAt: Date.now(), complete });
                    setConversations((prev) =>
                        reconcileFetched(prev, fetched, {
                            numeroId,
                            escopo: escopoDaBusca,
                            startedAt: watermark,
                            complete,
                            touched,
                            removidos,
                        }),
                    );
                    if (todosResolvidos) setIsLoadingConversations(false);
                    // Carregou por inteiro: a faixa de erro deste número sai na hora.
                    if (complete) {
                        atualizarLinhasComFalha((prev) => (prev.includes(numeroId) ? prev.filter((id) => id !== numeroId) : prev));
                    }
                },
                aoFalhar: (numeroId, error) => {
                    console.error(`Error fetching conversations (${numeroId}):`, error);
                    atualizarLinhasComFalha((prev) => (prev.includes(numeroId) ? prev : [...prev, numeroId].sort()));
                    // Falhar também resolve o número: o skeleton não espera a vez de quem não vai chegar.
                    if (resolver(numeroId)) setIsLoadingConversations(false);
                },
            });
            if (!isCurrent()) return SEM_FALHAS;

            // Um número que falha não derruba os outros nem apaga o que já estava em
            // memória dele. Todos falharam: nada novo foi entregue, e o completo
            // continua "velho" para a próxima revalidação tentar de novo. O completo
            // parcial só conta quando refaz o escopo inteiro (o "Tentar novamente" de um número
            // só, por exemplo): se não cobre o escopo, adiantar o relógio do completo
            // periódico deixaria sem limpeza o que o incremental não vê.
            const cobreOEscopo = numeros.length >= escopoIdsRef.current.length;
            if (cobreOEscopo && resultado.falhas.length < numeros.length) ultimoCompletoEmRef.current = Date.now();
            maiorUpdatedAtRef.current = maisRecente(maiorUpdatedAtRef.current, resultado.maiorUpdatedAt);

            const falhas = [...resultado.falhas].sort();
            falhasDoLote = falhas;
            atualizarLinhasComFalha((prev) => {
                // O completo parcial só fala dos números que refez: os outros seguem como estavam.
                const proximo = somente ? [...prev.filter((id) => !numeros.includes(id)), ...falhas].sort() : falhas;
                return mesmaLista(prev, proximo) ? prev : proximo;
            });
            // Um aviso por lote, e só quando há conversas na tela (sem elas, o estado
            // de erro da lista já tem o botão). Revalidação de fundo não avisa. O texto
            // é fixo de propósito: o que falhou é um SELECT da lista, que nunca traz
            // mensagem escrita para gente (a causa crua já foi para o console).
            const haConversas =
                entregouConversas ||
                conversationsRef.current.some((conv) => !!conv.phone_number_id && escopoDaBusca.has(conv.phone_number_id));
            if (falhas.length > 0 && haConversas && !opts?.silencioso) {
                toast({
                    title: "Não foi possível carregar todas as conversas",
                    description: "Verifique a conexão e tente novamente.",
                    variant: "destructive",
                });
            }
        } catch (error) {
            // `buscarEscopoCompleto` trata cada número por conta própria: chegar aqui é
            // defeito nosso, e a tela não pode ficar presa em "carregando".
            console.error("Error fetching conversations:", error);
            falhasDoLote = numeros;
        } finally {
            if (completoEmVooRef.current === fetchId) completoEmVooRef.current = null;
            if (isCurrent()) {
                setIsLoadingConversations(false);
                setIsLoadingMore(false);
            }
        }
        return { falhas: falhasDoLote };
    }, [currentOrganization, setConversations, revalidarIncremental, atualizarLinhasComFalha, toast]);

    // Mantém a referência sempre na versão mais recente (callbacks de vida longa).
    useEffect(() => {
        fetchConversationsRef.current = fetchConversations;
    }, [fetchConversations]);

    // Espelho do estado no cache por número: toda mudança (fetch, realtime, patch
    // otimista) fica gravada, então voltar a estes números — ou remontar o Dashboard
    // — pinta o último estado conhecido sem esperar a rede. Só grava quando o array
    // em memória é de fato deste escopo (troca em andamento não).
    useEffect(() => {
        if (chaveEmMemoriaRef.current !== escopoKey) return;
        espelharNoCache(conversations);
    }, [conversations, escopoKey, espelharNoCache]);

    const fetchTags = async () => {
        if (!currentOrganization) {
            setTags([]);
            setMemberNames(new Map());
            return;
        }

        // Nomes dos membros da organização (usados na atribuição de conversa).
        const { data: members } = await supabase
            .from("organization_members")
            .select("user_id, profiles:user_id(first_name, last_name, email)")
            .eq("organization_id", currentOrganization.id);

        const names: MemberNames = new Map();
        const profiles = new Map<string, Conversation["profiles"]>();
        for (const { user_id, profiles: profile } of members || []) {
            const label =
                [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() ||
                profile?.email?.split("@")[0]?.trim();
            if (label) names.set(user_id, label);
            profiles.set(
                user_id,
                profile
                    ? {
                          first_name: profile.first_name ?? null,
                          last_name: profile.last_name ?? null,
                          email: profile.email ?? null,
                      }
                    : null,
            );
        }
        setMemberNames(names);
        memberProfilesRef.current = profiles;

        // Sem filtro por criador: tags.user_id é só quem criou, e filtrar por ele
        // escondia do usuário comum as tags criadas por admin (82 das 109 em
        // produção) — o "+" sumia e não havia erro nenhum na tela. Quem enxerga
        // cada tag é a RLS de tags (escopo por linha), que é a autoridade certa.
        const { data, error } = await withRetry("lista de tags", () =>
            supabase.from("tags").select("*").order("name"),
        );

        if (error) {
            console.error("Error fetching tags:", error);
            toast({
                title: "Não foi possível carregar tags",
                description: toUserMessage(error, "Verifique a conexão e tente novamente."),
                variant: "destructive",
            });
            return;
        }

        setTags(data || []);
    };

    // As tags das conversas, uma chamada por número do escopo (até 4 ao mesmo tempo).
    //
    // O escopo por linha NÃO é otimização, é correção: sem ele a RPC devolvia as tags de
    // todas as linhas de uma vez e o PostgREST cortava em
    // db_max_rows=1000 sem erro nenhum — as tags de uma linha inteira simplesmente não
    // vinham. Ver a função get_conversation_tags_for_user (supabase/migrations/*_baseline.sql).
    //
    // `somente` refaz só esses números (marcar uma tag mexe numa conversa, de um número).
    // Um número que falha mantém o que já se sabia das conversas dele, e o aviso sai UMA vez
    // por lote. Uma busca mais nova do MESMO número vale mais que a antiga que ainda corre.
    const fetchConversationTags = async (somente?: readonly string[]) => {
        const chave = escopoKeyRef.current;
        const escopoDaBusca = escopoSetRef.current;
        const numeros = somente
            ? Array.from(new Set(somente.filter((id) => escopoDaBusca.has(id))))
            : escopoIdsRef.current;
        if (numeros.length === 0) return;

        const busca = ++tagsBuscaRef.current;
        for (const numeroId of numeros) tagsBuscaPorNumeroRef.current.set(numeroId, busca);

        const resultados = await buscarTagsDosNumeros(numeros, (numeroId) =>
            withRetry("tags das conversas", () =>
                supabase.rpc("get_conversation_tags_for_user", { p_phone_number_id: numeroId }),
            ),
        );

        // O escopo mudou durante a busca: as tags são de outros números.
        if (chave !== escopoKeyRef.current) return;
        const vigentes = resultados.filter((r) => tagsBuscaPorNumeroRef.current.get(r.numeroId) === busca);
        if (vigentes.length === 0) return;

        const linhaPorConversa = new Map(conversationsRef.current.map((conv) => [conv.id, conv.phone_number_id]));
        const completo = vigentes.length >= escopoDaBusca.size;
        setConversationTags((anterior) =>
            mesclarTagsDosNumeros({
                anterior,
                resultados: vigentes,
                linhaDaConversa: (conversationId) => linhaPorConversa.get(conversationId),
                escopo: escopoDaBusca,
                completo,
            }),
        );

        if (vigentes.some((r) => r.tags === null)) {
            toast({
                title: "Não foi possível carregar as tags das conversas",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        }
    };

    // Marcar ou tirar uma tag mexe numa conversa, que é de UM número: refaz só as tags dele.
    // Conversa fora da lista em memória (o número não se sabe) refaz as do escopo todo.
    const refazTagsDaConversa = (conversationId: string) => {
        const numeroId = conversationsRef.current.find((conv) => conv.id === conversationId)?.phone_number_id;
        void fetchConversationTags(numeroId ? [numeroId] : undefined);
    };

    // Latest-ref das funções de tags: callbacks de vida longa (pull-to-refresh,
    // canal realtime) não podem guardar a closure do primeiro render — o
    // fetchTags antigo via currentOrganization=null e APAGAVA as tags no refresh.
    const fetchTagsRef = useRef<typeof fetchTags>();
    fetchTagsRef.current = fetchTags;
    const fetchConversationTagsRef = useRef<typeof fetchConversationTags>();
    fetchConversationTagsRef.current = fetchConversationTags;

    // Trocar de números precisa rebuscar as tags: a RPC é escopada por número, então o mapa
    // do escopo anterior não serve. O effect grande de reset depende só de [userId,
    // organização], e acrescentar o escopo nas deps dele limparia a lista de conversas
    // inteira a cada troca — daí este effect separado, que faz só o refetch das tags.
    // Chaveado pela CHAVE do escopo, não pela identidade do array. A montagem não conta: o
    // effect de organização acima já busca as tags dela (uma busca só por número, não duas).
    const tagsDoEscopoMontadasRef = useRef(false);
    useEffect(() => {
        if (!tagsDoEscopoMontadasRef.current) {
            tagsDoEscopoMontadasRef.current = true;
            return;
        }
        void fetchConversationTagsRef.current?.();
    }, [escopoKey]);


    const handleSelectConversation = async (conversationId: string) => {
        const conversation = conversations.find(c => c.id === conversationId);
        // Congela a ordenação: se tinha não-lidas, segue ordenando como não-lida
        // enquanto selecionada — a lista não se reordena embaixo do cursor.
        selectedFreezeRef.current = {
            id: conversationId,
            hadUnread: isConversationUnread(
                unreadCounts.get(conversationId) || 0,
                markedUnread.has(conversationId),
            ),
        };
        // Congela a contagem ANTES do reset: o ChatArea posiciona o divisor
        // "N mensagens não lidas" com este valor.
        captureUnreadAtOpen(conversationId, unreadCounts.get(conversationId) || 0);
        onSelectConversation(conversationId, conversation?.contact_name, conversation?.phone_number_id);
        resetUnread(conversationId);
        resetFailed(conversationId);
    };

    // Uma conversa criada pelos diálogos (nova conversa, grupo): com o id, rebusca só ela; sem
    // id (importação de histórico, grupo que já existia), refaz a lista.
    const recarregarConversaCriada = useCallback((conversationId?: string) => {
        if (conversationId) void refreshConversationByIdRef.current(conversationId);
        else void fetchConversationsRef.current?.();
    }, []);

    // Pull-to-refresh handler (via refs — o gesto vive além deste render)
    const handleRefresh = useCallback(async () => {
        const { falhas } = (await fetchConversationsRef.current?.()) ?? SEM_FALHAS;
        await fetchTagsRef.current?.();
        await fetchConversationTagsRef.current?.();
        refreshUnreadCounts();
        // A busca já avisou o que não carregou (toast, faixa ou o estado de erro da lista):
        // confirmar "Atualizado" logo depois seria contradizê-la.
        if (falhas.length > 0) return;
        toast({
            title: "Atualizado",
            description: "Lista de conversas atualizada",
        });
    }, []);

    // Encerrar conversa (status='closed') — otimista, com Desfazer.
    const handleSwipeClose = useCallback(async (conversationId: string) => {
        const snapshot = conversations.find((c) => c.id === conversationId);
        if (!snapshot) return;

        // Gesto físico merece resposta imediata: a linha sai da aba na hora.
        touchedSinceFetchRef.current.add(conversationId);
        setConversations((prev) =>
            prev.map((c) => (c.id === conversationId ? { ...c, status: "closed" } : c))
        );

        const { error } = await supabase
            .from("conversations")
            .update({
                status: "closed",
                closed_at: new Date().toISOString(),
                closed_by: userId,
            })
            .eq("id", conversationId);

        if (error) {
            // Rollback
            setConversations((prev) =>
                prev.map((c) => (c.id === conversationId ? { ...c, status: snapshot.status } : c))
            );
            toast({
                title: "Não foi possível encerrar",
                description: toUserMessage(error, "Verifique a conexão e tente novamente."),
                variant: "destructive",
            });
            return;
        }

        toast({
            title: "Conversa encerrada",
            duration: 8000,
            action: (
                <ToastAction
                    altText="Desfazer encerramento"
                    onClick={async () => {
                        setConversations((prev) =>
                            prev.map((c) =>
                                c.id === conversationId ? { ...c, status: snapshot.status } : c
                            )
                        );
                        await supabase
                            .from("conversations")
                            .update({ status: snapshot.status, closed_at: null, closed_by: null })
                            .eq("id", conversationId);
                    }}
                >
                    Desfazer
                </ToastAction>
            ),
        });
    }, [conversations, setConversations, userId, toast]);

    // Exportar a conversa em .xlsx (menu de botão direito).
    const handleExportConversation = useCallback(async (conversationId: string) => {
        if (exportingId) return; // um arquivo por vez, como o assumir

        setExportingId(conversationId);
        // O menu fecha no onSelect e o spinner do item fica invisível: este
        // toast é o único sinal de que o clique pegou. Conversa longa leva
        // alguns segundos — e o primeiro export ainda baixa o chunk do xlsx.
        toast({ title: "Gerando planilha…" });
        try {
            const { messageCount } = await exportConversationToXlsx(conversationId);
            toast({
                title: "Conversa exportada",
                description: `${messageCount} ${messageCount === 1 ? "mensagem" : "mensagens"}.`,
            });
        } catch (error) {
            const expected = error instanceof ConversationExportError;
            toast({
                title: expected ? "Nada para exportar" : "Erro ao exportar conversa",
                description: expected ? error.message : "Tente novamente em instantes.",
                variant: "destructive",
            });
            if (!expected) console.error("[export] falha ao exportar conversa:", error);
        } finally {
            // Sem isto um erro deixaria o item desabilitado até o remount.
            setExportingId(null);
        }
    }, [exportingId, toast]);

    // Swipe action: Mark as read
    const handleSwipeMarkRead = useCallback(async (conversationId: string) => {
        resetUnread(conversationId);
        toast({ title: "Marcado como lido" });
    }, [resetUnread]);

    // ── Menu de contexto da linha (desktop) ────────────────────────────────
    // Alvo do menu: a conversa em que o botão direito caiu. Fica em estado (e não
    // por linha) porque o diálogo de transferência é UM só para a lista inteira —
    // montar um por linha dentro do Virtuoso seria pagar o hook a cada scroll.
    const [transferTargetId, setTransferTargetId] = useState<string | null>(null);
    // A conversa da transferência em curso, para o callback do hook (que vive além do render).
    const transferTargetIdRef = useRef(transferTargetId);
    transferTargetIdRef.current = transferTargetId;
    const transferTarget = useMemo(
        () => conversations.find((c) => c.id === transferTargetId) ?? null,
        [conversations, transferTargetId],
    );

    // Reaproveita o MESMO caminho do ChatArea: a RPC promote_co_owner_to_primary,
    // a nota automática de transferência e o broadcast que avisa o destinatário.
    // Reimplementar isso aqui seria a duplicação errada.
    const { transferConversation, releaseConversation } = useConversation({
        conversationId: transferTargetId,
        userId,
        seedConversation: transferTarget
            ? {
                  id: transferTarget.id,
                  contact_name: transferTarget.contact_name,
                  contact_phone: transferTarget.contact_phone,
              }
            : null,
        // A transferência toca UMA conversa: rebusca só ela, e não a lista de todos os números.
        onConversationUpdate: () => {
            const id = transferTargetIdRef.current;
            // Transferiu a conversa que está aberta: fecha o chat, como o Transferir do
            // cabeçalho faz. Com "só quem assumiu vê" ela pode ter saído do acesso, e o
            // banco não avisa quem fez a troca (o chat ficaria aberto com o envio ativo).
            if (id && selectedConversationIdRef.current === id) onDeselectConversation?.();
            if (id) void refreshConversationByIdRef.current(id);
            else void fetchConversationsRef.current?.();
        },
        onSuccess: (title, description) => toast({ title, description }),
        onError: (title, description) => toast({ title, description, variant: "destructive" }),
    });

    // Os dois sentidos NÃO são simétricos. "Marcar como lida" precisa zerar o
    // contador de verdade (senão a linha com 3 mensagens continuaria com badge 3
    // depois de o menu dizer que a marcou como lida), e quem faz isso é o
    // resetUnread — a mesma RPC do swipe e do clique na linha, que de quebra já
    // limpa a marcação manual. Ligar é que é exclusivo da flag.
    const handleToggleUnread = useCallback(
        async (conversationId: string, isCurrentlyUnread: boolean) => {
            if (isCurrentlyUnread) {
                await resetUnread(conversationId);
                toast({ title: "Marcada como lida" });
                return;
            }

            // Marcar a conversa ABERTA exige fechá-la antes. O ChatArea mantém
            // activeConversationId e o NotificationContext marca como lida toda
            // conversa ativa — marcar sem fechar seria apagado no mesmo instante.
            // Fechar primeiro (e não depois) porque o effect de leitura dispara
            // na TROCA de conversa; indo para null ele não faz nada.
            if (selectedConversationId === conversationId) {
                onDeselectConversation?.();
            }

            const ok = await markConversationUnread(conversationId);
            if (!ok) {
                // O contexto já reverteu o estado a partir do servidor; confirmar
                // "marcada" aqui seria a UI mentindo sobre o que foi gravado.
                toast({
                    title: "Não foi possível marcar como não lida",
                    description: "Tente de novo em instantes.",
                    variant: "destructive",
                });
                return;
            }
            toast({ title: "Marcada como não lida" });
        },
        [markConversationUnread, resetUnread, selectedConversationId, onDeselectConversation, toast],
    );

    const handleMenuTransfer = useCallback(
        async (targetUserId: string, targetUserName: string, keepAsCoOwner: boolean) => {
            const success = await transferConversation(targetUserId, targetUserName, keepAsCoOwner);
            if (success) setTransferTargetId(null);
        },
        [transferConversation],
    );

    // Botão da linha: o stopPropagation é só dele — pelo menu de contexto não há
    // clique na linha para conter. Os dois caminhos passam por resolveAndAssign,
    // senão assumir pelo menu deixaria a conversa sem setor.
    const handleAssignToMe = (conversationId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        resolveAndAssign(conversationId);
    };

    const handleAddTag = async (conversationId: string, tagId: string, e: React.MouseEvent) => {
        e.stopPropagation();

        const { error } = await supabase
            .from("conversation_tags")
            .insert({ conversation_id: conversationId, tag_id: tagId });

        if (error) {
            if (error.code === "23505") {
                // Duplicate - tag already exists
                return;
            }
            toast({
                title: "Não foi possível adicionar tag",
                description: toUserMessage(error, "Verifique a conexão e tente novamente."),
                variant: "destructive",
            });
            return;
        }

        refazTagsDaConversa(conversationId);
    };

    const handleRemoveTag = async (conversationId: string, tagId: string, e: React.MouseEvent) => {
        e.stopPropagation();

        const { error } = await supabase
            .from("conversation_tags")
            .delete()
            .eq("conversation_id", conversationId)
            .eq("tag_id", tagId);

        if (error) {
            toast({
                title: "Não foi possível remover tag",
                description: toUserMessage(error, "Verifique a conexão e tente novamente."),
                variant: "destructive",
            });
            return;
        }

        refazTagsDaConversa(conversationId);
    };

    // Base de todos os filtros: só os números do escopo (sem nenhum, tudo o que há em
    // memória). Memo próprio porque as opções do filtro por usuário derivam DAQUI —
    // se derivassem da lista já filtrada, digitar na busca encolheria o dropdown. De
    // brinde, digitar não refaz mais o filtro de telefone.
    const filteredByPhone = useMemo(
        () =>
            escopoSet.size > 0
                ? conversations.filter((conv) => !!conv.phone_number_id && escopoSet.has(conv.phone_number_id))
                : conversations,
        [conversations, escopoSet],
    );

    // Quem assumiu ou é co-responsável de alguma conversa NESTA linha — é essa a
    // lista do dropdown, não o roster da organização.
    const assigneeOptions = useMemo(
        () => buildAssigneeOptions(filteredByPhone, memberNames),
        [filteredByPhone, memberNames],
    );

    const userFilterOptions = useMemo<FilterOption[]>(
        () =>
            assigneeOptions.map((option) => ({
                ...option,
                label: option.id === userId ? `${option.label} (você)` : option.label,
            })),
        [assigneeOptions, userId],
    );

    // Tag pertence a uma linha: as opções são as dos números do escopo (sem escopo, todas).
    // Com mais de um número o mesmo nome existe uma vez por número; o filtro mostra uma
    // opção por nome (id = a chave do nome) e casa qualquer tag do grupo.
    const tagsDoEscopo = useMemo(
        () =>
            escopoSet.size > 0
                ? tags.filter((t) => !!t.phone_number_id && escopoSet.has(t.phone_number_id))
                : tags,
        [tags, escopoSet],
    );
    const agruparPorNome = escopoIds.length > 1;
    const tagOptionGroups = useMemo(
        () => opcoesAgrupadas(tagsDoEscopo, { nome: (t) => t.name, cor: (t) => t.color }, agruparPorNome),
        [tagsDoEscopo, agruparPorNome],
    );
    const tagFilterOptions = useMemo<FilterOption[]>(
        () => tagOptionGroups.map(({ id, label, color }) => ({ id, label, color })),
        [tagOptionGroups],
    );
    // Os ids de tag que a seleção casa (a opção de um grupo vale por todas as tags dele).
    const selectedTagIdsExpanded = useMemo(
        () => expandirSelecao(selectedTagIds, tagOptionGroups),
        [selectedTagIds, tagOptionGroups],
    );

    // Marcar uma pessoa dentro de uma aba por atribuição é vazio por construção:
    // essas abas JÁ são um filtro por pessoa, relativo a mim. Mesmo espírito dos
    // fallbacks de aba mais abaixo. Só na primeira marcação — marcar ou desmarcar
    // mais gente depois não arranca ninguém da aba onde escolheu ficar.
    const handleUserFilterChange = useCallback((ids: string[]) => {
        if (
            selectedUserIds.length === 0 &&
            ids.length > 0 &&
            (activeTab === "waiting" || activeTab === "mine" || activeTab === "shared")
        ) {
            setActiveTab("all");
        }
        setSelectedUserIds(ids);
    }, [selectedUserIds, activeTab]);

    // Usuário antes de tag: é o filtro novo e o que reordena a triagem do dia.
    // "Sem setor" primeiro: a fila de triagem é o que a divisão faz alguém abrir
    // várias vezes por dia, e ela não é um setor cadastrado.
    // Os setores dos números do escopo que têm isolamento (os legados, sem número, valem para
    // todos), na ordem em que vieram. Com mais de um número no escopo o mesmo nome agrupa.
    const sectorOptionGroups = useMemo(() => {
        const ids = new Set<string>();
        for (const numeroId of numerosComIsolamento) {
            for (const sector of sectorsForPhone(sectors, numeroId)) ids.add(sector.id);
        }
        return opcoesAgrupadas(
            sectors.filter((sector) => ids.has(sector.id)),
            { nome: (sector) => sector.name, cor: (sector) => sector.color ?? SECTOR_FALLBACK_COLOR },
            agruparPorNome,
        );
    }, [sectors, numerosComIsolamento, agruparPorNome]);
    const sectorFilterOptions = useMemo<FilterOption[]>(
        () => [
            { id: NO_SECTOR_FILTER_ID, label: "Sem setor (triagem)" },
            ...sectorOptionGroups.map(({ id, label, color }) => ({ id, label, color })),
        ],
        [sectorOptionGroups],
    );
    // Sem número com isolamento o grupo some do popover, e um setor marcado antes não filtra mais.
    const temFiltroDeSetor = numerosComIsolamento.size > 0;
    const selectedSectorIdsExpanded = useMemo(
        () => (temFiltroDeSetor ? expandirSelecao(selectedSectorIds, sectorOptionGroups) : NO_IDS),
        [temFiltroDeSetor, selectedSectorIds, sectorOptionGroups],
    );

    // Canal só aparece quando a linha tem conversa com Direct (linha Instagram
    // dividindo a caixa); sem Direct, uma seleção antiga deixa de valer.
    const lineHasDirect = useMemo(() => filteredByPhone.some((conv) => temDirect(conv)), [filteredByPhone]);
    const activeChannels = lineHasDirect ? selectedChannels : NO_CHANNELS;
    const handleChannelFilterChange = useCallback(
        (ids: string[]) => setSelectedChannels(ids.filter((id): id is CanalDoFiltro => id === "whatsapp" || id === "instagram")),
        [],
    );

    // Tipo (1:1 × grupo) só aparece quando o escopo tem grupo: numa linha só de
    // 1:1 a seção não recortaria nada, e uma seleção antiga deixa de valer.
    const lineHasGroups = useMemo(() => filteredByPhone.some((conv) => !!conv.is_group), [filteredByPhone]);
    const activeTipos = lineHasGroups ? selectedTipos : NO_TIPOS;
    const handleTipoFilterChange = useCallback((ids: string[]) => setSelectedTipos(ids.filter(ehTipoDaConversa)), []);

    // Rede de segurança de Com a IA (comAIa em src/lib/abaDaConversa.ts): a
    // conversa em que a pessoa escreveu e a IA não respondeu em 10 min volta para
    // Aguardando sem esperar outro evento. O relógio só anda enquanto alguma
    // conversa da linha está com a rede correndo; vencida a rede, ele para.
    const [agora, setAgora] = useState(() => Date.now());
    const iaEsperandoResposta = useMemo(
        () => filteredByPhone.some((conv) => iaContandoRede(conv, agora)),
        [filteredByPhone, agora],
    );
    useEffect(() => {
        if (!iaEsperandoResposta) return;
        setAgora(Date.now());
        const relogio = setInterval(() => setAgora(Date.now()), 30_000);
        return () => clearInterval(relogio);
    }, [iaEsperandoResposta]);

    // Quem está em Disparos NESTA linha, antes da busca e dos filtros: as opções
    // dos filtros da aba saem daqui (digitar não encolhe o popover) e a aba
    // existe enquanto houver alguém nela — filtrar até zero não a fecha.
    const disparosDaLinha = useMemo(
        () => filteredByPhone.filter((conv) => filaDaConversa(conv, agora) === "disparos"),
        [filteredByPhone, agora],
    );

    // Mesma ideia para Com a IA: a aba existe enquanto a IA atende alguém na linha.
    const iaDaLinha = useMemo(
        () => filteredByPhone.filter((conv) => filaDaConversa(conv, agora) === "ia"),
        [filteredByPhone, agora],
    );

    const campanhaFilterOptions = useMemo<FilterOption[]>(() => {
        const nomes = new Set<string>();
        for (const conv of disparosDaLinha) {
            for (const nome of conv.disparo_campanhas ?? []) nomes.add(nome);
        }
        return [...nomes].sort((a, b) => a.localeCompare(b, "pt-BR")).map((nome) => ({ id: nome, label: nome }));
    }, [disparosDaLinha]);

    const rotuloFilterOptions = useMemo<FilterOption[]>(() => {
        const rotulos = new Set<string>();
        for (const conv of disparosDaLinha) {
            if (conv.disparo_rotulo) rotulos.add(conv.disparo_rotulo);
        }
        return [...rotulos].sort((a, b) => a.localeCompare(b, "pt-BR")).map((rotulo) => ({ id: rotulo, label: rotulo }));
    }, [disparosDaLinha]);

    const filtrosDeDisparoAtivos =
        selectedCampanhas.length > 0 || selectedRotulos.length > 0 || selectedErroEnvio.length > 0;
    const limparFiltrosDeDisparo = useCallback(() => {
        setSelectedCampanhas((prev) => (prev.length === 0 ? prev : []));
        setSelectedRotulos((prev) => (prev.length === 0 ? prev : []));
        setSelectedErroEnvio((prev) => (prev.length === 0 ? prev : []));
    }, []);

    // Os filtros de Disparos só valem lá: sair da aba os limpa, senão voltariam
    // escondidos (e esvaziando a lista) na próxima visita.
    useEffect(() => {
        if (activeTab !== "disparos") limparFiltrosDeDisparo();
    }, [activeTab, limparFiltrosDeDisparo]);

    const filterGroups = useMemo<FilterGroup[]>(
        () => [
            // Na aba Disparos, os filtros dela vêm primeiro: são os que recortam a fila.
            ...(activeTab === "disparos"
                ? [
                    {
                        key: "campanhas",
                        label: "Campanha",
                        options: campanhaFilterOptions,
                        selected: selectedCampanhas,
                        onChange: setSelectedCampanhas,
                        noOptionsLabel: `Nenhuma campanha nos disparos ${rotuloDoEscopo}`,
                    },
                    {
                        key: "rotulos",
                        label: "Mensagem do disparo",
                        options: rotuloFilterOptions,
                        selected: selectedRotulos,
                        onChange: setSelectedRotulos,
                        noOptionsLabel: `Nenhum disparo com rótulo ${rotuloDoEscopo}`,
                    },
                    {
                        key: "erro_envio",
                        label: "Envio",
                        options: [{ id: "com_erro", label: "Só com erro de envio" }],
                        selected: selectedErroEnvio,
                        onChange: setSelectedErroEnvio,
                        noOptionsLabel: "",
                    },
                ]
                : []),
            ...(lineHasDirect
                ? [{
                    key: "channels",
                    label: "Canal",
                    options: [
                        { id: "whatsapp", label: "WhatsApp" },
                        { id: "instagram", label: "Instagram" },
                    ],
                    selected: activeChannels,
                    onChange: handleChannelFilterChange,
                    noOptionsLabel: `Nenhum canal ${rotuloDoEscopo}`,
                }]
                : []),
            ...(lineHasGroups
                ? [{
                    key: "tipos",
                    label: "Tipo",
                    options: [
                        { id: "individual", label: "Conversas" },
                        { id: "grupo", label: "Grupos" },
                    ],
                    selected: activeTipos,
                    onChange: handleTipoFilterChange,
                    noOptionsLabel: "",
                }]
                : []),
            // Sem isolamento na linha, filtrar por setor não recorta nada que o
            // atendente já não veja: o grupo inteiro sai do popover.
            ...(temFiltroDeSetor
                ? [{
                    key: "sectors",
                    label: "Setores",
                    options: sectorFilterOptions,
                    selected: selectedSectorIds,
                    onChange: setSelectedSectorIds,
                    noOptionsLabel: `Nenhum setor ${rotuloDoEscopo}`,
                }]
                : []),
            {
                key: "users",
                label: "Usuários",
                options: userFilterOptions,
                selected: selectedUserIds,
                onChange: handleUserFilterChange,
                noOptionsLabel: `Ninguém assumiu conversas ${rotuloDoEscopo}`,
            },
            {
                key: "tags",
                label: "Tags",
                options: tagFilterOptions,
                selected: selectedTagIds,
                onChange: setSelectedTagIds,
                noOptionsLabel: `Nenhuma tag ${rotuloDoEscopo}`,
            },
        ],
        [
            activeTab,
            campanhaFilterOptions,
            selectedCampanhas,
            rotuloFilterOptions,
            selectedRotulos,
            selectedErroEnvio,
            rotuloDoEscopo,
            lineHasDirect,
            activeChannels,
            handleChannelFilterChange,
            lineHasGroups,
            activeTipos,
            handleTipoFilterChange,
            temFiltroDeSetor,
            sectorFilterOptions,
            selectedSectorIds,
            userFilterOptions,
            selectedUserIds,
            handleUserFilterChange,
            tagFilterOptions,
            selectedTagIds,
        ],
    );

    // Filtros encadeados (fone → setor → usuário → busca → tag), memoizados: antes
    // disso, cada render refazia os filtros E cinco cópias+ordenações do array
    // completo. Set em vez de includes: o predicado roda por linha em lista
    // virtualizada.
    const filteredConversations = useMemo(() => {
        // Setor primeiro por ser o recorte mais grosso: encolhe a lista antes dos
        // predicados por conversa. Seleção vazia devolve tudo, sem cópia.
        const filteredByChannel = activeChannels.length === 0
            ? filteredByPhone
            : filteredByPhone.filter((conv) => casaFiltroDeCanal(conv, activeChannels));

        const filteredByTipo = activeTipos.length === 0
            ? filteredByChannel
            : filteredByChannel.filter((conv) => casaFiltroDeTipo(conv, activeTipos));

        const filteredBySector = selectedSectorIdsExpanded.length === 0
            ? filteredByTipo
            // Com 2+ números no escopo, "Sem setor (triagem)" não pode puxar a conversa de
            // número SEM isolamento: lá o sector_id é NULL por definição, não por estar
            // aguardando triagem. Seleção ativa: NULL só casa se o número da conversa isola.
            : filteredByTipo.filter((conv) =>
                matchesSectorFilter(conv.sector_id, selectedSectorIdsExpanded) &&
                (!!conv.sector_id || (!!conv.phone_number_id && numerosComIsolamento.has(conv.phone_number_id))));

        const userIdSet = new Set(selectedUserIds);
        const filteredByUser = userIdSet.size === 0
            ? filteredBySector
            : filteredBySector.filter((conv) =>
                (conv.assigned_to !== null && userIdSet.has(conv.assigned_to)) ||
                (conv.co_assignee_ids?.some((id) => userIdSet.has(id)) ?? false)
            );

        const normalizedSearch = searchQuery.replace(/\D/g, '');
        const filteredBySearch = filteredByUser.filter((conv) =>
            conv.contact_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            conv.contact_phone.includes(searchQuery) ||
            (normalizedSearch && conv.contact_phone.includes(normalizedSearch))
        );

        const tagIdSet = new Set(selectedTagIdsExpanded);
        const filteredByTag = tagIdSet.size === 0
            ? filteredBySearch
            : filteredBySearch.filter((conv) => {
                const convTags = conversationTags.get(conv.id) || [];
                return convTags.some((t) => tagIdSet.has(t.id));
            });

        // Filtros da aba Disparos: recortam só quem está nela, então as outras
        // abas (e os contadores delas) não mudam.
        if (!filtrosDeDisparoAtivos) return filteredByTag;
        const campanhaSet = new Set(selectedCampanhas);
        const rotuloSet = new Set(selectedRotulos);
        const soComErro = selectedErroEnvio.length > 0;
        return filteredByTag.filter((conv) => {
            if (filaDaConversa(conv, agora) !== "disparos") return true;
            if (campanhaSet.size > 0 && !(conv.disparo_campanhas?.some((nome) => campanhaSet.has(nome)) ?? false)) {
                return false;
            }
            if (rotuloSet.size > 0 && !(conv.disparo_rotulo && rotuloSet.has(conv.disparo_rotulo))) return false;
            // Erro do último disparo vem do banco (dura entre recargas); o contador
            // em memória cobre falha de outra mensagem vista com a tela aberta.
            if (soComErro && conv.disparo_status !== "failed" && (failedCounts.get(conv.id) || 0) === 0) return false;
            return true;
        });
    }, [
        filteredByPhone,
        activeChannels,
        activeTipos,
        selectedSectorIdsExpanded,
        numerosComIsolamento,
        selectedUserIds,
        searchQuery,
        selectedTagIdsExpanded,
        conversationTags,
        filtrosDeDisparoAtivos,
        selectedCampanhas,
        selectedRotulos,
        selectedErroEnvio,
        failedCounts,
        agora,
    ]);

    // Com texto na busca, Todos também mostra quem está em Disparos e Com a IA (com selo).
    const buscando = searchQuery.trim() !== "";

    // Contadores das abas numa única passada, sem ordenar nada.
    // Quem decide a aba é abasDaConversa (src/lib/abaDaConversa.ts), a mesma
    // regra do filtro da aba ativa logo abaixo. Em Disparos ninguém escreveu
    // ainda e em Com a IA a IA está atendendo: nenhuma das duas conta como fila
    // nas abas normais. Os contadores são da linha inteira — o disparo de um
    // colega também acende a aba.
    const tabStats = useMemo(() => {
        const stats = { all: 0, waiting: 0, mine: 0, shared: 0, closed: 0, ia: 0, disparos: 0, myUnread: 0, sharedUnread: 0 };
        for (const conv of filteredConversations) {
            for (const aba of abasDaConversa(conv, { userId, buscando, agora })) {
                stats[aba]++;
                if (aba === "mine") {
                    stats.myUnread += unreadWeight(unreadCounts.get(conv.id) || 0, markedUnread.has(conv.id));
                } else if (aba === "shared") {
                    // Shared custody: co-owner mas não primário (modo exclusivo, §8 Q11)
                    stats.sharedUnread += unreadWeight(unreadCounts.get(conv.id) || 0, markedUnread.has(conv.id));
                }
            }
        }
        return stats;
    }, [filteredConversations, userId, unreadCounts, markedUnread, buscando, agora]);

    // A conversa selecionada que TINHA não-lidas ao ser clicada continua ordenando como
    // não-lida: a lista não se reordena embaixo do cursor no fluxo de triagem. O freeze
    // só vale se foi registrado para ESTE id (clique na lista): seleção que não passa
    // pelo clique (busca global, deep-link) não herda. É um valor derivado, e não a
    // seleção em si, que entra nos deps da ordenação: trocar de conversa sem nada
    // congelado não muda a ordem, e reordenar milhares de linhas a cada clique era custo
    // à toa.
    const congeladaId =
        selectedConversationId !== null &&
        selectedFreezeRef.current.id === selectedConversationId &&
        selectedFreezeRef.current.hadUnread
            ? selectedConversationId
            : null;

    // Só a aba ATIVA é filtrada e ordenada — as outras só precisam dos contadores.
    const activeTabConversations = useMemo(() => {
        const byTab = filteredConversations.filter((conv) =>
            estaNaAba(conv, activeTab, { userId, buscando, agora }),
        );

        // Arquivadas saem da lista principal; a visão de arquivadas as mostra
        // sozinhas (ignorando a aba — paridade com o "Arquivadas" do WhatsApp).
        const byArchive = (showArchived ? filteredConversations : byTab).filter((conv) => {
            const isArchived = !!conversationPrefs.get(conv.id)?.archived_at;
            return showArchived ? isArchived : !isArchived;
        });

        // Decorate-sort: as chaves de cada linha saem UMA vez, e o comparador só as
        // compara. Antes ele criava dois `Date` por comparação (n·log n deles, numa
        // lista que chega a dezenas de milhares com a caixa conjunta).
        //
        // A conversa selecionada que TINHA não-lidas continua ordenando como
        // não-lida (`congeladaId`): a lista não se reordena embaixo do cursor
        // durante a triagem.
        const notificationsFirst = sortMode === "notifications-first";
        const decorated = byArchive.map((conv) => {
            const pinnedAt = conversationPrefs.get(conv.id)?.pinned_at;
            return {
                conv,
                // Instante em que foi fixada; null = não fixada.
                pinned: pinnedAt ? Date.parse(pinnedAt) : null,
                unread:
                    notificationsFirst &&
                    (unreadWeight(unreadCounts.get(conv.id) || 0, markedUnread.has(conv.id)) > 0 ||
                        conv.id === congeladaId),
                // Mesmas conversões de antes (`new Date(x || 0)`): ausente vale 0, e um
                // texto ilegível dá NaN, que o comparador trata como empate.
                time: new Date(conv.last_message_at || 0).getTime(),
            };
        });
        decorated.sort((a, b) => {
            // Fixadas sempre no topo (entre si, a fixada há mais tempo primeiro)
            if (a.pinned !== null && b.pinned === null) return -1;
            if (a.pinned === null && b.pinned !== null) return 1;
            if (a.pinned !== null && b.pinned !== null) return a.pinned - b.pinned;

            if (notificationsFirst) {
                if (a.unread && !b.unread) return -1;
                if (!a.unread && b.unread) return 1;
            }
            return b.time - a.time;
        });
        return decorated.map((entry) => entry.conv);
    }, [filteredConversations, activeTab, userId, sortMode, unreadCounts, markedUnread, congeladaId, conversationPrefs, showArchived, buscando, agora]);

    // Contador da linha "Arquivadas" (respeita os filtros ativos, não a aba)
    const archivedCount = useMemo(
        () => filteredConversations.filter((conv) => !!conversationPrefs.get(conv.id)?.archived_at).length,
        [filteredConversations, conversationPrefs]
    );

    // ── Teclado na lista (roving tabindex) ─────────────────────────────────
    // Tab entra pela linha selecionada (ou a primeira); setas movem o foco,
    // Enter/Espaço abrem. Linhas fora do viewport são roladas antes de focar.
    const virtuosoRef = useRef<VirtuosoHandle | null>(null);
    const focusableRowId = useMemo(() => {
        if (selectedConversationId && activeTabConversations.some((c) => c.id === selectedConversationId)) {
            return selectedConversationId;
        }
        return activeTabConversations[0]?.id ?? null;
    }, [activeTabConversations, selectedConversationId]);

    const focusRow = useCallback((conversationId: string) => {
        document.getElementById(`conv-row-${conversationId}`)?.focus();
    }, []);

    // Entrada por Tab: foca a linha canônica, montando-a antes se a
    // virtualização a descartou.
    const focusCanonicalRow = useCallback(() => {
        const id = focusableRowId;
        if (!id) return;
        const el = document.getElementById(`conv-row-${id}`);
        if (el) {
            el.focus();
            return;
        }
        const idx = activeTabConversations.findIndex((c) => c.id === id);
        if (idx === -1) return;
        virtuosoRef.current?.scrollIntoView({ index: idx, done: () => focusRow(id) });
    }, [focusableRowId, activeTabConversations, focusRow]);

    const listboxContext = useMemo<ListboxContext>(
        () => ({ onEnterFocus: focusCanonicalRow, isLoadingMore }),
        [focusCanonicalRow, isLoadingMore]
    );

    const handleRowKeyDown = useCallback((e: React.KeyboardEvent, conversationId: string) => {
        // Keydown de botões internos (Assumir, Remover tag, +tag) borbulha até
        // aqui — sem este guard, o preventDefault matava o click nativo deles
        // e o Enter abria a conversa no lugar de ativar o botão.
        if (e.target !== e.currentTarget) return;
        const list = activeTabConversations;
        const idx = list.findIndex((c) => c.id === conversationId);
        if (idx === -1) return;

        let targetIndex: number | null = null;
        if (e.key === "ArrowDown") targetIndex = Math.min(idx + 1, list.length - 1);
        else if (e.key === "ArrowUp") targetIndex = Math.max(idx - 1, 0);
        else if (e.key === "Home") targetIndex = 0;
        else if (e.key === "End") targetIndex = list.length - 1;
        else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleSelectConversation(conversationId);
            return;
        }

        if (targetIndex === null || targetIndex === idx) {
            if (targetIndex !== null) e.preventDefault();
            return;
        }
        e.preventDefault();
        const target = list[targetIndex];
        // Garante a linha montada (virtualização) antes de mover o foco
        virtuosoRef.current?.scrollIntoView({
            index: targetIndex,
            done: () => focusRow(target.id),
        });
        focusRow(target.id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTabConversations, focusRow, handleSelectConversation]);

    // Voltar do chat (mobile/Escape): devolve o foco à linha de origem
    const prevSelectedRef = useRef<string | null>(null);
    useEffect(() => {
        const prev = prevSelectedRef.current;
        prevSelectedRef.current = selectedConversationId;
        if (prev && !selectedConversationId) {
            requestAnimationFrame(() => focusRow(prev));
        }
    }, [selectedConversationId, focusRow]);

    // Fallback: if the user is on the "shared" tab and loses all co-ownerships
    // (left a conversation, was removed, or shared conv was closed), switch them
    // to "mine" so they don't get stuck on a tab that no longer exists.
    useEffect(() => {
        if (activeTab === "shared" && tabStats.shared === 0) {
            setActiveTab("mine");
        }
    }, [activeTab, tabStats.shared]);

    // E para Disparos: quando o último contato responde (o banco tira a marca)
    // ou a troca de número leva para uma linha sem disparo, volta para "all".
    useEffect(() => {
        if (activeTab === "disparos" && disparosDaLinha.length === 0) {
            setActiveTab("all");
        }
    }, [activeTab, disparosDaLinha.length]);

    // E para Com a IA: quando a IA passa a última conversa, volta para "all".
    useEffect(() => {
        if (activeTab === "ia" && iaDaLinha.length === 0) {
            setActiveTab("all");
        }
    }, [activeTab, iaDaLinha.length]);

    const showAssignButton = activeTab === "all" || activeTab === "waiting";

    // Um empty state por causa, sempre com uma ação de saída.
    const renderEmptyState = () => {
        const filteredUserLabel = selectedUserIds.length === 1
            ? assigneeOptions.find((o) => o.id === selectedUserIds[0])?.label
            : undefined;

        return (
        <div className="flex flex-col items-center justify-center h-64 p-8 text-center gap-3">
            <MessageCircle className="w-12 h-12 text-muted-foreground/50" />
            {searchQuery ? (
                <>
                    <p className="text-sm text-muted-foreground">Nenhuma conversa com “{searchQuery}”</p>
                    <Button variant="outline" size="sm" onClick={() => setSearchQuery("")}>
                        Limpar busca
                    </Button>
                </>
            ) : filtrosDeDisparoAtivos ? (
                <>
                    <p className="text-sm text-muted-foreground">Nenhum disparo com esses filtros</p>
                    <Button variant="outline" size="sm" onClick={limparFiltrosDeDisparo}>
                        Remover filtro
                    </Button>
                </>
            ) : activeChannels.length === 1 ? (
                <>
                    <p className="text-sm text-muted-foreground">
                        {activeChannels[0] === "instagram" ? "Nenhuma conversa do Instagram nesta aba" : "Nenhuma conversa do WhatsApp nesta aba"}
                    </p>
                    <Button variant="outline" size="sm" onClick={() => setSelectedChannels([])}>
                        Remover filtro
                    </Button>
                </>
            ) : activeTipos.length === 1 ? (
                <>
                    <p className="text-sm text-muted-foreground">
                        {activeTipos[0] === "grupo" ? "Nenhum grupo nesta aba" : "Nenhuma conversa individual nesta aba"}
                    </p>
                    <Button variant="outline" size="sm" onClick={() => setSelectedTipos([])}>
                        Remover filtro
                    </Button>
                </>
            ) : selectedTagIds.length > 0 ? (
                <>
                    <p className="text-sm text-muted-foreground">
                        {selectedTagIds.length === 1
                            ? "Nenhuma conversa com esta tag"
                            : "Nenhuma conversa com as tags filtradas"}
                    </p>
                    <Button variant="outline" size="sm" onClick={() => setSelectedTagIds([])}>
                        Remover filtro
                    </Button>
                </>
            ) : selectedUserIds.length > 0 ? (
                <>
                    <p className="text-sm text-muted-foreground">
                        {filteredUserLabel
                            ? `Nenhuma conversa de ${filteredUserLabel} nesta aba`
                            : "Nenhuma conversa dos usuários filtrados nesta aba"}
                    </p>
                    <Button variant="outline" size="sm" onClick={() => setSelectedUserIds([])}>
                        Remover filtro
                    </Button>
                </>
            ) : (
                <>
                    <p className="text-sm text-muted-foreground text-center text-pretty">Nenhuma conversa nesta aba ainda. Comece uma para ela aparecer aqui.</p>
                    <Button variant="outline" size="sm" onClick={() => setShowStartConversation(true)}>
                        <MessageSquarePlus className="w-4 h-4 mr-1.5" />
                        Nova conversa
                    </Button>
                </>
            )}
        </div>
        );
    };

    // Tags dos números do escopo. A regra por conversa
    // (`t.phone_number_id === conversation.phone_number_id`) continua dentro da
    // ConversationRow; este memo só evita filtrar todas as tags em cada linha
    // renderizada. Sem escopo, passa todas — a row recorta.
    const tagsForLine = tagsDoEscopo;

    // Handlers da linha com identidade estável (latest-ref): a ConversationRow
    // é React.memo, e recriar closures por linha a cada render do pai anularia
    // a memoização. `actionsRef` recebe as versões mais novas a cada render;
    // `rowActions` nunca muda de identidade.
    const actionsRef = useRef<ConversationRowActions>();
    actionsRef.current = {
        select: (id) => void handleSelectConversation(id),
        keyDown: handleRowKeyDown,
        addTag: (id, tagId, e) => void handleAddTag(id, tagId, e),
        removeTag: (id, tagId, e) => void handleRemoveTag(id, tagId, e),
        assignToMe: handleAssignToMe,
        resolveAndAssign,
        swipeClose: (id) => void handleSwipeClose(id),
        swipeMarkRead: (id) => void handleSwipeMarkRead(id),
        toggleUnread: (id, isUnread) => void handleToggleUnread(id, isUnread),
        exportConversation: (id) => void handleExportConversation(id),
        transfer: setTransferTargetId,
        togglePinned: (id) => void togglePinned(id),
        toggleArchived: (id) => void toggleArchived(id),
        setMutedUntil: (id, until) => void setMutedUntil(id, until),
    };
    const rowActions = useMemo<ConversationRowActions>(
        () => ({
            select: (id) => actionsRef.current?.select(id),
            keyDown: (e, id) => actionsRef.current?.keyDown(e, id),
            addTag: (id, tagId, e) => actionsRef.current?.addTag(id, tagId, e),
            removeTag: (id, tagId, e) => actionsRef.current?.removeTag(id, tagId, e),
            assignToMe: (id, e) => actionsRef.current?.assignToMe(id, e),
            resolveAndAssign: (id) => actionsRef.current?.resolveAndAssign(id),
            swipeClose: (id) => actionsRef.current?.swipeClose(id),
            swipeMarkRead: (id) => actionsRef.current?.swipeMarkRead(id),
            toggleUnread: (id, isUnread) => actionsRef.current?.toggleUnread(id, isUnread),
            exportConversation: (id) => actionsRef.current?.exportConversation(id),
            transfer: (id) => actionsRef.current?.transfer(id),
            togglePinned: (id) => actionsRef.current?.togglePinned(id),
            toggleArchived: (id) => actionsRef.current?.toggleArchived(id),
            setMutedUntil: (id, until) => actionsRef.current?.setMutedUntil(id, until),
        }),
        [],
    );

    // Só primitivas e objetos estáveis por id: é o que deixa o memo da row
    // pular tudo que não mudou quando um evento realtime toca UMA conversa.
    const propsForRow = (conversation: Conversation, isLast: boolean): ConversationRowProps => {
        const prefs = conversationPrefs.get(conversation.id);
        const fila = filaDaConversa(conversation, agora);
        const emDisparos = fila === "disparos";
        return {
            conversation,
            isLast,
            isSelected: selectedConversationId === conversation.id,
            viewMode,
            isMobile,
            canClose: activeTab !== "closed",
            showAssignButton,
            sectorIsolationEnabled: !!conversation.phone_number_id && numerosComIsolamento.has(conversation.phone_number_id),
            sector: conversation.sector_id ? sectorsById.get(conversation.sector_id) : undefined,
            convTags: conversationTags.get(conversation.id) ?? NO_TAGS,
            tagsForLine,
            unreadCount: unreadCounts.get(conversation.id) || 0,
            isMarkedUnread: markedUnread.has(conversation.id),
            failedCount: failedCounts.get(conversation.id) || 0,
            emDisparos,
            // Fora da aba Disparos (busca em Todos) a linha diz de onde veio.
            seloDisparos: emDisparos && activeTab !== "disparos",
            // Idem para Com a IA.
            seloIa: fila === "ia" && activeTab !== "ia",
            hasDraft: hasDraft(conversation.id),
            isPinned: !!prefs?.pinned_at,
            isArchived: !!prefs?.archived_at,
            isMuted: isMuted(conversation.id),
            isAssigning: assigningId === conversation.id,
            isExporting: exportingId === conversation.id,
            // Selo do número só na caixa conjunta; no modo número fica nulo e nada é renderizado.
            numeroNome: conjunta && conversation.phone_number_id ? numerosPorId.get(conversation.phone_number_id)?.nome ?? null : null,
            numeroHue: conjunta && conversation.phone_number_id ? numerosPorId.get(conversation.phone_number_id)?.hue ?? null : null,
            actions: rowActions,
        };
    };

    // A faixa de números que falharam: "Não foi possível carregar A e B".
    const textoDasFalhas = `Não foi possível carregar ${listarNomes(
        linhasComFalha.map((numeroId) => numerosPorId.get(numeroId)?.nome ?? "um número"),
    )}`;

    // Corpo da lista: skeleton enquanto carrega, erro com retry, empty com ação,
    // e a aba ativa virtualizada (react-virtuoso) — só linhas visíveis no DOM.
    const renderListBody = (customScrollParent?: HTMLElement) => {
        if (numerosEmErro) {
            return (
                <div className="flex flex-col items-center justify-center h-64 p-8 text-center gap-3">
                    <AlertCircle className="w-10 h-10 text-destructive/60" />
                    <p className="text-sm text-muted-foreground">Não foi possível carregar os números</p>
                    <Button variant="outline" size="sm" onClick={onTentarNumerosNovamente}>
                        <RefreshCw className="w-4 h-4 mr-1.5" />
                        Tentar novamente
                    </Button>
                </div>
            );
        }
        if (isLoadingConversations && activeTabConversations.length === 0) {
            return <ConversationListSkeleton />;
        }
        if (linhasComFalha.length > 0 && activeTabConversations.length === 0) {
            return (
                <div className="flex flex-col items-center justify-center h-64 p-8 text-center gap-3">
                    <AlertCircle className="w-10 h-10 text-destructive/60" />
                    <p className="text-sm text-muted-foreground">Não foi possível carregar as conversas</p>
                    {/* Desligado durante uma busca em voo, como a faixa: cada clique a reiniciaria. */}
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={isLoadingMore}
                        onClick={() => fetchConversationsRef.current?.({ showLoading: true })}
                    >
                        <RefreshCw className="w-4 h-4 mr-1.5" />
                        Tentar novamente
                    </Button>
                </div>
            );
        }
        if (activeTabConversations.length === 0 && !(archivedCount > 0 || showArchived)) {
            return renderEmptyState();
        }
        return (
            <>
                {activeTab === "disparos" && !showArchived && (
                    <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30 text-xs text-muted-foreground">
                        <Megaphone className="w-3.5 h-3.5 shrink-0" />
                        <span className="text-pretty">Ninguém daqui escreveu ainda. Quem escrever vai sozinho para Aguardando.</span>
                    </div>
                )}
                {/* Número que não carregou, com conversas na tela: o que veio fica, e
                    a faixa diz qual falhou. Fora do Virtuoso de propósito (a região
                    aria-live não fica dentro de lista virtualizada). */}
                {linhasComFalha.length > 0 && (
                    <div
                        role="status"
                        className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive"
                    >
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate" title={textoDasFalhas}>
                            {textoDasFalhas}
                        </span>
                        <span aria-hidden="true">·</span>
                        {/* Desligado enquanto uma busca corre: cada clique a reiniciaria do zero.
                            Refaz só o que falhou: os outros números já estão na tela. */}
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={isLoadingMore}
                            onClick={() => void fetchConversationsRef.current?.({ somente: linhasComFalha })}
                            className="-my-1 h-8 shrink-0 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                            Tentar novamente
                        </Button>
                    </div>
                )}
                {/* Linha "Arquivadas" (paridade WhatsApp): alterna a visão */}
                {(archivedCount > 0 || showArchived) && (
                    <button
                        type="button"
                        onClick={() => setShowArchived((v) => !v)}
                        className="flex items-center gap-3 w-full px-4 py-2.5 text-sm border-b bg-card text-left transition-colors hover:bg-foreground/[0.04]"
                    >
                        {showArchived ? (
                            <>
                                <ChevronLeft className="w-4 h-4 text-muted-foreground shrink-0" />
                                <span className="font-medium">Voltar para as conversas</span>
                            </>
                        ) : (
                            <>
                                <Archive className="w-4 h-4 text-muted-foreground shrink-0" />
                                <span className="font-medium flex-1">Arquivadas</span>
                                <span className="text-xs text-muted-foreground tabular-nums">{archivedCount}</span>
                            </>
                        )}
                    </button>
                )}
                {activeTabConversations.length === 0 ? (
                    showArchived ? (
                        <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
                            Nenhuma conversa arquivada
                        </div>
                    ) : (
                        renderEmptyState()
                    )
                ) : (
            <Virtuoso
                ref={virtuosoRef}
                data={activeTabConversations}
                components={VIRTUOSO_LIST_COMPONENTS}
                context={listboxContext}
                computeItemKey={(_, conv) => conv.id}
                itemContent={(index, conv) => (
                    <ConversationRow {...propsForRow(conv, index === activeTabConversations.length - 1)} />
                )}
                increaseViewportBy={{ top: 300, bottom: 300 }}
                {...(customScrollParent
                    ? { customScrollParent }
                    : { className: "flex-1 min-h-0" })}
            />
                )}
            </>
        );
    };

    return (
        <div className={cn(
            "theme-sidebar-surface border-r bg-card flex flex-col overflow-hidden relative z-10 shrink-0",
            isMobileView ? "w-full h-full" : "w-full"
        )}>
            {/* Safe-area do notch: pt-[max(...)] no próprio header (bg-card) — no
                shell o padding pintava a faixa da status bar com bg-background */}
            <div className="theme-sidebar-header p-4 sidebar-narrow:p-3 pt-[max(1rem,env(safe-area-inset-top))] sidebar-narrow:pt-3 border-b space-y-4 sidebar-narrow:space-y-3 bg-card">
                {/* Header: Logo & User */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="theme-echo-logo h-8 inline-flex items-center sidebar-narrow:hidden">
                            <img src="/echo-logo.png" alt="Echo" className="theme-echo-logo-img h-8" />
                        </span>
                        {/* Coluna estreita: só o símbolo, sem o nome. */}
                        <span className="theme-echo-icon h-7 w-7 hidden sidebar-narrow:inline-flex items-center">
                            <img src="/echo-icon.png" alt="Echo" className="theme-echo-icon-img h-7 w-7" />
                        </span>
                        <StatusIndicator size="sm" />
                    </div>

                    <div className="flex items-center gap-1 sidebar-narrow:gap-0.5">
                        {/* Hide nav buttons on mobile - BottomNavigation handles it */}
                        {!isMobileView && (
                            <>
                                <Button variant="ghost" size="icon" className={SIDEBAR_TOP_BUTTON} onClick={() => navigate('/broadcasts')} title="Disparos" aria-label="Disparos">
                                    <Send className={SIDEBAR_ICON} />
                                </Button>
                                <Button variant="ghost" size="icon" className={SIDEBAR_TOP_BUTTON} onClick={() => navigate('/automations')} aria-label="Automações">
                                    <Workflow className={SIDEBAR_ICON} />
                                </Button>
                                <Button variant="ghost" size="icon" className={SIDEBAR_TOP_BUTTON} onClick={() => navigate('/analytics')} aria-label="Relatórios">
                                    <TrendingUp className={SIDEBAR_ICON} />
                                </Button>
                                <Button variant="ghost" size="icon" className={SIDEBAR_TOP_BUTTON} onClick={() => navigate('/settings')} aria-label="Configurações">
                                    <Settings className={SIDEBAR_ICON} />
                                </Button>
                            </>
                        )}


                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" className="theme-sidebar-top-button relative h-8 w-8 sidebar-narrow:h-7 sidebar-narrow:w-7 rounded-full p-0" aria-label="Menu do usuário">
                                    <Avatar className="h-8 w-8 sidebar-narrow:h-7 sidebar-narrow:w-7">
                                        <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                                            {getInitials(user.email || "")}
                                        </AvatarFallback>
                                    </Avatar>
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>
                                    <div className="flex flex-col space-y-1 cursor-pointer" onClick={() => navigate('/settings')}>
                                        <p className="text-sm font-medium leading-none">{user.email}</p>
                                    </div>
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={onSignOut}>
                                    <LogOut className="mr-2 h-4 w-4" />
                                    <span>Sair</span>
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>

                {/* Phone Selector */}
                <div className="w-full">
                    <PhoneNumberSelector
                        selectedPhoneNumberId={numeroUnico}
                        onSelect={onPhoneSelect}
                        conjunta={conjunta}
                        numerosDaConjunta={numerosDaConjunta}
                        onSelecionarConjunta={onSelecionarConjunta}
                        onEscolherNumeros={onEscolherNumeros}
                    />
                </div>

                {/* Search */}
                <div className="relative">
                    <button
                        type="button"
                        className="absolute left-3 top-1/2 -translate-y-1/2 p-0 hover:text-foreground disabled:opacity-50"
                        onClick={() => escopoIds.length > 0 && setShowGlobalSearch(true)}
                        disabled={escopoIds.length === 0}
                        title="Buscar em mensagens (Ctrl+K)"
                        aria-label="Buscar em mensagens (Ctrl+K)"
                    >
                        <Search className="w-4 h-4 text-muted-foreground hover:text-foreground cursor-pointer" />
                    </button>
                    <Input
                        placeholder="Buscar conversas…"
                        aria-label="Buscar conversas"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-9 h-9 bg-muted/30 border-input"
                    />
                </div>

                {/* Actions Row: "Nova Conversa" ocupa todo o espaço que sobra e vai
                    encolhendo com a coluna (os ícones ficam colados à direita);
                    abaixo de 330px o rótulo sai e fica só o "+". */}
                <div className="flex items-center gap-2 sidebar-narrow:gap-1.5">
                    <Button
                        className="flex-1 min-w-0 h-9 sidebar-narrow:h-8 sidebar-narrow:px-3"
                        onClick={() => setShowStartConversation(true)}
                        // Na conjunta, sem número carregado ainda não há por onde enviar.
                        disabled={conjunta && numerosDeEnvio.length === 0}
                        title="Nova conversa"
                        aria-label="Nova conversa"
                    >
                        <Plus className={cn(SIDEBAR_ICON, "mr-2 sidebar-narrow:mr-1.5 sidebar-tight:mr-0")} />
                        <span className="truncate sidebar-tight:hidden">Nova Conversa</span>
                    </Button>

                    {/* Groups button (create / join by link): só com número QR. Na caixa conjunta, se algum número do escopo é QR. */}
                    {(conjunta ? numerosQrDeEnvio.length > 0 : isQrConnection && numeroUnico) && (
                        <Button
                            variant="outline"
                            size="icon"
                            className={SIDEBAR_ACTION_BUTTON}
                            onClick={() => setShowCreateGroup(true)}
                            title="Grupos"
                            aria-label="Grupos"
                        >
                            <Users className={SIDEBAR_ICON} />
                        </Button>
                    )}

                    {/* Um gatilho só para tag e usuário, e sem botão X dedicado:
                        a linha de ações não tem largura para um botão por filtro,
                        e o contador + "Limpar seleção" cobrem a limpeza. */}
                    <ConversationFilterPopover
                        icon={<Filter className={SIDEBAR_ICON} />}
                        triggerClassName={SIDEBAR_ACTION_BUTTON}
                        label="Filtros"
                        searchPlaceholder={activeTab === "disparos" ? "Buscar campanha, mensagem, tag…" : "Buscar tag ou usuário…"}
                        emptySearchLabel="Nada encontrado"
                        groups={filterGroups}
                    />

                    {/* Sort Mode Dropdown */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="outline"
                                size="icon"
                                className={SIDEBAR_ACTION_BUTTON}
                                title="Ordenação"
                                aria-label="Ordenação"
                            >
                                <ArrowUpDown className={SIDEBAR_ICON} />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Ordenar por</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                onClick={() => {
                                    setSortMode("notifications-first");
                                    localStorage.setItem("conversationSortMode", "notifications-first");
                                }}
                                className={sortMode === "notifications-first" ? "bg-accent" : ""}
                            >
                                <Bell className="w-4 h-4 mr-2" />
                                Notificações primeiro
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => {
                                    setSortMode("chronological");
                                    localStorage.setItem("conversationSortMode", "chronological");
                                }}
                                className={sortMode === "chronological" ? "bg-accent" : ""}
                            >
                                <ArrowDown className="w-4 h-4 mr-2" />
                                Ordem cronológica
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* View Mode Toggle */}
                    <Button
                        variant="outline"
                        size="icon"
                        className={SIDEBAR_ACTION_BUTTON}
                        title={viewMode === "normal" ? "Visão compacta" : "Visão normal"}
                        aria-label={viewMode === "normal" ? "Visão compacta" : "Visão normal"}
                        onClick={() => {
                            const newMode = viewMode === "normal" ? "compact" : "normal";
                            setViewMode(newMode);
                            localStorage.setItem("conversationViewMode", newMode);
                        }}
                    >
                        {viewMode === "normal" ? (
                            <LayoutList className={SIDEBAR_ICON} />
                        ) : (
                            <LayoutGrid className={SIDEBAR_ICON} />
                        )}
                    </Button>
                </div>
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
                <div className="theme-conversation-tabs flex items-center border-b pr-2">
                    <TabsList className="flex-1 flex-wrap justify-center rounded-none border-b-0 bg-transparent p-0 h-auto gap-1 sidebar-narrow:gap-0">
                        <TooltipProvider delayDuration={200}>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <TabsTrigger
                                        value="all"
                                        className="rounded-md border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-primary/20 data-[state=active]:text-primary py-2 px-3 mx-0.5 sidebar-narrow:px-1.5 sidebar-narrow:mx-0 transition-colors"
                                    >
                                        <Users className={SIDEBAR_ICON} />
                                        <span className="ml-1 text-xs font-medium">{tabStats.all}</span>
                                    </TabsTrigger>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>Todos</p>
                                </TooltipContent>
                            </Tooltip>

                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <TabsTrigger
                                        value="waiting"
                                        className={`rounded-md border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-primary/20 data-[state=active]:text-primary py-2 px-3 mx-0.5 sidebar-narrow:px-1.5 sidebar-narrow:mx-0 transition-colors ${
                                            showWaitingAlert && tabStats.waiting > 0
                                                ? "text-amber-600 dark:text-amber-400 tab-pulse-amber data-[state=active]:bg-amber-500/30 data-[state=active]:border-amber-500"
                                                : ""
                                        }`}
                                    >
                                        <Clock className={SIDEBAR_ICON} />
                                        <span className="ml-1 text-xs font-medium">{tabStats.waiting}</span>
                                    </TabsTrigger>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>Aguardando</p>
                                </TooltipContent>
                            </Tooltip>

                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <TabsTrigger
                                        value="mine"
                                        className={`rounded-md border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-primary/20 data-[state=active]:text-primary py-2 px-3 mx-0.5 sidebar-narrow:px-1.5 sidebar-narrow:mx-0 transition-colors ${
                                            showMyAlert && tabStats.myUnread > 0
                                                ? "text-green-600 dark:text-green-400 tab-pulse-green data-[state=active]:bg-green-500/30 data-[state=active]:border-green-500"
                                                : ""
                                        }`}
                                    >
                                        <UserIcon className={SIDEBAR_ICON} />
                                        <span className="ml-1 text-xs font-medium">{tabStats.mine}</span>
                                        {showMyAlert && tabStats.myUnread > 0 && (
                                            <span className="ml-1 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-green-500 text-white text-2xs font-bold">
                                                {tabStats.myUnread > 99 ? "99+" : tabStats.myUnread}
                                            </span>
                                        )}
                                    </TabsTrigger>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>Meus</p>
                                </TooltipContent>
                            </Tooltip>

                            {tabStats.shared > 0 && (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <TabsTrigger
                                            value="shared"
                                            className={`rounded-md border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-primary/20 data-[state=active]:text-primary py-2 px-3 mx-0.5 sidebar-narrow:px-1.5 sidebar-narrow:mx-0 transition-colors ${
                                                showSharedAlert && tabStats.sharedUnread > 0
                                                    ? "text-blue-600 dark:text-blue-400 tab-pulse-blue data-[state=active]:bg-blue-500/30 data-[state=active]:border-blue-500"
                                                    : ""
                                            }`}
                                        >
                                            <Handshake className={SIDEBAR_ICON} />
                                            <span className="ml-1 text-xs font-medium">{tabStats.shared}</span>
                                            {showSharedAlert && tabStats.sharedUnread > 0 && (
                                                <span className="ml-1 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-blue-500 text-white text-2xs font-bold">
                                                    {tabStats.sharedUnread > 99 ? "99+" : tabStats.sharedUnread}
                                                </span>
                                            )}
                                        </TabsTrigger>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        <p>Copropriedades</p>
                                    </TooltipContent>
                                </Tooltip>
                            )}

                            {/* Com a IA: a IA está atendendo e dando conta. Sem pulso, como
                                Disparos: não é fila esperando o time. A conversa volta
                                para as abas normais quando a IA passa ou para de responder. */}
                            {iaDaLinha.length > 0 && (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <TabsTrigger
                                            value="ia"
                                            className="rounded-md border-b-2 border-transparent data-[state=active]:border-violet-500 data-[state=active]:bg-violet-500/15 data-[state=active]:text-violet-600 dark:data-[state=active]:text-violet-300 py-2 px-3 mx-0.5 sidebar-narrow:px-1.5 sidebar-narrow:mx-0 transition-colors"
                                        >
                                            <Bot className={SIDEBAR_ICON} />
                                            <span className="ml-1 text-xs font-medium">{tabStats.ia}</span>
                                        </TabsTrigger>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        <p>Com a IA</p>
                                    </TooltipContent>
                                </Tooltip>
                            )}

                            {/* Disparos: só recebeu disparo e ninguém escreveu ainda. Sem
                                pulso e em ardósia: é fila parada, não fila esperando.
                                Aparece pela linha, não pela busca: filtrar até zero
                                não fecha a aba. */}
                            {disparosDaLinha.length > 0 && (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <TabsTrigger
                                            value="disparos"
                                            className="rounded-md border-b-2 border-transparent data-[state=active]:border-slate-500 data-[state=active]:bg-slate-500/15 data-[state=active]:text-slate-600 dark:data-[state=active]:text-slate-300 py-2 px-3 mx-0.5 sidebar-narrow:px-1.5 sidebar-narrow:mx-0 transition-colors"
                                        >
                                            <Megaphone className={SIDEBAR_ICON} />
                                            <span className="ml-1 text-xs font-medium">{tabStats.disparos}</span>
                                        </TabsTrigger>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        <p>Disparos</p>
                                    </TooltipContent>
                                </Tooltip>
                            )}

                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <TabsTrigger
                                        value="closed"
                                        className="rounded-md border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-primary/20 data-[state=active]:text-primary py-2 px-3 mx-0.5 sidebar-narrow:px-1.5 sidebar-narrow:mx-0 transition-colors"
                                    >
                                        <CheckCircle2 className={SIDEBAR_ICON} />
                                        <span className="ml-1 text-xs font-medium">{tabStats.closed}</span>
                                    </TabsTrigger>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>Encerrados</p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    </TabsList>

                    {/* Alert Settings Menu */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button className="h-8 w-8 flex items-center justify-center shrink-0" aria-label="Opções de alertas">
                                <MoreVertical className="w-4 h-4 text-muted-foreground" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem
                                onClick={async () => {
                                    const count = await markAllAsRead();
                                    toast({
                                        title: count > 0
                                            ? "Notificações limpas"
                                            : "Nenhuma notificação ativa",
                                    });
                                }}
                                className="flex items-center pl-8"
                            >
                                <CheckCheck className="w-4 h-4 mr-2 text-primary" />
                                Marcar tudo como lido
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel>Alertas visuais</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {/* CheckboxItem: aria-checked de verdade e o menu não fecha
                                a cada ajuste (antes: ponto colorido de 8px + fechar) */}
                            <DropdownMenuCheckboxItem
                                checked={showWaitingAlert}
                                onSelect={(e) => e.preventDefault()}
                                onCheckedChange={(checked) => {
                                    setShowWaitingAlert(checked);
                                    localStorage.setItem("showWaitingAlert", String(checked));
                                }}
                            >
                                <Clock className="w-4 h-4 mr-2 text-amber-500" />
                                Alerta aguardando
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem
                                checked={showMyAlert}
                                onSelect={(e) => e.preventDefault()}
                                onCheckedChange={(checked) => {
                                    setShowMyAlert(checked);
                                    localStorage.setItem("showMyAlert", String(checked));
                                }}
                            >
                                {/* Cor = vínculo com o badge da aba (green-500), não semântica de sucesso */}
                                    <MessageCircle className="w-4 h-4 mr-2 text-green-500" />
                                Alerta meus
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem
                                checked={showSharedAlert}
                                onSelect={(e) => e.preventDefault()}
                                onCheckedChange={(checked) => {
                                    setShowSharedAlert(checked);
                                    localStorage.setItem("showSharedAlert", String(checked));
                                }}
                            >
                                <Handshake className="w-4 h-4 mr-2 text-blue-500" />
                                Alerta copropriedades
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel>Alerta sonoro</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuCheckboxItem
                                checked={notificationSoundEnabled}
                                onSelect={(e) => e.preventDefault()}
                                onCheckedChange={(checked) => {
                                    setNotificationSoundEnabled(checked);
                                    localStorage.setItem("notificationSoundEnabled", String(checked));
                                }}
                            >
                                <Volume2 className="w-4 h-4 mr-2 text-violet-500" />
                                Som de notificação
                            </DropdownMenuCheckboxItem>
                            {canCall && (
                                <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuLabel>Ligações</DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuCheckboxItem
                                        checked={voiceCallsEnabled}
                                        onSelect={(e) => e.preventDefault()}
                                        onCheckedChange={setVoiceCallsEnabled}
                                    >
                                        <PhoneIncoming className="w-4 h-4 mr-2 text-emerald-500" />
                                        Receber ligações
                                    </DropdownMenuCheckboxItem>
                                </>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel>Notificações do sistema</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {osNotifPermission === "granted" && (
                                <DropdownMenuItem disabled className="pl-8 text-xs text-muted-foreground">
                                    <Bell className="w-4 h-4 mr-2 text-success" />
                                    Ativadas neste navegador
                                </DropdownMenuItem>
                            )}
                            {osNotifPermission === "default" && (
                                <DropdownMenuItem
                                    className="pl-8"
                                    onClick={async () => {
                                        const result = await ensureNotificationPermission();
                                        setOsNotifPermission(result);
                                    }}
                                >
                                    <Bell className="w-4 h-4 mr-2" />
                                    Ativar notificações do sistema
                                </DropdownMenuItem>
                            )}
                            {osNotifPermission === "denied" && (
                                <DropdownMenuItem disabled className="pl-8 text-xs text-muted-foreground">
                                    <Bell className="w-4 h-4 mr-2" />
                                    Bloqueadas — permita nas configurações do navegador
                                </DropdownMenuItem>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>

                {/* Uma única árvore para a aba ativa (antes: as 5 abas eram
                    construídas em todo render). No mobile o Virtuoso usa o
                    scroller do PullToRefresh como customScrollParent. */}
                {/* Um único TabsContent com value={activeTab}: sempre ativo e com
                    id/aria-labelledby do Radix — os aria-controls dos triggers
                    apontam para um painel que existe de verdade. */}
                {isMobile ? (
                    <PullToRefresh
                        onRefresh={handleRefresh}
                        className="flex-1 min-h-0"
                        scrollElementRef={setMobileScrollEl}
                    >
                        <TabsContent value={activeTab} tabIndex={0} className="m-0 min-h-full">
                            {renderListBody(mobileScrollEl ?? undefined)}
                        </TabsContent>
                    </PullToRefresh>
                ) : (
                    <TabsContent value={activeTab} tabIndex={0} className="m-0 flex-1 min-h-0 flex flex-col">
                        {renderListBody()}
                    </TabsContent>
                )}
            </Tabs >

            {/* Global Search Dialog */}
            <GlobalSearchDialog
                open={showGlobalSearch}
                onOpenChange={setShowGlobalSearch}
                onSelectResult={handleGlobalSearchResult}
                phoneNumberIds={escopoIds}
                numerosPorId={numerosPorId}
            />

            <StartConversationDialog
                open={showStartConversation}
                onOpenChange={setShowStartConversation}
                userId={userId}
                onConversationCreated={recarregarConversaCriada}
                phoneNumberId={metaPhoneNumberId}
                phoneNumberDbId={numeroUnico}
                isQrConnection={isQrConnection}
                numerosPossiveis={conjunta ? numerosDeEnvio : undefined}
                numeroPreferidoId={conjunta ? numeroDaConversaAberta : null}
            />

            {/* Assumir conversa de triagem quando o setor é ambíguo */}
            {dialogoDeSetor}

            {/* Groups Dialog (create / join by link) - only for QR connections */}
            {
                (conjunta ? numerosQrDeEnvio.length > 0 : isQrConnection && numeroUnico) && (
                    <CreateGroupDialog
                        open={showCreateGroup}
                        onOpenChange={setShowCreateGroup}
                        phoneNumberId={conjunta ? null : numeroUnico}
                        numerosPossiveis={conjunta ? numerosQrDeEnvio : undefined}
                        numeroPreferidoId={conjunta ? numeroDaConversaAberta : null}
                        onGroupCreated={(_groupJid, conversationId) => recarregarConversaCriada(conversationId)}
                    />
                )
            }

            {/* Transferência disparada pelo menu de contexto. Montado só com alvo
                definido para o diálogo buscar os agentes na abertura, e não a cada
                render da lista. */}
            {transferTarget && (
                <TransferConversationDialog
                    open
                    onOpenChange={(open) => {
                        if (!open) setTransferTargetId(null);
                    }}
                    onTransfer={handleMenuTransfer}
                    onRelease={async () => {
                        const released = await releaseConversation();
                        if (released) setTransferTargetId(null);
                        return released;
                    }}
                    currentUserId={userId}
                    conversationPhoneNumberId={transferTarget.phone_number_id}
                />
            )}
        </div >
    );
};

export default ConversationsList;