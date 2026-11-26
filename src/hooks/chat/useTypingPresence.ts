import { useCallback, useEffect, useRef, useState } from "react";
import { qrFetch } from "@/lib/qrService";
import { assinarPresenca } from "@/lib/presencaPorNumero";
import { alvoDeContato, type ConversaCarregavel } from "@/lib/conversaCarregada";

/**
 * Indicador de "digitando" nas duas direções (só QR/Baileys).
 *
 * SAÍDA: o chatstate que mandamos expira sozinho em ~10s do lado do WhatsApp,
 * então quem digita continuamente precisa de refresh. O servidor de propósito não
 * mantém timer para isso (teria que ser limpo em todo teardown de sessão) — a
 * cadência vive aqui.
 *
 * ENTRADA: broadcast efêmero do Realtime, sem passar pelo banco. O tópico é por
 * número (não por conversa), porque o serviço só conhece o JID; o filtro por
 * conversa é local. O canal em si é de `presencaPorNumero`, que o divide entre
 * quem escuta o mesmo número e o mantém vivo por um tempo depois da última saída.
 */

// Refresh antes dos ~10s de expiração, com folga para latência.
const REFRESH_MS = 8_000;
// Parou de digitar: o WhatsApp mostra "digitando" por alguns segundos após a
// última tecla, então 3s evita piscar entre palavras.
const IDLE_STOP_MS = 3_000;
// Rede de segurança da entrada: se o 'stopped' se perder, os pontinhos somem
// sozinhos. Precisa ser maior que o REFRESH_MS do remetente, senão pisca.
const INBOUND_TTL_MS = 10_000;
// Saída mais curta que a entrada (200ms): devagar pra decidir, rápido pra
// responder. Precisa bater com a duração do animate-out do TypingBubble, senão
// o nó desmonta no meio da animação.
const EXIT_MS = 150;

type OutboundState = "composing" | "recording";

export interface IncomingChatState {
  state: "typing" | "recording";
  participantJid: string;
  /** Em saída: o nó segue montado até o animate-out terminar. Sem isto a bolha
   *  entra animada e some por corte seco — e, na cadência real do WhatsApp,
   *  isso se repete a cada pausa entre palavras. */
  leaving: boolean;
}

interface ChatStatePayload {
  phone_number_id?: string;
  chat_jid?: string;
  participant_jid?: string;
  contact_phone?: string;
  /** Digitos crus do JID. Na pratica todo chat 1:1 chega como @lid; quando o
   *  servico consegue traduzir, contact_phone vem com o telefone real, e quando
   *  nao consegue este campo ainda casa com as conversas que guardam o LID. */
  contact_phone_raw?: string;
  state?: "typing" | "recording" | "stopped";
  is_group?: boolean;
}

interface UseTypingPresenceParams {
  conversationId: string | null;
  /** phone_numbers.id (UUID) — é o que as rotas do qr-service esperam. */
  phoneNumberDbId: string | null | undefined;
  /**
   * A conversa CARREGADA (não o telefone dela): o hook confere por dentro (`alvoDeContato`)
   * que é a do `conversationId` aberto e que não é do Direct. Na troca A -> B o primeiro render
   * tem o número da B e ainda a conversa da A; assinar a presença da A no número da B é tráfego
   * errado em linha sensível a ban. Sem conversa, ou com outra, a presença fica desligada.
   */
  conversation: ConversaCarregavel | null | undefined;
  isQrConnection: boolean | undefined;
}

const digitsOnly = (value: string) => value.replace(/\D/g, "");

/**
 * Últimos 8 dígitos: evita reimplementar no cliente as variações de nono dígito
 * brasileiro que o serviço já trata. DDD + país variam de formato, o final não.
 */
function matchesOpenConversation(
  payload: ChatStatePayload,
  contactPhone: string,
  isGroup: boolean,
): boolean {
  if (Boolean(payload.is_group) !== isGroup) return false;

  if (isGroup) return payload.chat_jid === contactPhone;

  const open = digitsOnly(contactPhone);
  if (open.length < 8) return false;

  // Dois candidatos porque o 1:1 chega como @lid: o telefone que o servico
  // conseguiu traduzir e os digitos crus do LID. Conversas antigas guardam um ou
  // outro em contact_phone, entao qualquer match serve.
  return [payload.contact_phone, payload.contact_phone_raw].some((candidate) => {
    const incoming = digitsOnly(candidate ?? "");
    return incoming.length >= 8 && incoming.slice(-8) === open.slice(-8);
  });
}

export function useTypingPresence({
  conversationId,
  phoneNumberDbId,
  conversation,
  isQrConnection,
}: UseTypingPresenceParams) {
  // contact_phone; em grupo guarda o próprio group_jid.
  const { contactPhone, isGroup } = alvoDeContato(conversation, conversationId);
  const enabled = Boolean(isQrConnection && phoneNumberDbId && contactPhone);

  const [incoming, setIncoming] = useState<IncomingChatState | null>(null);

  // O canal é por número e o filtro depende da conversa aberta. Ler o alvo de um
  // ref (em vez de pôr nas deps) evita reassinar o canal a cada troca de conversa.
  const targetRef = useRef({ contactPhone: contactPhone ?? "", isGroup });
  targetRef.current = { contactPhone: contactPhone ?? "", isGroup };

  const sentStateRef = useRef<OutboundState | null>(null);
  const sentAtRef = useRef(0);
  const idleTimerRef = useRef<number>();
  const inboundTtlRef = useRef<number>();
  const leaveTimerRef = useRef<number>();

  // Some com animação de saída. Chamar de novo enquanto já está saindo não
  // reinicia nada — o timer original continua valendo.
  const startLeaving = useCallback(() => {
    window.clearTimeout(inboundTtlRef.current);
    setIncoming((prev) => (prev && !prev.leaving ? { ...prev, leaving: true } : prev));
    window.clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = window.setTimeout(() => setIncoming(null), EXIT_MS);
  }, []);

  // Some na hora, sem animação: usado quando a conversa muda: animar a saída de
  // uma bolha que pertence a OUTRO contato seria mentira visual.
  const clearNow = useCallback(() => {
    window.clearTimeout(inboundTtlRef.current);
    window.clearTimeout(leaveTimerRef.current);
    setIncoming(null);
  }, []);

  const postChatState = useCallback(
    (phoneId: string, to: string, state: OutboundState | "paused", keepalive = false) => {
      // Best-effort: sessão caída ou rede ruim não pode estourar no composer.
      void qrFetch(`/message/presence/${phoneId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, state }),
        keepalive,
      }).catch(() => undefined);
    },
    [],
  );

  const notifyStopped = useCallback(() => {
    window.clearTimeout(idleTimerRef.current);
    if (!sentStateRef.current) return;
    sentStateRef.current = null;
    if (!enabled) return;
    postChatState(phoneNumberDbId as string, contactPhone as string, "paused");
  }, [enabled, phoneNumberDbId, contactPhone, postChatState]);

  const notify = useCallback(
    (state: OutboundState) => {
      if (!enabled) return;

      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(notifyStopped, IDLE_STOP_MS);

      const isRefreshDue = Date.now() - sentAtRef.current > REFRESH_MS;
      if (sentStateRef.current === state && !isRefreshDue) return;

      sentStateRef.current = state;
      sentAtRef.current = Date.now();
      postChatState(phoneNumberDbId as string, contactPhone as string, state);
    },
    [enabled, phoneNumberDbId, contactPhone, postChatState, notifyStopped],
  );

  const notifyTyping = useCallback(() => notify("composing"), [notify]);
  const notifyRecording = useCallback(() => notify("recording"), [notify]);

  // Trocar de conversa (ou desmontar) no meio da digitação tem que liberar o
  // "digitando" na conversa ANTERIOR — daí capturar o alvo no corpo do effect.
  useEffect(() => {
    if (!enabled) return;
    const phoneId = phoneNumberDbId as string;
    const to = contactPhone as string;

    return () => {
      window.clearTimeout(idleTimerRef.current);
      if (!sentStateRef.current) return;
      sentStateRef.current = null;
      postChatState(phoneId, to, "paused");
    };
  }, [enabled, phoneNumberDbId, contactPhone, postChatState]);

  // Fechar a aba: tentativa com keepalive. Se não vingar, o próprio chatstate
  // expira em ~10s no WhatsApp — não fica "digitando" preso.
  useEffect(() => {
    if (!enabled) return;
    const phoneId = phoneNumberDbId as string;
    const to = contactPhone as string;

    const onPageHide = () => {
      if (!sentStateRef.current) return;
      sentStateRef.current = null;
      postChatState(phoneId, to, "paused", true);
    };

    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [enabled, phoneNumberDbId, contactPhone, postChatState]);

  // Assinar a presença do chat ao abrir a conversa. O WhatsApp não empurra
  // presença de quem você não assinou — sem isto o servidor nunca recebe
  // presence.update e os pontinhos jamais apareceriam. Não custa notificação
  // nenhuma: é um nó <presence type="subscribe">, não a presença global.
  useEffect(() => {
    if (!enabled) return;
    void qrFetch(`/message/presence-subscribe/${phoneNumberDbId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: contactPhone }),
    }).catch(() => undefined);
  }, [enabled, phoneNumberDbId, contactPhone]);

  // Entrada: o canal é por número e fica no registro (`presencaPorNumero`), então
  // trocar de conversa dentro do mesmo número não reassina nada, e voltar a um
  // número visto há pouco reaproveita o canal vivo. Aqui só entra e sai o ouvinte.
  useEffect(() => {
    if (!isQrConnection || !phoneNumberDbId) return;

    const cancelar = assinarPresenca(phoneNumberDbId, (payload) => {
      const data = (payload ?? {}) as ChatStatePayload;
      const { contactPhone: openPhone, isGroup: openIsGroup } = targetRef.current;
      if (!openPhone) return;
      if (!matchesOpenConversation(data, openPhone, openIsGroup)) return;

      if (data.state === "stopped" || !data.state) {
        startLeaving();
        return;
      }

      // Voltou a digitar durante a saída: cancela o unmount e volta a entrar.
      window.clearTimeout(leaveTimerRef.current);
      window.clearTimeout(inboundTtlRef.current);
      setIncoming({
        state: data.state,
        participantJid: data.participant_jid ?? "",
        leaving: false,
      });
      inboundTtlRef.current = window.setTimeout(startLeaving, INBOUND_TTL_MS);
    });

    return () => {
      window.clearTimeout(inboundTtlRef.current);
      window.clearTimeout(leaveTimerRef.current);
      cancelar();
    };
  }, [isQrConnection, phoneNumberDbId, startLeaving]);

  // Conversa nova começa sem pontinhos — o estado anterior é de outro contato.
  useEffect(() => {
    clearNow();
  }, [conversationId, clearNow]);

  return { incoming, notifyTyping, notifyRecording, notifyStopped };
}
