import { beforeEach, describe, expect, it, vi } from "vitest";

type Linhas = Record<string, unknown[]>;
const tabelas = vi.hoisted(() => ({ dados: {} as Linhas }));

vi.mock("@/integrations/supabase/client", () => {
  const consulta = (tabela: string) => {
    const resultado = { data: tabelas.dados[tabela] ?? [], error: null };
    const cadeia: Record<string, unknown> = {};
    for (const metodo of ["select", "eq", "in", "is", "order"]) cadeia[metodo] = () => cadeia;
    cadeia.then = (ok: (valor: typeof resultado) => unknown) => Promise.resolve(resultado).then(ok);
    return cadeia;
  };
  return { supabase: { from: consulta } };
});

import { fetchTeamSnapshot } from "./teamDataQueries";

const perfil = (id: string, email: string, superAdmin: boolean) => ({
  id,
  first_name: null,
  last_name: null,
  full_name: email,
  email,
  avatar_url: null,
  is_super_admin: superAdmin,
});

const membro = (userId: string, email: string, superAdmin: boolean, role: "admin" | "agent") => ({
  id: `m-${userId}`,
  user_id: userId,
  role,
  sector_id: null,
  created_at: "2026-01-01T00:00:00Z",
  profiles: perfil(userId, email, superAdmin),
});

beforeEach(() => {
  tabelas.dados = {
    phone_numbers: [{ id: "p1", display_name: "Linha", phone_number: "+5500000000000", connection_type: "qr" }],
  };
});

describe("fetchTeamSnapshot", () => {
  it("lista o super admin que é membro da organização (o administrador da instalação)", async () => {
    tabelas.dados.organization_members = [
      membro("u1", "admin@example.com", true, "admin"),
      membro("u2", "agente@example.com", false, "agent"),
    ];
    const { members } = await fetchTeamSnapshot("org-1");
    expect(members.map((m) => m.email)).toEqual(["admin@example.com", "agente@example.com"]);
    expect(members[0]).toMatchObject({ role: "admin", isSuperAdmin: true });
  });

  it("não inclui super admin que só aparece por acesso a número, sem vínculo com a organização", async () => {
    tabelas.dados.organization_members = [membro("u2", "agente@example.com", false, "agent")];
    tabelas.dados.user_phone_numbers = [
      { id: "a1", user_id: "u9", phone_number_id: "p1", created_at: "2026-01-01T00:00:00Z", profiles: perfil("u9", "plataforma@example.com", true) },
    ];
    const { members } = await fetchTeamSnapshot("org-1");
    expect(members.map((m) => m.email)).toEqual(["agente@example.com"]);
  });

  it("junta o acesso a número ao super admin que já é membro", async () => {
    tabelas.dados.organization_members = [membro("u1", "admin@example.com", true, "admin")];
    tabelas.dados.user_phone_numbers = [
      { id: "a1", user_id: "u1", phone_number_id: "p1", created_at: "2026-01-01T00:00:00Z", profiles: perfil("u1", "admin@example.com", true) },
    ];
    const { members } = await fetchTeamSnapshot("org-1");
    expect(members).toHaveLength(1);
    expect(members[0].explicitAccessByPhoneId).toEqual({ p1: "a1" });
  });
});
