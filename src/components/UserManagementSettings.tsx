import { useMemo, useState } from "react";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Loader2, Users } from "lucide-react";
import { InviteMemberDialog } from "@/components/settings/team/InviteMemberDialog";
import { PendingInvitesSection } from "@/components/settings/team/PendingInvitesSection";
import { TeamByPhoneView } from "@/components/settings/team/TeamByPhoneView";
import { TeamMemberMatrixView } from "@/components/settings/team/TeamMemberMatrixView";
import { TeamToolbarHeader } from "@/components/settings/team/TeamToolbarHeader";
import type { MemberRoleFilter, TeamMember, TeamViewMode } from "@/components/settings/team/types";
import { useTeamActions } from "@/components/settings/team/useTeamActions";
import { useTeamManagement } from "@/components/settings/team/useTeamManagement";

interface UserManagementSettingsProps {
  userId: string;
}

const UserManagementSettings = ({ userId }: UserManagementSettingsProps) => {
  const core = useTeamManagement(userId);
  const actions = useTeamActions(core);
  const {
    phoneNumbers,
    setPhoneNumbers,
    members,
    sectors,
    invitations,
    isAdmin,
    loading,
    refreshAll,
    togglePhoneAccess,
    removeMemberFromOrg,
    updateMemberRole,
  } = core;

  const [viewMode, setViewMode] = useState<TeamViewMode>("lines");
  const [roleFilter, setRoleFilter] = useState<MemberRoleFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  const [memberToRemove, setMemberToRemove] = useState<TeamMember | null>(null);
  const [removingMember, setRemovingMember] = useState(false);

  const [sectorToDelete, setSectorToDelete] = useState<{ id: string; name: string } | null>(null);
  const [deletingSector, setDeletingSector] = useState(false);

  const adminCount = useMemo(
    () => members.filter((m) => m.role === "admin" || m.isSuperAdmin).length,
    [members],
  );
  const agentCount = members.length - adminCount;
  const isolatedLinesCount = useMemo(
    () => phoneNumbers.filter((p) => p.sector_isolation_enabled).length,
    [phoneNumbers],
  );

  const sectorNameById = useMemo(
    () => new Map(sectors.map((s) => [s.id, s.name.toLowerCase()])),
    [sectors],
  );

  const filteredMembers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return members.filter((member) => {
      if (roleFilter === "admin" && member.role !== "admin" && !member.isSuperAdmin) return false;
      if (roleFilter === "agent" && (member.role === "admin" || member.isSuperAdmin)) return false;
      if (!q) return true;
      const matchesName = member.displayName.toLowerCase().includes(q);
      const matchesEmail = (member.email ?? "").toLowerCase().includes(q);
      const matchesSector = member.sectorIds.some((sId) => (sectorNameById.get(sId) ?? "").includes(q));
      return matchesName || matchesEmail || matchesSector;
    });
  }, [members, roleFilter, searchQuery, sectorNameById]);

  const filteredPhones = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return phoneNumbers;
    return phoneNumbers.filter(
      (p) => p.display_name.toLowerCase().includes(q) || p.phone_number.toLowerCase().includes(q),
    );
  }, [phoneNumbers, searchQuery]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="rounded-xl border bg-card py-12 text-center">
        <Users className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Apenas administradores podem gerenciar a equipe e permissões.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <TeamToolbarHeader
        totalMembers={members.length}
        adminCount={adminCount}
        agentCount={agentCount}
        isolatedLinesCount={isolatedLinesCount}
        totalLinesCount={phoneNumbers.length}
        viewMode={viewMode}
        roleFilter={roleFilter}
        searchQuery={searchQuery}
        onChangeViewMode={setViewMode}
        onChangeRoleFilter={setRoleFilter}
        onChangeSearchQuery={setSearchQuery}
        onOpenInvite={() => setInviteDialogOpen(true)}
      />

      <PendingInvitesSection
        invitations={invitations}
        phoneNumbers={phoneNumbers}
        onCopyLink={(token) => void actions.copyInviteLink(token)}
        onDeleteInvitation={(id) => void actions.deleteInvitation(id)}
      />

      {viewMode === "members" ? (
        <TeamMemberMatrixView
          members={filteredMembers}
          phoneNumbers={phoneNumbers}
          sectors={sectors}
          currentUserId={userId}
          onUpdateRole={(uId, role) => void updateMemberRole(uId, role)}
          onTogglePhoneAccess={(uId, pId, grant) => void togglePhoneAccess(uId, pId, grant)}
          onToggleMemberSector={(uId, sId, c) => void actions.toggleMemberSector(uId, sId, c)}
          onSetDefaultSector={(uId, sId) => void actions.updateDefaultSector(uId, sId)}
          onRequestRemoveMember={(member) => setMemberToRemove(member)}
        />
      ) : (
        <TeamByPhoneView
          phoneNumbers={filteredPhones}
          members={members}
          sectors={sectors}
          onTogglePhoneAccess={(uId, pId, grant) => void togglePhoneAccess(uId, pId, grant)}
          onToggleMemberSector={(uId, sId, c) => void actions.toggleMemberSector(uId, sId, c)}
          onSetDefaultSector={(uId, sId) => void actions.updateDefaultSector(uId, sId)}
          onCreateSector={(input) => actions.createSector(input)}
          onRequestDeleteSector={(sector) => setSectorToDelete(sector)}
          onOptimisticIsolationChange={(phoneId, patch) =>
            setPhoneNumbers((curr) => curr.map((p) => (p.id === phoneId ? { ...p, ...patch } : p)))
          }
          onIsolationFailure={() => void refreshAll()}
        />
      )}

      <InviteMemberDialog
        open={inviteDialogOpen}
        onOpenChange={setInviteDialogOpen}
        phoneNumbers={phoneNumbers}
        onSendInvitations={(input) => actions.sendInvitations(input)}
      />

      <ConfirmDestructiveDialog
        open={memberToRemove !== null}
        onOpenChange={(open) => !open && setMemberToRemove(null)}
        title={`Remover ${memberToRemove?.displayName} da organização?`}
        description="Esta ação revoga o acesso deste membro a todos os números e setores da organização. Não pode ser desfeita."
        confirmText={memberToRemove?.displayName}
        confirmLabel="Remover membro"
        pending={removingMember}
        onConfirm={async () => {
          if (!memberToRemove) return;
          setRemovingMember(true);
          const ok = await removeMemberFromOrg(memberToRemove.userId);
          setRemovingMember(false);
          if (ok) setMemberToRemove(null);
        }}
      />

      <ConfirmDestructiveDialog
        open={sectorToDelete !== null}
        onOpenChange={(open) => !open && setSectorToDelete(null)}
        title={`Excluir setor ${sectorToDelete?.name}?`}
        description="Os membros perdem o vínculo com este setor e as conversas dele voltam para a triagem — sem setor, visíveis a todos os atendentes da linha."
        confirmLabel="Excluir setor"
        pending={deletingSector}
        onConfirm={async () => {
          if (!sectorToDelete) return;
          setDeletingSector(true);
          const ok = await actions.deleteSector(sectorToDelete.id);
          setDeletingSector(false);
          if (ok) setSectorToDelete(null);
        }}
      />
    </div>
  );
};

export default UserManagementSettings;