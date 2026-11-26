import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IdCopyButton } from "@/components/ui/id-copy-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import MemberSectorsControl from "@/components/settings/MemberSectorsControl";
import { sectorsForPhone, type Sector } from "@/lib/sectors";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Lock,
  ShieldCheck,
  Smartphone,
  Trash2,
  Unlock,
  UserCheck,
} from "lucide-react";
import {
  getPhoneLineColor,
  memberHasEffectivePhoneAccess,
  type OrgRole,
  type TeamMember,
  type TeamPhoneNumber,
} from "./types";

interface TeamMemberMatrixViewProps {
  members: TeamMember[];
  phoneNumbers: TeamPhoneNumber[];
  sectors: Sector[];
  currentUserId: string;
  onUpdateRole: (userId: string, role: OrgRole) => void;
  onTogglePhoneAccess: (userId: string, phoneNumberId: string, grant: boolean) => void;
  onToggleMemberSector: (userId: string, sectorId: string, checked: boolean) => void;
  onSetDefaultSector: (userId: string, sectorId: string | null) => void;
  onRequestRemoveMember: (member: TeamMember) => void;
}

export const TeamMemberMatrixView = ({
  members,
  phoneNumbers,
  sectors,
  currentUserId,
  onUpdateRole,
  onTogglePhoneAccess,
  onToggleMemberSector,
  onSetDefaultSector,
  onRequestRemoveMember,
}: TeamMemberMatrixViewProps) => {
  const [expandedByUser, setExpandedByUser] = useState<Record<string, boolean>>({});

  if (members.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-card/50 p-8 text-center">
        <UserCheck className="mx-auto mb-2 h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground">Nenhum membro encontrado para este filtro</p>
        <p className="mt-1 text-xs text-muted-foreground">Ajuste a busca ou convide um novo membro no botão acima.</p>
      </div>
    );
  }

  const isMemberExpanded = (userId: string, idx: number) =>
    expandedByUser[userId] ?? (members.length <= 3 || idx === 0);

  const allExpanded = members.every((m, idx) => isMemberExpanded(m.userId, idx));
  const toggleAll = () => {
    const next: Record<string, boolean> = {};
    for (const m of members) next[m.userId] = !allExpanded;
    setExpandedByUser(next);
  };

  return (
    <div className="space-y-3">
      {members.length > 1 && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={toggleAll} className="h-7 gap-1.5 text-xs text-muted-foreground">
            {allExpanded ? <><ChevronsDownUp className="h-3.5 w-3.5" /> Recolher todos os membros</> : <><ChevronsUpDown className="h-3.5 w-3.5" /> Expandir todos os membros</>}
          </Button>
        </div>
      )}

      {members.map((member, idx) => {
        const isExpanded = isMemberExpanded(member.userId, idx);
        const isImplicitAdmin = member.role === "admin" || member.isSuperAdmin;
        const explicitCount = Object.keys(member.explicitAccessByPhoneId).length;
        const accessibleCount = isImplicitAdmin ? phoneNumbers.length : explicitCount;
        const isSelf = member.userId === currentUserId;
        const lineWord = phoneNumbers.length === 1 ? "linha" : "linhas";

        return (
          <div key={member.userId} className="rounded-xl border bg-card overflow-hidden">
            <div className={`flex flex-col gap-3 bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${isExpanded ? "border-b" : ""}`}>
              <button
                type="button"
                onClick={() => setExpandedByUser((curr) => ({ ...curr, [member.userId]: !isExpanded }))}
                aria-expanded={isExpanded}
                className="flex flex-1 min-w-0 items-center gap-2.5 text-left"
              >
                {isExpanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                <Avatar className="h-8 w-8 shrink-0 border">
                  {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt={member.displayName} />}
                  <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{member.initials}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{member.displayName}</span>
                    {isSelf && <Badge variant="outline" className="text-2xs px-1.5 py-0">Você</Badge>}
                    <IdCopyButton id={member.userId} label="User ID" className="h-4 w-4 text-muted-foreground" />
                  </div>
                  {member.email && member.email !== member.displayName && (
                    <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                  )}
                </div>
              </button>

              <div className="flex flex-wrap items-center gap-2">
                {isImplicitAdmin ? (
                  <Badge className="gap-1 bg-primary/15 text-primary hover:bg-primary/20 border-primary/30 text-xs font-medium">
                    <ShieldCheck className="h-3.5 w-3.5" /> Acesso total ({phoneNumbers.length} {lineWord})
                  </Badge>
                ) : accessibleCount === 0 ? (
                  <Badge variant="outline" className="gap-1 border-destructive/40 bg-destructive/10 text-destructive text-xs">
                    <AlertCircle className="h-3.5 w-3.5" /> Sem acesso a linhas
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1 text-xs font-medium">
                    <Smartphone className="h-3.5 w-3.5 text-muted-foreground" /> {accessibleCount} de {phoneNumbers.length} {lineWord}
                  </Badge>
                )}

                <Select value={member.role} onValueChange={(val) => onUpdateRole(member.userId, val as OrgRole)}>
                  <SelectTrigger className="h-8 w-[135px] text-xs font-medium bg-background" aria-label={`Cargo de ${member.displayName}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">Atendente</SelectItem>
                    <SelectItem value="admin">Admin (Total)</SelectItem>
                  </SelectContent>
                </Select>

                {!isSelf && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRequestRemoveMember(member)}
                    aria-label={`Remover ${member.displayName} da organização`}
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            {isExpanded && (
              <div className="max-h-72 overflow-y-auto grid grid-cols-1 gap-2.5 p-4 md:grid-cols-2">
                {phoneNumbers.map((phone) => {
                  const hasEffectiveAccess = memberHasEffectivePhoneAccess(member, phone.id);
                  const hasExplicitAccess = Boolean(member.explicitAccessByPhoneId[phone.id]);

                  return (
                    <div
                      key={phone.id}
                      className={`flex flex-col justify-between gap-2.5 rounded-lg border p-3 transition-all ${
                        hasEffectiveAccess ? "border-border bg-background/60" : "border-dashed border-border/60 bg-muted/15 opacity-70 hover:opacity-100"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: getPhoneLineColor(phone.theme_hue) }} />
                          <span className="truncate text-sm font-medium text-foreground">{phone.display_name}</span>
                          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-muted-foreground bg-muted/60">
                            {phone.sector_isolation_enabled ? <><Lock className="h-2.5 w-2.5 text-primary" /> Isolado</> : <><Unlock className="h-2.5 w-2.5" /> Aberto</>}
                          </span>
                        </div>
                        {isImplicitAdmin ? (
                          <span className="inline-flex items-center gap-1 text-2xs font-medium text-success shrink-0">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Admin
                          </span>
                        ) : (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-2xs text-muted-foreground">{hasExplicitAccess ? "Ativo" : "Sem acesso"}</span>
                            <Switch
                              checked={hasExplicitAccess}
                              onCheckedChange={(c) => onTogglePhoneAccess(member.userId, phone.id, c)}
                              aria-label={`Acesso de ${member.displayName} à linha ${phone.display_name}`}
                            />
                          </div>
                        )}
                      </div>
                      {hasEffectiveAccess ? (
                        <MemberSectorsControl
                          sectors={sectorsForPhone(sectors, phone.id)}
                          memberSectorIds={member.sectorIds}
                          defaultSectorId={member.defaultSectorId}
                          isolationEnabled={phone.sector_isolation_enabled}
                          isAdminMember={isImplicitAdmin}
                          onToggle={(sId, checked) => onToggleMemberSector(member.userId, sId, checked)}
                          onSetDefault={(sId) => onSetDefaultSector(member.userId, sId)}
                        />
                      ) : (
                        <p className="text-2xs text-muted-foreground">Ative a chave acima para liberar este número ao atendente.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
