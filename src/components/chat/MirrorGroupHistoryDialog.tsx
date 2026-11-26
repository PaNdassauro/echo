import { useCallback, useEffect, useState } from "react";
import { Loader2, History, Info, CheckCircle2 } from "lucide-react";
import {
  ResponsiveDialog as Dialog,
  ResponsiveDialogContent as DialogContent,
  ResponsiveDialogHeader as DialogHeader,
  ResponsiveDialogFooter as DialogFooter,
  ResponsiveDialogTitle as DialogTitle,
  ResponsiveDialogDescription as DialogDescription,
} from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  countMirrorableMessages,
  mirrorGroupHistory,
} from "@/lib/mirrorGroupHistoryClient";
import { toUserMessage } from "@/lib/userFacingError";

/** Períodos oferecidos. `null` = tudo o que existir. */
const PERIODS = [
  { value: "30", label: "Últimos 30 dias" },
  { value: "90", label: "Últimos 90 dias" },
  { value: "all", label: "Todo o histórico" },
] as const;

type PeriodValue = (typeof PERIODS)[number]["value"];

const sinceFor = (period: PeriodValue): string | null => {
  if (period === "all") return null;
  const days = Number(period);
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
};

interface SourceOption {
  conversationId: string;
  lineName: string;
}

interface MirrorGroupHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Conversa do grupo NESTA linha — o destino da cópia. */
  targetConversationId: string;
  /** JID do grupo: identifica as conversas irmãs nas outras linhas. */
  groupJid: string;
  /** Linha em foco, excluída da lista de origens. */
  phoneNumberId: string;
  onMirrored?: () => void;
}

/**
 * Traz para esta linha o histórico do grupo que outra linha da organização já
 * tem registrado no Echo.
 *
 * Por que existe: cada linha tem sua própria conversa do grupo e suas próprias
 * mensagens. A linha que entra depois só enxerga dali para frente — o passado
 * fica só com quem já estava.
 *
 * O aviso sobre o limite (só o que passou pelo Echo) fica FIXO no corpo, não em
 * toast: é a diferença entre "recuperei a conversa" e "recuperei o pedaço que o
 * Echo viu", e o usuário precisa dessa expectativa antes de confirmar.
 */
const MirrorGroupHistoryDialog = ({
  open,
  onOpenChange,
  targetConversationId,
  groupJid,
  phoneNumberId,
  onMirrored,
}: MirrorGroupHistoryDialogProps) => {
  const { toast } = useToast();
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [sourceId, setSourceId] = useState<string>("");
  const [period, setPeriod] = useState<PeriodValue>("all");
  const [preview, setPreview] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  // Conversas irmãs: mesmo group_jid, outras linhas. A RLS já limita às linhas
  // do usuário, então não se filtra acesso aqui.
  useEffect(() => {
    if (!open || !groupJid) return;

    let cancelled = false;
    void (async () => {
      setLoadingSources(true);
      try {
        const { data, error } = await supabase
          .from("conversations")
          .select("id, phone_number_id, phone_numbers!inner(display_name)")
          .eq("group_jid", groupJid)
          .eq("is_group", true)
          .neq("id", targetConversationId);

        if (error) throw error;
        if (cancelled) return;

        const options = (data ?? [])
          .filter((row) => row.phone_number_id !== phoneNumberId)
          .map((row) => ({
            conversationId: row.id,
            lineName:
              (row as unknown as { phone_numbers?: { display_name?: string } })
                .phone_numbers?.display_name ?? "Outro número",
          }));

        setSources(options);
        setSourceId((prev) => prev || options[0]?.conversationId || "");
      } catch (error) {
        console.error("[MirrorGroupHistoryDialog] Falha ao listar origens:", error);
        if (!cancelled) {
          toast({
            title: "Não foi possível listar os números",
            description: "Verifique a conexão e tente novamente.",
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoadingSources(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, groupJid, targetConversationId, phoneNumberId, toast]);

  // Trocar origem/período invalida o preview: confirmar com a contagem antiga
  // mostraria um número que não corresponde ao que será copiado.
  useEffect(() => {
    setPreview(null);
  }, [sourceId, period]);

  const handlePreview = useCallback(async () => {
    if (!sourceId) return;
    setPreviewing(true);
    try {
      const total = await countMirrorableMessages(
        sourceId,
        targetConversationId,
        sinceFor(period)
      );
      setPreview(total);
    } catch (error) {
      toast({
        title: "Não foi possível contar mensagens",
        description: toUserMessage(error),
        variant: "destructive",
      });
    } finally {
      setPreviewing(false);
    }
  }, [sourceId, targetConversationId, period, toast]);

  const handleConfirm = async () => {
    if (!sourceId) return;
    setRunning(true);
    setProgress(0);
    try {
      const totals = await mirrorGroupHistory(
        sourceId,
        targetConversationId,
        sinceFor(period),
        setProgress
      );

      toast({
        title: "Histórico espelhado",
        description:
          totals.inserted > 0
            ? `${totals.inserted === 1 ? "1 mensagem copiada" : `${totals.inserted} mensagens copiadas`}${
                totals.skipped ? (totals.skipped === 1 ? ", 1 já existia" : `, ${totals.skipped} já existiam`) : ""
              }.`
            : "Nada novo para copiar — esta linha já tinha tudo.",
      });

      onMirrored?.();
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Não foi possível espelhar o histórico",
        description: toUserMessage(error),
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="w-4 h-4" />
            Trazer histórico para esta linha
          </DialogTitle>
          <DialogDescription>
            Copia as mensagens deste grupo que outro número seu já registrou.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-muted-foreground" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              Copia apenas o que já está registrado no Echo. Mensagens que nunca
              passaram por nenhuma linha conectada não podem ser recuperadas — o
              WhatsApp não permite compartilhar o histórico real do grupo com
              quem entra depois.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mirror-source">Copiar de</Label>
            {loadingSources ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Procurando números com histórico deste grupo…
              </div>
            ) : sources.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                Nenhum outro número seu tem histórico deste grupo.
              </p>
            ) : (
              <Select value={sourceId} onValueChange={setSourceId} disabled={running}>
                <SelectTrigger id="mirror-source">
                  <SelectValue placeholder="Escolha o número de origem" />
                </SelectTrigger>
                <SelectContent>
                  {sources.map((source) => (
                    <SelectItem key={source.conversationId} value={source.conversationId}>
                      {source.lineName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mirror-period">Período</Label>
            <Select
              value={period}
              onValueChange={(v) => setPeriod(v as PeriodValue)}
              disabled={running || sources.length === 0}
            >
              <SelectTrigger id="mirror-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {preview !== null && !running && (
            <p className="text-sm flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-muted-foreground shrink-0" />
              {preview === 0
                ? "Nenhuma mensagem para copiar neste período."
                : preview === 1
                  ? "1 mensagem será copiada."
                  : `${preview.toLocaleString("pt-BR")} mensagens serão copiadas.`}
            </p>
          )}

          {running && (
            <p className="text-sm flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              Copiando… {progress === 1 ? "1 processada" : `${progress.toLocaleString("pt-BR")} processadas`}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancelar
          </Button>
          {preview === null ? (
            <Button
              onClick={() => void handlePreview()}
              disabled={!sourceId || previewing || running}
            >
              {previewing && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Conferir
            </Button>
          ) : (
            <Button onClick={() => void handleConfirm()} disabled={preview === 0 || running}>
              {running && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Copiar histórico
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default MirrorGroupHistoryDialog;
