import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPaginated } from "@/lib/fetchAllPaginated";

export interface MessageReceiptRow {
  id: string;
  message_id: string;
  participant_jid: string;
  participant_phone: string | null;
  delivered_at: string | null;
  read_at: string | null;
}

/**
 * Recibos por participante de UMA mensagem de grupo (tabela message_receipts).
 *
 * Lazy de propósito: só busca quando messageId chega (o conteúdo do popover
 * monta ao abrir e desmonta ao fechar). O realtime é um canal único filtrado
 * por message_id, vivo só enquanto o popover está aberto — nunca assinar por
 * mensagem da lista. Paginado porque grupo pode ter 1024 participantes e o
 * PostgREST corta em 1000 linhas.
 */
export function useMessageReceipts(messageId: string | null) {
  const [rows, setRows] = useState<MessageReceiptRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!messageId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const data = await fetchAllPaginated<MessageReceiptRow>((from, to) =>
          supabase
            .from("message_receipts")
            .select("id, message_id, participant_jid, participant_phone, delivered_at, read_at")
            .eq("message_id", messageId)
            .order("id", { ascending: true })
            .range(from, to)
        );
        if (!cancelled) setRows(data);
      } catch (error) {
        console.error("Error fetching message receipts:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    // INSERT = participante novo, UPDATE = delivered→read (upgrade). DELETE não
    // existe no modelo. Canal efêmero: derrubado no cleanup (popover fechou).
    const channel = supabase
      .channel(`message-receipts-${messageId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "message_receipts",
          filter: `message_id=eq.${messageId}`,
        },
        (payload) => {
          const row = payload.new as MessageReceiptRow | null;
          if (!row?.id) return;
          setRows((prev) => [...prev.filter((r) => r.id !== row.id), row]);
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [messageId]);

  return { rows, loading };
}
