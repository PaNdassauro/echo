import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { Loader2, Mail, Smartphone, UserPlus } from "lucide-react";
import { Link } from "react-router-dom";
import type { InviteMemberInput } from "./schemas";
import { getPhoneLineColor, type TeamPhoneNumber } from "./types";
import { InviteLinksPanel } from "./InviteLinksPanel";
import type { ResultadoConvites } from "./inviteResult";

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phoneNumbers: TeamPhoneNumber[];
  onSendInvitations: (input: InviteMemberInput) => Promise<ResultadoConvites | null>;
}

export const InviteMemberDialog = ({
  open,
  onOpenChange,
  phoneNumbers,
  onSendInvitations,
}: InviteMemberDialogProps) => {
  const [email, setEmail] = useState("");
  const [selectedPhoneIds, setSelectedPhoneIds] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  // Depois de criar convites novos o diálogo troca o formulário pelos links para copiar.
  const [criado, setCriado] = useState<{ email: string; resultado: ResultadoConvites } | null>(null);

  useEffect(() => {
    if (open && phoneNumbers.length > 0 && selectedPhoneIds.length === 0) {
      setSelectedPhoneIds([phoneNumbers[0].id]);
    }
  }, [open, phoneNumbers, selectedPhoneIds.length]);

  const togglePhone = (phoneId: string, checked: boolean) => {
    setSelectedPhoneIds((curr) =>
      checked ? Array.from(new Set([...curr, phoneId])) : curr.filter((id) => id !== phoneId),
    );
  };

  const selectAll = () => {
    if (selectedPhoneIds.length === phoneNumbers.length) {
      setSelectedPhoneIds([]);
    } else {
      setSelectedPhoneIds(phoneNumbers.map((p) => p.id));
    }
  };

  // Instalação nova: o convite é por número, então sem nenhum não há o que oferecer.
  const semNumeros = phoneNumbers.length === 0;

  const handleSubmit = async () => {
    if (isSending) return;
    setIsSending(true);
    const destinatario = email.trim();
    const resultado = await onSendInvitations({
      email,
      phoneNumberIds: selectedPhoneIds,
    });
    setIsSending(false);
    if (!resultado) return;
    setEmail("");
    if (resultado.criados.length > 0) {
      setCriado({ email: destinatario, resultado });
    } else {
      onOpenChange(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) setCriado(null);
    onOpenChange(next);
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            {criado
              ? criado.resultado.criados.length > 1
                ? "Convites criados"
                : "Convite criado"
              : "Convidar membro para a equipe"}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {criado
              ? "A pessoa cria a conta pelo link e já entra com acesso aos números escolhidos."
              : semNumeros
                ? "O convite dá acesso a números de WhatsApp."
                : "Escolha os números que esta pessoa poderá atender. Se ela já tiver conta no Echo, o acesso é liberado na hora."}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {criado ? (
          <>
            <InviteLinksPanel email={criado.email} convites={criado.resultado.criados} />
            <ResponsiveDialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Concluir</Button>
            </ResponsiveDialogFooter>
          </>
        ) : semNumeros ? (
          <>
            <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
              <Smartphone className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                Conecte o primeiro número em Configurações &gt; Números, na aba QR Code (botão Gerar QR), e volte
                aqui para convidar a equipe.
              </p>
            </div>
            <ResponsiveDialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancelar
              </Button>
              <Button asChild>
                <Link to="/settings?tab=appearance" onClick={() => handleOpenChange(false)}>
                  Ir para Números
                </Link>
              </Button>
            </ResponsiveDialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="invite-member-email">E-mail do membro</Label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="invite-member-email"
                    type="email"
                    placeholder="nome@empresa.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && email.trim() && selectedPhoneIds.length > 0) {
                        void handleSubmit();
                      }
                    }}
                    className="pl-9"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Liberar acesso aos números ({selectedPhoneIds.length})</Label>
                  {phoneNumbers.length > 1 && (
                    <button
                      type="button"
                      onClick={selectAll}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      {selectedPhoneIds.length === phoneNumbers.length
                        ? "Desmarcar todos"
                        : "Selecionar todos"}
                    </button>
                  )}
                </div>

                <div className="max-h-52 space-y-1.5 overflow-y-auto rounded-lg border bg-muted/20 p-2">
                  {phoneNumbers.map((phone) => {
                    const checked = selectedPhoneIds.includes(phone.id);
                    return (
                      <label
                        key={phone.id}
                        className={`flex cursor-pointer items-center justify-between rounded-md border px-3 py-2 text-xs transition-colors ${
                          checked
                            ? "border-primary/40 bg-primary/5"
                            : "border-transparent bg-background hover:bg-muted/50"
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: getPhoneLineColor(phone.theme_hue) }}
                          />
                          <span className="truncate font-medium text-foreground">
                            {phone.display_name}
                          </span>
                        </span>
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(val) => togglePhone(phone.id, Boolean(val))}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <ResponsiveDialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSending}>
                Cancelar
              </Button>
              <Button
                onClick={() => void handleSubmit()}
                disabled={isSending || !email.trim() || selectedPhoneIds.length === 0}
                className="gap-1.5"
              >
                {isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <UserPlus className="h-4 w-4" />
                )}
                Enviar convite
              </Button>
            </ResponsiveDialogFooter>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
};
