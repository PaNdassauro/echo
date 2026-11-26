import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import MemberSectorsControl from "@/components/settings/MemberSectorsControl";
import SectorIsolationSwitch, { type IsolamentoDaLinha } from "@/components/settings/SectorIsolationSwitch";
import { sectorsForPhone, type Sector } from "@/lib/sectors";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Lock,
  QrCode,
  Search,
  ShieldCheck,
  Smartphone,
  Unlock,
  UserMinus,
  Users,
} from "lucide-react";
import { LineSectorManager } from "./LineSectorManager";
import { LinkMemberPopover } from "./LinkMemberPopover";
import type { CreateSectorInput } from "./schemas";
import { getPhoneLineColor, memberHasEffectivePhoneAccess, type TeamMember, type TeamPhoneNumber } from "./types";

interface TeamByPhoneViewProps {
  phoneNumbers: TeamPhoneNumber[];
  members: TeamMember[];
  sectors: Sector[];
  onTogglePhoneAccess: (userId: string, phoneNumberId: string, grant: boolean) => void;
  onToggleMemberSector: (userId: string, sectorId: string, checked: boolean) => void;
  onSetDefaultSector: (userId: string, sectorId: string | null) => void;
  onCreateSector: (input: CreateSectorInput) => Promise<boolean>;
  onRequestDeleteSector: (sector: { id: string; name: string }) => void;
  onOptimisticIsolationChange: (phoneNumberId: string, patch: Partial<IsolamentoDaLinha>) => void;
  onIsolationFailure: () => void;
}

export const TeamByPhoneView = ({
  phoneNumbers,
  members,
  sectors,
  onTogglePhoneAccess,
  onToggleMemberSector,
  onSetDefaultSector,
  onCreateSector,
  onRequestDeleteSector,
  onOptimisticIsolationChange,
  onIsolationFailure,
}: TeamByPhoneViewProps) => {
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>({});
  const [memberFilterByPhone, setMemberFilterByPhone] = useState<Record<string, string>>({});

  if (phoneNumbers.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-card/50 p-8 text-center">
        <Smartphone className="mx-auto mb-2 h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground">Nenhum número encontrado</p>
      </div>
    );
  }

  const isPhoneExpanded = (phoneId: string, idx: number) =>
    expandedById[phoneId] ?? (phoneNumbers.length <= 2 || idx === 0);

  const allExpanded = phoneNumbers.every((p, idx) => isPhoneExpanded(p.id, idx));
  const toggleAll = () => {
    const next: Record<string, boolean> = {};
    for (const p of phoneNumbers) next[p.id] = !allExpanded;
    setExpandedById(next);
  };

  return (
    <div className="space-y-3">
      {phoneNumbers.length > 1 && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={toggleAll} className="h-7 gap-1.5 text-xs text-muted-foreground">
            {allExpanded ? <><ChevronsDownUp className="h-3.5 w-3.5" /> Recolher todos os números</> : <><ChevronsUpDown className="h-3.5 w-3.5" /> Expandir todos os números</>}
          </Button>
        </div>
      )}

      {phoneNumbers.map((phone, idx) => {
        const isExpanded = isPhoneExpanded(phone.id, idx);
        const lineSectors = sectorsForPhone(sectors, phone.id);
        const membersWithAccess = members.filter((m) => memberHasEffectivePhoneAccess(m, phone.id));
        const membersWithoutAccess = members.filter((m) => !memberHasEffectivePhoneAccess(m, phone.id));
        const lineMemberQuery = (memberFilterByPhone[phone.id] ?? "").trim().toLowerCase();
        const visibleMembers = lineMemberQuery
          ? membersWithAccess.filter(
              (m) =>
                m.displayName.toLowerCase().includes(lineMemberQuery) ||
                (m.email ?? "").toLowerCase().includes(lineMemberQuery),
            )
          : membersWithAccess;

        return (
          <div key={phone.id} className="rounded-xl border bg-card overflow-hidden">
            <div className={`flex flex-col gap-3 bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${isExpanded ? "border-b" : ""}`}>
              <button
                type="button"
                onClick={() => setExpandedById((curr) => ({ ...curr, [phone.id]: !isExpanded }))}
                aria-expanded={isExpanded}
                className="flex flex-1 min-w-0 items-center gap-2.5 text-left"
              >
                {isExpanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                <span className="h-3.5 w-3.5 shrink-0 rounded-full ring-2 ring-background shadow-2xs" style={{ backgroundColor: getPhoneLineColor(phone.theme_hue) }} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="truncate text-sm font-semibold text-foreground">{phone.display_name}</h4>
                    <Badge variant="outline" className="gap-1 text-2xs font-normal">
                      {phone.connection_type === "qr" ? <><QrCode className="h-3 w-3" /> QR</> : <><Smartphone className="h-3 w-3" /> API</>}
                    </Badge>
                    <Badge variant="outline" className="gap-1 text-2xs font-normal">
                      {phone.sector_isolation_enabled ? <><Lock className="h-2.5 w-2.5 text-primary" /> Isolado</> : <><Unlock className="h-2.5 w-2.5" /> Aberto</>}
                    </Badge>
                    <Badge variant="secondary" className="gap-1 text-2xs">
                      <Users className="h-3 w-3" /> {membersWithAccess.length}
                    </Badge>
                  </div>
                  {phone.phone_number && <p className="text-xs text-muted-foreground">{phone.phone_number}</p>}
                </div>
              </button>

              <div className="flex items-center gap-2">
                {!isExpanded && membersWithAccess.length > 0 && (
                  <div className="flex -space-x-1.5 overflow-hidden pr-1">
                    {membersWithAccess.slice(0, 5).map((m) => (
                      <Avatar key={m.userId} className="h-6 w-6 border-2 border-background" title={m.displayName}>
                        {m.avatarUrl && <AvatarImage src={m.avatarUrl} alt={m.displayName} />}
                        <AvatarFallback className="bg-primary/10 text-2xs font-semibold text-primary">{m.initials}</AvatarFallback>
                      </Avatar>
                    ))}
                  </div>
                )}
                <LinkMemberPopover
                  phoneDisplayName={phone.display_name}
                  membersWithoutAccess={membersWithoutAccess}
                  onGrantAccess={(userId) => onTogglePhoneAccess(userId, phone.id, true)}
                />
              </div>
            </div>

            {isExpanded && (
              <div className="space-y-4 p-4">
                <div className="rounded-lg border bg-background/60 p-3">
                  <SectorIsolationSwitch
                    phoneNumberId={phone.id}
                    enabled={phone.sector_isolation_enabled}
                    followsOwner={phone.sector_follows_owner}
                    onOptimisticChange={(patch) => onOptimisticIsolationChange(phone.id, patch)}
                    onFailure={onIsolationFailure}
                  />
                </div>
                <LineSectorManager
                  phoneNumberId={phone.id}
                  lineSectors={lineSectors}
                  membersWithAccess={membersWithAccess}
                  onCreateSector={onCreateSector}
                  onRequestDeleteSector={onRequestDeleteSector}
                />

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-foreground">
                      Quem acessa esta linha ({membersWithAccess.length})
                    </p>
                    {membersWithAccess.length > 5 && (
                      <div className="relative w-52">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          placeholder="Filtrar nesta linha..."
                          value={memberFilterByPhone[phone.id] ?? ""}
                          onChange={(e) =>
                            setMemberFilterByPhone((curr) => ({ ...curr, [phone.id]: e.target.value }))
                          }
                          className="h-7 pl-7 text-xs"
                        />
                      </div>
                    )}
                  </div>

                  <div className="max-h-64 overflow-y-auto divide-y rounded-lg border bg-background">
                    {visibleMembers.map((member) => {
                      const isImplicitAdmin = member.role === "admin" || member.isSuperAdmin;
                      return (
                        <div key={member.userId} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <Avatar className="h-6 w-6 shrink-0 border">
                              {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt={member.displayName} />}
                              <AvatarFallback className="bg-primary/10 text-2xs font-semibold text-primary">{member.initials}</AvatarFallback>
                            </Avatar>
                            <span className="truncate text-xs font-medium text-foreground">{member.displayName}</span>
                            {isImplicitAdmin ? (
                              <Badge className="gap-1 bg-primary/15 text-primary border-primary/30 text-2xs px-1.5 py-0"><ShieldCheck className="h-2.5 w-2.5" /> Admin</Badge>
                            ) : (
                              <Badge variant="outline" className="text-2xs px-1.5 py-0">Atendente</Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <MemberSectorsControl
                              sectors={lineSectors}
                              memberSectorIds={member.sectorIds}
                              defaultSectorId={member.defaultSectorId}
                              isolationEnabled={phone.sector_isolation_enabled}
                              isAdminMember={isImplicitAdmin}
                              onToggle={(sId, c) => onToggleMemberSector(member.userId, sId, c)}
                              onSetDefault={(sId) => onSetDefaultSector(member.userId, sId)}
                            />
                            {!isImplicitAdmin && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onTogglePhoneAccess(member.userId, phone.id, false)}
                                aria-label={`Revogar acesso de ${member.displayName} a ${phone.display_name}`}
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                              >
                                <UserMinus className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
