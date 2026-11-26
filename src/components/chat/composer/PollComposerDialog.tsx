import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { BarChart3, Loader2, Plus, X } from "lucide-react";
import { toUserMessage } from "@/lib/userFacingError";

const MAX_OPTIONS = 12;

interface PollComposerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phoneNumberId: string;
  targetPhone: string;
  conversationId: string;
  onSent?: () => void;
}

/** Criação de enquete (QR only): pergunta + 2–12 opções + múltiplas respostas. */
export function PollComposerDialog({
  open,
  onOpenChange,
  phoneNumberId,
  targetPhone,
  conversationId,
  onSent,
}: PollComposerDialogProps) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [multipleAnswers, setMultipleAnswers] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const { toast } = useToast();

  const validOptions = options.map((o) => o.trim()).filter(Boolean);
  const canSend = question.trim().length > 0 && validOptions.length >= 2 && !isSending;

  const setOption = (index: number, value: string) => {
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)));
  };

  const removeOption = (index: number) => {
    setOptions((prev) => (prev.length > 2 ? prev.filter((_, i) => i !== index) : prev));
  };

  const reset = () => {
    setQuestion("");
    setOptions(["", ""]);
    setMultipleAnswers(false);
  };

  const handleSend = async () => {
    if (!canSend) return;
    setIsSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("whatsapp-send-poll", {
        body: {
          to: targetPhone,
          conversationId,
          phoneNumberId,
          question: question.trim(),
          options: validOptions,
          selectableCount: multipleAnswers ? 0 : 1,
        },
      });

      if (error || !data?.success) {
        let message = data?.error || error?.message || "Falha ao enviar enquete";
        const ctx = (error as { context?: Response } | null)?.context;
        if (ctx && typeof ctx.json === "function") {
          try {
            const body = await ctx.json();
            if (body?.error) message = body.error;
          } catch { /* corpo não-JSON */ }
        }
        throw new Error(message);
      }

      toast({ title: "Enquete enviada" });
      reset();
      onOpenChange(false);
      onSent?.();
    } catch (error: unknown) {
      toast({
        title: "Não foi possível enviar enquete",
        description: toUserMessage(error),
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !isSending && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5" />
            Criar enquete
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Pergunta</Label>
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Faça uma pergunta"
              maxLength={255}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Opções</Label>
            <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
              {options.map((option, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={option}
                    onChange={(e) => setOption(index, e.target.value)}
                    placeholder={`Opção ${index + 1}`}
                    maxLength={100}
                  />
                  {options.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeOption(index)}
                      className="p-1.5 rounded-full text-muted-foreground hover:bg-muted shrink-0"
                      aria-label={`Remover opção ${index + 1}`}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {options.length < MAX_OPTIONS && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOptions((prev) => [...prev, ""])}
              >
                <Plus className="w-4 h-4 mr-1.5" />
                Adicionar opção
              </Button>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="poll-multiple" className="text-sm">
                Várias respostas
              </Label>
              <p className="text-xs text-muted-foreground">
                Permite escolher mais de uma opção
              </p>
            </div>
            <Switch id="poll-multiple" checked={multipleAnswers} onCheckedChange={setMultipleAnswers} />
          </div>

          <Button className="w-full" onClick={handleSend} disabled={!canSend}>
            {isSending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Enviando…
              </>
            ) : (
              "Enviar enquete"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
