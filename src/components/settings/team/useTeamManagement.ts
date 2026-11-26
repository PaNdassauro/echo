import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { fetchTeamSnapshot } from "./teamDataQueries";
import { roleChangeSchema } from "./schemas";
import type {
  OrgRole,
  Sector,
  TeamInvitation,
  TeamMember,
  TeamPhoneNumber,
} from "./types";

export function useTeamManagement(currentUserId: string) {
  const { toast } = useToast();
  const { currentOrganization, userRole, isSuperAdmin } = useOrganization();
  const orgId = currentOrganization?.id ?? null;

  const [phoneNumbers, setPhoneNumbers] = useState<TeamPhoneNumber[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [invitations, setInvitations] = useState<TeamInvitation[]>([]);
  const [isAdmin, setIsAdmin] = useState<boolean>(isSuperAdmin || userRole === "admin");
  const [loading, setLoading] = useState<boolean>(true);

  const refreshAll = useCallback(async () => {
    if (!orgId) {
      setPhoneNumbers([]);
      setMembers([]);
      setSectors([]);
      setInvitations([]);
      setLoading(false);
      return;
    }
    const snapshot = await fetchTeamSnapshot(orgId);
    setPhoneNumbers(snapshot.phoneNumbers);
    setMembers(snapshot.members);
    setSectors(snapshot.sectors);
    setInvitations(snapshot.invitations);
  }, [orgId]);

  useEffect(() => {
    let active = true;
    const init = async () => {
      if (!orgId) {
        setIsAdmin(false);
        setLoading(false);
        return;
      }
      setLoading(true);
      if (isSuperAdmin || userRole === "admin") {
        setIsAdmin(true);
      } else {
        const { data } = await supabase
          .from("organization_members")
          .select("role")
          .eq("user_id", currentUserId)
          .eq("organization_id", orgId)
          .eq("role", "admin")
          .limit(1);
        if (active) setIsAdmin(Boolean(data && data.length > 0));
      }
      await refreshAll();
      if (active) setLoading(false);
    };
    void init();
    return () => {
      active = false;
    };
  }, [orgId, currentUserId, isSuperAdmin, userRole, refreshAll]);

  const togglePhoneAccess = async (
    targetUserId: string,
    phoneNumberId: string,
    grant: boolean,
  ) => {
    const prevMembers = members;
    setMembers((curr) =>
      curr.map((m) => {
        if (m.userId !== targetUserId) return m;
        const nextMap = { ...m.explicitAccessByPhoneId };
        if (grant) nextMap[phoneNumberId] = "optimistic";
        else delete nextMap[phoneNumberId];
        return { ...m, explicitAccessByPhoneId: nextMap };
      }),
    );

    if (grant) {
      const { data, error } = await supabase
        .from("user_phone_numbers")
        .insert({ user_id: targetUserId, phone_number_id: phoneNumberId })
        .select("id")
        .single();

      if (error || !data) {
        setMembers(prevMembers);
        toast({
          title: "Não foi possível liberar acesso à linha",
          description: toUserMessage(error),
          variant: "destructive",
        });
        return;
      }
      setMembers((curr) =>
        curr.map((m) =>
          m.userId === targetUserId
            ? { ...m, explicitAccessByPhoneId: { ...m.explicitAccessByPhoneId, [phoneNumberId]: data.id } }
            : m,
        ),
      );
      toast({ title: "Acesso à linha liberado" });
    } else {
      const { error } = await supabase
        .from("user_phone_numbers")
        .delete()
        .eq("user_id", targetUserId)
        .eq("phone_number_id", phoneNumberId);

      if (error) {
        setMembers(prevMembers);
        toast({
          title: "Não foi possível remover acesso à linha",
          description: toUserMessage(error),
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Acesso à linha revogado" });
    }
  };

  const removeMemberFromOrg = async (targetUserId: string) => {
    if (!orgId) return false;
    const phoneIds = phoneNumbers.map((p) => p.id);
    if (phoneIds.length > 0) {
      const { error: accessErr } = await supabase
        .from("user_phone_numbers")
        .delete()
        .eq("user_id", targetUserId)
        .in("phone_number_id", phoneIds);
      if (accessErr) {
        toast({
          title: "Não foi possível remover acessos do membro",
          description: toUserMessage(accessErr),
          variant: "destructive",
        });
        return false;
      }
    }

    const { error: orgErr } = await supabase
      .from("organization_members")
      .delete()
      .eq("user_id", targetUserId)
      .eq("organization_id", orgId);

    if (orgErr) {
      toast({
        title: "Não foi possível remover membro da organização",
        description: toUserMessage(orgErr),
        variant: "destructive",
      });
      return false;
    }

    toast({
      title: "Membro removido da organização",
      description: "Todos os acessos a números desta organização foram revogados.",
    });
    await refreshAll();
    return true;
  };

  const updateMemberRole = async (targetUserId: string, newRole: OrgRole) => {
    if (!orgId) return;
    const parsed = roleChangeSchema.safeParse({ userId: targetUserId, role: newRole });
    if (!parsed.success) {
      toast({
        title: "Dados inválidos",
        description: parsed.error.issues[0]?.message ?? "Cargo inválido.",
        variant: "destructive",
      });
      return;
    }

    const prevMembers = members;
    setMembers((curr) => curr.map((m) => (m.userId === targetUserId ? { ...m, role: newRole } : m)));

    const { error } = await supabase
      .from("organization_members")
      .update({ role: newRole })
      .eq("user_id", targetUserId)
      .eq("organization_id", orgId);

    if (error) {
      setMembers(prevMembers);
      toast({
        title: "Não foi possível atualizar cargo",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Cargo atualizado",
      description:
        newRole === "admin"
          ? "Membro promovido a Admin (acesso total a todas as linhas e setores)."
          : "Membro definido como Atendente (acesso restrito às linhas vinculadas).",
    });
  };

  return {
    orgId,
    phoneNumbers,
    setPhoneNumbers,
    members,
    setMembers,
    sectors,
    invitations,
    isAdmin,
    loading,
    refreshAll,
    togglePhoneAccess,
    removeMemberFromOrg,
    updateMemberRole,
  };
}
export type TeamCoreState = ReturnType<typeof useTeamManagement>;
