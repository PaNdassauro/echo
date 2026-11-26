import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { checkEdgeFunctionResponseAsync } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Loader2, User, Users, Search, Forward } from "lucide-react";
import type { Message } from "@/hooks/chat/useMessages";
import { toUserMessage } from "@/lib/userFacingError";

// Paridade com o WhatsApp: encaminhar para até 5 conversas por vez.
const MAX_TARGETS = 5;

interface ConversationRow {
  id: string;
  contact_name: string | null;
  contact_phone: string | null;
  is_group: boolean | null;
}

interface ForwardResult {
  conversationId: string;
  contactName: string | null;
  /** Só true quando TODAS as mensagens do lote chegaram neste destino. */
  success: boolean;
  sent: number;
  total: number;
  errors?: string[];
  messageId?: string;
  error?: string;
}

interface ForwardMessageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** UUID do número ativo (phone_numbers.id) — escopo da lista de destinos. */
  phoneNumberId: string;
  /** Lote a encaminhar, em ordem cronológica. Uma bolha só = array de 1. */
  messages: Message[];
  /** Chamado quando ao menos uma mensagem chegou a algum destino. */
  onForwarded?: () => void;
}

const ForwardMessageModal = ({
  open,
  onOpenChange,
  phoneNumberId,
  messages,
  onForwarded,
}: ForwardMessageModalProps) => {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { toast } = useToast();

  // Reset ao abrir: seleção e busca não sobrevivem entre encaminhamentos.
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setSearch("");
    }
  }, [open]);

  // Busca server-side com debounce: a lista completa pode passar do corte de
  // 1000 linhas do PostgREST, então filtrar em memória perderia conversas.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        let query = supabase
          .from("conversations")
          .select("id, contact_name, contact_phone, is_group")
          .eq("phone_number_id", phoneNumberId)
          // Direct do Instagram não recebe encaminhamento pelo WhatsApp.
          .eq("channel", "whatsapp")
          .order("last_message_at", { ascending: false })
          .limit(50);

        const term = search.trim();
        if (term) {
          // Vírgula/parêntese quebram a sintaxe do .or() do PostgREST.
          const safe = term.replace(/[,()]/g, " ").trim();
          const digits = term.replace(/\D/g, "");
          const filters = [`contact_name.ilike.%${safe}%`];
          if (digits) {
            filters.push(`contact_phone.ilike.%${digits}%`);
          }
          query = query.or(filters.join(","));
        }

        const { data, error } = await query;
        if (error) throw error;
        if (!cancelled) {
          setConversations(data || []);
        }
      } catch (error) {
        console.error("Error fetching conversations for forward:", error);
        if (!cancelled) {
          toast({
            title: "Não foi possível carregar as conversas",
            description: "Verifique a conexão e tente novamente.",
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }, search ? 300 : 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, phoneNumberId, search, toast]);

  const toggleSelection = (conversationId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else if (next.size < MAX_TARGETS) {
        next.add(conversationId);
      }
      return next;
    });
  };

  const messageCount = messages.length;

  const handleForward = async () => {
    if (messageCount === 0 || selected.size === 0) return;
    setIsSending(true);
    try {
      const result = await checkEdgeFunctionResponseAsync<{ success: boolean; results: ForwardResult[] }>(
        await supabase.functions.invoke("whatsapp-forward", {
          body: {
            messageIds: messages.map((m) => m.id),
            conversationIds: [...selected],
          },
        })
      );

      // Duas dimensões de falha: destino que não recebeu nada e destino que
      // recebeu parte do lote. O toast precisa distinguir as duas.
      const failures = result.results.filter((r) => !r.success);
      const successCount = result.results.length - failures.length;
      const anySent = result.results.some((r) => r.sent > 0);

      if (failures.length === 0) {
        toast({
          title: messageCount === 1 ? "Mensagem encaminhada" : `${messageCount} mensagens encaminhadas`,
          description:
            successCount === 1
              ? "Encaminhada para 1 conversa"
              : `Encaminhada para ${successCount} conversas`,
        });
        onForwarded?.();
        onOpenChange(false);
      } else if (anySent) {
        // Parcial: o que foi, foi — fechar e detalhar só o que faltou.
        toast({
          title: `Encaminhada para ${successCount} de ${result.results.length} conversas`,
          description: failures
            .map((f) =>
              `${f.contactName || "Conversa"}: ${f.sent} de ${f.total} — ${f.error || "falha desconhecida"}`
            )
            .join("\n"),
          variant: "destructive",
        });
        onForwarded?.();
        onOpenChange(false);
      } else {
        toast({
          title: "Não foi possível encaminhar",
          description: failures[0]?.error || "Tente novamente.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error forwarding message:", error);
      toast({
        title: "Não foi possível encaminhar",
        description: toUserMessage(error),
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  const atLimit = selected.size >= MAX_TARGETS;

  return (
    <Dialog open={open} onOpenChange={(o) => !isSending && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Forward className="w-5 h-5" />
            {messageCount > 1 ? `Encaminhar ${messageCount} mensagens` : "Encaminhar mensagem"}
          </DialogTitle>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar conversa…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Conversation list */}
        <ScrollArea className="h-[280px]">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
              <p>{search ? `Nenhuma conversa com “${search}”. Tente outro nome ou número.` : "Nenhuma conversa disponível para encaminhar."}</p>
              {search && (
                <Button variant="ghost" size="sm" onClick={() => setSearch("")}>
                  Limpar busca
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {conversations.map((conversation) => {
                const isSelected = selected.has(conversation.id);
                const disabled = !isSelected && atLimit;
                return (
                  <button
                    key={conversation.id}
                    onClick={() => toggleSelection(conversation.id)}
                    disabled={disabled}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 ${
                      isSelected
                        ? "border-primary bg-primary/5"
                        : disabled
                          ? "border-border opacity-50 cursor-not-allowed"
                          : "border-border hover:border-primary/50 hover:bg-muted/50"
                    }`}
                  >
                    <Checkbox
                      checked={isSelected}
                      disabled={disabled}
                      className="pointer-events-none shrink-0"
                      tabIndex={-1}
                      aria-hidden="true"
                    />
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                      {conversation.is_group ? (
                        <Users className="w-5 h-5 text-muted-foreground" />
                      ) : (
                        <User className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate" title={conversation.contact_name || conversation.contact_phone || "Sem nome"}>
                        {conversation.contact_name || conversation.contact_phone || "Sem nome"}
                      </p>
                      {!conversation.is_group && conversation.contact_phone && (
                        <p className="text-xs text-muted-foreground truncate">
                          {conversation.contact_phone}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>

        {/* Footer: contagem + enviar */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {selected.size === 1 ? `1 de ${MAX_TARGETS} selecionada` : `${selected.size} de ${MAX_TARGETS} selecionadas`}
          </span>
          <Button onClick={handleForward} disabled={selected.size === 0 || messageCount === 0 || isSending}>
            {isSending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Encaminhando…
              </>
            ) : (
              "Encaminhar"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ForwardMessageModal;
