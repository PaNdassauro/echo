import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Loader2, User, Phone, Search, UserPlus, Users } from "lucide-react";
import { toUserMessage } from "@/lib/userFacingError";

interface Contact {
  id: string;
  contact_name: string;
  contact_phone: string;
}

interface ContactPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phoneNumberId: string;
  targetPhone: string; // Who to send the contact to
  conversationId: string;
  quotedMessageId?: string | null;
  onSent?: () => void;
}

const ContactPickerModal = ({
  open,
  onOpenChange,
  phoneNumberId,
  targetPhone,
  conversationId,
  quotedMessageId,
  onSent,
}: ContactPickerModalProps) => {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);

  // Manual form
  const [manualName, setManualName] = useState("");
  const [manualPhone, setManualPhone] = useState("");

  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      fetchContacts();
    }
  }, [open, phoneNumberId]);

  const fetchContacts = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("conversations")
        .select("id, contact_name, contact_phone")
        .eq("phone_number_id", phoneNumberId)
        .eq("is_group", false)
        // Direct do Instagram não tem telefone para compartilhar.
        .eq("channel", "whatsapp")
        .order("last_message_at", { ascending: false })
        .limit(100);

      if (error) throw error;
      setContacts(data || []);
    } catch (error) {
      console.error("Error fetching contacts:", error);
      toast({
        title: "Não foi possível carregar os contatos",
        description: "Verifique a conexão e tente novamente.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const formatPhoneNumber = (phone: string): string => {
    const digits = phone.replace(/\D/g, "");
    if (digits.length >= 12 && digits.length <= 13) {
      const country = digits.slice(0, 2);
      const ddd = digits.slice(2, 4);
      const rest = digits.slice(4);
      if (rest.length >= 8) {
        const firstPart = rest.slice(0, rest.length - 4);
        const lastPart = rest.slice(-4);
        return `+${country} ${ddd} ${firstPart}-${lastPart}`;
      }
    }
    return `+${digits}`;
  };

  const handleSendContact = async (displayName: string, phone: string) => {
    setIsSending(true);
    try {
      // Edge function roteia por canal (QR via Baileys, Cloud API via
      // type:contacts) e grava a linha — antes era qrFetch direto, QR-only.
      const { data, error } = await supabase.functions.invoke("whatsapp-send-contact", {
        body: {
          to: targetPhone,
          conversationId,
          phoneNumberId,
          displayName,
          phone: phone.replace(/\D/g, ""),
          quotedMessageId: quotedMessageId ?? null,
        },
      });

      if (error || !data?.success) {
        // invoke() não devolve o corpo no erro — a mensagem real vem em error.context
        let message = data?.error || error?.message || "Falha ao enviar contato";
        const ctx = (error as { context?: Response } | null)?.context;
        if (ctx && typeof ctx.json === "function") {
          try {
            const body = await ctx.json();
            if (body?.error) message = body.error;
          } catch { /* corpo não-JSON: mantém a mensagem padrão */ }
        }
        throw new Error(message);
      }

      toast({
        title: "Contato enviado",
        description: `${displayName} foi compartilhado`,
      });

      // Reset and close
      setSelectedContact(null);
      setManualName("");
      setManualPhone("");
      setSearch("");
      onOpenChange(false);
      onSent?.();
    } catch (error: unknown) {
      console.error("Error sending contact:", error);
      toast({
        title: "Não foi possível enviar contato",
        description: toUserMessage(error),
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  const normalizedSearch = search.replace(/\D/g, '');
  const filteredContacts = contacts.filter(
    (c) =>
      c.contact_name.toLowerCase().includes(search.toLowerCase()) ||
      c.contact_phone.includes(search) ||
      (normalizedSearch && c.contact_phone.includes(normalizedSearch))
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="w-5 h-5" />
            Enviar Contato
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="existing" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="existing" className="flex items-center gap-2">
              <Users className="w-4 h-4" />
              Existente
            </TabsTrigger>
            <TabsTrigger value="manual" className="flex items-center gap-2">
              <UserPlus className="w-4 h-4" />
              Novo
            </TabsTrigger>
          </TabsList>

          <TabsContent value="existing" className="space-y-4">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar contato…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* Contact List */}
            <ScrollArea className="h-[250px]">
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : filteredContacts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  {contacts.length === 0
                    ? "Nenhum contato encontrado"
                    : "Nenhum resultado para a busca"}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredContacts.map((contact) => (
                    <button
                      key={contact.id}
                      onClick={() => setSelectedContact(contact)}
                      className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left active:scale-[0.96] motion-reduce:active:scale-100 transition-[background-color,border-color,transform] duration-150 ease-out ${
                        selectedContact?.id === contact.id
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50 hover:bg-muted/50"
                      }`}
                    >
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                        <User className="w-5 h-5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate" title={contact.contact_name ?? undefined}>
                          {contact.contact_name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatPhoneNumber(contact.contact_phone)}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>

            {/* Send Button */}
            <Button
              className="w-full"
              onClick={() =>
                selectedContact &&
                handleSendContact(
                  selectedContact.contact_name,
                  selectedContact.contact_phone
                )
              }
              disabled={!selectedContact || isSending}
            >
              {isSending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Enviando…
                </>
              ) : (
                "Enviar contato selecionado"
              )}
            </Button>
          </TabsContent>

          <TabsContent value="manual" className="space-y-4">
            {/* Name */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Nome do contato</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder="Nome completo"
                  className="pl-10"
                />
              </div>
            </div>

            {/* Phone */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Telefone</Label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={manualPhone}
                  onChange={(e) => setManualPhone(e.target.value)}
                  placeholder="5511999999999"
                  className="pl-10"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Digite o numero com codigo do pais
              </p>
            </div>

            {/* Send Button */}
            <Button
              className="w-full"
              onClick={() => handleSendContact(manualName, manualPhone)}
              disabled={!manualName.trim() || !manualPhone.trim() || isSending}
            >
              {isSending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Enviando…
                </>
              ) : (
                "Enviar contato"
              )}
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};

export default ContactPickerModal;
