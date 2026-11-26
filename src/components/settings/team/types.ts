import type { Database, Tables } from "@/integrations/supabase/types";
import type { Sector } from "@/lib/sectors";

export type OrgRole = Database["public"]["Enums"]["org_role"];

export type TeamProfile = Pick<
  Tables<"profiles">,
  | "id"
  | "first_name"
  | "last_name"
  | "full_name"
  | "email"
  | "avatar_url"
  | "is_super_admin"
>;

export type TeamPhoneNumber = Pick<
  Tables<"phone_numbers">,
  | "id"
  | "display_name"
  | "phone_number"
  | "theme_hue"
  | "connection_type"
  | "is_active"
  | "sector_isolation_enabled"
  | "sector_follows_owner"
>;

export type RawOrganizationMember = Pick<
  Tables<"organization_members">,
  "id" | "user_id" | "role" | "sector_id" | "created_at"
> & {
  profiles: TeamProfile | TeamProfile[] | null;
};

export type RawUserPhoneAccess = Pick<
  Tables<"user_phone_numbers">,
  "id" | "user_id" | "phone_number_id" | "created_at"
> & {
  profiles: TeamProfile | TeamProfile[] | null;
};

export type TeamInvitation = Pick<
  Tables<"user_invitations">,
  | "id"
  | "email"
  | "phone_number_id"
  | "token"
  | "expires_at"
  | "accepted_at"
  | "created_at"
> & {
  phone_numbers: Pick<Tables<"phone_numbers">, "display_name"> | null;
};

export interface TeamMember {
  /** ID em organization_members (pode ser sintetizado se o usuário só estava em user_phone_numbers) */
  memberRecordId: string | null;
  userId: string;
  role: OrgRole;
  defaultSectorId: string | null;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  initials: string;
  isSuperAdmin: boolean;
  /** phone_number_id -> user_phone_numbers.id */
  explicitAccessByPhoneId: Record<string, string>;
  /** Setores vinculados (sector_members) */
  sectorIds: string[];
}

export type TeamViewMode = "members" | "lines";

export type MemberRoleFilter = "all" | "admin" | "agent";

export const SECTOR_PRESET_COLORS = [
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#22c55e", // green
  "#eab308", // yellow
  "#f97316", // orange
  "#ef4444", // red
] as const;

export function unwrapProfile(
  raw: TeamProfile | TeamProfile[] | null | undefined,
): TeamProfile | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

export function formatMemberDisplayName(profile: TeamProfile | null): string {
  if (!profile) return "Atendente sem perfil";
  const firstLast = `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim();
  if (firstLast) return firstLast;
  if (profile.full_name?.trim()) return profile.full_name.trim();
  if (profile.email?.trim()) return profile.email.trim();
  return "Sem nome";
}

export function formatMemberInitials(displayName: string, email?: string | null): string {
  const clean = displayName.trim();
  if (clean && clean !== "Sem nome" && clean !== "Atendente sem perfil") {
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
    }
    return clean.slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return "AT";
}

// A fórmula mora em `@/lib/phoneColor`, que a caixa conjunta também usa.
export { getPhoneLineColor } from "@/lib/phoneColor";

export function memberHasEffectivePhoneAccess(
  member: TeamMember,
  phoneNumberId: string,
): boolean {
  if (member.role === "admin" || member.isSuperAdmin) return true;
  return Boolean(member.explicitAccessByPhoneId[phoneNumberId]);
}

export type { Sector };
