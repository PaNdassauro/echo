import { useState, useRef, useEffect, useCallback, useMemo, memo, forwardRef, useImperativeHandle } from "react";
import { Textarea } from "@/components/ui/textarea";
import MentionPopup, { MentionParticipant, MENTION_ALL_ID } from "@/components/MentionPopup";
import QuickReplyPopup from "@/components/chat/QuickReplyPopup";
import { useQuickReplies, QuickReply } from "@/hooks/useQuickReplies";
import { A11Y_CHANGE_EVENT } from "@/lib/accessibilityPrefs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Acima disso, "Marcar todos" pede confirmação: notificar centenas de pessoas
// é barulhento e tem risco de denúncia/spam no WhatsApp.
const MENTION_ALL_CONFIRM_THRESHOLD = 50;

export interface ChatInputRef {
  focus: () => void;
  clear: () => void;
  getValue: () => string;
  setValue: (value: string) => void;
  addText: (text: string) => void;
  submit: () => void;
  isEmpty: () => boolean;
}

interface ChatInputProps {
  onSubmit: (message: string, mentionJids?: string[], quotedMessageId?: string | null) => void;
  onPaste?: (e: React.ClipboardEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onMessageChange?: (hasContent: boolean) => void;
  /** Valor inicial do campo (restauração de rascunho — o componente remonta por conversa). */
  initialValue?: string;
  /** Notifica o texto cru a cada mudança (persistência de rascunho no chamador). */
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  // Reply support
  quotedMessageId?: string | null;
  // Group mention support
  isGroupChat?: boolean;
  isQrConnection?: boolean;
  groupParticipants?: MentionParticipant[];
  // Mobile flag - don't refocus after send
  isMobile?: boolean;
  /** UUID da linha na tabela phone_numbers (frases prontas via "/"). */
  phoneNumberDbId?: string | null;
}

const ChatInput = memo(forwardRef<ChatInputRef, ChatInputProps>(({
  onSubmit,
  onPaste,
  onKeyDown,
  onMessageChange,
  initialValue = "",
  onValueChange,
  disabled = false,
  placeholder = "Digite sua mensagem…",
  quotedMessageId,
  isGroupChat = false,
  isQrConnection = false,
  groupParticipants = [],
  isMobile = false,
  phoneNumberDbId = null,
}, ref) => {
  // Local state - isolated from parent re-renders
  const [message, setMessage] = useState(initialValue);
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStartIndex, setMentionStartIndex] = useState<number | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<MentionParticipant[]>([]);
  // Confirmação do "Marcar todos" em grupos grandes: guarda o texto/cursor
  // calculados no momento da seleção para aplicar só se o usuário confirmar.
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const pendingAllRef = useRef<{ newText: string; cursorPos: number } | null>(null);

  // Frases prontas ("/atalho"): token análogo à menção, mas com Escape
  // persistente — quem digita "/" literal e fechou o popup não pode tê-lo
  // reabrindo a cada tecla no mesmo token.
  const { quickReplies, ensureFetched } = useQuickReplies(phoneNumberDbId);
  const [slashStartIndex, setSlashStartIndex] = useState<number | null>(null);
  const [slashQuery, setSlashQuery] = useState("");
  const [quickReplyActiveIndex, setQuickReplyActiveIndex] = useState(0);
  const dismissedSlashIndexRef = useRef<number | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Ref to store latest submit function for useImperativeHandle
  const submitRef = useRef<() => void>(() => {});

  // Submit message - defined before useImperativeHandle
  const handleSubmit = useCallback(() => {
    if (!message.trim() || disabled) return;

    // Set: @todos 2x ou @todos + menção individual geram jids duplicados no
    // array append-only — dedupe aqui cobre todas as combinações.
    const mentionJids = selectedMentions.length > 0
      ? [...new Set(selectedMentions.map((m) => m.jid))]
      : undefined;

    onSubmit(message.trim(), mentionJids, quotedMessageId);
    setMessage("");
    setSelectedMentions([]);

    // Re-focus textarea after sending (only on desktop)
    if (!isMobile) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [message, disabled, selectedMentions, quotedMessageId, onSubmit, isMobile]);

  // Keep submitRef updated
  useEffect(() => {
    submitRef.current = handleSubmit;
  }, [handleSubmit]);

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    clear: () => {
      setMessage("");
      setSelectedMentions([]);
    },
    getValue: () => message,
    setValue: (value: string) => setMessage(value),
    addText: (text: string) => {
      setMessage(prev => prev + text);
      textareaRef.current?.focus();
    },
    submit: () => submitRef.current(),
    isEmpty: () => !message.trim(),
  }), [message]);

  // Notify parent when message content changes
  useEffect(() => {
    onMessageChange?.(!!message.trim());
    onValueChange?.(message);
  }, [message, onMessageChange, onValueChange]);

  // Auto-resize textarea (pela scrollHeight, então acompanha o tamanho do texto)
  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const newHeight = Math.min(textarea.scrollHeight, 200);
    textarea.style.height = `${newHeight}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [message, resizeTextarea]);

  // A altura também depende da LARGURA (o texto, e até o placeholder, quebra
  // linha): medido enquanto o campo estava estreito (abertura do chat, coluna
  // da lista arrastada), o placeholder sozinho passava de 200px e o campo
  // ficava gigante até digitar. Refaz a medida quando a largura muda (só a
  // largura: a altura muda por causa da própria medida).
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    let lastWidth = textarea.offsetWidth;
    const observer = new ResizeObserver(() => {
      const width = textarea.offsetWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      resizeTextarea();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  // Trocar o "Tamanho do texto das mensagens" com rascunho no campo muda a
  // altura das linhas sem mudar `message`: refaz a medida.
  useEffect(() => {
    window.addEventListener(A11Y_CHANGE_EVENT, resizeTextarea);
    return () => window.removeEventListener(A11Y_CHANGE_EVENT, resizeTextarea);
  }, [resizeTextarea]);

  // Mention detection — separada do onChange porque também roda quando a lista
  // de participantes chega DEPOIS de o usuário digitar "@" (a busca de metadata
  // do grupo leva segundos; sem isso o popup só aparecia na próxima tecla).
  // Retorna true quando o popup de menção está ativo — o handleChange usa
  // isso para suprimir a detecção de "/" (exclusão mútua entre os popups).
  const detectMention = useCallback((value: string, cursorPosition: number): boolean => {
    // Mention logic for groups
    if (!isGroupChat || !isQrConnection || groupParticipants.length === 0) {
      setShowMentionPopup(false);
      return false;
    }

    const textBeforeCursor = value.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");

    if (lastAtIndex === -1) {
      setShowMentionPopup(false);
      setMentionStartIndex(null);
      return false;
    }

    const charBeforeAt = lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : " ";
    if (charBeforeAt !== " " && charBeforeAt !== "\n" && lastAtIndex !== 0) {
      setShowMentionPopup(false);
      setMentionStartIndex(null);
      return false;
    }

    const query = textBeforeCursor.slice(lastAtIndex + 1);
    if (query.includes(" ")) {
      setShowMentionPopup(false);
      setMentionStartIndex(null);
      return false;
    }

    setMentionStartIndex(lastAtIndex);
    setMentionQuery(query);
    setShowMentionPopup(true);
    return true;
  }, [isGroupChat, isQrConnection, groupParticipants.length]);

  // Mesma detecção de token da menção, para "/": só no início ou após
  // espaço/quebra, query sem espaço. Escape persistente via
  // dismissedSlashIndexRef — o índice dispensado só volta a abrir quando o
  // token some ou muda de posição.
  const detectSlashCommand = useCallback((value: string, cursorPosition: number) => {
    const textBeforeCursor = value.slice(0, cursorPosition);
    const lastSlashIndex = textBeforeCursor.lastIndexOf("/");

    if (lastSlashIndex === -1) {
      setSlashStartIndex(null);
      dismissedSlashIndexRef.current = null;
      return;
    }

    const charBefore = lastSlashIndex > 0 ? textBeforeCursor[lastSlashIndex - 1] : " ";
    if (charBefore !== " " && charBefore !== "\n" && lastSlashIndex !== 0) {
      setSlashStartIndex(null);
      return;
    }

    const query = textBeforeCursor.slice(lastSlashIndex + 1);
    if (query.includes(" ") || query.includes("\n")) {
      setSlashStartIndex(null);
      return;
    }

    if (dismissedSlashIndexRef.current !== null && dismissedSlashIndexRef.current !== lastSlashIndex) {
      dismissedSlashIndexRef.current = null;
    }
    if (lastSlashIndex === dismissedSlashIndexRef.current) {
      setSlashStartIndex(null);
      return;
    }

    setSlashStartIndex(lastSlashIndex);
    setSlashQuery(query);
    ensureFetched();
  }, [ensureFetched]);

  // Handle text change with mention/slash detection
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    const mentionActive = detectMention(e.target.value, e.target.selectionStart || 0);
    if (mentionActive) {
      setSlashStartIndex(null);
    } else {
      detectSlashCommand(e.target.value, e.target.selectionStart || 0);
    }
  }, [detectMention, detectSlashCommand]);

  // Participantes carregaram (ou o grupo mudou) com o composer em foco: reavalia
  // o "@" já digitado em vez de esperar a próxima tecla.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || document.activeElement !== textarea) return;
    if (detectMention(textarea.value, textarea.selectionStart || 0)) {
      setSlashStartIndex(null);
    }
  }, [detectMention]);

  // Lista do popup de "/" já filtrada aqui (não no popup): a visibilidade é
  // derivada de "tem match" — query sem resultado fecha o popup e devolve o
  // Enter ao envio normal, e quem digita "/" literal não fica bloqueado.
  const filteredQuickReplies = useMemo(() => {
    if (slashStartIndex === null || quickReplies.length === 0) return [];
    const q = slashQuery.toLowerCase();
    return quickReplies.filter(
      (r) => r.shortcut.includes(q) || r.content.toLowerCase().includes(q)
    );
  }, [slashStartIndex, slashQuery, quickReplies]);
  const showQuickReplyPopup = filteredQuickReplies.length > 0;

  const closeQuickReplyPopup = useCallback(() => {
    dismissedSlashIndexRef.current = slashStartIndex;
    setSlashStartIndex(null);
  }, [slashStartIndex]);

  // Insere o conteúdo da frase no lugar do token "/query" — sem enviar; o
  // envio continua manual (Enter/botão depois da revisão do texto).
  const handleQuickReplySelect = useCallback((reply: QuickReply) => {
    if (slashStartIndex === null) return;

    const before = message.slice(0, slashStartIndex);
    const after = message.slice(slashStartIndex + slashQuery.length + 1);
    const newText = `${before}${reply.content}${after}`;
    const cursorPos = before.length + reply.content.length;

    setSlashStartIndex(null);
    setSlashQuery("");
    setMessage(newText);

    setTimeout(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(cursorPos, cursorPos);
      }
    }, 0);
  }, [message, slashStartIndex, slashQuery]);

  // Aplica texto+cursor e registra os JIDs mencionados (individual ou todos).
  const applyMention = useCallback((newText: string, cursorPos: number, mentioned: MentionParticipant[]) => {
    setMessage(newText);
    setSelectedMentions(prev => [...prev, ...mentioned]);

    // Focus back and move cursor
    setTimeout(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(cursorPos, cursorPos);
      }
    }, 0);
  }, []);

  // Handle mention selection
  const handleMentionSelect = useCallback((participant: MentionParticipant) => {
    if (mentionStartIndex === null) return;

    const isAll = participant.id === MENTION_ALL_ID;
    const beforeMention = message.slice(0, mentionStartIndex);
    const afterMention = message.slice(mentionStartIndex + mentionQuery.length + 1);
    // Só o sufixo @s.whatsapp.net era removido: participante @lid ainda não
    // resolvido caía aqui com o jid cru e injetava "@123456@lid" no texto. O JID
    // de fato mencionado continua sendo participant.jid, intocado.
    const insertToken = isAll
      ? "todos"
      : participant.jid.replace("@s.whatsapp.net", "").replace("@lid", "");
    const newText = `${beforeMention}@${insertToken} ${afterMention}`;
    const cursorPos = beforeMention.length + insertToken.length + 2;

    setShowMentionPopup(false);
    setMentionStartIndex(null);
    setMentionQuery("");

    if (isAll && groupParticipants.length > MENTION_ALL_CONFIRM_THRESHOLD) {
      // Grupo grande: confirma antes de armar a notificação em massa.
      pendingAllRef.current = { newText, cursorPos };
      setConfirmAllOpen(true);
      return;
    }

    applyMention(newText, cursorPos, isAll ? groupParticipants : [participant]);
  }, [message, mentionStartIndex, mentionQuery, groupParticipants, applyMention]);

  const handleConfirmAllMention = useCallback(() => {
    const pending = pendingAllRef.current;
    pendingAllRef.current = null;
    setConfirmAllOpen(false);
    if (pending) {
      applyMention(pending.newText, pending.cursorPos, groupParticipants);
    }
  }, [groupParticipants, applyMention]);

  // Atalhos de formatação (paridade WhatsApp): envolve a SELEÇÃO com o marcador.
  // setRangeText preserva o undo nativo do textarea (diferente de trocar value).
  const wrapSelection = useCallback((marker: string): boolean => {
    const el = textareaRef.current;
    if (!el) return false;
    const { selectionStart, selectionEnd } = el;
    if (selectionStart === selectionEnd) return false; // sem seleção: deixa o atalho nativo
    const selected = el.value.slice(selectionStart, selectionEnd);
    el.setRangeText(`${marker}${selected}${marker}`, selectionStart, selectionEnd, "select");
    // setRangeText não dispara onChange — sincroniza o estado à mão
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, []);

  // Handle keyboard events
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd+B/I/Shift+X → *negrito* _itálico_ ~tachado~ (só com seleção)
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      const marker = key === "b" ? "*" : key === "i" ? "_" : key === "x" && e.shiftKey ? "~" : null;
      if (marker && wrapSelection(marker)) {
        e.preventDefault();
        return;
      }
    }

    // Let MentionPopup/QuickReplyPopup handle navigation when visible
    if ((showMentionPopup || showQuickReplyPopup) && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      return;
    }

    // Call parent's onKeyDown if provided
    onKeyDown?.(e);

    // IME/teclado com predição (acentos pt-BR): o Enter que confirma a
    // composição não pode enviar a mensagem pela metade.
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      return;
    }

    // Enter envia apenas no desktop; no mobile não existe Shift+Enter,
    // então o Enter insere quebra de linha e o envio fica no botão.
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      handleSubmit();
    }
  }, [showMentionPopup, showQuickReplyPopup, onKeyDown, handleSubmit, isMobile, wrapSelection]);

  return (
    <div className="flex-1 relative">
      <Textarea
        ref={textareaRef}
        value={message}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        aria-label="Mensagem"
        // Padrão combobox só onde algum autocomplete existe (menção em grupos
        // ou frases prontas) — sem eles o composer é um textarea comum para o
        // leitor de tela. aria-controls/activedescendant apontam para o
        // listbox aberto (nunca abrem juntos: exclusão mútua no handleChange).
        {...(groupParticipants.length > 0 || quickReplies.length > 0
          ? {
              role: "combobox" as const,
              "aria-autocomplete": "list" as const,
              "aria-expanded": showMentionPopup || showQuickReplyPopup,
              "aria-controls": showMentionPopup
                ? "mention-listbox"
                : showQuickReplyPopup
                  ? "quick-reply-listbox"
                  : undefined,
              "aria-activedescendant": showMentionPopup
                ? `mention-opt-${mentionActiveIndex}`
                : showQuickReplyPopup
                  ? `quick-reply-opt-${quickReplyActiveIndex}`
                  : undefined,
            }
          : {})}
        // Texto acompanha o "Tamanho do texto das mensagens" (text-message).
        // No celular fica em no mínimo 16px: abaixo disso o iOS dá zoom no foco.
        className="text-[length:max(16px,calc(0.875rem*var(--message-text-scale,1)))] md:text-message min-h-[44px] max-h-[200px] resize-none rounded-[22px] border-none bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 transition-[box-shadow] duration-150 ease-out px-4 py-2.5 w-full overflow-y-auto"
        rows={1}
      />
      <MentionPopup
        participants={groupParticipants}
        searchQuery={mentionQuery}
        onSelect={handleMentionSelect}
        onClose={() => setShowMentionPopup(false)}
        position={{ top: 48, left: 0 }}
        visible={showMentionPopup}
        onActiveIndexChange={setMentionActiveIndex}
      />
      <QuickReplyPopup
        items={filteredQuickReplies}
        onSelect={handleQuickReplySelect}
        onClose={closeQuickReplyPopup}
        position={{ top: 48, left: 0 }}
        visible={showQuickReplyPopup}
        onActiveIndexChange={setQuickReplyActiveIndex}
      />
      <AlertDialog
        open={confirmAllOpen}
        onOpenChange={(open) => {
          setConfirmAllOpen(open);
          if (!open) pendingAllRef.current = null;
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Marcar todos os participantes?</AlertDialogTitle>
            <AlertDialogDescription>
              Isso vai notificar os {groupParticipants.length} participantes do
              grupo quando a mensagem for enviada.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmAllMention}>
              Marcar todos
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}));

ChatInput.displayName = "ChatInput";

export default ChatInput;
