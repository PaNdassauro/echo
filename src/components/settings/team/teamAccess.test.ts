import { describe, expect, it } from "vitest";
import {
  formatMemberDisplayName,
  formatMemberInitials,
  memberHasEffectivePhoneAccess,
  type TeamMember,
} from "./types";
import {
  createSectorSchema,
  inviteMemberSchema,
  roleChangeSchema,
} from "./schemas";

const makeMember = (overrides: Partial<TeamMember> = {}): TeamMember => ({
  memberRecordId: "mem-1",
  userId: "00000000-0000-4000-8000-000000000001",
  role: "agent",
  defaultSectorId: null,
  displayName: "Maria Silva",
  email: "maria@example.com",
  avatarUrl: null,
  initials: "MS",
  isSuperAdmin: false,
  explicitAccessByPhoneId: {},
  sectorIds: [],
  ...overrides,
});

describe("team access helpers & schemas", () => {
  it("grants implicit access to all lines for organization admins", () => {
    const admin = makeMember({ role: "admin", explicitAccessByPhoneId: {} });
    expect(memberHasEffectivePhoneAccess(admin, "phone-1")).toBe(true);
    expect(memberHasEffectivePhoneAccess(admin, "phone-2")).toBe(true);
  });

  it("grants access to agents only on explicitly linked lines", () => {
    const agent = makeMember({
      role: "agent",
      explicitAccessByPhoneId: { "phone-1": "access-row-1" },
    });
    expect(memberHasEffectivePhoneAccess(agent, "phone-1")).toBe(true);
    expect(memberHasEffectivePhoneAccess(agent, "phone-2")).toBe(false);
  });

  it("formats member display name and initials with fallbacks", () => {
    expect(
      formatMemberDisplayName({
        id: "u1",
        first_name: "João",
        last_name: "Souza",
        full_name: null,
        email: "joao@example.com",
        avatar_url: null,
        is_super_admin: false,
      }),
    ).toBe("João Souza");

    expect(formatMemberInitials("João Souza", "joao@example.com")).toBe("JS");
    expect(formatMemberInitials("Sem nome", "ana@example.com")).toBe("AN");
  });

  it("validates multi-line invitations and sector creation with Zod", () => {
    const validInvite = inviteMemberSchema.safeParse({
      email: "  atendente@empresa.com ",
      phoneNumberIds: ["00000000-0000-4000-8000-000000000010"],
    });
    expect(validInvite.success).toBe(true);

    const invalidInvite = inviteMemberSchema.safeParse({
      email: "invalido",
      phoneNumberIds: [],
    });
    expect(invalidInvite.success).toBe(false);

    const validSector = createSectorSchema.safeParse({
      name: "Comercial",
      phoneNumberId: "00000000-0000-4000-8000-000000000010",
      color: "#06b6d4",
    });
    expect(validSector.success).toBe(true);

    const validRole = roleChangeSchema.safeParse({
      userId: "00000000-0000-4000-8000-000000000001",
      role: "admin",
    });
    expect(validRole.success).toBe(true);
  });
});
