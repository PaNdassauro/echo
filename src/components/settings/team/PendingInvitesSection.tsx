import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Clock, Copy, Mail, Trash2 } from "lucide-react";
import {
  getPhoneLineColor,
  type TeamInvitation,
  type TeamPhoneNumber,
} from "./types";

interface PendingInvitesSectionProps {
  invitations: TeamInvitation[];
  phoneNumbers: TeamPhoneNumber[];
  onCopyLink: (token: string) => void;
  onDeleteInvitation: (invitationId: string) => void;
}

export const PendingInvitesSection = ({
  invitations,
  phoneNumbers,
  onCopyLink,
  onDeleteInvitation,
}: PendingInvitesSectionProps) => {
  if (invitations.length === 0) return null;

  const phoneById = new Map(phoneNumbers.map((p) => [p.id, p]));

  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-warning" />
          <h4 className="text-sm font-semibold text-foreground">
            Convites pendentes ({invitations.length})
          </h4>
        </div>
        <span className="text-xs text-muted-foreground">
          Aguardando criação de conta pelo link
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {invitations.map((invite) => {
          const isExpired = new Date(invite.expires_at) < new Date();
          const phone = phoneById.get(invite.phone_number_id);
          const phoneName =
            phone?.display_name ?? invite.phone_numbers?.display_name ?? "Linha";

          return (
            <div
              key={invite.id}
              className={`flex items-center justify-between gap-2 rounded-lg border p-2.5 ${
                isExpired
                  ? "border-destructive/30 bg-destructive/5"
                  : "border-warning/30 bg-warning/5"
              }`}
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  {isExpired ? (
                    <Clock className="h-3.5 w-3.5 shrink-0 text-destructive" />
                  ) : (
                    <Mail className="h-3.5 w-3.5 shrink-0 text-warning" />
                  )}
                  <span className="truncate text-xs font-medium text-foreground">
                    {invite.email}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 pl-5">
                  <Badge variant="outline" className="gap-1 text-2xs px-1.5 py-0 font-normal">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{
                        backgroundColor: getPhoneLineColor(phone?.theme_hue ?? null),
                      }}
                    />
                    {phoneName}
                  </Badge>
                  <span className="text-2xs text-muted-foreground">
                    {isExpired
                      ? "Expirado"
                      : `Expira em ${format(new Date(invite.expires_at), "dd/MM", {
                          locale: ptBR,
                        })}`}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {!isExpired && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onCopyLink(invite.token)}
                    title="Copiar link de convite"
                    aria-label={`Copiar link de convite para ${invite.email}`}
                    className="h-7 w-7 p-0"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onDeleteInvitation(invite.id)}
                  title="Cancelar convite"
                  aria-label={`Cancelar convite para ${invite.email}`}
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
