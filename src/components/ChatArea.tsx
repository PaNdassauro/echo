import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useGroupParticipants } from "@/hooks/chat/useGroupParticipants";
import { resolveGroupSendPermission } from "@/lib/groupSelfRole";
import { useParticipantContacts } from "@/hooks/chat/useParticipantContacts";
import {
  bareJid,
  buildParticipantDisplayMap,
  trustedSenderPhone,
} from "@/lib/participantDisplayName";
import { formatParticipantPhone } from "@/lib/phone";
import type { PollParticipantRef } from "@/lib/pollResults";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { supabase } from "@/integrations/supabase/client";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Send,
  MessageCircle,
  Plus,
  Loader2,
  UserMinus,
  CheckCircle2,
  Clock,
  StickyNote,
  FileText,
  Image,
  LayoutTemplate,
  MapPin,
  Smile,
  BarChart3,
  Users,
  UserCircle,
  Search,
  Workflow,
  Pencil,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
  MoreVertical,
  Lock
} from "lucide-react";
import { format, addHours, isAfter, isSameDay, isTomorrow } from "date-fns";
import { ptBR } from "date-fns/locale";
import EmojiPicker, { EmojiPickerPanel } from "./EmojiPicker";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import StickerPicker from "./StickerPicker";
import { useStickers, type UserSticker } from "@/hooks/useStickers";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import TemplateDialog from "./TemplateDialog";
import { useInlineTemplateCreation } from "@/components/templates/useInlineTemplateCreation";
import { TemplateHeaderMedia } from "@/lib/templateMedia";
import ContactPickerModal from "./ContactPickerModal";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { LocationPickerDialog } from "./chat/composer/LocationPickerDialog";
import { PollComposerDialog } from "./chat/composer/PollComposerDialog";
import { useMessageReactions } from "@/hooks/chat/useMessageReactions";
import { consumeUnreadAtOpen } from "@/lib/unreadDividerStore";
import { MediaLightbox } from "./chat/media/MediaLightbox";
import { useConversationMedia, type ConversationMediaItem } from "./chat/media/useConversationMedia";
import { insertIntoField } from "@/lib/insertAtCursor";
import { useHistoryRefetch } from "@/hooks/useHistoryRefetch";
import ForwardMessageModal from "./chat/ForwardMessageModal";
import CloseConversationDialog from "./CloseConversationDialog";
import { TransferConversationDialog } from "./TransferConversationDialog";
import { ShareConversationDialog } from "./ShareConversationDialog";
import SectorPickerDialog from "./SectorPickerDialog";
import { useSectors } from "@/hooks/useSectors";
import { useAssumirConversa } from "@/hooks/useAssumirConversa";
import GroupInfoPanel from "./GroupInfoPanel";
import { useVoiceCalls } from "@/contexts/VoiceCallContext";
import AudioRecorder from "./AudioRecorder";
import { audioPlayback } from "./AudioPlayer";
import { isValidAudioBlob } from "@/lib/audioValidation";
import { useDragDropFiles } from "./chat/composer/useDragDropFiles";
import ReplyPreview from "./ReplyPreview";
import { CopilotoDaConversa } from "./chat/copiloto/CopilotoDaConversa";
import ScheduledMessagesBanner from "./scheduled/ScheduledMessagesBanner";
import { MentionParticipant } from "./MentionPopup";
import { ChatInput, ChatInputRef, ChatHeader, MessageSelectionBar, MessageList, MessageListRef, NoteDialog, TemplateSelector, MessageSearchFilters, ScheduleMessagePopover } from "./chat";
import { selectedInOrder, toggleSelection } from "@/lib/messageSelection";
import ImportHistoryDialog from "./chat/ImportHistoryDialog";
import { useMessages, useConversation, useNotes, useMessageSearch, useTemplates, useTypingPresence, useCloudTyping, Message, Conversation, Note, Template } from "@/hooks/chat";
import { useActionButton } from "@/hooks/useActionButton";
import { ContactInfoPanel } from "@/components/chat/ContactInfoPanel";
import { useScheduledMessages } from "@/hooks/useScheduledMessages";
import { getDraft, setDraft, getReplyDraft, setReplyDraft } from "@/lib/messageDrafts";
import { latestInboundSentAt } from "@/lib/deliveryTiming";
import { alvoDeContato } from "@/lib/conversaCarregada";
import { ehDirect, identificacaoDoContato, mensagemDoDirect, respostaVaiPeloDirect, telefoneSugerido, temDirect } from "@/lib/directDoInstagram";
import { JuntarAoWhatsApp } from "./chat/JuntarAoWhatsApp";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useVisualViewportHeight } from "@/hooks/useVisualViewport";

interface ChatAreaProps {
  conversationId: string | null;
  userId: string;
  agentEmail?: string; // Logged-in user email — used by action button {agent.email} placeholder
  onConversationUpdate?: (clearSelection?: boolean) => void;
  /** A conversa aberta saiu do acesso de quem a abriu (a RLS devolve 0 linhas): o Dashboard avisa e sai dela. */
  onConversationInaccessible?: (conversationId: string) => void;
  phoneNumberId?: string | null; // Meta's phone_number_id
  phoneNumberDbId?: string | null; // Database phone_number UUID (for QR connections)
  isQrConnection?: boolean; // True for QR-connected numbers (Baileys-only features)
  isFreeTextChannel?: boolean; // True for channels with no 24h window / no template gate (QR)
  /** Nome e cor do número da conversa, em qualquer modo (nulo só enquanto o mapa de números não carregou: sem selo). */
  numeroNome?: string | null;
  numeroHue?: number | null;
  onNavigateToConversation?: (phone: string, name: string) => void; // Callback to navigate to or create conversation with phone
  /**
   * Abre uma conversa que JÁ EXISTE, pelo id. Diferente de
   * onNavigateToConversation, que busca por telefone e cria se não achar — as
   * variações dele não cobrem o 9º dígito, então usá-lo para o vínculo do grupo
   * criaria conversa duplicada justamente no caso que a feature resolve.
   */
  onOpenConversation?: (conversationId: string) => void;
  onMobileBack?: () => void; // Callback for mobile back button
  /** Escape em cascata: o Dashboard chama antes de desselecionar; retorna true se consumiu (fechou a coluna da direita). */
  escapeInterceptorRef?: React.MutableRefObject<(() => boolean) | null>;
}

import { useOrganization } from "@/contexts/OrganizationContext";

import { IdCopyButton } from "@/components/ui/id-copy-button";
import { useNotifications } from "@/contexts/NotificationContext";
import { mediaUploadQueue } from "@/lib/mediaUploadTransport";
import { postSendMedia } from "@/lib/sendMediaRequest";
import { measureLocalMedia, localMediaSize } from "@/lib/localMediaSize";
import { createDeliveryMatcher, type UploadRequest } from "@/lib/mediaUploadQueue";
import { ultimaTrocaDeNome } from "@/lib/nomeDoGrupo";

const MAX_MEDIA_FILES = 30;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const extFromMime = (mime: string) => EXT_BY_MIME[mime] ?? (mime.split('/')[1] || 'png');

const imageFilesFromClipboard = (data: DataTransfer): File[] => {
  const files: File[] = [];
  const stamp = Date.now();
  let i = 0;
  for (const item of data.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) {
        files.push(new File([blob], `clipboard_${stamp}_${i++}.${extFromMime(blob.type)}`, {
          type: blob.type,
        }));
      }
    }
  }
  return files;
};

const ChatArea = ({ conversationId, userId, agentEmail, onConversationUpdate, onConversationInaccessible, phoneNumberId, phoneNumberDbId, isQrConnection, isFreeTextChannel, numeroNome = null, numeroHue = null, onNavigateToConversation, onOpenConversation, onMobileBack, escapeInterceptorRef }: ChatAreaProps) => {
  const { toast } = useToast();
  const { currentOrganization } = useOrganization();
  const { setActiveConversationId, conversations: contextConversations, refreshConversationById, conversationRefreshRequest } = useNotifications();
  const isMobile = useIsMobile();
  const isOnline = useOnlineStatus();
  // iOS: o teclado virtual não encolhe o layout viewport — medimos o
  // visualViewport e aplicamos a altura visível no wrapper (null = sem ajuste).
  const visualHeight = useVisualViewportHeight(isMobile);
  const [searchParams, setSearchParams] = useSearchParams();
  const targetMessageId = searchParams.get("messageId");

  // Toast helpers for hooks
  const handleError = (title: string, description: string) => {
    toast({ title, description, variant: "destructive" });
  };
  const handleSuccess = (title: string, description?: string) => {
    toast({ title, description });
  };

  // === HOOKS ===

  // Semente do header: a lista já tem nome/telefone/avatar da conversa clicada,
  // então o header troca em 0ms e o fetch só completa o que falta (group_jid).
  const seedConversation = useMemo(() => {
    if (!conversationId) return null;
    const c = contextConversations.find((conv) => conv.id === conversationId);
    if (!c) return null;
    return {
      id: c.id,
      contact_name: c.contact_name,
      contact_phone: c.contact_phone,
      is_group: c.is_group,
      contact_avatar_url: c.contact_avatar_url,
      // O canal vem no seed: sem ele o Direct passaria pelo modo WhatsApp até o fetch.
      channel: c.channel,
      instagram_username: c.instagram_username,
    };
  }, [conversationId, contextConversations]);

  // Conversation hook
  const {
    conversation,
    isUpdating,
    fetchConversation,
    isEditingName,
    editNameValue,
    setEditNameValue,
    isSavingName,
    editNameInputRef,
    startEditName,
    cancelEditName,
    saveContactName,
    isEditingPhone,
    editPhoneValue,
    setEditPhoneValue,
    isSavingPhone,
    editPhoneInputRef,
    startEditPhone,
    cancelEditPhone,
    saveContactPhone,
    releaseConversation,
    transferConversation,
    forwardToSector,
    closeConversation,
    addCoOwner,
    removeCoOwner,
    leaveSharedConversation,
  } = useConversation({
    conversationId,
    userId,
    seedConversation,
    onConversationUpdate,
    onInaccessible: (id) => {
      // 0 linhas: o refresh pontual tira a conversa da lista (o realtime não
      // entrega o UPDATE que a tira do escopo da RLS).
      void refreshConversationById(id);
      onConversationInaccessible?.(id);
    },
    onNotesRefresh: () => notesHook.fetchNotes(),
    onSuccess: handleSuccess,
    onError: handleError,
  });

  // Broadcast para a conversa ABERTA (outra pessoa a assumiu ou a transferiram:
  // `conversation-left-scope`, mandado pelo banco nas linhas com "só quem assumiu
  // vê"): rebusca. 0 linhas → onInaccessible fecha o chat e avisa. Sem isto a
  // lista tirava a conversa, mas o chat seguia aberto e com o envio ativo.
  useEffect(() => {
    if (conversationRefreshRequest.seq <= 0) return;
    if (!conversationId || conversationRefreshRequest.conversationId !== conversationId) return;
    void fetchConversation();
  }, [conversationRefreshRequest, conversationId, fetchConversation]);

  // Direct do Instagram: o canal é da conversa, não da linha. Só texto, janela
  // de 24h do Meta sem modelo que reabra, e nada que fale com WhatsApp
  // (mídia, figurinha, ligação, agendamento, botões de ação, reação, edição).
  const isDirect = ehDirect(conversation);
  // Para quem os efeitos de WhatsApp apontam (presença, participantes de grupo): só a
  // conversa carregada que é a do id aberto e que não é do Direct. Na troca A -> B, o
  // primeiro render tem o número da B e ainda a conversa da A; sem este filtro a
  // presença da A seria assinada no número da B.
  const alvoWhatsApp = alvoDeContato(conversation, conversationId);

  // Notes hook
  const notesHook = useNotes({
    conversationId,
    userId,
    onSuccess: handleSuccess,
    onError: handleError,
  });
  const { notes, noteContent, setNoteContent, isSaving: noteLoading, addNote, deleteNote, fetchNotes } = notesHook;

  // Coleção pessoal de figurinhas (picker do composer + "salvar" na bolha)
  const {
    stickers,
    isLoading: stickersLoading,
    isConverting: stickerConverting,
    isSaving: stickerSaving,
    fetchStickers,
    convertToSticker,
    saveStickerBlob,
    saveStickerFromUrl,
    removeSticker,
    touchLastUsed,
  } = useStickers({
    userId,
    onSuccess: handleSuccess,
    onError: handleError,
  });

  // Messages hook
  const {
    messages,
    setMessages,
    fetchMessages,
    loadMore,
    fetchAllMessages,
    sendMessage,
    editMessage,
    deleteMessage,
    reactToMessage,
    retryMessage,
    discardMessage,
    isLoading: messagesLoading,
    isLoadingMore,
    isFetchingAll,
    hasMore,
  } = useMessages({
    conversationId,
    userId,
    phoneNumberId: phoneNumberDbId,
    isQrConnection,
    contactPhone: conversation?.contact_phone,
    onConversationUpdate,
    onError: handleError,
    onSuccess: handleSuccess,
  });
  // Nome do grupo trocou (pelo painel ou no aparelho): o cabeçalho não escuta UPDATE em
  // `conversations`, então relê a conversa quando chega a mensagem "mudou o nome". A
  // primeira leitura de cada conversa só marca o ponto de partida.
  const trocaDeNome = ultimaTrocaDeNome(messages);
  const trocaDeNomeVistaRef = useRef<{ conversationId: string | undefined; id: string | null } | null>(null);
  useEffect(() => {
    const vista = trocaDeNomeVistaRef.current;
    trocaDeNomeVistaRef.current = { conversationId, id: trocaDeNome };
    if (!vista || vista.conversationId !== conversationId || !trocaDeNome || vista.id === trocaDeNome) return;
    void fetchConversation();
  }, [trocaDeNome, conversationId, fetchConversation]);

  // A fila de mídia termina depois (às vezes em outra conversa): lê o fetch vivo.
  const fetchMessagesRef = useRef(fetchMessages);
  fetchMessagesRef.current = fetchMessages;

  // Bolha pendente → mensagem real no MESMO commit, antes do paint: o realtime
  // traz a linha antes da resposta HTTP da edge (que ainda espera webhooks), e
  // sem isto as duas apareciam juntas até a pendente sumir de uma vez.
  const deliveryMatcherRef = useRef(createDeliveryMatcher());
  const messagesForUploadsRef = useRef(messages);
  messagesForUploadsRef.current = messages;
  useLayoutEffect(() => {
    if (!conversationId) return;
    const check = () => {
      deliveryMatcherRef
        .current(mediaUploadQueue.getSnapshot(), messagesForUploadsRef.current, conversationId)
        .forEach((id) => mediaUploadQueue.settle(id));
    };
    check();
    return mediaUploadQueue.subscribe(check);
  }, [conversationId, messages]);

  // Card com Direct (fase 3): no card juntado ao WhatsApp, a resposta sai pelo
  // Direct quando o contato escreveu por último lá e ainda está nas 24h. Enquanto
  // a resposta vai pelo Direct, o composer é só texto.
  const temDirectNaConversa = temDirect(conversation);
  const soTexto = isDirect || (temDirectNaConversa && respostaVaiPeloDirect(messages));

  // Reações agregadas por reator (grupo mostra todo mundo, não só o último)
  const { reactionsByMessage } = useMessageReactions(conversationId ?? null);

  // Galeria do lightbox: imagens/vídeos das páginas carregadas, em ordem
  const conversationMedia = useConversationMedia(messages);

  // Autoplay da próxima nota de voz consecutiva (paridade WhatsApp). Ref para
  // não reassinar o listener do singleton a cada mensagem nova.
  const messagesForAutoplayRef = useRef(messages);
  messagesForAutoplayRef.current = messages;
  useEffect(() => {
    return audioPlayback.subscribeEnded((endedSrc) => {
      const msgs = messagesForAutoplayRef.current;
      const idx = msgs.findIndex((m) => m.media_url === endedSrc);
      if (idx === -1) return;
      const next = msgs[idx + 1];
      if (next?.media_url && (next.message_type === 'audio' || next.message_type === 'ptt')) {
        audioPlayback.play(next.media_url);
      }
    });
  }, []);

  // ─── Identidade dos participantes do grupo ──────────────────────────────
  // UMA resolução para quatro fontes: apelido do grupo > pushName > contato da
  // conversa 1:1 existente > telefone formatado. Antes essa cadeia estava
  // escrita em 6 lugares com 6 ordens diferentes — e o cabeçalho da bolha não
  // tinha cadeia nenhuma, renderizando sender_name cru (ou nada).

  // Apelidos manuais. Deps SEM `messages`: antes esse select era refeito a cada
  // mensagem nova que chegava no grupo.
  const [aliases, setAliases] = useState<Record<string, string>>({});
  useEffect(() => {
    const groupJid = conversation?.group_jid;
    if (!conversation?.is_group || !groupJid || !currentOrganization?.id) {
      setAliases({});
      return;
    }

    let cancelled = false;
    const fetchAliases = async () => {
      const { data, error } = await supabase
        .from("group_participant_aliases")
        .select("participant_jid, alias")
        .eq("organization_id", currentOrganization.id)
        .eq("group_jid", groupJid);

      if (error) {
        console.error("Error fetching participant aliases:", error);
        return;
      }
      if (cancelled) return;

      const map: Record<string, string> = {};
      for (const row of data ?? []) {
        const bare = bareJid(row.participant_jid);
        if (bare) map[bare] = row.alias;
      }
      setAliases(map);
    };

    void fetchAliases();
    return () => {
      cancelled = true;
    };
  }, [conversation?.is_group, conversation?.group_jid, currentOrganization?.id]);

  // pushName de quem falou no grupo, chaveado por telefone e por bare do JID.
  //
  // `messages` está em ordem cronológica, e aqui o ÚLTIMO vence: quem trocou o
  // nome no WhatsApp aparece com o atual. O código anterior tinha a guarda
  // `if (!lookup[phone])`, que fazia vencer o mais ANTIGO — mas ela só existia
  // porque os apelidos eram escritos no mesmo mapa e não podiam ser
  // sobrescritos. Agora o apelido é camada própria e a guarda perdeu a razão.
  const pushNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of messages) {
      if (m.direction !== "inbound" || !m.sender_name) continue;
      for (const key of [m.sender_phone, bareJid(m.sender_jid)]) {
        if (key) map[key] = m.sender_name;
      }
    }
    return map;
  }, [messages]);

  // Raw group participants (nomes resolvidos no buildParticipantDisplayMap).
  const {
    participants: rawGroupParticipants,
    group: groupMeta,
    refetch: refetchGroupMeta,
  } = useGroupParticipants({
    isGroup: alvoWhatsApp.isGroup,
    groupJid: alvoWhatsApp.groupJid,
    phoneNumberDbId,
    isQrConnection,
  });

  // Telefones que valem consulta de contato. LID não resolvido fica fora: o
  // valor não é telefone e qualquer match seria falso positivo.
  const participantPhones = useMemo(() => {
    const set = new Set<string>();
    for (const p of rawGroupParticipants) {
      if (!p.isLid && p.phone) set.add(p.phone);
    }
    for (const m of messages) {
      const phone = trustedSenderPhone(m);
      if (phone) set.add(phone);
    }
    return [...set];
  }, [rawGroupParticipants, messages]);

  const participantContacts = useParticipantContacts({
    phones: participantPhones,
    phoneNumberDbId,
    enabled: Boolean(alvoWhatsApp.isGroup && isQrConnection),
    scopeKey: alvoWhatsApp.groupJid ?? null,
  });

  const resolvedParticipants = useMemo(
    () =>
      buildParticipantDisplayMap({
        participants: rawGroupParticipants,
        aliases,
        pushNames,
        contacts: participantContacts,
      }),
    [rawGroupParticipants, aliases, pushNames, participantContacts]
  );

  // Mapa plano para os consumidores que só precisam de nome (MessageList,
  // MessageBubble, buildGroupActionText, chips da busca).
  const participantLookup = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(resolvedParticipants).map(([key, display]) => [key, display.name])
      ),
    [resolvedParticipants]
  );

  // Participantes na forma que a bolha de enquete consome ("ainda não votaram"):
  // chave = id sem sufixo (LID ou telefone), a mesma do voto.
  const pollParticipants = useMemo<PollParticipantRef[]>(() => {
    const selfKey = bareJid(groupMeta?.me?.id);
    return rawGroupParticipants.map((p) => {
      const key = bareJid(p.id) ?? p.id;
      return {
        key,
        name:
          participantLookup[key] ??
          participantLookup[p.phone] ??
          p.name ??
          formatParticipantPhone(key, Boolean(p.isLid)),
        isSelf: selfKey !== undefined && key === selfKey,
      };
    });
  }, [rawGroupParticipants, participantLookup, groupMeta?.me?.id]);

  // Message search hook
  const {
    isOpen: searchOpen,
    searchTerm,
    setSearchTerm,
    searchResults,
    currentIndex: currentSearchIndex,
    searchInputRef,
    open: openSearch,
    close: handleCloseSearch,
    goToPrev: handleSearchPrev,
    goToNext: handleSearchNext,
    filters: searchFilters,
    updateFilters: updateSearchFilters,
    resetFilters: resetSearchFilters,
    hasActiveFilters,
    activeFilterCount,
    participants: searchParticipants,
  } = useMessageSearch({
    messages,
    conversationId,
    isGroup: conversation?.is_group ?? false,
    participantNames: participantLookup,
  });

  // Templates hook
  const {
    templates,
    loadingTemplates,
    templatesOpen,
    setTemplatesOpen,
    selectedTemplate,
    templateDialogOpen,
    templateSearch,
    setTemplateSearch,
    fetchTemplates,
    upsertTemplate,
    selectTemplate,
    sendTemplate,
    closeTemplateDialog,
    flowTemplates,
    loadingFlowTemplates,
    flowTemplatesOpen,
    setFlowTemplatesOpen,
    selectedFlowTemplate,
    flowTemplateDialogOpen,
    flowTemplateSearch,
    setFlowTemplateSearch,
    flowTemplateParams,
    setFlowTemplateParams,
    fetchFlowTemplates,
    selectFlowTemplate,
    sendFlowTemplate,
    closeFlowTemplateDialog,
    getVariableCount,
    getTemplatePreview,
  } = useTemplates({
    organizationId: currentOrganization?.id || null,
    phoneNumberId,
  });

  // Criar template na hora: aprovado, ele já abre para preencher e enviar.
  const templateCreation = useInlineTemplateCreation({
    onApproved: (template) => {
      upsertTemplate(template);
      // Outro template já aberto para envio: não troca por baixo (o toast do hook avisa da aprovação).
      if (!templateDialogOpen) selectTemplate(template);
    },
    // O aviso "em análise" mora na lista de templates.
    onSaved: () => setTemplatesOpen(true),
    beforeOpen: () => setTemplatesOpen(false),
  });
  const resetTemplateCreation = templateCreation.reset;
  useEffect(() => {
    resetTemplateCreation();
  }, [conversationId, resetTemplateCreation]);
  const openTemplateBuilder = templateCreation.openBuilder;
  const openTemplateCreator = useCallback(() => openTemplateBuilder(), [openTemplateBuilder]);

  // Action Button hook (multiple buttons)
  const {
    buttons: actionButtons,
    sendingButtonId: loadingButtonId,
    handleButtonClick: handleActionButton,
  } = useActionButton({
    organizationId: currentOrganization?.id || null,
    phoneNumberDbId: phoneNumberDbId || null,
  });

  // Recuperação do histórico da janela em que o número ficou desconectado.
  const { refetchHistory, isRefetchingHistory } = useHistoryRefetch(
    conversation,
    phoneNumberDbId || null,
  );
  // Terceira coluna à direita (conversas | chat | perfil). O estado é um valor
  // só, e não um booleano, para que uma coluna nova possa dividir o mesmo
  // espaço sem nunca aparecerem duas ao mesmo tempo.
  const [rightPanel, setRightPanel] = useState<"none" | "profile">("none");
  const profileOpen = rightPanel === "profile";
  // Escape em cascata é decidido num ÚNICO handler no Dashboard (dois listeners
  // no document dependiam da ordem de registro — e o Dashboard monta antes,
  // com user=null, então o "filho registra primeiro" era falso). O ChatArea só
  // expõe o interceptor: fecha a coluna e devolve true se havia o que fechar.
  const rightPanelRef = useRef(rightPanel);
  rightPanelRef.current = rightPanel;
  const toggleProfile = useCallback(
    () => setRightPanel((panel) => (panel === "profile" ? "none" : "profile")),
    [],
  );
  // Seleção múltipla de mensagens: o lote a encaminhar sai daqui em ordem
  // cronológica. Declarado aqui em cima porque o interceptor de Escape logo
  // abaixo já precisa dele.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Modo de seleção sai antes da coluna da direita: é o estado mais "raso" na cabeça do usuário.
  const selectionModeRef = useRef(selectionMode);
  selectionModeRef.current = selectionMode;
  // Lightbox de mídia: overlay mais raso de todos — Esc fecha SÓ ele. Ref
  // síncrona (não estado) porque o interceptor e o Radix disputam o mesmo
  // keydown e o estado ainda não commitou quando o segundo handler roda.
  const [lightboxMessageId, setLightboxMessageId] = useState<string | null>(null);
  const lightboxOpenRef = useRef(false);
  const openLightbox = useCallback((messageId: string) => {
    lightboxOpenRef.current = true;
    setLightboxMessageId(messageId);
  }, []);
  const closeLightbox = useCallback(() => {
    lightboxOpenRef.current = false;
    setLightboxMessageId(null);
  }, []);
  useEffect(() => {
    if (!escapeInterceptorRef) return;
    escapeInterceptorRef.current = () => {
      if (lightboxOpenRef.current) {
        closeLightbox();
        return true;
      }
      if (selectionModeRef.current) {
        setSelectionMode(false);
        setSelectedIds(new Set());
        return true;
      }
      // O lightbox aberto DE DENTRO da galeria do painel é um Radix Dialog
      // portalado por cima: ele consome o Esc antes de chegar aqui, então
      // fechar a coluna neste ponto não rouba o Esc de ninguém.
      if (rightPanelRef.current !== "none") {
        setRightPanel("none");
        return true;
      }
      return false;
    };
    return () => {
      escapeInterceptorRef.current = null;
    };
  }, [escapeInterceptorRef, closeLightbox]);

  // Trocou de conversa: fecha a coluna da direita — um perfil aberto passaria
  // a ser de OUTRA pessoa.
  useEffect(() => {
    setRightPanel("none");
  }, [conversationId]);

  // Scheduled Messages hook
  const {
    scheduledMessages,
    scheduleTextMessage,
    scheduleTemplateMessage,
    scheduleMediaMessage,
    cancelScheduledMessage,
    updateScheduledMessage,
    sendScheduledMessageNow,
    isSaving: isScheduling,
  } = useScheduledMessages({
    organizationId: currentOrganization?.id || null,
    conversationId: conversationId || null,
    phoneNumberId: phoneNumberDbId || null,
  });

  // === LOCAL STATE ===

  const [hasMessageContent, setHasMessageContent] = useState(false);

  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'preview' | 'sending'>('idle');

  // "Digitando" nas duas direções (só QR/Baileys — Cloud API não tem).
  const {
    incoming: incomingChatState,
    notifyTyping,
    notifyRecording,
    notifyStopped,
  } = useTypingPresence({
    conversationId: conversationId || null,
    phoneNumberDbId,
    conversation,
    isQrConnection,
  });

  const { notifyCloudTyping } = useCloudTyping();

  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [importHistoryOpen, setImportHistoryOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [forwardSectorOpen, setForwardSectorOpen] = useState(false);

  // Shared custody: derive current assignee state from the context conversations list.
  // The useConversation hook only fetches display fields (name/phone/avatar), so we
  // read assigned_to / co_assignee_ids from NotificationContext where the full list lives.
  const contextConversation = conversationId
    ? contextConversations.find((c) => c.id === conversationId) ?? null
    : null;
  const primaryAssigneeId = contextConversation?.assigned_to ?? null;
  const coOwnerIds = contextConversation?.co_assignee_ids ?? [];
  // Setor da conversa: mesma origem do estado de posse — a lista do contexto.
  const currentSectorId = contextConversation?.sector_id ?? null;
  // O diálogo de encaminhar lista TODOS os setores da linha, não só os meus:
  // encaminhar é o conserto de "assumi por engano", e precisa alcançar o setor
  // certo mesmo que quem move não atenda lá.
  const setores = useSectors(phoneNumberDbId ?? null, userId);
  const { sectorsForLine, byId: sectorsById, isolationEnabled: sectorIsolationEnabled, followsOwner: setorSegueDono } = setores;
  // Assumir pelo cabeçalho: o mesmo caminho do botão da linha e do menu de
  // contexto da lista (setor, otimista, toast). Só para conversa sem dono e
  // aberta — a mesma fonte de posse acima, a lista do contexto.
  const { assigningId, resolveAndAssign, dialogoDeSetor } = useAssumirConversa({
    userId,
    phoneNumberId: phoneNumberDbId ?? null,
    setores,
    comIsolamento: () => setores.isolationEnabled,
  });
  const podeAssumir =
    !!contextConversation && contextConversation.assigned_to === null && contextConversation.status !== "closed";
  const userIsPrimary = primaryAssigneeId === userId;
  const userIsCoOwner = coOwnerIds.includes(userId);
  const messageListRef = useRef<MessageListRef>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);
  // Emoji no mobile: drawer aberto pelo item do menu "+"
  const [emojiDrawerOpen, setEmojiDrawerOpen] = useState(false);
  const [pollDialogOpen, setPollDialogOpen] = useState(false);
  const [forwardBatchOpen, setForwardBatchOpen] = useState(false);

  const enterSelection = useCallback((message?: Message) => {
    setSelectionMode(true);
    setSelectedIds(message ? new Set([message.id]) : new Set());
  }, []);

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((message: Message) => {
    setSelectedIds((prev) => toggleSelection(prev, message.id));
  }, []);

  // Ordem do lote = ordem da conversa, não a ordem em que o usuário clicou.
  const selectedMessages = useMemo(
    () => selectedInOrder(messages, selectedIds),
    [messages, selectedIds]
  );

  // Trocou de conversa: a seleção não faz sentido no histórico do outro contato.
  useEffect(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setForwardBatchOpen(false);
  }, [conversationId]);

  // Media upload states
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  // Legenda POR ARQUIVO (paridade WhatsApp): array paralelo a selectedFiles;
  // captionIndex = qual thumb está com a legenda em edição.
  const [mediaCaptions, setMediaCaptions] = useState<string[]>([]);
  const [captionIndex, setCaptionIndex] = useState(0);
  const captionRef = useRef<HTMLTextAreaElement>(null);
  // "Ver uma vez" — só QR (a Cloud API não envia view-once)
  const [viewOnceEnabled, setViewOnceEnabled] = useState(false);
  const [mediaPreviewUrls, setMediaPreviewUrls] = useState<string[]>([]);
  const [mediaDialogOpen, setMediaDialogOpen] = useState(false);
  const [mediaType, setMediaType] = useState<'image' | 'document'>('image');
  // Prévia do envio abre no MESMO lightbox da conversa, por cima do dialog.
  // Id = índice do arquivo; o Esc fecha só o lightbox (camada de cima do Radix).
  const [pendingLightboxId, setPendingLightboxId] = useState<string | null>(null);
  const pendingMedia = useMemo<ConversationMediaItem[]>(
    () =>
      selectedFiles.flatMap((file, i) => {
        const url = mediaPreviewUrls[i];
        const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : null;
        if (!url || !type) return [];
        return [{ messageId: String(i), url, type, caption: mediaCaptions[i]?.trim() || null }];
      }),
    [selectedFiles, mediaPreviewUrls, mediaCaptions]
  );
  const closePendingLightbox = useCallback(() => setPendingLightboxId(null), []);
  // Guarda do Enviar: o clique duplo no mesmo frame enfileiraria tudo duas vezes.
  // Liberada quando uma seleção nova começa (appendMediaFiles).
  const mediaSendLockRef = useRef(false);
  // Arquivos subindo para um agendamento: o diálogo fica travado (Enviar mandaria
  // os mesmos arquivos agora e de novo no horário; fechar não cancela o upload).
  const [schedulingFiles, setSchedulingFiles] = useState(false);
  const schedulingFilesRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatInputRef = useRef<ChatInputRef>(null);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  // O painel é de UMA conversa: trocar de conversa (inclusive pelo histórico do navegador) o
  // fecha, senão ele reabre sozinho na próxima conversa que for grupo.
  useEffect(() => {
    setGroupInfoOpen(false);
  }, [conversationId]);
  // Ligação de voz: só linha QR, conversa 1:1 e só onde o serviço realmente liga
  // (zapo com o plugin @zapo-js/voip). Sem a capability nada de ligação aparece —
  // enquanto nenhuma linha tiver o plugin, isso significa nenhuma ligação.
  // A ligação em si vive no VoiceCallProvider (App), não aqui: montada no
  // ChatArea, ela caía a cada troca de conversa.
  const { canCall, busyByOther, inCall, startCall } = useVoiceCalls();
  const canVoiceCall = Boolean(canCall && phoneNumberDbId && conversation && !conversation.is_group);
  const callBlockedReason = inCall
    ? "Você já está em uma ligação"
    : busyByOther
      ? "A linha está em ligação"
      : null;

  // Texto pronto (sugestão do Copiloto) entra na caixa de escrever, para conferir e enviar; o que
  // já estava escrito fica acima. A caixa remonta por conversa (key), então a conversa do clique é
  // conferida aqui, contra a dona da caixa: trocou no meio da espera, a mensagem de um contato não
  // cai na caixa de outro. Atualizada no layout effect, no mesmo commit
  // que monta a caixa nova, antes de qualquer resposta de rede ser tratada.
  const conversaDaCaixaRef = useRef(conversationId);
  useLayoutEffect(() => {
    conversaDaCaixaRef.current = conversationId;
  }, [conversationId]);
  const inserirNoComposer = useCallback((texto: string, conversaDoClique: string) => {
    if (conversaDoClique !== conversaDaCaixaRef.current) return "outra" as const;
    const caixa = chatInputRef.current;
    if (!caixa) return "fechada" as const;
    const atual = caixa.getValue();
    caixa.setValue(atual.trim() ? `${atual.trimEnd()}\n\n${texto}` : texto);
    caixa.focus();
    return "inserida" as const;
  }, []);
  // Reply state
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);

  // Reply pendente sobrevive à troca de conversa (guardado por id no draft store).
  // ORDEM IMPORTA: o effect de salvar vem ANTES do de restaurar — na troca, o
  // salvar vê o id restaurado ≠ novo id e não polui a conversa nova com a
  // citação da anterior; o restaurar então repõe a citação da conversa nova.
  const replyRestoredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (conversationId && replyRestoredForRef.current === conversationId) {
      setReplyDraft(conversationId, replyingTo);
    }
  }, [replyingTo, conversationId]);
  useEffect(() => {
    if (!conversationId) return;
    setReplyingTo(getReplyDraft<Message>(conversationId));
    replyRestoredForRef.current = conversationId;
  }, [conversationId]);

  // À prova de frame: no primeiro render após a troca, replyingTo ainda é o da
  // conversa ANTERIOR (o restore roda em effect). Renderizar sempre a derivação.
  const activeReplyingTo =
    conversationId && replyRestoredForRef.current === conversationId ? replyingTo : null;

  // Rascunho de texto: persistido por conversa (o ChatInput remonta por key).
  // Também é o gancho do "digitando": o onValueChange do ChatInput já dispara a
  // cada tecla, e o throttle de rede vive dentro do useTypingPresence.
  const draftPrimedRef = useRef<string | null>(null);
  const handleDraftChange = useCallback(
    (value: string) => {
      if (conversationId) setDraft(conversationId, value);

      // O ChatInput remonta por key e dispara onValueChange UMA vez na montagem,
      // com o initialValue (o rascunho salvo). Isso não é digitação: sem engolir
      // essa primeira chamada, abrir uma conversa com rascunho avisaria o contato
      // que estamos digitando.
      if (draftPrimedRef.current !== conversationId) {
        draftPrimedRef.current = conversationId ?? null;
        return;
      }

      // Direct: o "digitando" do WhatsApp não chega ao Instagram.
      if (soTexto) return;

      // Apagar tudo é sinal explícito de que parou — não espera os 3s de ócio.
      if (value.trim()) {
        if (isQrConnection) {
          notifyTyping();
        } else {
          void notifyCloudTyping(conversationId, phoneNumberDbId);
        }
      } else {
        if (isQrConnection) {
          notifyStopped();
        }
      }
    },
    [conversationId, soTexto, isQrConnection, notifyTyping, notifyStopped, notifyCloudTyping, phoneNumberDbId],
  );

  // Responder é a ação mais repetida do dia: deixar o composer pronto para
  // digitar no desktop. No mobile não focar (abriria o teclado por cima).
  const handleReply = useCallback(
    (message: Message) => {
      setReplyingTo(message);
      if (!isMobile) chatInputRef.current?.focus();
    },
    [isMobile],
  );

  // Scroll-to-bottom button state
  const [showScrollButton, setShowScrollButton] = useState(false);
  const showScrollButtonRef = useRef(false);

  // Edit/Delete state
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [editContent, setEditContent] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // Apagar para todos: dialog estilizado no lugar do window.confirm
  const [messageToDelete, setMessageToDelete] = useState<Message | null>(null);

  // Scroll to target message from URL (e.g., from global search)
  const scrollTargetHandled = useRef(false);
  useEffect(() => {
    if (targetMessageId && messages.length > 0 && !messagesLoading && !scrollTargetHandled.current) {
      // Check if message exists in current messages
      const messageExists = messages.some(m => m.id === targetMessageId);

      if (!messageExists) {
        // Message not in current batch, fetch all messages
        scrollTargetHandled.current = true;
        fetchAllMessages().then(() => {
          setTimeout(() => {
            messageListRef.current?.scrollToMessage(targetMessageId);
            setSearchParams((prev) => {
              prev.delete("messageId");
              return prev;
            }, { replace: true });
          }, 200);
        });
      } else {
        // Message exists, scroll to it
        scrollTargetHandled.current = true;
        setTimeout(() => {
          messageListRef.current?.scrollToMessage(targetMessageId);
          setSearchParams((prev) => {
            prev.delete("messageId");
            return prev;
          }, { replace: true });
        }, 100);
      }
    }

    // Reset when conversation changes
    if (!targetMessageId) {
      scrollTargetHandled.current = false;
    }
  }, [targetMessageId, messages, messagesLoading, setSearchParams, fetchAllMessages]);

  // Menção @: o popup só recebe nome quando ele é NOME. Com o telefone
  // formatado no lugar de `name`, a linha exibiria o mesmo número duas vezes
  // (rótulo e subtítulo) — o fallback é responsabilidade do popup.
  const groupParticipants: MentionParticipant[] = useMemo(() => {
    return rawGroupParticipants.map((p) => {
      const display = resolvedParticipants[p.phone] ?? resolvedParticipants[bareJid(p.jid) ?? ""];
      return {
        ...p,
        name: display && display.origin !== "phone" ? display.name : undefined,
      };
    });
  }, [rawGroupParticipants, resolvedParticipants]);

  // Gravar áudio manda 'recording' (o WhatsApp mostra "gravando áudio", não
  // "digitando"). Deriva do recordingState que o AudioRecorder já reporta, em vez
  // de acrescentar callbacks ao componente.
  useEffect(() => {
    if (recordingState === 'recording') notifyRecording();
    else notifyStopped();
  }, [recordingState, notifyRecording, notifyStopped]);

  // Em grupo o nome de quem digita importa; em 1:1 a bolha já é do contato.
  // Reusa o lookup que as menções e a busca já usam (JID -> nome).
  const typingIndicator = useMemo(() => {
    if (!incomingChatState) return null;
    const { state, leaving } = incomingChatState;
    if (!conversation?.is_group) return { state, leaving };

    const bare = bareJid(incomingChatState.participantJid);
    if (!bare) return { state, leaving };
    return {
      state,
      leaving,
      // Antes o rabo era o número CRU; agora vem formatado (ou "ID: …" quando o
      // WhatsApp não expôs o telefone daquele participante).
      name:
        resolvedParticipants[bare]?.name ??
        formatParticipantPhone(bare, incomingChatState.participantJid.endsWith("@lid")),
    };
  }, [incomingChatState, conversation?.is_group, resolvedParticipants]);

  // Set active conversation for notifications (hooks handle fetching and realtime)
  useEffect(() => {
    if (conversationId) {
      setActiveConversationId(conversationId);
    }
    // Deriva do rascunho em vez de zerar às cegas: os effects do pai rodam
    // DEPOIS do onMessageChange(true) do ChatInput no mount, e um reset cego
    // deixava o botão Enviar desabilitado com o rascunho restaurado na tela.
    setHasMessageContent(conversationId ? getDraft(conversationId).trim().length > 0 : false);

    return () => {
      setActiveConversationId(null);
    };
  }, [conversationId, setActiveConversationId]);

  // Reset input state when conversation changes (rascunho restaurado conta
  // como conteúdo — ver comentário no effect de activeConversationId).
  useEffect(() => {
    setHasMessageContent(conversationId ? getDraft(conversationId).trim().length > 0 : false);
  }, [conversationId]);

  useEffect(() => {
    // Only scroll if we have a conversation selected
    if (conversationId) {
      // Focus the input when conversation changes (only on desktop to avoid keyboard popup on mobile)
      if (!isMobile) {
        chatInputRef.current?.focus();
      }
      // Fallback scroll for media-heavy conversations (images may still be loading).
      // Respeita quem já rolou para cima — reposicionar layout não pode roubar scroll.
      const timer = setTimeout(() => {
        if (!showScrollButtonRef.current) {
          scrollToBottom("auto");
        }
      }, 500);
      return () => {
        clearTimeout(timer);
      };
    }
  }, [conversationId, isMobile]);

  // Handle scroll state from MessageList
  const handleAtBottom = useCallback((atBottom: boolean) => {
    showScrollButtonRef.current = !atBottom;
    setShowScrollButton(!atBottom);
    if (atBottom) setNewWhileUpCount(0);
  }, []);

  // ── Divisor "N mensagens não lidas" (congelado por abertura) ────────────
  const [unreadDivider, setUnreadDivider] = useState<{ messageId: string; count: number } | null>(null);
  const dividerComputedForRef = useRef<string | null>(null);
  useEffect(() => {
    setUnreadDivider(null);
    dividerComputedForRef.current = null;
  }, [conversationId]);
  useEffect(() => {
    if (!conversationId || messagesLoading) return;
    if (dividerComputedForRef.current === conversationId) return;
    if (messages.length === 0) return;
    // Troca de conversa em voo: as mensagens ainda podem ser da anterior.
    const first = messages[0] as { conversation_id?: string };
    if (first.conversation_id && first.conversation_id !== conversationId) return;
    dividerComputedForRef.current = conversationId;
    const count = consumeUnreadAtOpen(conversationId);
    if (count <= 0) return;
    // Âncora = a N-ésima inbound de trás pra frente; com menos inbound
    // carregadas que N, a mais antiga da página serve (aproximação honesta).
    const inbound = messages.filter((m) => m.direction === 'inbound');
    const anchor = inbound[Math.max(0, inbound.length - count)];
    if (anchor) setUnreadDivider({ messageId: anchor.id, count });
  }, [conversationId, messages, messagesLoading]);

  // ── Contador do botão de rolar (msgs novas com o scroll lá em cima) ─────
  const [newWhileUpCount, setNewWhileUpCount] = useState(0);
  const lastTailIdRef = useRef<string | null>(null);
  useEffect(() => {
    setNewWhileUpCount(0);
    lastTailIdRef.current = null;
  }, [conversationId]);
  useEffect(() => {
    const tail = messages[messages.length - 1];
    if (!tail) return;
    const prevTailId = lastTailIdRef.current;
    lastTailIdRef.current = tail.id;
    if (prevTailId === null || tail.id === prevTailId) return;
    if (tail.direction === 'inbound' && showScrollButtonRef.current) {
      setNewWhileUpCount((c) => c + 1);
    }
  }, [messages]);

  // Notes handled by useNotes hook

  // Message search handled by useMessageSearch hook
  // Fetch all messages when opening search for accurate results
  const handleOpenSearch = useCallback(() => {
    fetchAllMessages();
    openSearch();
  }, [fetchAllMessages, openSearch]);

  // Scroll to search result — só quando o MATCH muda de verdade (recomputações
  // da lista não teleportam) e nunca em filtro sem termo (destaca e conta,
  // mas não arrasta o usuário para o match mais antigo do histórico).
  const lastScrolledMatchRef = useRef<string | null>(null);
  useEffect(() => {
    if (!searchTerm.trim()) return;
    if (searchResults.length > 0 && currentSearchIndex >= 0) {
      const messageId = searchResults[currentSearchIndex];
      if (messageId && messageId !== lastScrolledMatchRef.current) {
        lastScrolledMatchRef.current = messageId;
        messageListRef.current?.scrollToMessage(messageId);
      }
    }
  }, [currentSearchIndex, searchResults, searchTerm]);

  // Note submit wrapper
  const handleNoteSubmit = async () => {
    const success = await addNote();
    if (success) {
      setNoteOpen(false);
    }
  };

  // Conversation, edit functions, and fetchMessages handled by hooks

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    messageListRef.current?.scrollToBottom(behavior);
  }, []);

  // Track last message ID to detect actual new messages vs refetches
  const lastMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    const lastMessageId = lastMessage?.id || null;

    // Uma única fonte de auto-scroll: o followOutput do Virtuoso cuida de quem
    // está no fim da lista. Este effect só cobre o caso que o followOutput não
    // vê — o próprio usuário enviou uma mensagem estando rolado para cima.
    if (lastMessageId && lastMessageId !== lastMessageIdRef.current) {
      const isUserSent = lastMessage?.direction === "outbound" && lastMessage?.sent_by === userId;

      if (isUserSent && showScrollButtonRef.current) {
        scrollToBottom("smooth");
      }

      lastMessageIdRef.current = lastMessageId;
    }
  }, [messages, userId, scrollToBottom]);

  // Teclado abriu/fechou (iOS): reposicionamento de layout, sem animação —
  // mantém a última mensagem visível para quem estava no fim da conversa.
  useEffect(() => {
    if (visualHeight !== null && !showScrollButtonRef.current) {
      scrollToBottom("auto");
    }
  }, [visualHeight, scrollToBottom]);

  // Destaque temporário da mensagem alvo (citação clicada) — via prop/estado
  // React, nunca mutação de style em nó que o Virtuoso pode reciclar.
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashMessageHighlight = useCallback((messageId: string) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedMessageId(messageId);
    highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1800);
  }, []);

  // Scroll to a specific message when clicking on a quote
  const handleQuotedClick = useCallback((messageId: string) => {
    // Check if message exists in current array
    const messageExists = messages.some(m => m.id === messageId);

    if (!messageExists && hasMore) {
      // Message not loaded yet - fetch all messages first, then scroll
      fetchAllMessages().then(() => {
        setTimeout(() => {
          messageListRef.current?.scrollToMessage(messageId);
          flashMessageHighlight(messageId);
        }, 150);
      });
    } else {
      messageListRef.current?.scrollToMessage(messageId);
      flashMessageHighlight(messageId);
    }
  }, [messages, hasMore, fetchAllMessages, flashMessageHighlight]);

  // Conversation actions - wrap hook functions with dialog handling
  const handleReleaseConversation = async () => {
    return releaseConversation();
  };

  const handleTransferConversation = async (targetUserId: string, targetUserName: string, keepAsCoOwner: boolean) => {
    const success = await transferConversation(targetUserId, targetUserName, keepAsCoOwner);
    if (success) {
      setTransferDialogOpen(false);
    }
  };

  const handleForwardToSector = async (sectorId: string) => {
    const name = sectorsById.get(sectorId)?.name ?? "outro setor";
    const success = await forwardToSector(sectorId, name);
    if (success) {
      setForwardSectorOpen(false);
    }
  };

  const handleAddCoOwner = async (targetUserId: string, targetUserName: string) => {
    return addCoOwner(targetUserId, targetUserName);
  };

  const handleRemoveCoOwner = async (targetUserId: string, targetUserName: string) => {
    return removeCoOwner(targetUserId, targetUserName);
  };

  const handleLeaveSharedConversation = () => leaveSharedConversation();

  const handleCloseConversation = async (reason: string) => {
    const success = await closeConversation(reason);
    if (success) {
      setCloseDialogOpen(false);
    }
  };

  // Handle action button click - send webhook, open link, or open built-in dialog
  const handleActionButtonClick = useCallback(async (button: import("@/hooks/useActionButton").ActionButtonConfig) => {
    if (!conversationId || !userId) return;

    if (button.button_type === 'import_history') {
      setImportHistoryOpen(true);
      return;
    }

    const result = await handleActionButton(button, {
      conversationId,
      userId,
      contactName: conversation?.contact_name,
      contactPhone: conversation?.contact_phone,
      agentEmail,
    });
    if (button.button_type === 'link') {
      // Links open in new tab, no toast needed
      return;
    }
    if (result.success) {
      toast({
        title: "Dados enviados",
      });
    } else {
      toast({
        title: "Não foi possível enviar os dados",
        description: toUserMessage(result.error, "O botão não respondeu. Tente novamente em instantes."),
        variant: "destructive",
      });
    }
  }, [conversationId, userId, conversation?.contact_name, conversation?.contact_phone, agentEmail, handleActionButton, toast]);

  // Handle send from ChatInput component - wrapper for sendMessage hook
  const handleSendFromChatInput = async (
    content: string,
    mentionJids?: string[],
    quotedMessageId?: string | null
  ) => {
    // Mensagem enviada encerra o "digitando" na hora — esperar os 3s de ócio
    // deixaria o contato vendo "digitando" depois de a mensagem já ter chegado.
    notifyStopped();
    const success = await sendMessage({ content, mentionJids, quotedMessageId });
    if (success) {
      setReplyingTo(null);
    }
  };

  // Handle schedule message
  const handleScheduleMessage = useCallback(async (scheduledAt: Date) => {
    const content = chatInputRef.current?.getValue()?.trim();
    if (!content || !conversationId || !phoneNumberDbId || !currentOrganization?.id || !conversation) {
      return { success: false, error: "Dados incompletos" };
    }

    const result = await scheduleTextMessage({
      conversationId,
      phoneNumberId: phoneNumberDbId,
      organizationId: currentOrganization.id,
      content,
      scheduledAt,
      contactPhone: conversation.contact_phone,
      contactName: conversation.contact_name || undefined,
      quotedMessageId: activeReplyingTo?.id,
      mentions: [], // TODO: extract mentions from ChatInput if needed (inclui @todos/marcar todos)
    });

    if (result.success) {
      chatInputRef.current?.clear();
      setReplyingTo(null);
    }

    return result;
  }, [conversationId, phoneNumberDbId, currentOrganization?.id, conversation, replyingTo, scheduleTextMessage]);

  // Handle schedule template
  const handleScheduleTemplate = useCallback(async (
    template: Template,
    parameters: string[],
    buttonParameters: string[],
    scheduledAt: Date,
    headerMedia: TemplateHeaderMedia | null
  ) => {
    if (!conversationId || !phoneNumberDbId || !currentOrganization?.id || !conversation) {
      return { success: false, error: "Dados incompletos" };
    }

    const result = await scheduleTemplateMessage({
      conversationId,
      phoneNumberId: phoneNumberDbId,
      organizationId: currentOrganization.id,
      templateName: template.name,
      templateLanguage: template.language,
      templateComponents: template.components,
      bodyVariables: parameters,
      buttonVariables: buttonParameters,
      headerMedia,
      scheduledAt,
      contactPhone: conversation.contact_phone,
      contactName: conversation.contact_name || undefined,
    });

    return result;
  }, [conversationId, phoneNumberDbId, currentOrganization?.id, conversation, scheduleTemplateMessage]);

  // Handle edit message - wrapper for hook
  const handleEditMessage = async () => {
    if (!editingMessage || !editContent.trim() || isEditing) return;
    setIsEditing(true);
    const success = await editMessage(editingMessage.id, editContent.trim());
    if (success) {
      setEditingMessage(null);
      setEditContent("");
    }
    setIsEditing(false);
  };

  // Handle delete message - wrapper for hook
  const handleDeleteMessage = (message: Message) => {
    if (isDeleting) return;
    setMessageToDelete(message);
  };

  // Reenvio de MÍDIA falhada: sem re-upload — a edge function reenvia a partir
  // do media_url já no Storage e atualiza a MESMA linha (contrato retryMessageId).
  const retryMediaMessage = async (message: Message) => {
    if (!conversationId || !phoneNumberId) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error('Sessão expirada. Faça login novamente.');

      const formData = new FormData();
      formData.append('retryMessageId', message.id);
      formData.append('conversationId', conversationId);
      formData.append('phoneNumberId', phoneNumberId);

      const response = await postSendMedia(formData, accessToken);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao reenviar mídia');
      fetchMessages();
    } catch (error: unknown) {
      toast({
        title: 'Não foi possível reenviar a mídia',
        description: toUserMessage(error, 'Verifique a conexão e tente novamente.'),
        variant: 'destructive',
      });
    }
  };

  // Voto do painel numa enquete (QR): otimista na bolha; o realtime traz a
  // linha atualizada quando o RPC grava.
  const handlePollVote = useCallback(async (message: Message, options: string[]) => {
    try {
      const { data, error } = await supabase.functions.invoke('whatsapp-poll-vote', {
        body: { messageId: message.id, selectedOptions: options },
      });
      if (error || !data?.success) {
        let msg = data?.error || error?.message || 'Falha ao votar';
        const ctx = (error as { context?: Response } | null)?.context;
        if (ctx && typeof ctx.json === 'function') {
          try {
            const body = await ctx.json();
            if (body?.error) msg = body.error;
          } catch { /* corpo não-JSON */ }
        }
        throw new Error(msg);
      }
    } catch (error: unknown) {
      toast({
        title: 'Não foi possível registrar o voto',
        description: toUserMessage(error, 'Tente votar de novo em instantes.'),
        variant: 'destructive',
      });
      fetchMessages();
    }
  }, [toast, fetchMessages]);

  const confirmDeleteMessage = async () => {
    if (!messageToDelete || isDeleting) return;
    setIsDeleting(true);
    await deleteMessage(messageToDelete.id);
    setIsDeleting(false);
    setMessageToDelete(null);
  };

  // Handle react to message - wrapper for hook
  const handleReact = async (message: Message, emoji: string) => {
    await reactToMessage(message.id, emoji);
  };

  // Handle send template - wrapper for hook
  const handleSendTemplate = async (
    template: Template,
    parameters: string[],
    buttonParameters: string[] = [],
    headerMedia: TemplateHeaderMedia | null = null
  ) => {
    if (!conversationId || !conversation) return;

    await sendTemplate({
      template,
      parameters,
      buttonParameters,
      headerMedia,
      conversationId,
      contactPhone: conversation.contact_phone,
      userId,
      onOptimisticMessage: (msg) => setMessages((prev) => [...prev, msg]),
      onMessageUpdate: (tempId, updates) => setMessages((prev) =>
        prev.map((m) => m.id === tempId ? { ...m, ...updates } : m)
      ),
      onMessageRemove: (tempId) => setMessages((prev) => prev.filter((m) => m.id !== tempId)),
      // Sem onConversationUpdate pós-envio: o trigger do banco já emite o UPDATE
      // realtime em conversations, e o bump refazia o download da linha inteira.
      onSuccess: () => {
        fetchMessages();
      },
    });
  };

  // Handle send flow template - wrapper for hook
  const handleSendFlowTemplate = async () => {
    if (!selectedFlowTemplate || !conversationId || !conversation) return;

    await sendFlowTemplate({
      template: selectedFlowTemplate,
      bodyParameters: flowTemplateParams,
      conversationId,
      contactPhone: conversation.contact_phone,
      phoneNumberDbId,
      phoneNumberId,
      userId,
    });
  };

  // Acrescenta arquivos à seleção (append) e garante o dialog aberto.
  // `type` só vem nos fluxos de abertura (composer/menu de anexo); appends não mudam o modo.
  const appendMediaFiles = (incoming: File[], type?: 'image' | 'document') => {
    if (incoming.length === 0) return;
    const room = MAX_MEDIA_FILES - selectedFiles.length;
    if (room <= 0) {
      toast({
        title: `Limite de ${MAX_MEDIA_FILES} arquivos`,
        variant: "destructive",
      });
      return;
    }
    const files = incoming.slice(0, room);
    if (files.length < incoming.length) {
      toast({
        title: `Limite de ${MAX_MEDIA_FILES} arquivos`,
        description: "Alguns arquivos foram ignorados.",
      });
    }
    const previews = files.map(file =>
      file.type.startsWith('image/') || file.type.startsWith('video/')
        ? URL.createObjectURL(file)
        : '' // Empty string for documents (no preview)
    );
    // Mede já na escolha: a bolha pendente e a mensagem real nascem com a caixa final.
    files.forEach((f, i) => { if (previews[i]) void measureLocalMedia(f, previews[i]); });
    setSelectedFiles(prev => [...prev, ...files]);
    setMediaCaptions(prev => [...prev, ...files.map(() => "")]);
    setMediaPreviewUrls(prev => [...prev, ...previews]);
    mediaSendLockRef.current = false;
    if (type) setMediaType(type);
    setMediaDialogOpen(true);
  };

  // Caminho único de fechar/limpar o dialog de mídia (Cancelar, Esc, overlay, pós-envio).
  // No envio as prévias passam para a fila (que as revoga ao remover o item).
  const closeMediaDialog = ({ keepPreviews = false }: { keepPreviews?: boolean } = {}) => {
    setMediaDialogOpen(false);
    setPendingLightboxId(null);
    setSelectedFiles([]);
    setMediaCaptions([]);
    setCaptionIndex(0);
    setViewOnceEnabled(false);
    if (!keepPreviews) {
      mediaPreviewUrls.forEach(url => {
        if (url) URL.revokeObjectURL(url);
      });
    }
    setMediaPreviewUrls([]);
  };

  const setCaptionAt = (index: number, value: string) => {
    setMediaCaptions(prev => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const removeFileAt = (index: number) => {
    if (selectedFiles.length <= 1) {
      closeMediaDialog();
      return;
    }
    const url = mediaPreviewUrls[index];
    if (url) URL.revokeObjectURL(url);
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
    setMediaPreviewUrls(prev => prev.filter((_, i) => i !== index));
    setMediaCaptions(prev => prev.filter((_, i) => i !== index));
    setCaptionIndex(prev => Math.max(0, Math.min(prev > index ? prev - 1 : prev, selectedFiles.length - 2)));
  };

  const openAddMoreFilePicker = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    // Documento aceita qualquer arquivo (zip, rar, apk...), como o WhatsApp.
    if (mediaType === 'image') input.accept = 'image/*,video/*';
    input.onchange = () => {
      if (input.files?.length) appendMediaFiles(Array.from(input.files));
    };
    input.click();
  };

  // Handle file selection for media upload (supports multiple files)
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'document') => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setMediaCaptions([]);
    setCaptionIndex(0);
    appendMediaFiles(Array.from(files), type);

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Agendar os arquivos do dialog: mesmos campos do envio na hora (legenda por
  // arquivo, citação no primeiro, ver uma vez só no QR). Os arquivos sobem agora
  // e o agendador manda no horário, na ordem escolhida.
  const handleScheduleMedia = async (scheduledAt: Date) => {
    if (selectedFiles.length === 0 || !conversation || !conversationId || !phoneNumberDbId || !currentOrganization?.id) {
      return { success: false, error: "Dados incompletos" };
    }
    // Guarda síncrona: o clique duplo no mesmo frame subiria tudo duas vezes.
    if (schedulingFilesRef.current) return { success: false, error: "em andamento" };
    schedulingFilesRef.current = true;
    setSchedulingFiles(true);
    const conversaDoAgendamento = conversationId;
    const result = await scheduleMediaMessage({
      conversationId,
      phoneNumberId: phoneNumberDbId,
      organizationId: currentOrganization.id,
      scheduledAt,
      contactPhone: conversation.contact_phone,
      contactName: conversation.contact_name || undefined,
      quotedMessageId: activeReplyingTo?.id,
      files: selectedFiles.map((file, i) => {
        const isVisual = file.type.startsWith('image/') || file.type.startsWith('video/');
        const size = isVisual ? localMediaSize(file) : undefined;
        return {
          file,
          caption: mediaCaptions[i]?.trim() || undefined,
          width: size?.width,
          height: size?.height,
          viewOnce: viewOnceEnabled && isQrConnection && isVisual,
        };
      }),
    }).finally(() => {
      schedulingFilesRef.current = false;
      setSchedulingFiles(false);
    });
    if (result.success) {
      // Fecha sempre: aberto em outra conversa, "Enviar" mandaria para ela os arquivos já agendados.
      closeMediaDialog();
      // A citação é por conversa: só limpa a da conversa do agendamento.
      if (conversaDaCaixaRef.current === conversaDoAgendamento) setReplyingTo(null);
    }
    return result;
  };

  // Envio de mídia: cada arquivo vira um item da fila (src/lib/mediaUploadQueue.ts)
  // e aparece na conversa como bolha com progresso e X para cancelar. O dialog
  // fecha na hora: o atendente não fica preso esperando o upload.
  const handleSendMedia = () => {
    if (selectedFiles.length === 0 || !conversation || !conversationId || !phoneNumberId) return;
    if (mediaSendLockRef.current || schedulingFilesRef.current) return;
    mediaSendLockRef.current = true;

    const requests: UploadRequest[] = selectedFiles.map((file, i) => {
      const fields: Record<string, string> = {
        to: conversation.contact_phone,
        conversationId,
        userId,
        phoneNumberId,
      };
      // Legenda do PRÓPRIO arquivo (não mais só do primeiro)
      const caption = mediaCaptions[i]?.trim() ?? "";
      if (caption) fields.caption = caption;
      // Reply: cita só no primeiro arquivo (mesma regra da legenda)
      if (replyingTo && i === 0) fields.quotedMessageId = replyingTo.id;
      const size = localMediaSize(file);
      const isVisual = file.type.startsWith('image/') || file.type.startsWith('video/');
      if (size && isVisual) { fields.mediaWidth = String(size.width); fields.mediaHeight = String(size.height); }
      // Ver uma vez (QR; só imagem/vídeo)
      if (viewOnceEnabled && isQrConnection && (file.type.startsWith('image/') || file.type.startsWith('video/'))) {
        fields.viewOnce = 'true';
      }
      return { conversationId, file, previewUrl: mediaPreviewUrls[i] ?? '', caption, fields, mediaSize: isVisual ? size : undefined };
    });

    mediaUploadQueue.enqueue(requests, {
      onSent: (item) => {
        if (item.conversationId === conversaDaCaixaRef.current) fetchMessagesRef.current();
      },
      // A bolha falhada fica na conversa (tentar de novo / descartar); o toast
      // cobre quem já saiu dela.
      onFailed: (item) => {
        toast({
          title: "Não foi possível enviar o arquivo",
          description: `${item.file.name}: ${item.error ?? "tente de novo pela bolha na conversa."}`,
          variant: "destructive",
        });
      },
    });

    setReplyingTo(null);
    closeMediaDialog({ keepPreviews: true });
  };

  // Send audio message
  // Retorna false na falha: o AudioRecorder mantém o preview com o blob
  // intacto para "Tentar de novo" em vez de perder a gravação.
  const handleSendAudio = async (audioBlob: Blob): Promise<boolean> => {
    if (!conversation || !phoneNumberId) return false;

    if (!isValidAudioBlob(audioBlob)) {
      toast({
        title: "Áudio inválido",
        description: "A gravação não contém áudio válido. Tente gravar novamente.",
        variant: "destructive",
      });
      return false;
    }

    try {
      // Create a File from the Blob - use simple mimetype for storage compatibility
      const audioFile = new File([audioBlob], `audio_${Date.now()}.ogg`, {
        type: 'audio/ogg',
      });

      const formData = new FormData();
      formData.append('file', audioFile);
      formData.append('to', conversation.contact_phone);
      formData.append('conversationId', conversationId!);
      formData.append('userId', userId);
      formData.append('phoneNumberId', phoneNumberId);
      formData.append('isPtt', 'true'); // Flag as a voice note
      if (replyingTo) {
        formData.append('quotedMessageId', replyingTo.id);
      }

      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) {
        throw new Error('Sessão expirada. Faça login novamente para enviar áudio.');
      }

      const response = await postSendMedia(formData, accessToken);

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Erro ao enviar áudio');
      }

      toast({
        title: "Áudio enviado",
        description: "Mensagem de voz enviada com sucesso",
      });

      setReplyingTo(null);
      fetchMessages();
      return true;
    } catch (error: unknown) {
      console.error('[ChatArea] Error sending audio:', error);
      toast({
        title: "Não foi possível enviar o áudio",
        description: `${toUserMessage(error, "Verifique a conexão.")} A gravação foi mantida, tente enviar de novo.`,
        variant: "destructive",
      });
      return false;
    }
  };

  // Send a sticker from the user's collection. O front manda só o stickerId;
  // a edge function resolve a URL da coleção (sem re-upload) e roteia por canal.
  const handleSendSticker = async (sticker: UserSticker) => {
    if (!conversation || !phoneNumberId) return;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) {
        throw new Error('Sessão expirada. Faça login novamente para enviar figurinhas.');
      }

      const formData = new FormData();
      formData.append('stickerId', sticker.id);
      formData.append('to', conversation.contact_phone);
      formData.append('conversationId', conversationId!);
      formData.append('userId', userId);
      formData.append('phoneNumberId', phoneNumberId);
      if (replyingTo) {
        formData.append('quotedMessageId', replyingTo.id);
      }

      const response = await postSendMedia(formData, accessToken);

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao enviar figurinha');
      }

      touchLastUsed(sticker.id);
      setReplyingTo(null);
      fetchMessages();
    } catch (error: unknown) {
      console.error('[ChatArea] Error sending sticker:', error);
      toast({
        title: "Não foi possível enviar a figurinha",
        description: toUserMessage(error, "Verifique a conexão e tente novamente."),
        variant: "destructive",
      });
    }
  };

  // Composer: Ctrl+V com imagem(ns) abre o dialog com TODAS as imagens do clipboard
  const handlePaste = (e: React.ClipboardEvent) => {
    // Direct: só texto — imagem colada seguiria pelo envio de mídia do WhatsApp.
    if (soTexto) return;
    if (!e.clipboardData) return;
    const images = imageFilesFromClipboard(e.clipboardData);
    if (images.length === 0) return; // texto puro segue o paste normal

    e.preventDefault();
    setMediaCaptions([]);
    setCaptionIndex(0);
    appendMediaFiles(images, 'image');
  };

  // Dialog aberto: Ctrl+V ACRESCENTA à seleção, sem resetar legenda nem trocar mediaType
  const handleDialogPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!e.clipboardData) return;
    const images = imageFilesFromClipboard(e.clipboardData);
    if (images.length === 0) return; // deixa texto entrar na textarea de legenda

    e.preventDefault();
    appendMediaFiles(images);
  };

  // Janela de 24h: conta do envio mais recente do cliente (metadata.sent_at),
  // não da chegada — reentrega atrasada da Meta chega com a janela já fechada.
  // Card juntado: a janela é a do canal por onde a resposta vai.
  const mensagensDaJanela = useMemo(
    () => (temDirectNaConversa && !isDirect ? messages.filter((m) => mensagemDoDirect(m) === soTexto) : messages),
    [messages, temDirectNaConversa, isDirect, soTexto],
  );
  const windowExpiration = useMemo(() => {
    const lastInboundTime = latestInboundSentAt(mensagensDaJanela);

    if (!lastInboundTime) {
      // If no inbound messages, the window is not open (must use template)
      return {
        isExpired: true,
        timeRemaining: 0,
        expiresAt: new Date(),
      };
    }

    const expiresAt = addHours(lastInboundTime, 24);
    const now = new Date();
    const isExpired = isAfter(now, expiresAt);
    const timeRemaining = isExpired ? 0 : expiresAt.getTime() - now.getTime();

    return {
      isExpired,
      timeRemaining,
      expiresAt,
    };
  }, [mensagensDaJanela]);

  // Composer fechado pela janela: linha oficial (WhatsApp) ou Direct, que tem a
  // mesma regra de 24h mesmo numa linha QR.
  const janelaFechada = windowExpiration.isExpired && (!isFreeTextChannel || soTexto);

  // Grupo "só administradores enviam" com a linha como membro comum: o WhatsApp aceita e
  // descarta em silêncio (1 check para sempre). Fecha a caixa como a janela de 24h.
  // Bloqueia só com certeza positiva (regra em src/lib/groupSelfRole.ts); carregando = aberto.
  const soAdminsEnviam = Boolean(
    conversation?.is_group &&
      isQrConnection &&
      groupMeta &&
      !resolveGroupSendPermission({ ...groupMeta, participants: rawGroupParticipants }, null).allowed
  );
  const composerFechado = janelaFechada || soAdminsEnviam;

  // Drag & drop de arquivos direto no chat → dialog de mídia (appendMediaFiles)
  const { isDraggingOver, dragHandlers } = useDragDropFiles({
    enabled: Boolean(
      conversation && phoneNumberId && !composerFechado && !soTexto
    ),
    onDropFiles: (files) => {
      const type = files[0]?.type.startsWith('image/') || files[0]?.type.startsWith('video/')
        ? 'image' as const
        : 'document' as const;
      appendMediaFiles(files, type);
    },
  });


  // Format expiration time for display
  const formatExpirationTime = (expiration: { isExpired: boolean; timeRemaining: number; expiresAt: Date }) => {
    if (expiration.isExpired) {
      return "Expirado";
    }

    const { expiresAt } = expiration;
    const now = new Date();
    const timeStr = format(expiresAt, "HH:mm", { locale: ptBR });

    if (isSameDay(expiresAt, now)) {
      return `Hoje às ${timeStr}`;
    } else if (isTomorrow(expiresAt)) {
      return `Amanhã às ${timeStr}`;
    } else {
      return format(expiresAt, "dd/MM 'às' HH:mm", { locale: ptBR });
    }
  };

  if (!conversationId) {
    return (
      <div className="theme-empty-chat flex-1 flex items-center justify-center bg-muted/20">
        <div className="text-center">
          <MessageCircle className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
          <p className="text-lg font-medium text-muted-foreground">
            Selecione uma conversa
          </p>
          <p className="text-sm text-muted-foreground">
            Escolha uma conversa na lista ao lado para começar
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex-1 flex min-w-0 ${isMobile ? 'h-dvh' : ''}`}
      style={
        isMobile && visualHeight !== null
          ? // flex: none é obrigatório: com flex-1 (basis 0%) o height inline
            // era IGNORADO pelo algoritmo de flex e o fix do teclado iOS era no-op.
            { height: `${visualHeight}px`, flex: "none" }
          : undefined
      }
      {...dragHandlers}
    >
    <div className="flex-1 flex flex-col relative min-w-0">
      {/* Overlay de drag & drop de arquivos */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary rounded-lg m-2 pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Image className="w-10 h-10" />
            <p className="text-sm font-medium">Solte para enviar</p>
          </div>
        </div>
      )}
      {conversation ? (
        selectionMode ? (
        <MessageSelectionBar
          count={selectedIds.size}
          isMobile={isMobile}
          onCancel={exitSelection}
          onForward={() => setForwardBatchOpen(true)}
        />
        ) : (
        <ChatHeader
          conversation={conversation}
          isMobile={isMobile}
          isQrConnection={isQrConnection}
          isFreeTextChannel={isFreeTextChannel && !soTexto}
          numeroNome={numeroNome}
          numeroHue={numeroHue}
          isUpdating={isUpdating}
          onMobileBack={onMobileBack}
          isEditingName={isEditingName}
          editNameValue={editNameValue}
          setEditNameValue={setEditNameValue}
          editNameInputRef={editNameInputRef}
          isSavingName={isSavingName}
          startEditName={startEditName}
          saveContactName={saveContactName}
          cancelEditName={cancelEditName}
          isEditingPhone={isEditingPhone}
          editPhoneValue={editPhoneValue}
          setEditPhoneValue={setEditPhoneValue}
          editPhoneInputRef={editPhoneInputRef}
          isSavingPhone={isSavingPhone}
          startEditPhone={startEditPhone}
          saveContactPhone={saveContactPhone}
          cancelEditPhone={cancelEditPhone}
          searchOpen={searchOpen}
          onOpenSearch={handleOpenSearch}
          onCloseSearch={handleCloseSearch}
          onStartCall={canVoiceCall && conversation && !isDirect ? () => startCall(conversation.contact_phone, conversation.contact_name || conversation.contact_phone) : undefined}
          callBlockedReason={callBlockedReason}
          onAssign={podeAssumir ? () => resolveAndAssign(contextConversation.id) : undefined}
          isAssigning={assigningId !== null}
          onTransfer={() => setTransferDialogOpen(true)}
          onClose={() => setCloseDialogOpen(true)}
          onGroupInfo={() => setGroupInfoOpen(true)}
          sectorIsolationEnabled={sectorIsolationEnabled}
          currentSectorName={currentSectorId ? sectorsById.get(currentSectorId)?.name ?? null : null}
          // "Só quem assumiu vê": o setor é a pessoa, e encaminhar deixaria a conversa
          // sem dono na fila dela (o banco a devolve para todos). Quem passa é o Transferir.
          onForwardToSector={setorSegueDono ? undefined : () => setForwardSectorOpen(true)}
          userIsPrimary={userIsPrimary}
          userIsCoOwner={userIsCoOwner}
          coOwners={coOwnerIds}
          onShare={() => setShareDialogOpen(true)}
          onLeaveShared={handleLeaveSharedConversation}
          windowExpiration={windowExpiration}
          formatExpirationTime={formatExpirationTime}
          actionButtons={isDirect ? [] : actionButtons}
          onActionButtonClick={handleActionButtonClick}
          loadingButtonId={loadingButtonId}
          onRefetchHistory={refetchHistory}
          isRefetchingHistory={isRefetchingHistory}
          onOpenProfile={toggleProfile}
          profileOpen={profileOpen}
        />
        )
      ) : conversationId ? (
        // Placeholder com a MESMA geometria do ChatHeader (mobile h-14 / desktop
        // p-4 + avatar 56px): o header nunca desmonta nem muda de altura durante
        // o fetch — só acontece em deep-link, quando a lista ainda não tem seed.
        isMobile ? (
          <header className="theme-chat-header sticky top-0 z-40 bg-background/95 backdrop-blur border-b border-border safe-area-top">
            <div className="flex items-center h-14 px-2 gap-2">
              <div className="w-9 h-9 rounded-full bg-muted animate-pulse shrink-0" />
              <div className="flex flex-col gap-1.5">
                <div className="h-3.5 w-32 rounded bg-muted animate-pulse" />
                <div className="h-3 w-24 rounded bg-muted animate-pulse" />
              </div>
            </div>
          </header>
        ) : (
          <div className="theme-chat-header border-b bg-card p-4 flex items-center gap-3">
            <div className="w-14 h-14 rounded-full bg-muted animate-pulse shrink-0" />
            <div className="flex flex-col gap-2">
              <div className="h-4 w-40 rounded bg-muted animate-pulse" />
              <div className="h-3 w-28 rounded bg-muted animate-pulse" />
            </div>
          </div>
        )
      ) : null}
      {/* Search bar */}
      {searchOpen && (
        <div className="border-b px-4 py-2 flex items-center gap-2 bg-muted/50">
          <Search className="w-4 h-4 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Pesquisar mensagens…"
            aria-label="Pesquisar mensagens"
            className="h-8 flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) {
                  handleSearchPrev();
                } else {
                  handleSearchNext();
                }
              }
              if (e.key === 'Escape') {
                handleCloseSearch();
              }
            }}
          />
          <MessageSearchFilters
            filters={searchFilters}
            onFiltersChange={updateSearchFilters}
            onReset={resetSearchFilters}
            hasActiveFilters={hasActiveFilters}
            activeFilterCount={activeFilterCount}
            isGroup={conversation?.is_group ?? false}
            participants={searchParticipants}
          />
          {isFetchingAll ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground whitespace-nowrap">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Carregando histórico…
            </span>
          ) : (
            <>
              {searchResults.length > 0 && (
                <span className="text-sm text-muted-foreground whitespace-nowrap" aria-live="polite">
                  {currentSearchIndex + 1} de {searchResults.length}
                </span>
              )}
              {(searchTerm || hasActiveFilters) && searchResults.length === 0 && (
                <span className="text-sm text-muted-foreground whitespace-nowrap" aria-live="polite">
                  Nenhum resultado
                </span>
              )}
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSearchPrev}
            disabled={searchResults.length === 0}
            className="h-8 w-8 p-0"
            title="Anterior (Shift+Enter)"
            aria-label="Resultado anterior (Shift+Enter)"
          >
            <ChevronUp className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSearchNext}
            disabled={searchResults.length === 0}
            className="h-8 w-8 p-0"
            title="Próximo (Enter)"
            aria-label="Próximo resultado (Enter)"
          >
            <ChevronDown className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCloseSearch}
            className="h-8 w-8 p-0"
            title="Fechar pesquisa (Esc)"
            aria-label="Fechar pesquisa (Esc)"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}
      <MessageList
        ref={messageListRef}
        conversationId={conversationId}
        messages={messages}
        notes={notes}
        conversation={conversation}
        isQrConnection={isQrConnection}
        participantLookup={participantLookup}
        groupParticipants={pollParticipants}
        searchTerm={searchTerm}
        searchResults={searchResults}
        currentSearchIndex={currentSearchIndex}
        highlightedMessageId={highlightedMessageId}
        isMobile={isMobile}
        isLoading={messagesLoading}
        isLoadingMore={isLoadingMore}
        hasMore={hasMore}
        onLoadMore={loadMore}
        onReply={handleReply}
        // Encaminhar não abre mais o modal direto: entra no modo de seleção já
        // com esta mensagem marcada, e o envio sai do botão da barra.
        onForward={enterSelection}
        selectionMode={selectionMode}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        onEdit={(message) => {
          if (isDirect || mensagemDoDirect(message)) {
            toast({ title: "Direct", description: "O Instagram não deixa editar mensagem enviada pelo Echo." });
            return;
          }
          setEditingMessage(message);
          setEditContent(message.content || "");
        }}
        onDelete={(message) => {
          if (isDirect || mensagemDoDirect(message)) {
            toast({ title: "Direct", description: "O Instagram não deixa apagar mensagem enviada pelo Echo." });
            return;
          }
          handleDeleteMessage(message);
        }}
        onReact={handleReact}
        reactionsEnabled={!isDirect && Boolean(isQrConnection || !isFreeTextChannel)}
        mostrarCanal={temDirectNaConversa && !isDirect}
        reactionsByMessage={reactionsByMessage}
        onOpenLightbox={openLightbox}
        onPollVote={isQrConnection ? handlePollVote : undefined}
        onRetry={(message) =>
          message.media_url ? void retryMediaMessage(message) : retryMessage(message.id)
        }
        onDiscard={(message) => discardMessage(message.id)}
        onQuotedClick={handleQuotedClick}
        onDeleteNote={deleteNote}
        onSaveSticker={(message) => {
          if (message.media_url) void saveStickerFromUrl(message.media_url);
        }}
        typing={typingIndicator}
        onNavigateToConversation={onNavigateToConversation}
        onAtBottom={handleAtBottom}
        unreadDivider={unreadDivider}
      />

      {/* Scroll to bottom button — com contador de novas enquanto rolado p/ cima */}
      {showScrollButton && (
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded-full shadow-lg z-10 h-10 w-10"
          onClick={() => {
            setNewWhileUpCount(0);
            scrollToBottom("smooth");
          }}
          aria-label={
            newWhileUpCount > 0
              ? `${newWhileUpCount} nova${newWhileUpCount > 1 ? "s" : ""} mensagem${newWhileUpCount > 1 ? "s" : ""} — rolar para o fim`
              : "Rolar para a mensagem mais recente"
          }
        >
          <ChevronDown className="w-5 h-5" />
          {newWhileUpCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-5 h-5 px-1 rounded-full bg-primary text-primary-foreground text-2xs font-medium tabular-nums">
              {newWhileUpCount > 99 ? "99+" : newWhileUpCount}
            </span>
          )}
        </Button>
      )}

      {/* Agendadas pendentes desta conversa — ver, editar, enviar agora */}
      {conversationId && (
        <ScheduledMessagesBanner
          key={conversationId}
          messages={scheduledMessages}
          onSendNow={(m) => sendScheduledMessageNow(m.id)}
          onEdit={updateScheduledMessage}
          onCancel={cancelScheduledMessage}
        />
      )}

      {/* Copiloto: sugere respostas para a última fala do cliente. Só aparece para
          quem ligou em Configurações > Perfil; o chip insere no composer, não envia. */}
      {!composerFechado && (
        <CopilotoDaConversa
          conversationId={conversationId}
          userId={userId}
          messages={messages}
          onInserir={(texto) => inserirNoComposer(texto, conversationId ?? "") === "inserida"}
          compacta={isMobile}
        />
      )}

      {/* Reply Preview - shows above input when replying */}
      {activeReplyingTo && (
        <ReplyPreview
          message={activeReplyingTo}
          onCancel={() => setReplyingTo(null)}
        />
      )}

      <form
        onSubmit={(e) => e.preventDefault()}
        className="theme-chat-input border-t bg-card p-2 md:p-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        {/* Direct sem telefone: liga ao WhatsApp do contato (conversa única). */}
        {isDirect && conversation && (
          <JuntarAoWhatsApp
            conversationId={conversation.id}
            sugestao={telefoneSugerido(messages)}
            onJuntada={(conversaQueFica) => {
              if (conversaQueFica !== conversation.id) onOpenConversation?.(conversaQueFica);
              else void fetchConversation();
            }}
          />
        )}
        {/* Card juntado: diz por onde a resposta vai (canal da última mensagem do contato). */}
        {temDirectNaConversa && !isDirect && !composerFechado && (
          <p className="pb-1 text-xs text-muted-foreground">
            Resposta vai pelo {soTexto ? "Direct" : "WhatsApp"}
          </p>
        )}
        <div className="flex gap-2 items-center">
          {recordingState === 'idle' && (
            <>
              {/* Mobile: o botão de emoji vive no menu "+" (5 botões fixos
                  deixavam ~90px para digitar em 360px) e abre um Drawer.
                  Janela de 24h expirada: o ChatInput desmonta, o botão viraria
                  um alvo morto — some junto. */}
              {!isMobile && !composerFechado && (
                <EmojiPicker
                  onEmojiSelect={(emoji) => chatInputRef.current?.addText(emoji)}
                />
              )}

              {/* Figurinhas — no business_api respeita a janela de 24h, que o
                  resto do composer só aplica na área de texto. */}
              {!composerFechado && !soTexto && (
                  <StickerPicker
                    stickers={stickers}
                    isLoading={stickersLoading}
                    isConverting={stickerConverting}
                    isSaving={stickerSaving}
                    requireMetaCompliant={!isQrConnection}
                    onOpen={fetchStickers}
                    onSelect={handleSendSticker}
                    onConvert={convertToSticker}
                    onConfirmUpload={(blob) => saveStickerBlob(blob, 'upload')}
                    onRemove={removeSticker}
                  />
                )}

              {/* Unified + Menu */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Anexos e opções"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  {/* Note - Always visible */}
                  <DropdownMenuItem
                    onClick={() => setNoteOpen(true)}
                    className="cursor-pointer"
                  >
                    <StickyNote className="w-4 h-4 mr-3" />
                    Nota
                  </DropdownMenuItem>

                  {/* Templates - Only for API connections (not QR) */}
                  {!isFreeTextChannel && !soTexto && (
                    <DropdownMenuItem
                      onClick={() => {
                        fetchTemplates();
                        setTemplatesOpen(true);
                      }}
                      className="cursor-pointer"
                    >
                      <LayoutTemplate className="w-4 h-4 mr-3" />
                      Templates
                    </DropdownMenuItem>
                  )}

                  {/* Flows option temporarily disabled
                  {!isQrConnection && (
                    <DropdownMenuItem
                      onClick={() => {
                        fetchFlowTemplates();
                        setFlowTemplatesOpen(true);
                      }}
                      className="cursor-pointer"
                    >
                      <Workflow className="w-4 h-4 mr-3" />
                      Flows
                    </DropdownMenuItem>
                  )}
                  */}

                  {/* Emoji no mobile: item do menu (a fileira do composer não
                      comporta mais um botão fixo em 360px) */}
                  {isMobile && !composerFechado && (
                    <DropdownMenuItem
                      onClick={() => setEmojiDrawerOpen(true)}
                      className="cursor-pointer"
                    >
                      <Smile className="w-4 h-4 mr-3" />
                      Emoji
                    </DropdownMenuItem>
                  )}

                  {/* Documento e Foto/Vídeo — no business_api respeitam a
                      janela de 24h (a Meta rejeita mídia fora dela; só
                      template reabre). Nota e Modelos seguem sempre visíveis. */}
                  {!composerFechado && !soTexto && (
                    <>
                      {/* Documento: qualquer tipo de arquivo, como o WhatsApp (sem
                          `accept`). Arquivo de áudio (mp3 etc.) viaja como áudio
                          comum, não nota de voz (sem isPtt) */}
                      <DropdownMenuItem
                        onClick={() => {
                          const input = document.createElement('input');
                          input.type = 'file';
                          input.multiple = true;
                          input.onchange = (e) => handleFileSelect(e as unknown as React.ChangeEvent<HTMLInputElement>, 'document');
                          input.click();
                        }}
                        className="cursor-pointer"
                      >
                        <FileText className="w-4 h-4 mr-3" />
                        Documento e Áudio
                      </DropdownMenuItem>

                      {/* Photo/Video */}
                      <DropdownMenuItem
                        onClick={() => {
                          const input = document.createElement('input');
                          input.type = 'file';
                          input.accept = 'image/*,video/*';
                          input.multiple = true;
                          input.onchange = (e) => handleFileSelect(e as unknown as React.ChangeEvent<HTMLInputElement>, 'image');
                          input.click();
                        }}
                        className="cursor-pointer"
                      >
                        <Image className="w-4 h-4 mr-3" />
                        Foto e Vídeo
                      </DropdownMenuItem>
                    </>
                  )}

                  {/* Contact — ambos os canais (a Cloud API aceita type:contacts);
                      no business_api respeita a janela de 24h como as demais mídias */}
                  {!composerFechado && !soTexto && (
                    <DropdownMenuItem
                      onClick={() => setContactPickerOpen(true)}
                      className="cursor-pointer"
                    >
                      <UserCircle className="w-4 h-4 mr-3" />
                      Contato
                    </DropdownMenuItem>
                  )}

                  {/* Localização — ambos os canais (Baileys locationMessage / CA type:location) */}
                  {!composerFechado && !soTexto && (
                    <DropdownMenuItem
                      onClick={() => setLocationPickerOpen(true)}
                      className="cursor-pointer"
                    >
                      <MapPin className="w-4 h-4 mr-3" />
                      Localização
                    </DropdownMenuItem>
                  )}

                  {/* Enquete — só QR (a Cloud API não envia poll) */}
                  {isQrConnection && !soTexto && (
                    <DropdownMenuItem
                      onClick={() => setPollDialogOpen(true)}
                      className="cursor-pointer"
                    >
                      <BarChart3 className="w-4 h-4 mr-3" />
                      Enquete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          {/* Note Dialog */}
          <NoteDialog
            open={noteOpen}
            onOpenChange={setNoteOpen}
            noteContent={noteContent}
            setNoteContent={setNoteContent}
            onSubmit={handleNoteSubmit}
            isLoading={noteLoading}
          />

          {/* Edit Message Dialog */}
          <Dialog
            open={!!editingMessage}
            onOpenChange={(open) => {
              if (!open) {
                setEditingMessage(null);
                setEditContent("");
              }
            }}
          >
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Editar mensagem</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <Textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  placeholder="Digite o novo conteúdo…"
                  className="min-h-[100px] resize-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.ctrlKey) {
                      e.preventDefault();
                      handleEditMessage();
                    }
                  }}
                />
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">
                    Ctrl+Enter para salvar
                  </span>
                  <Button
                    size="sm"
                    onClick={handleEditMessage}
                    disabled={isEditing || !editContent.trim()}
                  >
                    {isEditing ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-1" />
                    ) : (
                      <Send className="w-4 h-4 mr-1" />
                    )}
                    Salvar
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* Media Preview Dialog */}
          <Dialog
            open={mediaDialogOpen}
            onOpenChange={(open) => {
              if (!open && !schedulingFilesRef.current) closeMediaDialog();
            }}
          >
            <DialogContent className="sm:max-w-md overflow-hidden" onPaste={handleDialogPaste}>
              <DialogHeader>
                <DialogTitle>
                  {mediaType === 'image' ? 'Enviar Foto/Vídeo' : 'Enviar Documento'}
                  {selectedFiles.length > 1 && ` (${selectedFiles.length} arquivos)`}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4 overflow-hidden">
                {/* Preview - Single file */}
                {selectedFiles.length === 1 && (
                  <>
                    {mediaPreviewUrls[0] && selectedFiles[0]?.type.startsWith('image/') && (
                      <div className="flex justify-center">
                        <button
                          type="button"
                          onClick={() => setPendingLightboxId('0')}
                          aria-label="Ampliar imagem"
                          className="rounded-lg cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <img
                            src={mediaPreviewUrls[0]}
                            alt="Preview"
                            className="max-w-full max-h-[200px] rounded-lg object-contain"
                          />
                        </button>
                      </div>
                    )}
                    {mediaPreviewUrls[0] && selectedFiles[0]?.type.startsWith('video/') && (
                      <div className="flex justify-center">
                        <video
                          src={mediaPreviewUrls[0]}
                          controls
                          className="max-w-full max-h-[200px] rounded-lg"
                        />
                      </div>
                    )}
                    {selectedFiles[0] && !mediaPreviewUrls[0] && (
                      <div className="flex items-center gap-3 p-4 bg-muted rounded-lg">
                        <FileText className="w-10 h-10 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate" title={selectedFiles[0].name}>{selectedFiles[0].name}</p>
                          <p className="text-sm text-muted-foreground">
                            {(selectedFiles[0].size / 1024 / 1024).toFixed(2)} MB
                          </p>
                        </div>
                      </div>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full border-dashed text-muted-foreground"
                      onClick={openAddMoreFilePicker}
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Adicionar mais
                    </Button>
                  </>
                )}

                {/* Preview - Multiple files */}
                {selectedFiles.length > 1 && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-2 max-h-[200px] overflow-y-auto">
                      {selectedFiles.map((file, index) => (
                        <div
                          key={index}
                          className={cn(
                            "relative rounded-lg cursor-pointer",
                            index === captionIndex && "ring-2 ring-primary ring-offset-1",
                            mediaPreviewUrls[index] && /^(image|video)\//.test(file.type) && "cursor-zoom-in"
                          )}
                          // Um clique escolhe a legenda em edição E abre o
                          // arquivo no lightbox (documento só escolhe a legenda).
                          onClick={() => {
                            setCaptionIndex(index);
                            if (pendingMedia.some(item => item.messageId === String(index))) {
                              setPendingLightboxId(String(index));
                            }
                          }}
                        >
                          {mediaCaptions[index]?.trim() && (
                            <span
                              className="absolute bottom-1 left-1 z-10 rounded-full bg-foreground/70 text-background p-0.5"
                              title="Este arquivo tem legenda"
                            >
                              <Pencil className="w-3 h-3" />
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); removeFileAt(index); }}
                            aria-label={`Remover ${file.name}`}
                            className="absolute top-1 right-1 z-10 rounded-full bg-foreground/70 text-background p-0.5 hover:bg-foreground disabled:opacity-50"
                          >
                            <X className="w-3 h-3" />
                          </button>
                          {mediaPreviewUrls[index] && file.type.startsWith('image/') ? (
                            <img
                              src={mediaPreviewUrls[index]}
                              alt={`Preview ${index + 1}`}
                              className="w-full h-20 object-cover rounded-lg"
                            />
                          ) : mediaPreviewUrls[index] && file.type.startsWith('video/') ? (
                            <div className="w-full h-20 bg-muted rounded-lg flex items-center justify-center">
                              <span className="text-xs text-muted-foreground">Vídeo</span>
                            </div>
                          ) : (
                            <div className="w-full h-20 bg-muted rounded-lg flex flex-col items-center justify-center p-1">
                              <FileText className="w-6 h-6 text-muted-foreground" />
                              <span className="text-2xs text-muted-foreground truncate w-full text-center">
                                {file.name.length > 12 ? file.name.slice(0, 12) + '…' : file.name}
                              </span>
                            </div>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={openAddMoreFilePicker}
                        aria-label="Adicionar mais arquivos"
                        className="w-full h-20 rounded-lg border-2 border-dashed border-muted-foreground/40 flex items-center justify-center text-muted-foreground hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
                      >
                        <Plus className="w-6 h-6" />
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground text-center">
                      {selectedFiles.length} arquivos selecionados •{' '}
                      {(selectedFiles.reduce((acc, f) => acc + f.size, 0) / 1024 / 1024).toFixed(2)} MB total
                    </p>
                  </div>
                )}

                {mediaType === 'image' && (
                  <p className="text-xs text-muted-foreground text-center">
                    Dica: Ctrl+V cola mais imagens
                  </p>
                )}

                {/* Caption input */}
                <div>
                  <Textarea
                    ref={captionRef}
                    value={mediaCaptions[captionIndex] ?? ""}
                    onChange={(e) => setCaptionAt(captionIndex, e.target.value)}
                    placeholder={
                      selectedFiles.length > 1
                        ? `Legenda do arquivo ${captionIndex + 1} (selecione uma miniatura para trocar)`
                        : "Adicionar legenda (opcional)"
                    }
                    rows={2}
                    className="resize-none"
                  />
                </div>

                {/* Ver uma vez (só QR e só imagem/vídeo) + emojis da legenda */}
                <div className="flex items-center gap-2">
                  {isQrConnection && selectedFiles.some(f => f.type.startsWith('image/') || f.type.startsWith('video/')) && (
                    <button
                      type="button"
                      onClick={() => setViewOnceEnabled(v => !v)}
                      className={cn(
                        "flex items-center gap-2 text-xs rounded-md border px-2.5 py-1.5 transition-colors",
                        viewOnceEnabled
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:border-primary/50"
                      )}
                      aria-pressed={viewOnceEnabled}
                    >
                      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-current text-2xs leading-none">1</span>
                      Ver uma vez
                    </button>
                  )}
                  <div className="ml-auto">
                    <EmojiPicker
                      variant={isMobile ? "drawer" : "popover"}
                      onEmojiSelect={(emoji) =>
                        insertIntoField(
                          captionRef.current,
                          mediaCaptions[captionIndex] ?? "",
                          emoji,
                          (next) => setCaptionAt(captionIndex, next)
                        )
                      }
                    />
                  </div>
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => closeMediaDialog()}
                    disabled={schedulingFiles}
                  >
                    Cancelar
                  </Button>
                  {!soTexto && (
                    <ScheduleMessagePopover
                      onSchedule={handleScheduleMedia}
                      disabled={selectedFiles.length === 0 || isScheduling || schedulingFiles}
                      description={
                        selectedFiles.length > 1
                          ? "Os arquivos serão enviados no horário escolhido, nesta ordem, com as legendas."
                          : "O arquivo será enviado no horário escolhido, com a legenda."
                      }
                      trigger={
                        <Button type="button" variant="outline">
                          <Clock className="w-4 h-4 mr-2" />
                          Agendar
                        </Button>
                      }
                    />
                  )}
                  <Button
                    onClick={handleSendMedia}
                    disabled={selectedFiles.length === 0 || schedulingFiles}
                  >
                    <Send className="w-4 h-4 mr-2" />
                    {selectedFiles.length > 1 ? `Enviar ${selectedFiles.length}` : 'Enviar'}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* Template Selector (Templates Sheet + Flow Templates Sheet + Flow Template Dialog) */}
          <TemplateSelector
            templates={templates}
            loadingTemplates={loadingTemplates}
            templatesOpen={templatesOpen}
            setTemplatesOpen={setTemplatesOpen}
            templateSearch={templateSearch}
            setTemplateSearch={setTemplateSearch}
            selectTemplate={selectTemplate}
            getVariableCount={getVariableCount}
            onCreateTemplate={openTemplateCreator}
            createNotice={templateCreation.notice}
            flowTemplates={flowTemplates}
            loadingFlowTemplates={loadingFlowTemplates}
            flowTemplatesOpen={flowTemplatesOpen}
            setFlowTemplatesOpen={setFlowTemplatesOpen}
            flowTemplateSearch={flowTemplateSearch}
            setFlowTemplateSearch={setFlowTemplateSearch}
            selectFlowTemplate={selectFlowTemplate}
            selectedFlowTemplate={selectedFlowTemplate}
            flowTemplateDialogOpen={flowTemplateDialogOpen}
            closeFlowTemplateDialog={closeFlowTemplateDialog}
            flowTemplateParams={flowTemplateParams}
            setFlowTemplateParams={setFlowTemplateParams}
            getTemplatePreview={getTemplatePreview}
            onSendFlowTemplate={handleSendFlowTemplate}
          />

          {janelaFechada ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground bg-muted/50 rounded-md px-4 py-2">
              <Clock className="w-4 h-4 mr-2" />
              {isDirect
                ? "Janela de 24h do Direct fechada. Para responder agora, use o app do Instagram. Aqui volta a dar quando a pessoa escrever de novo."
                : (
                  <>
                    Janela de 24h fechada. Para falar com o cliente agora, envie um template (mensagem aprovada).
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto px-1.5 py-0"
                      onClick={() => {
                        fetchTemplates();
                        setTemplatesOpen(true);
                      }}
                    >
                      Escolher template
                    </Button>
                  </>
                )}
            </div>
          ) : soAdminsEnviam ? (
            <div className="flex-1 flex items-center justify-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-md px-4 py-2">
              <Lock className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Só administradores enviam mensagens neste grupo. Peça a um admin para tornar este número administrador ou liberar o envio para todos.</span>
              <Button variant="ghost" size="sm" className="shrink-0" onClick={refetchGroupMeta}>Conferir de novo</Button>
            </div>
          ) : (
            <>
              {/* Stable container for ChatInput and AudioRecorder */}
              <div className="flex-1 flex gap-2 items-center">
                {recordingState === 'idle' && (
                  <ChatInput
                    key={conversationId}
                    ref={chatInputRef}
                    onSubmit={handleSendFromChatInput}
                    onPaste={handlePaste}
                    onMessageChange={setHasMessageContent}
                    initialValue={conversationId ? getDraft(conversationId) : ""}
                    onValueChange={handleDraftChange}
                    disabled={!isOnline}
                    placeholder={isOnline ? "Digite sua mensagem…" : "Sem conexão…"}
                    quotedMessageId={activeReplyingTo?.id}
                    isGroupChat={conversation?.is_group}
                    isQrConnection={isQrConnection}
                    groupParticipants={groupParticipants}
                    isMobile={isMobile}
                    phoneNumberDbId={phoneNumberDbId ?? null}
                  />
                )}

                {/* Mobile: mic e enviar alternam no MESMO slot (padrão WhatsApp) —
                    mic sem texto, agendar+enviar com texto. Desktop: tudo visível. */}
                {!soTexto && (!isMobile || !hasMessageContent || recordingState !== 'idle') && (
                  <div className={recordingState !== 'idle' ? "flex-1 flex justify-center" : "flex items-center"}>
                    <AudioRecorder
                      onSend={handleSendAudio}
                      onStateChange={setRecordingState}
                    />
                  </div>
                )}
              </div>

              {recordingState === 'idle' && (
                <>
                  {!soTexto && (!isMobile || hasMessageContent) && (
                    <ScheduleMessagePopover
                      onSchedule={handleScheduleMessage}
                      disabled={!hasMessageContent || isScheduling}
                    />
                  )}
                  {(!isMobile || hasMessageContent || soTexto) && (
                    <Button
                      type="button"
                      onClick={() => chatInputRef.current?.submit()}
                      disabled={!hasMessageContent}
                      size="icon"
                      aria-label="Enviar mensagem"
                      className="rounded-full h-10 w-10 shrink-0 bg-primary hover:bg-primary/90 text-white shadow-sm"
                    >
                      {/* translate-x-px: a massa do avião fica à esquerda — nudge óptico */}
                      <Send className="w-5 h-5 translate-x-px" />
                    </Button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </form>

      {templateCreation.dialog}

      <TemplateDialog
        template={selectedTemplate}
        open={templateDialogOpen}
        onOpenChange={(open) => !open && closeTemplateDialog()}
        onSend={handleSendTemplate}
        onSchedule={handleScheduleTemplate}
      />

      <CloseConversationDialog
        open={closeDialogOpen}
        onOpenChange={setCloseDialogOpen}
        onConfirm={handleCloseConversation}
        isLoading={isUpdating}
        conversationPhoneNumberId={phoneNumberDbId}
      />

      <TransferConversationDialog
        open={transferDialogOpen}
        onOpenChange={setTransferDialogOpen}
        onTransfer={handleTransferConversation}
        onRelease={handleReleaseConversation}
        currentUserId={userId}
        conversationPhoneNumberId={phoneNumberDbId}
      />

      <SectorPickerDialog
        open={forwardSectorOpen}
        onOpenChange={setForwardSectorOpen}
        title="Encaminhar para setor"
        description="A conversa vai para a fila do setor escolhido e você continua acompanhando como co-proprietário. Fica registrado em nota quem encaminhou."
        sectors={sectorsForLine}
        currentSectorId={currentSectorId}
        confirmLabel="Encaminhar para o setor"
        pending={isUpdating}
        onConfirm={handleForwardToSector}
      />

      {/* Assumir em qual setor (cabeçalho, linha com isolamento e setor ambíguo) */}
      {dialogoDeSetor}

      <ShareConversationDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        currentUserId={userId}
        conversationPhoneNumberId={phoneNumberDbId}
        primaryAssigneeId={primaryAssigneeId}
        coOwnerIds={coOwnerIds}
        onAddCoOwner={handleAddCoOwner}
        onRemoveCoOwner={handleRemoveCoOwner}
      />

      {conversation && conversationId && (
        <ImportHistoryDialog
          open={importHistoryOpen}
          onOpenChange={setImportHistoryOpen}
          conversationId={conversationId}
          conversationContactPhone={conversation.contact_phone}
          isGroup={!!conversation.is_group}
          userId={userId}
          onImported={fetchMessages}
        />
      )}

      {/* Mobile Edit Name Dialog */}
      {isMobile && (
        <Dialog open={isEditingName} onOpenChange={(open) => { if (!open) cancelEditName(); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Editar nome do contato</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <Input
                value={editNameValue}
                onChange={(e) => setEditNameValue(e.target.value)}
                placeholder="Nome do contato"
                disabled={isSavingName}
                autoFocus
              />
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={cancelEditName}
                  disabled={isSavingName}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={saveContactName}
                  disabled={isSavingName || !editNameValue.trim()}
                >
                  {isSavingName ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Salvar
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Mobile Edit Phone Dialog */}
      {isMobile && (
        <Dialog open={isEditingPhone} onOpenChange={(open) => { if (!open) cancelEditPhone(); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Editar número do contato</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <Input
                value={editPhoneValue}
                onChange={(e) => setEditPhoneValue(e.target.value)}
                placeholder="Número do contato"
                disabled={isSavingPhone}
                autoFocus
              />
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={cancelEditPhone}
                  disabled={isSavingPhone}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={saveContactPhone}
                  disabled={isSavingPhone || !editPhoneValue.trim()}
                >
                  {isSavingPhone ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Salvar
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Group Info Panel. Pelo alvo, como presença e participantes: na troca A -> B o primeiro
          render tem o número da B e ainda a conversa da A, e o painel buscaria o grupo da A no
          número da B (metadata de grupo pela linha errada). */}
      {conversation && alvoWhatsApp.isGroup && alvoWhatsApp.groupJid && phoneNumberDbId && currentOrganization?.id && (
        <GroupInfoPanel
          open={groupInfoOpen}
          onOpenChange={setGroupInfoOpen}
          groupJid={alvoWhatsApp.groupJid}
          conversationId={conversation.id}
          phoneNumberId={phoneNumberDbId}
          organizationId={currentOrganization.id}
          userId={userId}
          onGroupUpdated={() => {
            fetchConversation();
          }}
          onOpenConversation={onOpenConversation}
        />
      )}

      {/* Emoji no mobile (Drawer aberto pelo menu "+") */}
      {isMobile && (
        <Drawer open={emojiDrawerOpen} onOpenChange={setEmojiDrawerOpen}>
          <DrawerContent className="safe-area-bottom">
            <DrawerTitle className="sr-only">Escolher emoji</DrawerTitle>
            <EmojiPickerPanel
              onEmojiSelect={(emoji) => {
                chatInputRef.current?.addText(emoji);
                setEmojiDrawerOpen(false);
              }}
              heightClass="h-72"
            />
          </DrawerContent>
        </Drawer>
      )}

      {/* Lightbox de mídia da conversa */}
      <MediaLightbox
        items={conversationMedia}
        initialMessageId={lightboxMessageId}
        onClose={closeLightbox}
      />

      {/* Lightbox da prévia do envio (por cima do dialog de mídia) */}
      <MediaLightbox
        items={pendingMedia}
        initialMessageId={pendingLightboxId}
        onClose={closePendingLightbox}
      />

      {/* Apagar para todos — confirmação estilizada (era window.confirm) */}
      <ConfirmDestructiveDialog
        open={!!messageToDelete}
        onOpenChange={(open) => {
          if (!open) setMessageToDelete(null);
        }}
        title="Apagar para todos?"
        description="A mensagem será apagada para todos nesta conversa. Essa ação não pode ser desfeita."
        confirmLabel="Apagar para todos"
        pending={isDeleting}
        onConfirm={confirmDeleteMessage}
      />

      {/* Contact Picker Modal */}
      {phoneNumberDbId && conversation && (
        <ContactPickerModal
          open={contactPickerOpen}
          onOpenChange={setContactPickerOpen}
          phoneNumberId={phoneNumberDbId}
          targetPhone={conversation.contact_phone}
          conversationId={conversationId!}
          quotedMessageId={replyingTo?.id ?? null}
          onSent={() => {
            setReplyingTo(null);
            fetchMessages();
          }}
        />
      )}

      {/* Location Picker Dialog */}
      {phoneNumberDbId && conversation && (
        <LocationPickerDialog
          open={locationPickerOpen}
          onOpenChange={setLocationPickerOpen}
          phoneNumberId={phoneNumberDbId}
          targetPhone={conversation.contact_phone}
          conversationId={conversationId!}
          quotedMessageId={replyingTo?.id ?? null}
          onSent={() => {
            setReplyingTo(null);
            fetchMessages();
          }}
        />
      )}

      {/* Poll Composer Dialog (QR only) */}
      {phoneNumberDbId && conversation && (
        <PollComposerDialog
          open={pollDialogOpen}
          onOpenChange={setPollDialogOpen}
          phoneNumberId={phoneNumberDbId}
          targetPhone={conversation.contact_phone}
          conversationId={conversationId!}
          onSent={() => fetchMessages()}
        />
      )}

      {/* Escolha dos destinos — último passo do fluxo de seleção */}
      {phoneNumberDbId && (
        <ForwardMessageModal
          open={forwardBatchOpen}
          onOpenChange={(open) => {
            if (!open) setForwardBatchOpen(false);
          }}
          phoneNumberId={phoneNumberDbId}
          messages={selectedMessages}
          // Só sai da seleção quando algo foi de fato encaminhado; cancelar
          // preserva o que o usuário marcou.
          onForwarded={exitSelection}
        />
      )}
    </div>

    {/* Perfil do contato — a terceira coluna à direita (rightPanel garante
        que só uma aparece). Em grupo quem abre é o GroupInfoPanel. */}
    {conversation && !conversation.is_group && (
      <ContactInfoPanel
        conversationId={conversation.id}
        contactName={conversation.contact_name}
        contactPhone={identificacaoDoContato(conversation)}
        contactAvatarUrl={conversation.contact_avatar_url ?? null}
        open={profileOpen}
        onOpenChange={(next) => setRightPanel(next ? "profile" : "none")}
        status={contextConversation?.status ?? null}
        sectorName={currentSectorId ? sectorsById.get(currentSectorId)?.name ?? null : null}
        primaryAssigneeId={primaryAssigneeId}
        coOwnerIds={coOwnerIds}
        onShare={() => setShareDialogOpen(true)}
        // Só QR: a Cloud API não tem fila offline nem history sync para pedir.
        onRefetchHistory={isQrConnection ? refetchHistory : undefined}
        isRefetchingHistory={isRefetchingHistory}
      />
    )}
    </div>
  );
};

export default ChatArea;
