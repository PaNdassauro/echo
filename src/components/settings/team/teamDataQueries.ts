import { supabase } from "@/integrations/supabase/client";
import { SECTOR_SELECT, type Sector } from "@/lib/sectors";
import {
  formatMemberDisplayName,
  formatMemberInitials,
  unwrapProfile,
  type RawOrganizationMember,
  type RawUserPhoneAccess,
  type TeamInvitation,
  type TeamMember,
  type TeamPhoneNumber,
  type TeamProfile,
} from "./types";

export interface TeamSnapshot {
  phoneNumbers: TeamPhoneNumber[];
  members: TeamMember[];
  sectors: Sector[];
  invitations: TeamInvitation[];
}

export async function fetchTeamSnapshot(organizationId: string): Promise<TeamSnapshot> {
  const [phonesResult, orgMembersResult, sectorsResult] = await Promise.all([
    supabase
      .from("phone_numbers")
      .select(
        "id, display_name, phone_number, theme_hue, connection_type, is_active, sector_isolation_enabled, sector_follows_owner",
      )
      .eq("organization_id", organizationId)
      .order("display_name"),
    supabase
      .from("organization_members")
      .select(
        `
        id,
        user_id,
        role,
        sector_id,
        created_at,
        profiles:user_id (id, first_name, last_name, full_name, email, avatar_url, is_super_admin)
      `,
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("sectors")
      .select(SECTOR_SELECT)
      .eq("organization_id", organizationId)
      .order("name"),
  ]);

  const phoneNumbers: TeamPhoneNumber[] = phonesResult.data ?? [];
  const phoneIds = phoneNumbers.map((p) => p.id);
  const rawOrgMembers = (orgMembersResult.data ?? []) as unknown as RawOrganizationMember[];
  const sectors: Sector[] = (sectorsResult.data ?? []) as Sector[];
  const sectorIds = sectors.map((s) => s.id);

  const [accessResult, invitesResult, sectorMembersResult] = await Promise.all([
    phoneIds.length > 0
      ? supabase
          .from("user_phone_numbers")
          .select(
            `
            id,
            user_id,
            phone_number_id,
            created_at,
            profiles:user_id (id, first_name, last_name, full_name, email, avatar_url, is_super_admin)
          `,
          )
          .in("phone_number_id", phoneIds)
      : Promise.resolve({ data: [], error: null }),
    phoneIds.length > 0
      ? supabase
          .from("user_invitations")
          .select(
            `
            id,
            email,
            phone_number_id,
            token,
            expires_at,
            accepted_at,
            created_at,
            phone_numbers:phone_number_id (display_name)
          `,
          )
          .in("phone_number_id", phoneIds)
          .is("accepted_at", null)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    sectorIds.length > 0
      ? supabase
          .from("sector_members")
          .select("sector_id, user_id")
          .in("sector_id", sectorIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const rawPhoneAccess = (accessResult.data ?? []) as unknown as RawUserPhoneAccess[];
  const invitations = (invitesResult.data ?? []) as unknown as TeamInvitation[];

  const sectorsByUser: Record<string, string[]> = {};
  for (const row of sectorMembersResult.data ?? []) {
    sectorsByUser[row.user_id] = [...(sectorsByUser[row.user_id] ?? []), row.sector_id];
  }

  const membersByUserId = new Map<string, TeamMember>();

  const upsertFromProfile = (
    userId: string,
    profile: TeamProfile | null,
    defaults: Partial<TeamMember>,
  ): TeamMember => {
    const existing = membersByUserId.get(userId);
    const displayName = formatMemberDisplayName(profile);
    const email = profile?.email ?? existing?.email ?? null;
    const base: TeamMember = existing ?? {
      memberRecordId: null,
      userId,
      role: "agent",
      defaultSectorId: null,
      displayName,
      email,
      avatarUrl: profile?.avatar_url ?? null,
      initials: formatMemberInitials(displayName, email),
      isSuperAdmin: Boolean(profile?.is_super_admin),
      explicitAccessByPhoneId: {},
      sectorIds: sectorsByUser[userId] ?? [],
    };

    const merged: TeamMember = {
      ...base,
      ...defaults,
    };
    membersByUserId.set(userId, merged);
    return merged;
  };

  // Quem tem vínculo com esta organização é da equipe, mesmo sendo super admin (o administrador da instalação é os dois).
  for (const row of rawOrgMembers) {
    const profile = unwrapProfile(row.profiles);
    upsertFromProfile(row.user_id, profile, {
      memberRecordId: row.id,
      role: row.role,
      defaultSectorId: row.sector_id,
    });
  }

  for (const access of rawPhoneAccess) {
    const profile = unwrapProfile(access.profiles);
    if (profile?.is_super_admin && !membersByUserId.has(access.user_id)) continue;
    const member = upsertFromProfile(access.user_id, profile, {});
    member.explicitAccessByPhoneId = {
      ...member.explicitAccessByPhoneId,
      [access.phone_number_id]: access.id,
    };
  }

  const members = Array.from(membersByUserId.values()).sort((a, b) => {
    if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
    return a.displayName.localeCompare(b.displayName, "pt-BR");
  });

  return {
    phoneNumbers,
    members,
    sectors,
    invitations,
  };
}
