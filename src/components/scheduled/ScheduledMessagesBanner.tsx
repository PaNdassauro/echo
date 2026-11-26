import { useMemo, useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ChevronDown, Clock, LayoutTemplate, Loader2, Paperclip, Pencil, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { IconSwap } from "@/components/ui/icon-swap";
import type { ScheduledMessage } from "@/hooks/useScheduledMessages";
import { parseScheduledMedia, scheduledMediaSummary } from "@/lib/scheduledMedia";
import { formatDateTimeLocal, getMinScheduleDate, SCHEDULE_MIN_LEAD_MINUTES } from "./datetimeLocal";

interface ScheduledMessagesBannerProps {
  messages: ScheduledMessage[];
  onSendNow: (message: ScheduledMessage) => Promise<{ success: boolean; error?: string }>;
  onEdit: (
    id: string,
    updates: { content?: string; scheduledAt?: Date }
  ) => Promise<{ success: boolean; error?: string }>;
  onCancel: (id: string) => Promise<{ success: boolean; error?: string }>;
}

const previewOf = (message: ScheduledMessage) => {
  if (message.message_type === "template") {
    return message.template_name || "Template";
  }
  if (message.message_type === "media") {
    return scheduledMediaSummary(parseScheduledMedia(message.media));
  }
  const content = message.content || "";
  return content.length > 80 ? content.substring(0, 80) + "…" : content;
};

const ScheduledMessagesBanner = ({ messages, onSendNow, onEdit, onCancel }: ScheduledMessagesBannerProps) => {
  const [expanded, setExpanded] = useState(false);
  const [editTarget, setEditTarget] = useState<ScheduledMessage | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editDate, setEditDate] = useState("");
  const [cancelTarget, setCancelTarget] = useState<ScheduledMessage | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendNowTarget, setSendNowTarget] = useState<ScheduledMessage | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);

  const pending = useMemo(
    () =>
      messages
        .filter((m) => m.status === "scheduled" || m.status === "processing")
        .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)),
    [messages]
  );

  if (pending.length === 0) return null;

  const openEdit = (message: ScheduledMessage) => {
    setEditTarget(message);
    setEditContent(message.content ?? "");
    setEditDate(formatDateTimeLocal(message.scheduled_at));
    setDateError(null);
    setContentError(null);
  };

  const handleEditSave = async () => {
    if (!editTarget || !editDate) return;

    const newDate = new Date(editDate);
    const isText = editTarget.message_type === "text";
    const nextDateError =
      newDate < new Date(Date.now() + SCHEDULE_MIN_LEAD_MINUTES * 60 * 1000)
        ? `Escolha um horário pelo menos ${SCHEDULE_MIN_LEAD_MINUTES} minutos à frente.`
        : null;
    const nextContentError = isText && !editContent.trim() ? "Escreva o texto da mensagem para agendar." : null;
    setDateError(nextDateError);
    setContentError(nextContentError);
    if (nextDateError || nextContentError) return;

    setBusyId(editTarget.id);
    const result = await onEdit(editTarget.id, {
      scheduledAt: newDate,
      ...(isText ? { content: editContent.trim() } : {}),
    });
    setBusyId(null);
    if (result.success) setEditTarget(null);
  };

  const handleSendNowConfirm = async () => {
    if (!sendNowTarget) return;
    const message = sendNowTarget;
    setSendNowTarget(null);
    setBusyId(message.id);
    await onSendNow(message);
    setBusyId(null);
  };

  const handleCancelConfirm = async () => {
    if (!cancelTarget) return;
    setBusyId(cancelTarget.id);
    await onCancel(cancelTarget.id);
    setBusyId(null);
    setCancelTarget(null);
  };

  return (
    <div className="bg-muted border-l-4 border-primary">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left"
        aria-expanded={expanded}
      >
        <Clock className="h-4 w-4 shrink-0 text-primary" />
        <span className="flex-1 min-w-0 truncate text-sm text-foreground/80">
          {pending.length === 1
            ? `1 mensagem agendada · ${format(new Date(pending[0].scheduled_at), "dd/MM 'às' HH:mm", { locale: ptBR })}`
            : `${pending.length} mensagens agendadas`}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {expanded && (
        <ul className="max-h-40 overflow-y-auto border-t border-border/50">
          {pending.map((message) => {
            const busy = busyId === message.id;
            const processing = message.status === "processing";
            return (
              <li key={message.id} className="flex items-center gap-2 px-4 py-1.5 text-sm">
                <span className="shrink-0 font-medium text-primary tabular-nums">
                  {format(new Date(message.scheduled_at), "dd/MM HH:mm", { locale: ptBR })}
                </span>
                {message.message_type === "template" && (
                  <LayoutTemplate className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Template" />
                )}
                {message.message_type === "media" && (
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Arquivo" />
                )}
                <span className="flex-1 min-w-0 truncate text-foreground/70">{previewOf(message)}</span>

                {processing ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Enviando…
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={busy}
                      onClick={() => setSendNowTarget(message)}
                      aria-label={busy ? "Enviando…" : "Enviar agora"}
                      title="Enviar agora"
                    >
                      <IconSwap
                        active={busy ? "spinner" : "send"}
                        durationMs={150}
                        icons={{
                          spinner: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
                          send: <Send className="h-3.5 w-3.5 translate-x-px" />,
                        }}
                      />
                      {busy && (
                        <span className="sr-only" aria-live="polite">
                          Enviando…
                        </span>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={busy}
                      onClick={() => openEdit(message)}
                      aria-label="Editar agendamento"
                      title="Editar agendamento"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      disabled={busy}
                      onClick={() => setCancelTarget(message)}
                      aria-label="Cancelar agendamento"
                      title="Cancelar agendamento"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Editar agendamento</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {editTarget?.message_type === "text" ? (
              <div className="space-y-2">
                <Label htmlFor="scheduled-edit-content">Mensagem</Label>
                <Textarea
                  id="scheduled-edit-content"
                  value={editContent}
                  onChange={(e) => {
                    setEditContent(e.target.value);
                    setContentError(null);
                  }}
                  rows={4}
                  aria-invalid={contentError ? true : undefined}
                  aria-describedby={contentError ? "scheduled-edit-content-error" : undefined}
                />
                {contentError && (
                  <p id="scheduled-edit-content-error" role="alert" className="text-sm text-destructive">
                    {contentError}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {editTarget?.message_type === "media" ? (
                  <>
                    Arquivo <span className="font-medium">{editTarget && previewOf(editTarget)}</span> — só o horário
                    pode ser alterado. Para trocar o arquivo, cancele e agende outro.
                  </>
                ) : (
                  <>
                    Template <span className="font-medium">{editTarget?.template_name}</span> — só o horário pode ser
                    alterado. Para trocar o conteúdo, cancele e agende outro.
                  </>
                )}
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="scheduled-edit-date">Enviar em</Label>
              <Input
                id="scheduled-edit-date"
                type="datetime-local"
                value={editDate}
                min={getMinScheduleDate()}
                onChange={(e) => {
                  setEditDate(e.target.value);
                  setDateError(null);
                }}
                aria-invalid={dateError ? true : undefined}
                aria-describedby={dateError ? "scheduled-edit-date-error" : undefined}
              />
              {dateError && (
                <p id="scheduled-edit-date-error" role="alert" className="text-sm text-destructive">
                  {dateError}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              Cancelar
            </Button>
            <Button onClick={handleEditSave} disabled={busyId === editTarget?.id}>
              {busyId === editTarget?.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!sendNowTarget} onOpenChange={(open) => !open && setSendNowTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enviar esta mensagem agora?</AlertDialogTitle>
            <AlertDialogDescription>
              A mensagem &ldquo;{sendNowTarget ? previewOf(sendNowTarget) : ""}&rdquo; sai imediatamente para o
              contato, sem esperar o horário agendado. Essa ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={handleSendNowConfirm}>Enviar agora</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!cancelTarget} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar agendamento?</AlertDialogTitle>
            <AlertDialogDescription>
              A mensagem &ldquo;{cancelTarget ? previewOf(cancelTarget) : ""}&rdquo; não será enviada. Essa ação não
              pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={handleCancelConfirm} className="bg-destructive text-destructive-foreground">
              Cancelar agendamento
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ScheduledMessagesBanner;
