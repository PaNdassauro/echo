import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BroadcastStatusBadge } from "@/components/broadcasts/broadcastStatus";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  Calendar,
  MoreVertical,
  Trash2,
  MessageSquare,
  LayoutTemplate,
  Paperclip,
  Pencil,
  User,
} from "lucide-react";
import { discardUnsentScheduledFiles } from "@/hooks/useScheduledMessages";
import { parseScheduledMedia, scheduledMediaSummary } from "@/lib/scheduledMedia";
import { formatDistanceToNow, format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useIsMobile } from "@/hooks/use-mobile";

interface ScheduledMessage {
  id: string;
  message_type: "text" | "template" | "media";
  content: string | null;
  media: unknown;
  template_name: string | null;
  contact_phone: string;
  contact_name: string | null;
  scheduled_at: string;
  status: string;
  error_message: string | null;
  created_at: string;
  phone_numbers?: {
    display_name: string;
  };
  conversations?: {
    contact_name: string | null;
    contact_phone: string;
  };
  profiles?: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  };
}

export default function ScheduledMessagesList() {
  const { toast } = useToast();
  const { currentOrganization } = useOrganization();
  const [messages, setMessages] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelConfirm, setCancelConfirm] = useState<ScheduledMessage | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [editMessage, setEditMessage] = useState<ScheduledMessage | null>(null);
  const [editDate, setEditDate] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [editDateError, setEditDateError] = useState<string | null>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!currentOrganization?.id) return;
    fetchMessages();
    // O cleanup devolvido remove o canal — descartá-lo empilhava um canal
    // fantasma (de nome fixo) a cada remount/troca de org, cada um refazendo
    // o fetch em todo evento.
    return subscribeToChanges();
  }, [currentOrganization?.id]);

  const fetchMessages = async () => {
    if (!currentOrganization?.id) return;

    setLoading(true);
    try {
      const { data, error } = await (supabase as any)
        .from("scheduled_messages")
        .select(`
          *,
          phone_numbers (
            display_name
          ),
          conversations (
            contact_name,
            contact_phone
          ),
          profiles:created_by (
            first_name,
            last_name,
            email
          )
        `)
        .eq("organization_id", currentOrganization.id)
        .order("scheduled_at", { ascending: true });

      if (error) throw error;
      setMessages(data || []);
    } catch (error: any) {
      console.error("Error fetching scheduled messages:", error);
      toast({
        title: "Não foi possível carregar os agendamentos",
        description: toUserMessage(error, "Verifique a conexão e recarregue a página."),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const subscribeToChanges = () => {
    const channel = supabase
      .channel("scheduled_messages_list")
      .on(
        "postgres_changes" as any,
        {
          event: "*",
          schema: "public",
          table: "scheduled_messages",
          filter: `organization_id=eq.${currentOrganization?.id}`,
        },
        () => {
          fetchMessages();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  };

  const handleCancel = async (message: ScheduledMessage) => {
    setCancelling(true);
    try {
      const { data, error } = await supabase
        .from("scheduled_messages")
        .update({ status: "cancelled" })
        .eq("id", message.id)
        .eq("status", "scheduled")
        .select("id, message_type, media");

      if (error) throw error;
      if (data?.[0]) discardUnsentScheduledFiles(data[0]);

      setMessages(messages.map((m) =>
        m.id === message.id ? { ...m, status: "cancelled" } : m
      ));
      toast({ title: "Agendamento cancelado" });
    } catch (error: any) {
      console.error("Error cancelling scheduled message:", error);
      toast({
        title: "Não foi possível cancelar o agendamento",
        description: toUserMessage(error, "A mensagem continua agendada. Tente de novo."),
        variant: "destructive",
      });
    } finally {
      setCancelling(false);
      setCancelConfirm(null);
    }
  };

  const handleEdit = async () => {
    if (!editMessage || !editDate) return;

    const newDate = new Date(editDate);
    const minDate = new Date(Date.now() + 5 * 60 * 1000);

    if (newDate < minDate) {
      setEditDateError("Escolha um horário pelo menos 5 minutos à frente.");
      return;
    }

    setSaving(true);
    try {
      const { error } = await (supabase as any)
        .from("scheduled_messages")
        .update({ scheduled_at: newDate.toISOString() })
        .eq("id", editMessage.id)
        .eq("status", "scheduled");

      if (error) throw error;

      setMessages(messages.map((m) =>
        m.id === editMessage.id ? { ...m, scheduled_at: newDate.toISOString() } : m
      ));
      toast({ title: "Horário atualizado" });
      setEditMessage(null);
    } catch (error: any) {
      console.error("Error updating scheduled message:", error);
      toast({
        title: "Não foi possível alterar o horário",
        description: toUserMessage(error, "O horário anterior foi mantido. Tente de novo."),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const formatDateTimeLocal = (date: Date | string): string => {
    const d = typeof date === "string" ? new Date(date) : date;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  const getMinDate = (): string => {
    const min = new Date();
    min.setMinutes(min.getMinutes() + 5);
    return formatDateTimeLocal(min);
  };


  const getMessagePreview = (message: ScheduledMessage) => {
    if (message.message_type === "template") {
      return message.template_name || "Template";
    }
    if (message.message_type === "media") {
      return scheduledMediaSummary(parseScheduledMedia(message.media));
    }
    const content = message.content || "";
    return content.length > 50 ? content.substring(0, 50) + "…" : content;
  };

  const getContactDisplay = (message: ScheduledMessage) => {
    return message.conversations?.contact_name || message.contact_name || message.contact_phone;
  };

  const getCreatorName = (message: ScheduledMessage) => {
    if (!message.profiles) return null;
    const { first_name, last_name, email } = message.profiles;
    if (first_name) {
      return `${first_name}${last_name ? ` ${last_name}` : ""}`.trim();
    }
    return email?.split("@")[0] || null;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-12 sm:py-16">
          <Clock className="h-12 w-12 sm:h-16 sm:w-16 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-semibold mb-2">Nenhuma mensagem agendada</h3>
          <p className="text-muted-foreground text-center mb-6 max-w-md text-sm">
            Agende mensagens diretamente nas conversas usando o botão de relógio
            ao lado do enviar.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      {/* Same height as the Disparos tab. dvh on both: the desktop branch used vh,
          which ignores mobile browser chrome. */}
      <ScrollArea className="h-[calc(100dvh-250px)]">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {messages.map((message) => (
            <Card key={message.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base truncate flex items-center gap-2">
                      <User className="h-4 w-4 text-muted-foreground shrink-0" />
                      {getContactDisplay(message)}
                    </CardTitle>
                    <CardDescription className="truncate flex items-center gap-1">
                      {message.message_type === "template" ? (
                        <LayoutTemplate className="h-3 w-3" />
                      ) : message.message_type === "media" ? (
                        <Paperclip className="h-3 w-3" aria-label="Arquivo" />
                      ) : (
                        <MessageSquare className="h-3 w-3" />
                      )}
                      {getMessagePreview(message)}
                    </CardDescription>
                  </div>
                  {message.status === "scheduled" && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 touch-manipulation">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => {
                          setEditMessage(message);
                          setEditDate(formatDateTimeLocal(message.scheduled_at));
                          setEditDateError(null);
                        }}>
                          <Pencil className="h-4 w-4 mr-2" />
                          Editar agendamento
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setCancelConfirm(message)}
                          className="text-destructive"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Cancelar agendamento
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <BroadcastStatusBadge status={message.status} />
                  <span className="text-xs text-muted-foreground">
                    {message.phone_numbers?.display_name}
                  </span>
                </div>

                {message.status === "failed" && message.error_message && (
                  <p className="text-xs text-red-600 truncate" title={message.error_message}>
                    {message.error_message}
                  </p>
                )}

                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="h-4 w-4" />
                  {format(new Date(message.scheduled_at), "dd/MM/yyyy 'às' HH:mm", {
                    locale: ptBR,
                  })}
                </div>

                <p className="text-xs text-muted-foreground">
                  {getCreatorName(message) ? (
                    <>
                      Agendado por <span className="font-medium">{getCreatorName(message)}</span>{" "}
                    </>
                  ) : (
                    "Criado "
                  )}
                  {formatDistanceToNow(new Date(message.created_at), {
                    addSuffix: true,
                    locale: ptBR,
                  })}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollArea>

      {/* Cancel Confirmation */}
      <AlertDialog open={!!cancelConfirm} onOpenChange={() => setCancelConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar este agendamento?</AlertDialogTitle>
            <AlertDialogDescription>
              A mensagem para {cancelConfirm ? getContactDisplay(cancelConfirm) : "este contato"} não será enviada. Essa ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => cancelConfirm && handleCancel(cancelConfirm)}
              disabled={cancelling}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelling ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Cancelar agendamento
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Time Dialog */}
      <Dialog open={!!editMessage} onOpenChange={(open) => !open && setEditMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar agendamento</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-datetime" className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Novo horário
              </Label>
              <Input
                id="edit-datetime"
                type="datetime-local"
                value={editDate}
                onChange={(e) => {
                  setEditDate(e.target.value);
                  setEditDateError(null);
                }}
                min={getMinDate()}
                aria-invalid={editDateError ? true : undefined}
                aria-describedby={editDateError ? "edit-datetime-error" : "edit-datetime-hint"}
              />
              {editDateError ? (
                <p id="edit-datetime-error" role="alert" className="text-sm text-destructive">
                  {editDateError}
                </p>
              ) : (
                <p id="edit-datetime-hint" className="text-xs text-muted-foreground">
                  Mínimo de 5 minutos à frente
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditMessage(null)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={handleEdit} disabled={saving || !editDate}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
