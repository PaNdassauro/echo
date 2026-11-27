import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  insert: { data: null as { id: string } | null, error: null as { message: string; code?: string } | null },
  busca: { data: null as { id: string } | null, error: null as { message: string } | null },
  inserts: [] as Array<Record<string, unknown>>,
  filtros: [] as Array<[string, unknown]>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      insert: (linha: Record<string, unknown>) => {
        h.inserts.push(linha);
        return { select: () => ({ single: () => Promise.resolve(h.insert) }) };
      },
      select: () => {
        const consulta = {
          eq: (coluna: string, valor: unknown) => {
            h.filtros.push([coluna, valor]);
            return consulta;
          },
          maybeSingle: () => Promise.resolve(h.busca),
        };
        return consulta;
      },
    }),
  },
}));

const { garantirConversaDoGrupo } = await import("./groupConversation");

beforeEach(() => {
  h.insert = { data: null, error: null };
  h.busca = { data: null, error: null };
  h.inserts.length = 0;
  h.filtros.length = 0;
});

describe("garantirConversaDoGrupo", () => {
  it("insere a conversa do grupo e devolve o id", async () => {
    h.insert = { data: { id: "nova" }, error: null };
    const r = await garantirConversaDoGrupo("linha-1", "123@g.us", "Equipe");
    expect(r).toEqual({ conversationId: "nova", error: null });
    expect(h.inserts[0]).toMatchObject({ phone_number_id: "linha-1", contact_phone: "123@g.us", group_jid: "123@g.us", is_group: true, contact_name: "Equipe" });
    expect(h.filtros).toEqual([]);
  });

  it("conversa já criada pelo webhook (23505): devolve a existente, sem erro", async () => {
    h.insert = { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } };
    h.busca = { data: { id: "do-webhook" }, error: null };
    const r = await garantirConversaDoGrupo("linha-1", "123@g.us", "Equipe");
    expect(r).toEqual({ conversationId: "do-webhook", error: null });
    expect(h.filtros).toEqual([
      ["phone_number_id", "linha-1"],
      ["contact_phone", "123@g.us"],
      ["is_group", true],
    ]);
  });

  it("duplicata que a busca não acha (sem acesso, por exemplo): mantém o erro original", async () => {
    h.insert = { data: null, error: { message: "duplicate key", code: "23505" } };
    h.busca = { data: null, error: null };
    const r = await garantirConversaDoGrupo("linha-1", "123@g.us", "Equipe");
    expect(r.conversationId).toBeUndefined();
    expect(r.error?.code).toBe("23505");
  });

  it("outro erro do banco: devolve o erro e não busca", async () => {
    h.insert = { data: null, error: { message: "permission denied", code: "42501" } };
    const r = await garantirConversaDoGrupo("linha-1", "123@g.us", "Equipe");
    expect(r.error?.code).toBe("42501");
    expect(h.filtros).toEqual([]);
  });
});
