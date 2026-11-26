import { useCallback, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { qrFetch } from "@/lib/qrService";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";

interface RefetchTarget {
  id: string;
  contact_phone: string;
  is_group?: boolean;
  group_jid?: string;
}

interface SyncResponse {
  success?: boolean;
  requested?: number;
  received?: number;
  error?: string;
}

/**
 * Pede ao qr-service o histórico da janela em que o número ficou desconectado.
 *
 * O que recupera a maior parte de um gap é automático: ao reconectar, o WhatsApp
 * reentrega a fila offline. Este caminho é para o resto — quedas longas, em que a
 * fila já não cobre tudo. O protocolo puxa mensagens ANTERIORES a uma âncora, então
 * a âncora aqui é a primeira mensagem depois do gap; sem nenhuma mensagem posterior
 * não há por onde entrar, e o caminho é o import de CSV.
 */
export function useHistoryRefetch(
  conversation: RefetchTarget | null,
  phoneNumberId: string | null,
) {
  const [isRefetching, setIsRefetching] = useState(false);
  const { toast } = useToast();

  const refetchHistory = useCallback(async () => {
    if (!conversation || isRefetching) return;
    if (!phoneNumberId) {
      toast({
        title: "Não foi possível identificar a linha",
        description: "Esta conversa não está vinculada a um número conectado.",
        variant: "destructive",
      });
      return;
    }
    setIsRefetching(true);

    try {
      const { data: session, error: sessionError } = await supabase
        .from("phone_number_sessions")
        .select("last_disconnected_at, connection_status")
        .eq("phone_number_id", phoneNumberId)
        .maybeSingle();

      if (sessionError) {
        toast({
          title: "Não foi possível ler o estado da linha",
          description: toUserMessage(sessionError, "Recarregue a página e tente de novo."),
          variant: "destructive",
        });
        return;
      }

      if (!session?.last_disconnected_at) {
        toast({
          title: "Nenhuma desconexão registrada",
          description:
            "Sem uma janela de queda conhecida não há período para recuperar. Para histórico antigo, use a importação de conversa.",
        });
        return;
      }

      const gapStart = session.last_disconnected_at;

      // Âncora: a primeira mensagem DEPOIS do gap. O WhatsApp devolve o que vem
      // antes dela, que é exatamente o intervalo perdido.
      const { data: anchor, error: anchorError } = await supabase
        .from("messages")
        .select("whatsapp_message_id, created_at, direction")
        .eq("conversation_id", conversation.id)
        .gt("created_at", gapStart)
        .not("whatsapp_message_id", "is", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (anchorError) {
        toast({
          title: "Não foi possível localizar o ponto de retomada",
          description: toUserMessage(anchorError, "Tente de novo em instantes."),
          variant: "destructive",
        });
        return;
      }

      if (!anchor?.whatsapp_message_id) {
        toast({
          title: "Sem ponto de partida nesta conversa",
          description:
            "O WhatsApp só devolve mensagens anteriores a uma mensagem existente, e esta conversa não tem nenhuma depois da queda. Use a importação de conversa por CSV.",
        });
        return;
      }

      const chatJid = conversation.is_group
        ? conversation.group_jid
        : `${conversation.contact_phone.replace(/\D/g, "")}@s.whatsapp.net`;

      if (!chatJid) {
        toast({
          title: "Não foi possível identificar este grupo",
          description: "O grupo não foi encontrado no WhatsApp desta linha.",
          variant: "destructive",
        });
        return;
      }

      const response = await qrFetch(`/session/sync/${phoneNumberId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatJid,
          anchorMessageId: anchor.whatsapp_message_id,
          anchorTimestampMs: new Date(anchor.created_at).getTime(),
          anchorFromMe: anchor.direction === "outbound",
          sinceMs: new Date(gapStart).getTime(),
          count: 100,
        }),
      });

      const result: SyncResponse = await response.json().catch(() => ({}));

      if (!response.ok) {
        toast({
          title: "Não foi possível pedir o histórico",
          description: toUserMessage(result.error, "O WhatsApp não respondeu. Tente de novo em alguns minutos."),
          variant: "destructive",
        });
        return;
      }

      const received = result.received ?? 0;
      if (received > 0) {
        toast({
          title: received === 1 ? "1 mensagem recuperada" : `${received} mensagens recuperadas`,
          description: "As mensagens do período offline foram adicionadas à conversa.",
        });
      } else {
        // Silêncio do aparelho e "não havia nada" são indistinguíveis no protocolo:
        // dizer "recuperado" aqui seria mentira.
        toast({
          title: "Nada voltou do WhatsApp",
          description:
            "O aparelho não respondeu ou não há mais histórico dessa janela. Para períodos longos, importe a conversa por CSV.",
        });
      }
    } catch (error) {
      toast({
        title: "Não foi possível recuperar o histórico",
        description: toUserMessage(error, "Verifique a conexão e tente novamente."),
        variant: "destructive",
      });
    } finally {
      setIsRefetching(false);
    }
  }, [conversation, phoneNumberId, isRefetching, toast]);

  return { refetchHistory, isRefetchingHistory: isRefetching };
}
