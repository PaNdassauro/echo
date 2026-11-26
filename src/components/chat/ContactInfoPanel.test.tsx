import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ContactInfoPanel } from "./ContactInfoPanel";

// A galeria tem query própria (Supabase + drenagem paginada); aqui o alvo é o
// cabeçalho do painel, então ela entra dublada.
vi.mock("./media/ConversationMediaTabs", () => ({
    ConversationMediaTabs: ({ active }: { active: boolean }) => (
        <div data-testid="galeria">{active ? "armada" : "desarmada"}</div>
    ),
}));

vi.mock("@/components/AssigneeAvatarStack", () => ({
    AssigneeAvatarStack: ({ coOwners }: { coOwners: string[] }) => (
        <div data-testid="responsaveis">{coOwners.join(",")}</div>
    ),
}));

// Desktop por padrão: o painel é coluna, não Sheet.
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

afterEach(cleanup);

const base = {
    conversationId: "conv-1",
    contactName: "Ana Souza",
    contactPhone: "+55 11 99999-0000",
    contactAvatarUrl: null,
    open: true,
    onOpenChange: vi.fn(),
    status: "open",
    sectorName: null,
    primaryAssigneeId: null,
    coOwnerIds: [],
};

describe("ContactInfoPanel", () => {
    it("fechado no desktop não renderiza nada", () => {
        render(<ContactInfoPanel {...base} open={false} />);
        expect(screen.queryByText("Ana Souza")).toBeNull();
    });

    it("mostra identidade e arma a galeria quando aberto", () => {
        render(<ContactInfoPanel {...base} />);

        expect(screen.getByText("Ana Souza")).toBeTruthy();
        expect(screen.getByText("+55 11 99999-0000")).toBeTruthy();
        expect(screen.getByTestId("galeria").textContent).toBe("armada");
    });

    it("conversa sem setor aparece como triagem", () => {
        render(<ContactInfoPanel {...base} />);
        expect(screen.getByText("Triagem")).toBeTruthy();
        expect(screen.getByText("Aberta")).toBeTruthy();
    });

    it("status closed vira Encerrada", () => {
        render(<ContactInfoPanel {...base} status="closed" sectorName="Vendas Geral" />);
        expect(screen.getByText("Encerrada")).toBeTruthy();
        expect(screen.getByText("Vendas Geral")).toBeTruthy();
    });

    it("responsável principal entra primeiro na lista do stack", () => {
        render(
            <ContactInfoPanel {...base} primaryAssigneeId="user-1" coOwnerIds={["user-2"]} />,
        );
        expect(screen.getByTestId("responsaveis").textContent).toBe("user-1,user-2");
    });

    it("sem ninguém atribuído não renderiza o stack", () => {
        render(<ContactInfoPanel {...base} />);
        expect(screen.queryByTestId("responsaveis")).toBeNull();
        expect(screen.getByText("Ninguém atribuído")).toBeTruthy();
    });

    it('"Recuperar mensagens" só aparece em linha que oferece a ação (QR)', () => {
        render(<ContactInfoPanel {...base} />);
        expect(screen.queryByText("Recuperar mensagens")).toBeNull();

        cleanup();
        render(<ContactInfoPanel {...base} onRefetchHistory={vi.fn()} />);
        expect(screen.getByText("Recuperar mensagens")).toBeTruthy();
    });

    it("botão de recuperar desabilita enquanto está buscando", () => {
        render(
            <ContactInfoPanel {...base} onRefetchHistory={vi.fn()} isRefetchingHistory />,
        );
        const botao = screen.getByRole("button", { name: /Recuperar mensagens/ });
        expect(botao.hasAttribute("disabled")).toBe(true);
    });
});
