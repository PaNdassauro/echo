import { useState, useCallback, useEffect, useRef, useLayoutEffect, memo } from "react";
import { motion, useMotionValue, useTransform, useAnimation, PanInfo, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { rememberMediaSize, wasMediaLoaded } from "@/lib/mediaSizeCache";
import { captureVideoPoster, getVideoPoster, scheduleIdle } from "@/lib/videoPoster";
import { boxedMediaKind, parseMediaDimensions, resolveMediaBox, type MediaBox } from "@/lib/mediaBox";
import { bubbleImageSrc } from "@/lib/mediaDerivative";
import { mediaDownloadName, toDownloadUrl } from "@/lib/mediaDownload";
import { thumbHashDataUrl } from "@/lib/thumbhash";
import { retainImage } from "@/lib/mediaPreload";
import { MediaFrame } from "@/components/chat/bubbles/MediaFrame";
import { formatParticipantPhone } from "@/lib/phone";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Loader2, AlertCircle, Check, CheckCheck, ExternalLink, Phone, FileText, Download, Play, Reply, Pencil, Trash2, MoreVertical, User, Users, MessageSquare, Smile, List, Copy, X, ImageOff, RotateCw, Plus, Forward, Clock, Instagram, Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { IconSwap } from "@/components/ui/icon-swap";
import { SPRING_SNAP } from "@/lib/motion";
import AudioPlayer from "./AudioPlayer";
import { LocationBubble } from "./chat/bubbles/LocationBubble";
import { LinkPreviewCard, parseLinkPreview } from "./chat/bubbles/LinkPreviewCard";
import { PollBubble, parsePoll } from "./chat/bubbles/PollBubble";
import type { PollParticipantRef } from "@/lib/pollResults";
import { PixBubble } from "./chat/bubbles/PixBubble";
import { ReactionPills, type AggregatedReaction } from "./chat/bubbles/ReactionPills";
import { ReactionPicker, QUICK_REACTIONS } from "./chat/bubbles/ReactionPicker";
import { EmojiGrid } from "./EmojiPicker";
import { ReadReceiptsPopover } from "./chat/bubbles/ReadReceiptsPopover";
import { AudioTranscricao } from "./chat/bubbles/AudioTranscricao";
import { parseLocationMessage } from "@/lib/locationMessage";
import { parseDeliveryTiming } from "@/lib/deliveryTiming";
import { extractPixPayload } from "@/lib/pixPayload";
import { senderColorCss } from "@/lib/senderColor";

// WhatsApp allows editing a sent message only within 15 minutes of sending.
// After that window, the server (WhatsApp itself) rejects the edit.
const WHATSAPP_EDIT_WINDOW_MS = 15 * 60 * 1000;

interface MessageBubbleProps {
  content: string;
  direction: "inbound" | "outbound";
  timestamp: string;
  status?: "sending" | "sent" | "delivered" | "read" | "error" | "failed";
  error?: string;
  message_type?: string;
  media_url?: string | null;
  media_mime_type?: string | null;
  media_filename?: string | null;
  senderName?: string | null; // For group messages - who sent it
  /** Cor estável do remetente em grupo (1..8 → --group-sender-N). */
  senderColorIndex?: number | null;
  onReply?: () => void; // Callback when reply button is clicked
  onForward?: () => void; // Abre o modal de encaminhar (presente só em mensagens encaminháveis)
  // Quoted message fields
  quotedContent?: string | null;
  quotedDirection?: "inbound" | "outbound" | null;
  quotedMediaUrl?: string | null;
  quotedMessageType?: string | null;
  quotedMessageId?: string | null;
  /** Nome do autor da mensagem citada (grupos); "Você"/"Contato" é o fallback. */
  quotedSenderLabel?: string | null;
  quotedSenderColorIndex?: number | null;
  onQuotedClick?: (messageId: string) => void;
  // Edit/Delete callbacks (QR connections only)
  onEdit?: () => void;
  onDelete?: () => void;
  isQrConnection?: boolean;
  // Reagir vale para QR e Business API (Cloud API `type: 'reaction'`).
  reactionsEnabled?: boolean;
  /** Card juntado (WhatsApp + Direct): toda bolha diz por qual canal passou. */
  mostrarCanal?: boolean;
  // Recuperação de envio falho (mensagens otimistas com status error/failed)
  onRetry?: () => void;
  onDiscard?: () => void;
  // "Adicionar aos stickers" — presente só quando message_type é sticker com media_url
  onSaveSticker?: () => void;
  // Flow response fields
  flowResponseJson?: Record<string, unknown> | null;
  reaction?: string | null;
  // Reaction callbacks (QR connections only)
  onReact?: (emoji: string) => void;
  ourReaction?: string | null;
  /** Agregado por reator (message_reactions); ausente → fallback nas escalares. */
  reactions?: AggregatedReaction[] | null;
  // Media load callback (for scroll handling)
  onMediaLoad?: () => void;
  /** Caixa travada pela lista por conversa; sem ela a bolha trava a própria por montagem */
  mediaBox?: MediaBox;
  /** Abre o lightbox da conversa nesta mensagem (fallback: window.open). */
  onOpenLightbox?: () => void;
  /** Voto na enquete (QR only) — ausente = enquete só leitura. */
  onPollVote?: (options: string[]) => void;
  // ID for scroll targeting
  id?: string;
  /** UUID da linha em messages (o prop `id` acima é âncora de DOM) — habilita
   *  o popover "quem leu" nos risquinhos de grupo. */
  messageId?: string;
  /** Conversa de grupo — junto com isQrConnection, gate do popover de recibos. */
  isGroup?: boolean;
  // Participant lookup for group mentions (phone number -> display name)
  participantLookup?: Record<string, string>;
  /** Participantes do grupo (enquete: "ainda não votaram"). */
  groupParticipants?: PollParticipantRef[];
  // Contact metadata for contact messages, list metadata for list messages
  metadata?: {
    /** Dimensões da mídia (metadata.media): ler só via parseMediaDimensions */
    media?: unknown;
    contact?: {
      displayName: string;
      /** Ausente na Cloud API, que manda o contato estruturado em vez de vCard. */
      vcard?: string;
      phones: string[];
      /** Todos os contatos da mensagem; rows antigas só têm os campos singulares acima. */
      contacts?: Array<{ displayName: string; vcard?: string; phones: string[] }>;
    };
    list?: {
      title?: string;
      body: string;
      buttonText: string;
      sections: Array<{
        title: string;
        rows: Array<{
          id: string;
          title: string;
          description?: string;
        }>;
      }>;
      footer?: string;
    };
    /**
     * Chave Pix copia-e-cola (payload EMV) extraída pelo qr-service de dentro do
     * native flow de um interactiveMessage — é onde o Pix nativo do WhatsApp a
     * carrega, fora do texto da mensagem.
     */
    pix_code?: string;
    /** Mensagem encaminhada: pelo Echo (whatsapp-forward) ou pelo contato (qr-service/webhook). */
    forwarded?: boolean;
    /** Encaminhada muitas vezes (forwardingScore >= 5 / frequently_forwarded da Cloud API). */
    frequently_forwarded?: boolean;
    /** 'instagram' = veio ou saiu pelo Direct do Instagram. */
    canal?: string;
    /** Mensagem que saiu num disparo (do Echo ou de um sistema externo pela API). */
    disparo?: { rotulo?: string; campanha?: string; origem?: string };
    /** Mídia "ver uma vez" (a cópia fica salva para auditoria; a bolha sinaliza). */
    view_once?: boolean;
    /** Vídeo enviado/recebido como GIF (gifPlayback). */
    gif?: boolean;
    /** Nota de voz (inbound QR grava type='audio' + esta flag). */
    ptt?: boolean;
    /** Localização estruturada — parseada por parseLocationMessage. */
    location?: unknown;
    /** Preview de link (inbound QR ou enrichment OG do envio). */
    link_preview?: unknown;
    /** Enquete — parseada por parsePoll. */
    poll?: unknown;
    /** Hora real do envio pelo cliente (Cloud API) — parseada por parseDeliveryTiming. */
    sent_at?: unknown;
    /** Chegou bem depois de enviada (reentrega da Meta). */
    delivered_late?: unknown;
    /** Leitura de mídia (transcrição do áudio): ler só via `src/lib/transcricaoAudio.ts`. */
    leitura?: unknown;
  } | null;
  // Callback to start a conversation with a contact
  onStartConversation?: (phone: string, name: string) => void;
  // Search highlighting
  searchTerm?: string;
  isCurrentSearchMatch?: boolean;
  // Mobile flag (passed from parent to avoid hook per message)
  isMobile?: boolean;
  // Edited flag (received from WhatsApp)
  is_edited?: boolean;
  // Versões anteriores do texto, da mais antiga para a mais recente
  editHistory?: Array<{ content: string; at: string }> | null;
  // Houve edição mas o texto novo não chegou: o content exibido é o antigo
  editContentUnavailable?: boolean;
  // Apagada para todos. O conteúdo segue preservado; a bolha só sinaliza.
  is_deleted?: boolean;
  // ── Seleção múltipla (encaminhar em lote) ──
  // Modo ativo: a linha inteira vira alvo de clique e as ações da bolha somem.
  selectionMode?: boolean;
  isSelected?: boolean;
  // Não encaminhável (ou lote cheio): visível, mas fora da seleção.
  selectionDisabled?: boolean;
  onToggleSelect?: () => void;
}

interface ParsedButton {
  text: string;
  type: "url" | "phone" | "quick_reply";
  url?: string;
  phoneNumber?: string;
}

// Parse WhatsApp-style markdown formatting
const parseMarkdown = (text: string): React.ReactNode[] => {
  const parts: React.ReactNode[] = [];
  const remaining = text;
  let key = 0;

  // Regex patterns for WhatsApp formatting
  const patterns = [
    { regex: /\*([^*]+)\*/g, render: (match: string) => <strong key={key++}>{match}</strong> },
    { regex: /_([^_]+)_/g, render: (match: string) => <em key={key++}>{match}</em> },
    { regex: /~([^~]+)~/g, render: (match: string) => <s key={key++}>{match}</s> },
    { regex: /```([^`]+)```/g, render: (match: string) => <code key={key++} className="bg-black/10 px-1 rounded">{match}</code> },
  ];

  // Combined regex to find all formatting
  const combinedRegex = /(\*[^*]+\*|_[^_]+_|~[^~]+~|```[^`]+```)/g;

  const segments = remaining.split(combinedRegex);

  for (const segment of segments) {
    if (!segment) continue;

    // Check if segment matches any pattern
    if (/^\*[^*]+\*$/.test(segment)) {
      parts.push(<strong key={key++}>{segment.slice(1, -1)}</strong>);
    } else if (/^_[^_]+_$/.test(segment)) {
      parts.push(<em key={key++}>{segment.slice(1, -1)}</em>);
    } else if (/^~[^~]+~$/.test(segment)) {
      parts.push(<s key={key++}>{segment.slice(1, -1)}</s>);
    } else if (/^```[^`]+```$/.test(segment)) {
      parts.push(<code key={key++} className="bg-black/10 px-1 rounded">{segment.slice(3, -3)}</code>);
    } else {
      parts.push(segment);
    }
  }

  return parts;
};

// URL detection for making links clickable in message text.
// Matches http(s):// and bare www. links; split keeps the URL as its own segment.
const URL_SPLIT_REGEX = /((?:https?:\/\/|www\.)[^\s]+)/gi;
const isUrl = (s: string): boolean => /^(?:https?:\/\/|www\.)/i.test(s);
// Punctuation that commonly trails a URL in prose but isn't part of it.
const TRAILING_PUNCT_REGEX = /[.,;:!?)\]}'"]+$/;
const splitTrailingPunctuation = (url: string): { url: string; trailing: string } => {
  const match = url.match(TRAILING_PUNCT_REGEX);
  if (!match) return { url, trailing: "" };
  const trailing = match[0];
  return { url: url.slice(0, url.length - trailing.length), trailing };
};

// Parse @mentions in text and replace with display names
const parseMentions = (
  text: string,
  lookup?: Record<string, string>
): React.ReactNode[] => {
  // Match @followed by digits (WhatsApp mention format) ou o token especial
  // "@todos" (marcar todos — o destaque é só no painel; no WhatsApp dos
  // destinatários é texto puro, mas a notificação de menção chega).
  const mentionRegex = /@(\d+|todos\b)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    // Add text before the mention
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const token = match[1];
    // Look up the display name, fallback to formatted phone
    const displayName =
      token === "todos"
        ? "todos"
        : lookup?.[token] || formatParticipantPhone(token);

    // Render mention with styling - inherit text color, use underline to distinguish
    parts.push(
      <span
        key={key++}
        className="font-semibold underline decoration-1 underline-offset-2"
      >
        @{displayName}
      </span>
    );

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
};

// Parse buttons from message content
const parseMessageContent = (content: string): { text: string; buttons: ParsedButton[] } => {
  const buttons: ParsedButton[] = [];

  // Check for new format with ---BUTTONS--- marker
  const buttonMarkerIndex = content.indexOf("\n\n---BUTTONS---\n");
  if (buttonMarkerIndex !== -1) {
    const textPart = content.substring(0, buttonMarkerIndex);
    const buttonsPart = content.substring(buttonMarkerIndex + "\n\n---BUTTONS---\n".length);

    const buttonLines = buttonsPart.split("\n").filter(line => line.trim());
    for (const line of buttonLines) {
      // Parse [URL:https://...]Text or [PHONE:+123]Text or [QUICK]Text
      const urlMatch = line.match(/^\[URL:(.*?)\](.+)$/);
      const phoneMatch = line.match(/^\[PHONE:(.*?)\](.+)$/);
      const quickMatch = line.match(/^\[QUICK\](.+)$/);

      if (urlMatch) {
        buttons.push({
          text: urlMatch[2],
          type: "url",
          url: urlMatch[1]
        });
      } else if (phoneMatch) {
        buttons.push({
          text: phoneMatch[2],
          type: "phone",
          phoneNumber: phoneMatch[1]
        });
      } else if (quickMatch) {
        buttons.push({
          text: quickMatch[1],
          type: "quick_reply"
        });
      }
    }

    return { text: textPart, buttons };
  }

  // Fallback: Check for old format with [ Button Text ] pattern
  const buttonRegex = /\[\s*(.+?)\s*\]/g;
  const lines = content.split("\n");

  const textLines: string[] = [];
  let foundButtonSection = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Check if this line contains button patterns
    const matches = [...trimmedLine.matchAll(buttonRegex)];

    if (matches.length > 0 && trimmedLine.replace(buttonRegex, "").trim() === "") {
      foundButtonSection = true;
      for (const match of matches) {
        buttons.push({
          text: match[1].trim(),
          type: "quick_reply"
        });
      }
    } else if (!foundButtonSection || trimmedLine !== "") {
      textLines.push(line);
    }
  }

  // Remove trailing empty lines from text
  while (textLines.length > 0 && textLines[textLines.length - 1].trim() === "") {
    textLines.pop();
  }

  return {
    text: textLines.join("\n"),
    buttons
  };
};

const MessageBubble = ({
  content,
  direction,
  timestamp,
  status,
  error,
  message_type,
  media_url,
  media_mime_type,
  media_filename,
  senderName,
  senderColorIndex,
  onReply,
  onForward,
  quotedContent,
  quotedDirection,
  quotedMediaUrl,
  quotedMessageType,
  quotedMessageId,
  quotedSenderLabel,
  quotedSenderColorIndex,
  onQuotedClick,
  onEdit,
  onDelete,
  isQrConnection,
  reactionsEnabled,
  mostrarCanal,
  onRetry,
  onDiscard,
  onSaveSticker,
  flowResponseJson,
  reaction,
  onReact,
  ourReaction,
  reactions,
  onMediaLoad,
  mediaBox,
  onOpenLightbox,
  onPollVote,
  id,
  messageId,
  isGroup,
  participantLookup,
  groupParticipants,
  metadata,
  onStartConversation,
  searchTerm,
  isCurrentSearchMatch,
  isMobile = false,
  is_edited = false,
  editHistory,
  editContentUnavailable = false,
  is_deleted = false,
  selectionMode = false,
  isSelected = false,
  selectionDisabled = false,
  onToggleSelect,
}: MessageBubbleProps) => {
  const isOutbound = direction === "outbound";
  // Risquinho de status (sent/delivered/read). Em grupo QR ele vira o gatilho
  // do popover "quem leu" — computado uma vez porque o JSX usa nos dois ramos.
  // Os quatro estados ficam no DOM e fazem cross-fade (IconSwap): é a troca de
  // ícone mais frequente do app e o corte seco congelava o spinner num ângulo.
  const statusTickKey =
    status === "sending" || status === "sent" || status === "delivered" || status === "read" ? status : null;
  const statusTick = statusTickKey ? (
    <IconSwap
      active={statusTickKey}
      durationMs={150}
      icons={{
        sending: <Loader2 className="w-4 h-4 animate-spin" />,
        sent: <Check className="w-4 h-4" strokeWidth={2.5} />,
        delivered: <CheckCheck className="w-4 h-4" strokeWidth={2.5} />,
        read: <CheckCheck className="w-4 h-4 text-blue-500" strokeWidth={2.5} />,
      }}
    />
  ) : null;
  const showReceiptsPopover = Boolean(isGroup && isQrConnection && messageId);
  // 'deleted' é o formato legado (a exclusão sobrescrevia tipo e conteúdo); is_deleted é o
  // soft delete atual, que preserva texto e mídia. Toda decisão de UI passa por aqui.
  const isDeleted = is_deleted || message_type === 'deleted';
  // Linhas anteriores ao histórico só têm o selo "editado", sem versão para abrir.
  const hasEditHistory = Boolean(editHistory && editHistory.length > 0);
  const { text, buttons } = parseMessageContent(content);
  const isFlowResponse = message_type === 'nfm_reply';
  const { toast } = useToast();

  // Long-press menu state
  const [isLongPressMenuOpen, setIsLongPressMenuOpen] = useState(false);
  // "+" do quick-picker mobile: troca a fileira de 6 pela grade completa
  const [showFullReactionGrid, setShowFullReactionGrid] = useState(false);
  // Ciclo de vida da mídia (imagem/figurinha/vídeo): skeleton → fade-in → erro com retry.
  // A caixa é travada na montagem (por URL) a partir de metadata.media, do cache
  // ou de um letterbox fixo; o onLoad só preenche o cache e NUNCA muda a altura.
  // O estado é derivado por URL: uma URL nova não pede render extra.
  const boxKind = boxedMediaKind(message_type);
  const ownBoxRef = useRef<{ url: string | null | undefined; box: MediaBox } | null>(null);
  if (boxKind && media_url && !mediaBox && (ownBoxRef.current === null || ownBoxRef.current.url !== media_url)) {
    ownBoxRef.current = { url: media_url, box: resolveMediaBox({ kind: boxKind, url: media_url, metadata }) };
  }
  const box: MediaBox | null = boxKind && media_url ? (mediaBox ?? ownBoxRef.current?.box ?? null) : null;
  type MediaLoadState = "loading" | "loaded" | "error";
  const initialMediaState = (url: string | null | undefined): MediaLoadState =>
    wasMediaLoaded(url) ? "loaded" : "loading";
  const [mediaLoad, setMediaLoad] = useState<{ url: string | null | undefined; state: MediaLoadState; fade: boolean }>(
    () => ({ url: media_url, state: initialMediaState(media_url), fade: false }),
  );
  const mediaState: MediaLoadState = mediaLoad.url === media_url ? mediaLoad.state : initialMediaState(media_url);
  const mediaFade = mediaLoad.url === media_url && mediaLoad.fade;
  const setMediaState = (state: MediaLoadState, fade = false) => setMediaLoad({ url: media_url, state, fade });
  const [mediaRetry, setMediaRetry] = useState(0);
  // Imagem: derivada reduzida do Storage; se falhar, cai no original (por URL).
  const [derivativeFailedFor, setDerivativeFailedFor] = useState<string | null>(null);
  const mediaIsImage = boxKind === "image";
  const mediaIsPicture = boxKind === "image" || boxKind === "sticker";
  const derivedSrc = mediaIsImage && derivativeFailedFor !== media_url ? bubbleImageSrc(media_url) : null;
  const imageSrc = derivedSrc ?? media_url ?? undefined;
  // Miniatura borrada já dentro da caixa, na ordem: thumbhash do metadata (28 bytes,
  // decodificado aqui, sem rede), thumb embutida (base64 JPEG) ou a derivada de 32 px.
  const mediaDims = mediaIsImage ? parseMediaDimensions(metadata) : undefined;
  const thumbHashUrl = thumbHashDataUrl(mediaDims?.thumbhash);
  const placeholderSrc = !mediaIsImage
    ? null
    : thumbHashUrl
      ? thumbHashUrl
      : mediaDims?.thumb
        ? `data:image/jpeg;base64,${mediaDims.thumb}`
        : bubbleImageSrc(media_url, 32);
  const [placeholderLoadedFor, setPlaceholderLoadedFor] = useState<string | null>(null);
  const [fadeDoneFor, setFadeDoneFor] = useState<string | null>(null);
  const [videoStartedFor, setVideoStartedFor] = useState<string | null>(null);
  // Poster do vídeo: thumb do metadata, depois primeiro quadro (cache/captura), senão o tom liso.
  const videoThumb = message_type === "video" ? parseMediaDimensions(metadata)?.thumb : undefined;
  const posterFromMeta = videoThumb ? `data:image/jpeg;base64,${videoThumb}` : null;
  const videoPosterUrl = message_type === "video" && media_url ? media_url : null;
  const [capturedPoster, setCapturedPoster] = useState<{ url: string; src: string } | null>(null);
  useEffect(() => {
    if (!videoPosterUrl || posterFromMeta || getVideoPoster(videoPosterUrl)) return;
    let alive = true;
    // Em tempo ocioso: bolha que passa voando pela tela não dispara captura.
    const cancel = scheduleIdle(() => {
      if (!alive) return;
      void captureVideoPoster(videoPosterUrl).then((src) => {
        if (alive && src) setCapturedPoster({ url: videoPosterUrl, src });
      });
    });
    return () => {
      alive = false;
      cancel();
    };
  }, [videoPosterUrl, posterFromMeta]);
  const posterUrl =
    posterFromMeta ??
    (videoPosterUrl
      ? (getVideoPoster(videoPosterUrl) ?? (capturedPoster?.url === videoPosterUrl ? capturedPoster.src : null))
      : null);
  const mediaImgRef = useRef<HTMLImageElement>(null);
  const mediaGenRef = useRef("");
  const mediaStartRef = useRef(0);
  // Revelação instantânea: imagem já em cache (complete na montagem) aparece sem fade.
  useLayoutEffect(() => {
    if (!mediaIsPicture || !media_url) return;
    mediaGenRef.current = `${imageSrc}|${mediaRetry}`;
    mediaStartRef.current = performance.now();
    const img = mediaImgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      rememberMediaSize(media_url, img.naturalWidth, img.naturalHeight);
      retainImage(img.currentSrc || img.src);
      setMediaLoad({ url: media_url, state: "loaded", fade: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSrc, mediaRetry]);
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const LONG_PRESS_DURATION = 500; // ms

  // Determine if this is a media message
  // 'ptt' = nota de voz. O whatsapp-webhook grava 'audio' para voz recebida, mas o
  // echo-api grava 'ptt' no envio — sem esse tipo aqui a bolha ficava vazia.
  const isMediaMessage = media_url && ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(message_type || '');
  // Todo anexo baixa de fato e com o nome original: o Storage é outra origem, então
  // o atributo `download` sozinho é ignorado; `?download=` força o attachment.
  const downloadName = isMediaMessage && media_url ? mediaDownloadName(media_url, media_filename, message_type) : null;
  const downloadHref = downloadName && media_url ? toDownloadUrl(media_url, downloadName) : null;
  // Documento e áudio já têm o baixar na própria bolha; o resto ganha o botão na barra.
  const showToolbarDownload = !!downloadHref && !isDeleted && ['image', 'video', 'sticker'].includes(message_type || '');

  // Localização: metadata.location (novo) ou string legada; parse falho → texto cru.
  const parsedLocation = message_type === 'location'
    ? parseLocationMessage(content, metadata)
    : null;

  // Preview de link (só em texto; ausente/malformado → nada renderiza)
  const linkPreview = message_type === 'text' || !message_type
    ? parseLinkPreview(metadata)
    : null;

  // Enquete: metadata.poll validado; malformado → cai no texto (a pergunta)
  const parsedPoll = message_type === 'poll' ? parsePoll(metadata) : null;
  // Reentrega tardia da Meta: a hora da bolha é a chegada, então a do envio vai no rótulo.
  const lateSentAt = !isOutbound ? (() => {
    const timing = parseDeliveryTiming(metadata);
    return timing.deliveredLate ? timing.sentAt : null;
  })() : null;

  // Pix nativo do WhatsApp: chega como interactiveMessage, e a chave vem num
  // JSON dentro dos botões de native flow — o qr-service a extrai para
  // metadata.pix_code. Só esse caminho vira card: chave colada em texto comum
  // fica como texto, porque ali o atendente já vê e seleciona o que precisa.
  const parsedPix = !isDeleted ? extractPixPayload(metadata?.pix_code) : null;

  // Reações a exibir: o agregado (message_reactions) manda quando existe;
  // sem linhas, degrada para as colunas escalares (rows antigas / payload velho).
  // Mesmo emoji dos dois lados vira UM pill (a key do pill é o emoji).
  const displayReactions: AggregatedReaction[] = reactions?.length
    ? reactions
    : reaction && ourReaction && reaction === ourReaction
      ? [{ emoji: reaction, count: 2, mine: true }]
      : [
          ...(reaction ? [{ emoji: reaction, count: 1, mine: false }] : []),
          ...(ourReaction ? [{ emoji: ourReaction, count: 1, mine: true }] : []),
        ];

  // WhatsApp only allows editing within 15 minutes after the message was sent.
  // Parsed at render time so re-renders (new messages, status updates) refresh the window.
  const messageSentAt = new Date(timestamp).getTime();
  const isWithinEditWindow = Number.isFinite(messageSentAt) && (Date.now() - messageSentAt) < WHATSAPP_EDIT_WINDOW_MS;
  const isImage = message_type === 'image';
  const isSticker = message_type === 'sticker';
  const isVideo = message_type === 'video';
  const isAudio = message_type === 'audio' || message_type === 'ptt';
  const isDocument = message_type === 'document';

  // Swipe-to-reply state and logic (mobile only)
  const x = useMotionValue(0);
  const controls = useAnimation();
  const SWIPE_THRESHOLD = 60;

  // Transform x position to reply icon opacity and scale
  // Emil: nothing in the real world appears from nothing — start scale at 0.85, let opacity carry the "entering" work
  const replyIconOpacity = useTransform(x, [0, SWIPE_THRESHOLD / 2, SWIPE_THRESHOLD], [0, 0.5, 1]);
  const replyIconScale = useTransform(x, [0, SWIPE_THRESHOLD], [0.85, 1]);

  const handlePanEnd = useCallback(
    (event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (info.offset.x > SWIPE_THRESHOLD && onReply) {
        // Trigger reply
        onReply();
        // Haptic feedback if available
        if (navigator.vibrate) {
          navigator.vibrate(50);
        }
      }
      // Animate back to original position
      controls.start({ x: 0, transition: SPRING_SNAP });
    },
    [onReply, controls]
  );

  const handleButtonClick = (button: ParsedButton) => {
    if (button.type === "url" && button.url) {
      window.open(button.url, "_blank", "noopener,noreferrer");
    } else if (button.type === "phone" && button.phoneNumber) {
      window.open(`tel:${button.phoneNumber}`, "_blank");
    }
    // Quick reply buttons are informational only in this context
  };

  // Long-press handlers
  const handleTouchStart = useCallback(() => {
    if (!isMobile || selectionMode) return;
    longPressTimer.current = setTimeout(() => {
      setIsLongPressMenuOpen(true);
      // Haptic feedback
      if (navigator.vibrate) {
        navigator.vibrate(50);
      }
    }, LONG_PRESS_DURATION);
  }, [isMobile, selectionMode]);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleTouchMove = useCallback(() => {
    // Cancel long-press if user moves finger
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Copy message text to clipboard
  const handleCopyText = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast({
        title: "Copiado",
        description: "Texto copiado para a área de transferência",
      });
    } catch (err) {
      toast({
        title: "Não foi possível copiar o texto",
        description: "Selecione o texto da mensagem e copie manualmente.",
        variant: "destructive",
      });
    }
    setIsLongPressMenuOpen(false);
  }, [text, toast]);

  // Long-press menu action handlers
  const handleMenuReply = useCallback(() => {
    setIsLongPressMenuOpen(false);
    onReply?.();
  }, [onReply]);

  const handleMenuEdit = useCallback(() => {
    setIsLongPressMenuOpen(false);
    onEdit?.();
  }, [onEdit]);

  const handleMenuDelete = useCallback(() => {
    setIsLongPressMenuOpen(false);
    onDelete?.();
  }, [onDelete]);

  const handleMenuReact = useCallback((emoji: string) => {
    setIsLongPressMenuOpen(false);
    setShowFullReactionGrid(false);
    onReact?.(emoji);
  }, [onReact]);

  // Highlight search term in text
  const highlightSearchTerm = (text: string): React.ReactNode => {
    if (!searchTerm || !text) return text;

    const term = searchTerm.toLowerCase();
    const lowerText = text.toLowerCase();
    const index = lowerText.indexOf(term);

    if (index === -1) return text;

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let currentIndex = index;
    let keyCounter = 0;

    while (currentIndex !== -1) {
      // Add text before match
      if (currentIndex > lastIndex) {
        parts.push(text.slice(lastIndex, currentIndex));
      }
      // Add highlighted match
      parts.push(
        <mark key={keyCounter++} className="bg-yellow-300 text-yellow-950 dark:bg-yellow-500/40 dark:text-yellow-100 rounded px-0.5">
          {text.slice(currentIndex, currentIndex + term.length)}
        </mark>
      );
      lastIndex = currentIndex + term.length;
      currentIndex = lowerText.indexOf(term, lastIndex);
    }

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }

    return <>{parts}</>;
  };

  // Apply markdown + search highlighting to a plain (non-URL, non-mention) string
  const renderPlainSegment = (segment: string, keyBase: string) => {
    const markdownParsed = parseMarkdown(segment);
    return markdownParsed.map((node, nodeIndex) => {
      const key = `${keyBase}-${nodeIndex}`;
      if (typeof node === 'string') {
        return <span key={key}>{highlightSearchTerm(node)}</span>;
      }
      return <span key={key}>{node}</span>;
    });
  };

  // Render text with mention parsing, clickable links, and markdown parsing.
  // Order matters: linkify BEFORE markdown so URLs with "_" aren't mangled as italics.
  const renderFormattedText = (text: string) => {
    const lines = text.split("\n");
    return lines.map((line, lineIndex) => {
      const mentionParsed = parseMentions(line, participantLookup);
      const result = mentionParsed.flatMap<React.ReactNode>((part, partIndex) => {
        // Mention element - wrap with key
        if (typeof part !== 'string') {
          return <span key={`${lineIndex}-${partIndex}-mention`}>{part}</span>;
        }

        // Split the string into URL and non-URL segments
        const segments = part.split(URL_SPLIT_REGEX);
        return segments.flatMap<React.ReactNode>((segment, segIndex) => {
          if (!segment) return [];
          const keyBase = `${lineIndex}-${partIndex}-${segIndex}`;

          if (isUrl(segment)) {
            const { url, trailing } = splitTrailingPunctuation(segment);
            const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
            const nodes: React.ReactNode[] = [
              <a
                key={keyBase}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="underline underline-offset-2 break-all transition-opacity hover:opacity-80"
              >
                {url}
              </a>,
            ];
            if (trailing) {
              nodes.push(<span key={`${keyBase}-trail`}>{trailing}</span>);
            }
            return nodes;
          }

          return renderPlainSegment(segment, keyBase);
        });
      });

      return (
        <span key={lineIndex}>
          {result}
          {lineIndex < lines.length - 1 && <br />}
        </span>
      );
    });
  };

  // Render media content
  const renderMedia = () => {
    if (!isMediaMessage || !media_url) return null;

    // Erro de mídia (URL expirada etc.): UI dentro da MESMA moldura, nunca o
    // ícone de imagem quebrada nem uma linha de outra altura.
    const reload = () => {
      setMediaState("loading");
      setMediaRetry((n) => n + 1);
    };
    const mediaError = (b: MediaBox) => (
      <div className="absolute inset-0 grid place-items-center rounded-lg bg-muted p-2 text-xs text-muted-foreground">
        {b.width >= 180 ? (
          <div className="flex items-center gap-2">
            <ImageOff className="w-4 h-4 shrink-0" />
            <span>Mídia indisponível</span>
            <button type="button" onClick={reload} className="underline underline-offset-2 hover:text-foreground">
              Recarregar
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label="Mídia indisponível. Recarregar"
            title="Mídia indisponível. Recarregar"
            onClick={reload}
            className="grid h-8 w-8 place-items-center rounded-full hover:text-foreground active:scale-[0.96]"
          >
            <RotateCw className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </div>
    );

    // onLoad da imagem/figurinha: grava o tamanho (chave = URL original), espera o
    // decode e só então revela. O fade só vale se o load demorou (>= 100 ms).
    const handleMainLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      const gen = mediaGenRef.current;
      rememberMediaSize(media_url, img.naturalWidth, img.naturalHeight);
      retainImage(img.currentSrc || img.src);
      const decoded: Promise<void> = typeof img.decode === "function" ? img.decode() : Promise.resolve();
      void decoded
        .catch(() => undefined)
        .then(() => {
          if (mediaGenRef.current !== gen) return;
          setMediaState("loaded", performance.now() - mediaStartRef.current >= 100);
        });
    };

    // Sticker: conteúdo "solto" (a bolha fica transparente), menor que imagem,
    // com a ação de salvar no hover — no touch a entrada é o long-press menu.
    if (isSticker && box) {
      return (
        <MediaFrame box={box} className="group/sticker mb-1">
          {mediaState !== "error" && (
            <img
              ref={mediaImgRef}
              key={`${imageSrc}|${mediaRetry}`}
              src={imageSrc}
              alt="Figurinha"
              draggable={false}
              decoding={mediaState === "loaded" && !mediaFade ? "sync" : "async"}
              className="absolute inset-0 h-full w-full object-contain"
              onLoad={handleMainLoad}
              onError={() => setMediaState("error")}
            />
          )}
          {mediaState === "error" && mediaError(box)}
          {onSaveSticker && mediaState === "loaded" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSaveSticker();
              }}
              aria-label="Salvar nas figurinhas"
              title="Salvar nas figurinhas"
              className="absolute bottom-1 right-1 flex h-7 w-7 items-center justify-center rounded-full border bg-background/90 text-muted-foreground shadow-sm opacity-0 transition-opacity duration-150 group-hover/sticker:opacity-100 hover:text-foreground active:scale-[0.96]"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </MediaFrame>
      );
    }

    if (isImage && box) {
      const placeholderReady = placeholderSrc !== null && placeholderLoadedFor === placeholderSrc;
      const showPlaceholder =
        placeholderSrc !== null &&
        (mediaState === "loading" || (mediaState === "loaded" && mediaFade && fadeDoneFor !== imageSrc));
      const instant = mediaState === "loaded" && !mediaFade;
      return (
        // rounded-sm (8px): concêntrico com a bolha (16px − py-2). Outline de 1px
        // a 10% separa foto clara do fundo claro sem virar borda.
        <MediaFrame
          box={box}
          className="mb-1 rounded-sm bg-muted/40 outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
        >
          {showPlaceholder && placeholderSrc && (
            <img
              src={placeholderSrc}
              alt=""
              aria-hidden="true"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover scale-110 blur-[10px]"
              onLoad={() => setPlaceholderLoadedFor(placeholderSrc)}
            />
          )}
          {mediaState === "loading" && !placeholderReady && (
            <div className="absolute inset-0 bg-muted/60 animate-pulse" aria-hidden="true" />
          )}
          {mediaState !== "error" && (
            <img
              ref={mediaImgRef}
              key={`${imageSrc}|${mediaRetry}`}
              src={imageSrc}
              alt={media_filename || "Imagem"}
              decoding={instant ? "sync" : "async"}
              className={cn(
                "absolute inset-0 h-full w-full cursor-pointer hover:opacity-90",
                !instant && "transition-opacity duration-200 ease-out",
                box.fit === "cover" ? "object-cover" : "object-contain",
                mediaState === "loading" && "opacity-0",
              )}
              onClick={() => (onOpenLightbox ? onOpenLightbox() : window.open(media_url, '_blank'))}
              onTransitionEnd={() => setFadeDoneFor(imageSrc ?? null)}
              onLoad={handleMainLoad}
              onError={() => {
                if (derivedSrc) setDerivativeFailedFor(media_url);
                else setMediaState("error");
              }}
            />
          )}
          {mediaState === "error" && mediaError(box)}
        </MediaFrame>
      );
    }

    if (isVideo && box) {
      const started = videoStartedFor === media_url;
      return (
        <MediaFrame
          box={box}
          className="mb-2 rounded-sm bg-black outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
        >
          {mediaState !== "error" && !started && (
            <button
              type="button"
              aria-label="Reproduzir vídeo"
              onClick={() => setVideoStartedFor(media_url)}
              className="absolute inset-0 grid place-items-center bg-muted/20 text-white"
            >
              {posterUrl && (
                <>
                  <img
                    src={posterUrl}
                    alt=""
                    aria-hidden="true"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 bg-gradient-to-t from-black/40 via-black/10 to-black/30"
                  />
                </>
              )}
              <span className="relative grid h-12 w-12 place-items-center rounded-full bg-black/50 active:scale-[0.96]">
                <Play className="h-6 w-6 fill-current" aria-hidden="true" />
              </span>
            </button>
          )}
          {mediaState !== "error" && started && (
            <video
              key={mediaRetry}
              src={media_url}
              poster={posterUrl ?? undefined}
              controls
              autoPlay
              playsInline
              preload="auto"
              className="absolute inset-0 h-full w-full object-contain"
              onLoadedMetadata={(e) =>
                rememberMediaSize(media_url, e.currentTarget.videoWidth, e.currentTarget.videoHeight)
              }
              onError={() => setMediaState("error")}
            >
              Seu navegador não suporta vídeo.
            </video>
          )}
          {mediaState === "error" && mediaError(box)}
        </MediaFrame>
      );
    }

    if (isAudio) {
      return (
        <div className="mb-2">
          <AudioPlayer
            key={media_url}
            src={media_url}
            onLoadedMetadata={onMediaLoad}
            showUnplayedDot={!isOutbound}
            filename={media_filename ?? undefined}
          />
          {messageId && (
            <AudioTranscricao messageId={messageId} metadata={metadata} isOutbound={isOutbound} />
          )}
        </div>
      );
    }

    if (isDocument) {
      return (
        <a
          href={downloadHref ?? media_url}
          download={downloadName ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          title={`Baixar ${media_filename || 'documento'}`}
          className={cn(
            "flex items-center gap-3 p-3 mb-2 rounded-lg transition-colors",
            isOutbound
              ? "bg-chat-bubble-user-foreground/10 hover:bg-chat-bubble-user-foreground/20"
              : "bg-chat-bubble-contact-foreground/10 hover:bg-chat-bubble-contact-foreground/20"
          )}
        >
          <FileText className="w-8 h-8 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-message font-medium truncate" title={media_filename || undefined}>
              {media_filename || 'Documento'}
            </p>
            <p className="text-xs opacity-70">
              {media_mime_type?.split('/')[1]?.toUpperCase() || 'Arquivo'}
            </p>
          </div>
          <Download className="w-5 h-5 shrink-0" />
        </a>
      );
    }

    return null;
  };

  // Render contact card(s)
  const renderContactCard = () => {
    if (message_type !== 'contact' || !metadata?.contact) return null;

    // Rows antigas e o envio outbound só gravam os campos singulares (1º contato);
    // `contacts` existe quando a mensagem trouxe a lista completa.
    const cards = metadata.contact.contacts?.length
      ? metadata.contact.contacts
      : [metadata.contact];

    return (
      <div className="mb-1">
        {cards.length > 1 && (
          <p className="text-xs font-medium opacity-70 mb-1.5 flex items-center gap-1">
            <Users className="w-3.5 h-3.5 shrink-0" />
            {cards.length} contatos
          </p>
        )}
        <div className="space-y-1.5">
          {cards.map((card, index) => {
            const phoneNumber = card.phones?.[0] || '';
            return (
              <div
                key={`${card.displayName}-${index}`}
                className={cn(
                  "p-3 rounded-lg",
                  isOutbound
                    ? "bg-chat-bubble-user-foreground/10"
                    : "bg-chat-bubble-contact-foreground/10"
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-12 h-12 rounded-full flex items-center justify-center shrink-0",
                    isOutbound
                      ? "bg-chat-bubble-user-foreground/20"
                      : "bg-chat-bubble-contact-foreground/20"
                  )}>
                    <User className="w-6 h-6" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-message truncate">{card.displayName}</p>
                    {phoneNumber && (
                      <p className="text-message-xs opacity-70">{formatParticipantPhone(phoneNumber.replace(/\D/g, ''))}</p>
                    )}
                  </div>
                </div>
                {phoneNumber && onStartConversation && (
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      "w-full mt-3 text-xs font-medium",
                      isOutbound
                        ? "bg-chat-bubble-user-foreground/10 border-chat-bubble-user-foreground/30 text-chat-bubble-user-foreground hover:bg-chat-bubble-user-foreground/20"
                        : "bg-chat-bubble-contact-foreground/10 border-chat-bubble-contact-foreground/30 text-chat-bubble-contact-foreground hover:bg-chat-bubble-contact-foreground/20"
                    )}
                    onClick={() => onStartConversation(phoneNumber.replace(/\D/g, ''), card.displayName)}
                  >
                    <MessageSquare className="w-3 h-3 mr-2" />
                    Iniciar conversa
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render interactive list message
  const renderListMessage = () => {
    if (message_type !== 'list' || !metadata?.list) return null;

    const { title, body, buttonText, sections, footer } = metadata.list;

    return (
      <div className="space-y-2">
        {/* Header/Title */}
        {title && (
          <p className="font-semibold text-message">{title}</p>
        )}

        {/* Body text */}
        <p className="text-message">{body}</p>

        {/* Sections with rows */}
        <div className={cn(
          "mt-2 border rounded-sm overflow-hidden",
          isOutbound
            ? "border-chat-bubble-user-foreground/20"
            : "border-chat-bubble-contact-foreground/20"
        )}>
          {sections.map((section, sIdx) => (
            <div key={sIdx}>
              {section.title && (
                <div className={cn(
                  "px-3 py-1.5 text-message-xs font-medium",
                  isOutbound
                    ? "bg-chat-bubble-user-foreground/10"
                    : "bg-chat-bubble-contact-foreground/10"
                )}>
                  {section.title}
                </div>
              )}
              {section.rows.map((row, rIdx) => (
                <div
                  key={rIdx}
                  className={cn(
                    "px-3 py-2 border-t first:border-t-0",
                    isOutbound
                      ? "border-chat-bubble-user-foreground/10"
                      : "border-chat-bubble-contact-foreground/10"
                  )}
                >
                  <p className="text-message font-medium">{row.title}</p>
                  {row.description && (
                    <p className="text-message-xs opacity-70 mt-0.5">{row.description}</p>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Button indicator */}
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "w-full justify-center text-xs font-medium cursor-default",
            isOutbound
              ? "bg-chat-bubble-user-foreground/10 border-chat-bubble-user-foreground/30 text-chat-bubble-user-foreground"
              : "bg-chat-bubble-contact-foreground/10 border-chat-bubble-contact-foreground/30 text-chat-bubble-contact-foreground"
          )}
        >
          <List className="w-3 h-3 mr-2" />
          {buttonText}
        </Button>

        {/* Footer */}
        {footer && (
          <p className="text-message-xs opacity-60 italic">{footer}</p>
        )}
      </div>
    );
  };

  // Render flow response data
  const renderFlowResponse = () => {
    if (!isFlowResponse || !flowResponseJson) return null;

    // Filter out internal fields
    const displayFields = Object.entries(flowResponseJson).filter(
      ([key]) => !['flow_token', 'raw'].includes(key)
    );

    if (displayFields.length === 0) return null;

    return (
      <div className={cn(
        "mt-2 p-3 rounded-sm text-xs space-y-1.5",
        isOutbound
          ? "bg-chat-bubble-user-foreground/10"
          : "bg-chat-bubble-contact-foreground/10"
      )}>
        <p className="font-semibold text-2xs uppercase tracking-wide opacity-70 mb-2">
          Dados do formulário
        </p>
        {displayFields.map(([key, value]) => (
          <div key={key} className="flex justify-between gap-2">
            <span className="opacity-70 capitalize">{key.replace(/_/g, ' ')}:</span>
            <span className="font-medium text-right">
              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
            </span>
          </div>
        ))}
      </div>
    );
  };

  // Long-press action menu for mobile.
  // Drawer (vaul) em vez do sheet à mão: Escape, focus trap, role=dialog,
  // scroll lock, swipe-to-dismiss e retorno de foco vêm do primitivo.
  // Continua função de render (não componente no corpo) para não remontar
  // a subárvore a cada render da bolha.
  const renderLongPressMenu = () => {
    const canEdit = isOutbound && isQrConnection && onEdit && !isMediaMessage && !isDeleted && isWithinEditWindow;
    const canDelete = isOutbound && isQrConnection && onDelete && !isDeleted;
    // Trocar de reação é toque direto (mesmo emoji = remove) — sem gate de ourReaction
    const canReact = reactionsEnabled && onReact && !isDeleted;

    return (
      <Drawer
        open={isLongPressMenuOpen}
        onOpenChange={(next) => {
          setIsLongPressMenuOpen(next);
          if (!next) setShowFullReactionGrid(false);
        }}
      >
        <DrawerContent className="safe-area-bottom">
          <DrawerTitle className="sr-only">Ações da mensagem</DrawerTitle>

          {/* Reaction quick picker + "+" para a grade completa */}
          {canReact && (
            showFullReactionGrid ? (
              <div className="border-b border-border">
                <EmojiGrid
                  onEmojiSelect={(emoji) => handleMenuReact(emoji === ourReaction ? '' : emoji)}
                  heightClass="h-56"
                />
              </div>
            ) : (
              <div className="flex justify-center gap-3 py-3 border-b border-border">
                {QUICK_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => handleMenuReact(emoji === ourReaction ? '' : emoji)}
                    aria-label={emoji === ourReaction ? 'Remover reação' : `Reagir com ${emoji}`}
                    className={cn(
                      "text-2xl p-2 hover:bg-muted rounded-full active:scale-[0.96] transition-transform duration-100 ease-out touch-manipulation",
                      emoji === ourReaction && "bg-primary/10 ring-1 ring-primary/30"
                    )}
                  >
                    {emoji}
                  </button>
                ))}
                <button
                  onClick={() => setShowFullReactionGrid(true)}
                  aria-label="Abrir todos os emojis"
                  className="p-3 rounded-full hover:bg-muted active:scale-[0.96] transition-transform duration-100 ease-out touch-manipulation"
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>
            )
          )}

          {/* Action buttons */}
          <div className="p-2 space-y-1">
            {/* Copy */}
            {text && (
              <button
                onClick={handleCopyText}
                className="flex items-center gap-4 w-full p-4 rounded-xl hover:bg-accent active:bg-accent touch-manipulation"
              >
                <Copy className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium">Copiar texto</span>
              </button>
            )}

            {/* Reply */}
            {onReply && (
              <button
                onClick={handleMenuReply}
                className="flex items-center gap-4 w-full p-4 rounded-xl hover:bg-accent active:bg-accent touch-manipulation"
              >
                <Reply className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium">Responder</span>
              </button>
            )}

            {/* Forward */}
            {onForward && (
              <button
                onClick={() => {
                  onForward();
                  setIsLongPressMenuOpen(false);
                }}
                className="flex items-center gap-4 w-full p-4 rounded-xl hover:bg-accent active:bg-accent touch-manipulation"
              >
                <Forward className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium">Encaminhar</span>
              </button>
            )}

            {/* Download — qualquer anexo */}
            {downloadHref && !isDeleted && (
              <a
                href={downloadHref}
                download={downloadName!}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setIsLongPressMenuOpen(false)}
                className="flex items-center gap-4 w-full p-4 rounded-xl hover:bg-accent active:bg-accent touch-manipulation"
              >
                <Download className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium">Baixar</span>
              </a>
            )}

            {/* Save sticker */}
            {onSaveSticker && (
              <button
                onClick={() => {
                  onSaveSticker();
                  setIsLongPressMenuOpen(false);
                }}
                className="flex items-center gap-4 w-full p-4 rounded-xl hover:bg-accent active:bg-accent touch-manipulation"
              >
                <Plus className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium">Salvar nas figurinhas</span>
              </button>
            )}

            {/* Edit */}
            {canEdit && (
              <button
                onClick={handleMenuEdit}
                className="flex items-center gap-4 w-full p-4 rounded-xl hover:bg-accent active:bg-accent touch-manipulation"
              >
                <Pencil className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium">Editar</span>
              </button>
            )}

            {/* Delete */}
            {canDelete && (
              <button
                onClick={handleMenuDelete}
                className="flex items-center gap-4 w-full p-4 rounded-xl hover:bg-accent active:bg-accent touch-manipulation"
              >
                <Trash2 className="w-5 h-5 text-destructive" />
                <span className="font-medium text-destructive">Apagar para todos</span>
              </button>
            )}

            {/* Cancel */}
            <button
              onClick={() => setIsLongPressMenuOpen(false)}
              className="flex items-center gap-4 w-full p-4 rounded-xl hover:bg-accent active:bg-accent touch-manipulation mt-2"
            >
              <X className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium">Cancelar</span>
            </button>
          </div>
        </DrawerContent>
      </Drawer>
    );
  };

  // Mobile swipe-to-reply wrapper — também função de render, pelo mesmo motivo
  // do renderLongPressMenu (evita remount da bolha a cada re-render).
  const renderSwipeWrapper = (children: React.ReactNode) => {
    if (!isMobile || !onReply || selectionMode) {
      return <>{children}</>;
    }

    return (
      <div className="relative">
        {/* Reply indicator - shows during swipe */}
        <motion.div
          className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-full pr-2"
          style={{ opacity: replyIconOpacity, scale: replyIconScale }}
        >
          <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
            <Reply className="w-4 h-4 text-primary" />
          </div>
        </motion.div>

        {/* Swipeable content */}
        <motion.div
          style={{ x }}
          animate={controls}
          drag="x"
          dragConstraints={{ left: 0, right: 80 }}
          dragDirectionLock
          dragElastic={0.1}
          onDragEnd={handlePanEnd}
          className="touch-pan-y"
        >
          {children}
        </motion.div>
      </div>
    );
  };

  // Sticker sem citação renderiza "solto", sem a moldura da bolha (como no
  // WhatsApp). Com quote ou apagada, a bolha volta — o conteúdo extra
  // precisa do fundo para continuar legível. Erro de mídia NÃO devolve a bolha:
  // o padding mudaria e a linha trocaria de altura.
  const bareSticker =
    isSticker && !!media_url && !quotedContent && !isDeleted;

  const bubbleTree = (
    <>
      {/* Long-press menu portal */}
      {isMobile && !selectionMode && renderLongPressMenu()}

      <div id={id} className={cn("flex flex-col", isOutbound ? "items-end" : "items-start")}>
        <div
          className={cn(
            "max-w-[85%] sm:max-w-[70%] rounded-2xl px-4 py-2 shadow-sm overflow-hidden",
            isMobile && "select-none",
            isOutbound
              ? "bg-chat-bubble-user text-chat-bubble-user-foreground"
              : "bg-chat-bubble-contact text-chat-bubble-contact-foreground",
            bareSticker && "bg-transparent px-0 py-0 shadow-none text-foreground overflow-visible",
            (status === "error" || status === "failed") && "opacity-70 border-2 border-destructive",
            // Apagada continua legível, só recua: o conteúdo é preservado de propósito.
            isDeleted && "opacity-70",
            isCurrentSearchMatch && "ring-2 ring-primary ring-offset-2"
          )}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchMove={handleTouchMove}
          onContextMenu={(e) => {
            if (isMobile) {
              e.preventDefault();
              setIsLongPressMenuOpen(true);
            }
          }}
        >
        {/* Sender name for group messages — cor estável por participante */}
        {senderName && !isOutbound && (
          <p
            className={cn("text-xs font-semibold mb-1", !senderColorIndex && "opacity-80")}
            style={senderColorIndex ? { color: senderColorCss(senderColorIndex) } : undefined}
          >
            {senderName}
          </p>
        )}

        {/* Canal da bolha: Direct sempre; no card juntado, também WhatsApp (decisão C1) */}
        {metadata?.canal === 'instagram' && !isDeleted ? (
          <p className="text-xs opacity-70 mb-1 flex items-center gap-1 text-pink-700 dark:text-pink-400">
            <Instagram className="w-3 h-3 shrink-0" strokeWidth={1.5} />
            Instagram
          </p>
        ) : mostrarCanal && !isDeleted ? (
          <p className="text-xs opacity-70 mb-1 flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <MessageSquare className="w-3 h-3 shrink-0" />
            WhatsApp
          </p>
        ) : null}

        {/* Disparo: a bolha diz que não foi conversa escrita à mão */}
        {metadata?.disparo && !isDeleted && (
          <p className="text-xs opacity-70 mb-1 flex items-center gap-1">
            <Megaphone className="w-3 h-3 shrink-0" />
            {metadata.disparo.rotulo ? `Disparo · ${metadata.disparo.rotulo}` : "Disparo"}
          </p>
        )}

        {/* Forwarded label */}
        {metadata?.forwarded && !isDeleted && (
          <p className="text-xs italic opacity-60 mb-1 flex items-center gap-1">
            <Forward className="w-3 h-3 shrink-0" />
            {metadata.frequently_forwarded ? 'Encaminhada muitas vezes' : 'Encaminhada'}
          </p>
        )}

        {lateSentAt && !isDeleted && (
          <p
            className="text-xs italic opacity-60 mb-1 flex items-center gap-1"
            title="O WhatsApp entregou esta mensagem ao Echo com atraso. A janela de 24h conta a partir do envio."
          >
            <Clock className="w-3 h-3 shrink-0" />
            Enviada em {format(lateSentAt, "dd/MM 'às' HH:mm", { locale: ptBR })} · chegou atrasada
          </p>
        )}

        {/* View-once com mídia baixada: marcador discreto (a cópia fica visível) */}
        {metadata?.view_once && !isDeleted && isMediaMessage && (
          <p className="text-xs italic opacity-60 mb-1 flex items-center gap-1">
            <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-current text-2xs leading-none shrink-0">1</span>
            Ver uma vez
          </p>
        )}

        {/* View-once SEM mídia: o WhatsApp não entrega a chave a dispositivos
            vinculados (mesma limitação do WhatsApp Web) — placeholder honesto
            no lugar de bolha vazia. */}
        {metadata?.view_once && !isDeleted && !isMediaMessage && (
          <div className="flex items-center gap-2.5 py-1.5 pr-2 min-w-[210px]">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-full border-2 border-current/40 text-sm font-semibold shrink-0 opacity-70">1</span>
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {message_type === 'image'
                  ? 'Foto'
                  : message_type === 'video'
                  ? 'Vídeo'
                  : message_type === 'audio' || message_type === 'ptt'
                  ? 'Áudio'
                  : 'Mídia'}{' '}
                de visualização única
              </p>
              <p className="text-xs opacity-60">Disponível apenas no celular conectado</p>
            </div>
          </div>
        )}

        {/* Quoted message preview */}
        {quotedContent && (
          <div
            className={cn(
              "mb-2 px-3 py-1.5 rounded-sm border-l-2 opacity-70 flex gap-2",
              isOutbound
                ? "bg-chat-bubble-user-foreground/10 border-chat-bubble-user-foreground/50"
                : "bg-chat-bubble-contact-foreground/10 border-chat-bubble-contact-foreground/50",
              quotedMessageId && onQuotedClick && "cursor-pointer hover:opacity-90"
            )}
            style={
              // Barra de acento na cor do AUTOR da mensagem citada (paridade wpp)
              quotedDirection !== 'outbound' && quotedSenderColorIndex
                ? { borderLeftColor: senderColorCss(quotedSenderColorIndex) }
                : undefined
            }
            onClick={() => quotedMessageId && onQuotedClick?.(quotedMessageId)}
          >
            {/* Quoted media thumbnail */}
            {quotedMediaUrl && ['image', 'sticker'].includes(quotedMessageType || '') && (
              <img
                src={quotedMediaUrl}
                alt="Quoted"
                className="w-10 h-10 object-cover rounded shrink-0"
              />
            )}
            {quotedMediaUrl && quotedMessageType === 'video' && (
              <div className="w-10 h-10 bg-black/20 rounded shrink-0 flex items-center justify-center">
                <span className="text-lg">▶</span>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p
                className="text-2xs font-medium opacity-80 mb-0.5"
                style={
                  quotedDirection !== 'outbound' && quotedSenderColorIndex
                    ? { color: senderColorCss(quotedSenderColorIndex) }
                    : undefined
                }
              >
                {quotedDirection === 'outbound' ? 'Você' : (quotedSenderLabel || 'Contato')}
              </p>
              {quotedMessageType === 'contact' ? (
                <p className="text-message-xs flex items-center gap-1">
                  <User className="w-3 h-3 shrink-0" />
                  Contato
                </p>
              ) : (
                <p dir="auto" className="text-message-xs line-clamp-2 break-words [overflow-wrap:anywhere]">
                  {quotedContent.split('\n\n---BUTTONS---')[0].slice(0, 100)}
                  {quotedContent.length > 100 && '…'}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Media content */}
        {renderMedia()}

        {/* Contact card */}
        {renderContactCard()}

        {/* Location card */}
        {parsedLocation && (
          <LocationBubble location={parsedLocation} isOutbound={isOutbound} />
        )}

        {/* Link preview card (acima do texto, como no WhatsApp) */}
        {linkPreview && !isDeleted && (
          <LinkPreviewCard preview={linkPreview} isOutbound={isOutbound} />
        )}

        {/* Enquete */}
        {parsedPoll && (
          <PollBubble
            poll={parsedPoll}
            isOutbound={isOutbound}
            onVote={onPollVote}
            participantLookup={participantLookup}
            groupParticipants={groupParticipants}
          />
        )}

        {/* Interactive list message */}
        {renderListMessage()}

        {/* Mensagens apagadas no formato legado perderam conteúdo e tipo no banco, então só
            resta o aviso fixo. No soft delete atual o tipo é preservado e a mensagem cai no
            ramo normal abaixo (mídia inclusive) — quem sinaliza é a tag na linha de metadados. */}
        {message_type === 'deleted' ? (
          <p className="text-message italic opacity-60 flex items-center gap-1.5">
            <Trash2 className="w-3.5 h-3.5 shrink-0" />
            Esta mensagem foi apagada
          </p>
        ) : (
          /* Text content - show if not placeholder text for media/contact/list (but show contact text as fallback if metadata missing) */
          !parsedLocation && !parsedPoll && !parsedPix &&
          text && !['[Imagem]', '[Vídeo]', '[Áudio]', '[Arquivo de Áudio]', '[Documento]', '[Sticker]', '[Visualização única]'].includes(text) &&
          (!(text === '[Contato]' || text.startsWith('[Contato:')) || (message_type === 'contact' && !metadata?.contact)) &&
          (!(text === '[Lista]' || text.startsWith('[Lista]')) || (message_type === 'list' && !metadata?.list)) && (
            // break-words: break-all partia palavras comuns no meio ("disponibi/lidade")
            // dir="auto": mensagem em árabe/hebraico chega pelo WhatsApp; sem isso a
            // pontuação e telefones embutidos pulam para o lado errado da linha.
            <p dir="auto" className="text-message break-words [overflow-wrap:anywhere]">{renderFormattedText(text)}</p>
          )
        )}

        {/* Pix nativo: o card É a mensagem (a chave não está no texto). */}
        {parsedPix && <PixBubble pix={parsedPix} isOutbound={isOutbound} />}

        {/* Flow response data */}
        {renderFlowResponse()}

        {/* Template Buttons - hide for media messages */}
        {buttons.length > 0 && !isMediaMessage && (
          <div className="flex flex-col gap-2 mt-3 pt-3 border-t border-current/20">
            {buttons.map((btn, idx) => (
              <Button
                key={idx}
                variant="outline"
                size="sm"
                className={cn(
                  "w-full justify-center text-xs font-medium",
                  isOutbound
                    ? "bg-chat-bubble-user-foreground/10 border-chat-bubble-user-foreground/30 text-chat-bubble-user-foreground hover:bg-chat-bubble-user-foreground/20"
                    : "bg-chat-bubble-contact-foreground/10 border-chat-bubble-contact-foreground/30 text-chat-bubble-contact-foreground hover:bg-chat-bubble-contact-foreground/20",
                  (btn.type === "url" || btn.type === "phone") && "cursor-pointer"
                )}
                onClick={() => handleButtonClick(btn)}
              >
                {btn.type === "url" && <ExternalLink className="w-3 h-3 mr-2" />}
                {btn.type === "phone" && <Phone className="w-3 h-3 mr-2" />}
                {btn.text}
              </Button>
            ))}
          </div>
        )}

        <div
          className={cn(
            "flex items-center gap-1.5 mt-1",
            isOutbound
              ? "text-chat-bubble-user-foreground/70"
              : "text-chat-bubble-contact-foreground/70"
          )}
        >
          <Tooltip delayDuration={600}>
            <TooltipTrigger asChild>
              <span className="text-xs cursor-default">
                {format(new Date(timestamp), "HH:mm", { locale: ptBR })}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {format(new Date(timestamp), "EEEE, d 'de' MMMM 'de' yyyy 'às' HH:mm", { locale: ptBR })}
            </TooltipContent>
          </Tooltip>
          {isDeleted && message_type !== 'deleted' && (
            <span className="text-xs italic opacity-60 flex items-center gap-1">
              <Trash2 className="w-3 h-3 shrink-0" />
              {isOutbound ? "apagada por você" : "apagada pelo contato"}
            </span>
          )}
          {is_edited && !isDeleted && (
            editContentUnavailable ? (
              <span className="text-xs italic opacity-60" title="O contato editou esta mensagem, mas o texto novo não chegou">
                editado (texto anterior)
              </span>
            ) : hasEditHistory ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="text-xs italic opacity-60 underline decoration-dotted underline-offset-2 hover:opacity-100 transition-opacity"
                    aria-label="Ver versão anterior da mensagem"
                  >
                    editado
                  </button>
                </PopoverTrigger>
                <PopoverContent align={isOutbound ? "end" : "start"} className="w-72 p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    {editHistory!.length > 1 ? "Versões anteriores" : "Versão anterior"}
                  </p>
                  <div className="flex flex-col gap-2 max-h-56 overflow-y-auto">
                    {editHistory!.map((version, idx) => (
                      <div key={`${version.at}-${idx}`} className="flex flex-col gap-0.5">
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {format(new Date(version.at), "dd/MM 'às' HH:mm", { locale: ptBR })}
                        </span>
                        <span dir="auto" className="text-message break-words [overflow-wrap:anywhere]">{version.content}</span>
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            ) : (
              <span className="text-xs italic opacity-60">editado</span>
            )
          )}
          {isOutbound && statusTick && (
            showReceiptsPopover && status !== "sending" ? (
              // Em grupo (QR) os risquinhos abrem "quem leu" por participante.
              // Inclui status "sent" de propósito: mensagens anteriores ao
              // fan-out de recibos pararam nele e o estado vazio explica.
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Ver confirmações de leitura"
                    className="inline-flex rounded-sm transition-opacity hover:opacity-70"
                  >
                    {statusTick}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-0">
                  <ReadReceiptsPopover messageId={messageId!} participantLookup={participantLookup} />
                </PopoverContent>
              </Popover>
            ) : (
              statusTick
            )
          )}
          {isOutbound && (status === "error" || status === "failed") && (
            <AlertCircle className="w-4 h-4 text-destructive" />
          )}
          {/* Reply button — só desktop: no touch os alvos de ~22px eram
              inúteis e o long-press/swipe já cobre responder */}
          {onReply && !isMobile && !selectionMode && (
            <button
              onClick={onReply}
              className={cn(
                "ml-1 p-0.5 rounded hover:bg-current/10 transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 opacity-100 [@media(hover:hover)]:opacity-60 hover:opacity-100",
                "touch-action-manipulation"
              )}
              title="Responder"
            >
              <Reply className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Forward button — ao lado do responder, mesmo affordance */}
          {onForward && !isMobile && !selectionMode && (
            <button
              onClick={onForward}
              className={cn(
                "ml-1 p-0.5 rounded hover:bg-current/10 transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 opacity-100 [@media(hover:hover)]:opacity-60 hover:opacity-100",
                "touch-action-manipulation"
              )}
              title="Encaminhar"
            >
              <Forward className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Baixar — imagem, vídeo e figurinha (documento e áudio baixam na bolha) */}
          {showToolbarDownload && !isMobile && !selectionMode && (
            <a
              href={downloadHref!}
              download={downloadName!}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "ml-1 p-0.5 rounded hover:bg-current/10 transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 opacity-100 [@media(hover:hover)]:opacity-60 hover:opacity-100",
                "touch-action-manipulation"
              )}
              title="Baixar"
              aria-label="Baixar"
            >
              <Download className="w-3.5 h-3.5" />
            </a>
          )}
          {/* Edit/Delete menu - only for outbound messages on QR connections */}
          {/* Note: Edit is disabled for media messages as WhatsApp doesn't support caption editing after send */}
          {isOutbound && isQrConnection && !isMobile && !selectionMode && status !== "error" && status !== "failed" && !isDeleted && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    "ml-1 p-0.5 rounded hover:bg-current/10 transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 opacity-100 [@media(hover:hover)]:opacity-60 hover:opacity-100",
                    "touch-action-manipulation"
                  )}
                  title="Mais opções"
                >
                  <MoreVertical className="w-3.5 h-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onEdit && isWithinEditWindow && (
                  <DropdownMenuItem onClick={onEdit}>
                    <Pencil className="w-4 h-4 mr-2" />
                    Editar
                  </DropdownMenuItem>
                )}
                {/* Copiar a legenda de mídia (texto puro tem seleção nativa) */}
                {isMediaMessage && text && !['[Imagem]', '[Vídeo]', '[Áudio]', '[Sticker]'].includes(text) && (
                  <DropdownMenuItem
                    onClick={() => {
                      navigator.clipboard.writeText(text);
                      toast({ description: "Legenda copiada" });
                    }}
                  >
                    <Copy className="w-4 h-4 mr-2" />
                    Copiar legenda
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
                    <Trash2 className="w-4 h-4 mr-2" />
                    Apagar para todos
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Reaction emoji badges */}
      {displayReactions.length > 0 && (
        <div className={cn(
          "flex gap-1",
          isOutbound ? "justify-end" : "justify-start"
        )}>
          <ReactionPills
            reactions={displayReactions}
            isOutbound={isOutbound}
            onReact={onReact}
          />
        </div>
      )}

      {/* Reaction picker — canais com suporte a reação (QR e Business API).
          Sempre visível (trocar de reação é toque direto, sem remover antes).
          Só desktop: no touch o quick-picker do long-press cobre reagir. */}
      {reactionsEnabled && !isMobile && !selectionMode && !isDeleted && onReact && (
        <div className={cn(
          "flex",
          isOutbound ? "justify-end" : "justify-start"
        )}>
          <ReactionPicker
            onReact={onReact}
            ourReaction={ourReaction}
            isOutbound={isOutbound}
          />
        </div>
      )}

      {/* !isDeleted: linha falhada descartada (soft-delete) vira tombstone —
          sem o guard ela empilharia tombstone + erro + Reenviar. */}
      {(status === "error" || status === "failed") && error && !isDeleted && (
        <div className="flex flex-col items-end gap-1.5 mt-1">
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertCircle className="w-3 h-3 shrink-0" />
            {/* title: o erro é o texto que o usuário copia para o suporte — cortado
                em duas linhas ele não pode sumir. */}
            <span className="line-clamp-2" title={error}>Falha no envio: {error}</span>
          </div>
          {/* Erro sempre com saída: reenviar, copiar o texto ou descartar */}
          <div className="flex items-center gap-2">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="min-h-[32px] rounded-md border border-destructive/40 px-2.5 text-xs font-medium text-destructive transition-transform duration-150 ease-out active:scale-[0.96] hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Reenviar
              </button>
            )}
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(content)}
              className="min-h-[32px] rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-transform duration-150 ease-out active:scale-[0.96] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Copiar texto
            </button>
            {onDiscard && (
              <button
                type="button"
                onClick={onDiscard}
                className="min-h-[32px] rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-transform duration-150 ease-out active:scale-[0.96] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Descartar
              </button>
            )}
          </div>
        </div>
      )}
      </div>
    </>
  );

  // Em modo de seleção a linha inteira vira alvo de clique: o conteúdo fica
  // inerte (pointer-events-none derruba lightbox, links, player e as ações de
  // hover de uma vez) e ganha checkbox à esquerda. Mensagem não encaminhável
  // — ou lote cheio — entra opaca e fora do alcance do clique.
  if (selectionMode) {
    return (
      <div
        role="checkbox"
        aria-checked={isSelected}
        aria-disabled={selectionDisabled || undefined}
        aria-label={senderName ? `Mensagem de ${senderName}` : "Mensagem"}
        tabIndex={selectionDisabled ? -1 : 0}
        onClick={() => {
          if (!selectionDisabled) onToggleSelect?.();
        }}
        onKeyDown={(e) => {
          if (selectionDisabled) return;
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onToggleSelect?.();
          }
        }}
        className={cn(
          "-mx-2 flex items-center gap-3 rounded-xl px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selectionDisabled
            ? "opacity-40 cursor-not-allowed"
            : "cursor-pointer hover:bg-muted/50",
          isSelected && !selectionDisabled && "bg-primary/10"
        )}
      >
        <Checkbox
          checked={isSelected}
          disabled={selectionDisabled}
          className="pointer-events-none shrink-0"
          tabIndex={-1}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 pointer-events-none select-none">{bubbleTree}</div>
      </div>
    );
  }

  return renderSwipeWrapper(bubbleTree);
};

// Custom comparison function - ignore callback props to prevent unnecessary re-renders
// This is critical for audio playback stability
const arePropsEqual = (prevProps: MessageBubbleProps, nextProps: MessageBubbleProps): boolean => {
  // Only compare props that affect visual rendering
  return (
    prevProps.content === nextProps.content &&
    prevProps.direction === nextProps.direction &&
    prevProps.timestamp === nextProps.timestamp &&
    prevProps.status === nextProps.status &&
    prevProps.error === nextProps.error &&
    prevProps.message_type === nextProps.message_type &&
    prevProps.media_url === nextProps.media_url &&
    prevProps.media_mime_type === nextProps.media_mime_type &&
    prevProps.media_filename === nextProps.media_filename &&
    prevProps.senderName === nextProps.senderName &&
    prevProps.senderColorIndex === nextProps.senderColorIndex &&
    prevProps.quotedContent === nextProps.quotedContent &&
    prevProps.quotedDirection === nextProps.quotedDirection &&
    prevProps.quotedMediaUrl === nextProps.quotedMediaUrl &&
    prevProps.quotedMessageType === nextProps.quotedMessageType &&
    prevProps.quotedMessageId === nextProps.quotedMessageId &&
    prevProps.quotedSenderLabel === nextProps.quotedSenderLabel &&
    prevProps.quotedSenderColorIndex === nextProps.quotedSenderColorIndex &&
    prevProps.isQrConnection === nextProps.isQrConnection &&
    prevProps.reactionsEnabled === nextProps.reactionsEnabled &&
    prevProps.mostrarCanal === nextProps.mostrarCanal &&
    prevProps.mediaBox?.width === nextProps.mediaBox?.width &&
    prevProps.mediaBox?.height === nextProps.mediaBox?.height &&
    prevProps.mediaBox?.fit === nextProps.mediaBox?.fit &&
    prevProps.mediaBox?.source === nextProps.mediaBox?.source &&
    prevProps.reaction === nextProps.reaction &&
    prevProps.ourReaction === nextProps.ourReaction &&
    // Agregado por reator (novo modelo); arrays pequenos — JSON compare basta
    JSON.stringify(prevProps.reactions) === JSON.stringify(nextProps.reactions) &&
    prevProps.id === nextProps.id &&
    // Gate do popover de recibos — escalares estáveis, custo zero no compare.
    prevProps.messageId === nextProps.messageId &&
    prevProps.isGroup === nextProps.isGroup &&
    prevProps.searchTerm === nextProps.searchTerm &&
    prevProps.isCurrentSearchMatch === nextProps.isCurrentSearchMatch &&
    prevProps.isMobile === nextProps.isMobile &&
    prevProps.is_edited === nextProps.is_edited &&
    prevProps.is_deleted === nextProps.is_deleted &&
    // Seleção: sem estas três o checkbox não repinta (o comparador ignora
    // callbacks de propósito, então onToggleSelect não sinaliza nada).
    prevProps.selectionMode === nextProps.selectionMode &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.selectionDisabled === nextProps.selectionDisabled &&
    // Comprimento basta: o histórico só cresce, nunca reescreve versão já gravada.
    (prevProps.editHistory?.length ?? 0) === (nextProps.editHistory?.length ?? 0) &&
    prevProps.editContentUnavailable === nextProps.editContentUnavailable &&
    // Deep compare flowResponseJson (usually small object or null)
    JSON.stringify(prevProps.flowResponseJson) === JSON.stringify(nextProps.flowResponseJson) &&
    JSON.stringify(prevProps.metadata) === JSON.stringify(nextProps.metadata) &&
    JSON.stringify(prevProps.participantLookup) === JSON.stringify(nextProps.participantLookup) &&
    JSON.stringify(prevProps.groupParticipants) === JSON.stringify(nextProps.groupParticipants)
  );
};

export default memo(MessageBubble, arePropsEqual);