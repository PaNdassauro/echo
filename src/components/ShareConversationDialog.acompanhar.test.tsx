import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareConversationDialog } from "./ShareConversationDialog";

const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRUNO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CARLA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LINHA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const h = vi.hoisted(() => ({
  members: [] as Array<{ user_id: string; role: string; profiles: { id: string; first_name: string; last_name: string | null; full_name: string | null } }>,
  phoneAccess: [] as Array<{ user_id: string }>,
}));

// Objeto estável: o efeito do diálogo depende de currentOrganization, e um
// objeto novo por render faria o fetch rodar em laço.
const ORG = { currentOrganization: { id: "org-1" } };
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ORG,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () =>
          Promise.resolve(
            table === "organization_members"
              ? { data: h.members, error: null }
              : { data: h.phoneAccess, error: null },
          ),
      }),
    }),
  },
}));

const perfil = (id: string, nome: string, role = "agent") => ({
  user_id: id,
  role,
  profiles: { id, first_name: nome, last_name: null, full_name: nome },
});

const montar = (props: Partial<React.ComponentProps<typeof ShareConversationDialog>> = {}) => {
  const onAddCoOwner = vi.fn(async () => true);
  const onRemoveCoOwner = vi.fn(async () => true);
  render(
    <ShareConversationDialog
      open
      onOpenChange={() => {}}
      currentUserId={ANA}
      conversationPhoneNumberId={LINHA}
      primaryAssigneeId={BRUNO}
      coOwnerIds={[]}
      onAddCoOwner={onAddCoOwner}
      onRemoveCoOwner={onRemoveCoOwner}
      {...props}
    />,
  );
  return { onAddCoOwner };
};

const esperarCarregar = () => waitFor(() => expect(screen.getByText("Bruno")).toBeTruthy());

beforeEach(() => {
  h.members = [perfil(ANA, "Ana"), perfil(BRUNO, "Bruno"), perfil(CARLA, "Carla")];
  h.phoneAccess = [{ user_id: ANA }, { user_id: BRUNO }];
});
afterEach(cleanup);

describe("ShareConversationDialog: acompanhar a conversa de outra pessoa", () => {
  it("oferece 'Acompanhar esta conversa' e adiciona a própria pessoa como co-dona", async () => {
    const { onAddCoOwner } = montar();
    await esperarCarregar();

    const botao = screen.getByRole("button", { name: /Acompanhar esta conversa/ });
    fireEvent.click(botao);

    await waitFor(() => expect(onAddCoOwner).toHaveBeenCalledWith(ANA, "Ana"));
  });

  it("a própria pessoa nunca entra na lista 'Adicionar'", async () => {
    montar();
    await esperarCarregar();
    // Só a dona e o botão de acompanhar trazem nomes; "Ana" não é item da lista.
    expect(screen.queryByTitle("Ana")).toBeNull();
  });

  it("some quando ela já é co-dona, e ela aparece entre os co-proprietários", async () => {
    montar({ coOwnerIds: [ANA] });
    await esperarCarregar();
    expect(screen.queryByRole("button", { name: /Acompanhar esta conversa/ })).toBeNull();
    expect(screen.getByText("Co-proprietários (1)")).toBeTruthy();
    expect(screen.getByText("Ana")).toBeTruthy();
  });

  it("some quando ela é a dona principal", async () => {
    montar({ primaryAssigneeId: ANA, coOwnerIds: [BRUNO] });
    await waitFor(() => expect(screen.getByText("Dono principal")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Acompanhar esta conversa/ })).toBeNull();
  });

  it("aparece mesmo quando ela não tem a linha da conversa (já enxerga a conversa)", async () => {
    h.phoneAccess = [{ user_id: BRUNO }];
    montar();
    await esperarCarregar();
    expect(screen.getByRole("button", { name: /Acompanhar esta conversa/ })).toBeTruthy();
  });

  it("colega sem acesso à linha continua fora da lista", async () => {
    montar();
    await esperarCarregar();
    expect(screen.queryByTitle("Carla")).toBeNull();
  });
});
