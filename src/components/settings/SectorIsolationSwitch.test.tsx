import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no
// seguinte.
afterEach(cleanup);

const user = userEvent.setup({ pointerEventsCheck: 0 });

// Papel do usuário, trocado por teste. `let` porque o mock do módulo é hoisted
// e lê a variável só na hora da chamada.
let papel: { userRole: string | null; isSuperAdmin: boolean } = {
    userRole: "admin",
    isSuperAdmin: false,
};

vi.mock("@/contexts/OrganizationContext", () => ({
    useOrganization: () => papel,
}));

const updateEq = vi.fn(() => Promise.resolve({ error: null }));
const update = vi.fn((_patch: Record<string, unknown>) => ({ eq: updateEq }));
vi.mock("@/integrations/supabase/client", () => ({
    supabase: {
        from: () => ({ update }),
    },
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

// Importado depois dos mocks para que o módulo já os enxergue.
const { default: SectorIsolationSwitch } = await import("./SectorIsolationSwitch");

// O switch invalida o mapa de números pelo React Query: precisa de um client.
let queryClient: QueryClient;
beforeEach(() => {
    queryClient = new QueryClient();
});

function montar(enabled = false, followsOwner = false) {
    const onOptimisticChange = vi.fn();
    const onFailure = vi.fn();
    render(
        <QueryClientProvider client={queryClient}>
            <SectorIsolationSwitch
                phoneNumberId="11111111-1111-1111-1111-111111111111"
                enabled={enabled}
                followsOwner={followsOwner}
                onOptimisticChange={onOptimisticChange}
                onFailure={onFailure}
            />
        </QueryClientProvider>,
    );
    return { onOptimisticChange, onFailure };
}

describe("SectorIsolationSwitch — quem pode ver", () => {
    it("agent não vê o controle", () => {
        papel = { userRole: "agent", isSuperAdmin: false };
        montar();
        expect(screen.queryByRole("switch")).toBeNull();
        expect(screen.queryByText(/isolar conversas por setor/i)).toBeNull();
    });

    it("usuário sem papel na organização não vê o controle", () => {
        papel = { userRole: null, isSuperAdmin: false };
        montar();
        expect(screen.queryByRole("switch")).toBeNull();
    });

    it("admin da organização vê", () => {
        papel = { userRole: "admin", isSuperAdmin: false };
        montar();
        expect(screen.getByRole("switch")).toBeTruthy();
    });

    it("super admin vê mesmo sem papel na organização", () => {
        papel = { userRole: null, isSuperAdmin: true };
        montar();
        expect(screen.getByRole("switch")).toBeTruthy();
    });
});

describe("SectorIsolationSwitch — gravação", () => {
    it("pinta o estado novo antes de gravar e persiste na linha certa", async () => {
        papel = { userRole: "admin", isSuperAdmin: false };
        updateEq.mockClear();
        const { onOptimisticChange, onFailure } = montar(false);

        await user.click(screen.getByRole("switch"));

        expect(onOptimisticChange).toHaveBeenCalledWith({ sector_isolation_enabled: true });
        expect(updateEq).toHaveBeenCalledWith("id", "11111111-1111-1111-1111-111111111111");
        expect(onFailure).not.toHaveBeenCalled();
    });

    it("erro do banco devolve o painel ao estado real", async () => {
        papel = { userRole: "admin", isSuperAdmin: false };
        updateEq.mockClear();
        updateEq.mockResolvedValueOnce({ error: { message: "boom" } } as never);
        const { onOptimisticChange, onFailure } = montar(false);

        await user.click(screen.getByRole("switch"));

        expect(onOptimisticChange).toHaveBeenCalledWith({ sector_isolation_enabled: true });
        expect(onFailure).toHaveBeenCalledTimes(1);
    });
});

describe("SectorIsolationSwitch — mapa de números", () => {
    it("depois de gravar, invalida o mapa: o chat tira o isolamento da linha dele, em qualquer painel que renderize o switch", async () => {
        papel = { userRole: "admin", isSuperAdmin: false };
        updateEq.mockClear();
        const invalidar = vi.spyOn(queryClient, "invalidateQueries");
        montar(false);

        await user.click(screen.getByRole("switch"));

        expect(invalidar).toHaveBeenCalledTimes(1);
        expect(invalidar).toHaveBeenCalledWith({ queryKey: ["numeros-acessiveis"] });
    });

    it("erro do banco não invalida nada: o mapa segue valendo o estado que está no banco", async () => {
        papel = { userRole: "admin", isSuperAdmin: false };
        updateEq.mockClear();
        updateEq.mockResolvedValueOnce({ error: { message: "boom" } } as never);
        const invalidar = vi.spyOn(queryClient, "invalidateQueries");
        montar(false);

        await user.click(screen.getByRole("switch"));

        expect(invalidar).not.toHaveBeenCalled();
    });
});

describe("SectorIsolationSwitch — só quem assumiu vê", () => {
    it("sem isolamento a segunda chave não aparece", () => {
        papel = { userRole: "admin", isSuperAdmin: false };
        montar(false);
        expect(screen.getAllByRole("switch")).toHaveLength(1);
        expect(screen.queryByText(/só quem assumiu vê a conversa/i)).toBeNull();
    });

    it("com isolamento aparece com o estado da linha", () => {
        papel = { userRole: "admin", isSuperAdmin: false };
        montar(true, true);
        const chave = screen.getByRole("switch", { name: /só quem assumiu vê a conversa/i });
        expect(chave.getAttribute("aria-checked")).toBe("true");
    });

    it("grava sector_follows_owner, e só ela, na linha certa", async () => {
        papel = { userRole: "admin", isSuperAdmin: false };
        updateEq.mockClear();
        update.mockClear();
        const { onOptimisticChange, onFailure } = montar(true, false);

        await user.click(screen.getByRole("switch", { name: /só quem assumiu vê a conversa/i }));

        expect(onOptimisticChange).toHaveBeenCalledWith({ sector_follows_owner: true });
        expect(update).toHaveBeenCalledWith({ sector_follows_owner: true });
        expect(updateEq).toHaveBeenCalledWith("id", "11111111-1111-1111-1111-111111111111");
        expect(onFailure).not.toHaveBeenCalled();
    });

    it("agent não vê nenhuma das duas", () => {
        papel = { userRole: "agent", isSuperAdmin: false };
        montar(true, true);
        expect(screen.queryByRole("switch")).toBeNull();
    });
});
