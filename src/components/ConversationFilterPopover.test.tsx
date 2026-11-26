// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { ConversationFilterPopover, type FilterOption } from "@/components/ConversationFilterPopover";

afterEach(cleanup);

const USUARIOS: FilterOption[] = [
    { id: "ana", label: "Ana Souza", initials: "AS" },
    { id: "bruno", label: "Bruno Lima", initials: "BL" },
];

const TAGS: FilterOption[] = [
    { id: "vip", label: "VIP", color: "#f00" },
    { id: "orcamento", label: "Orçamento", color: "#0f0" },
];

const LABEL = "Filtros";

/** Wrapper controlado: o popover é stateless, quem guarda a seleção é a lista. */
function Harness({
    usuarios = USUARIOS,
    tags = TAGS,
    onUsers,
    onTags,
}: {
    usuarios?: FilterOption[];
    tags?: FilterOption[];
    onUsers?: (ids: string[]) => void;
    onTags?: (ids: string[]) => void;
}) {
    const [userIds, setUserIds] = useState<string[]>([]);
    const [tagIds, setTagIds] = useState<string[]>([]);
    return (
        <ConversationFilterPopover
            icon={<svg data-testid="icone" />}
            label={LABEL}
            searchPlaceholder="Buscar tag ou usuário..."
            emptySearchLabel="Nada encontrado"
            groups={[
                {
                    key: "users",
                    label: "Usuários",
                    options: usuarios,
                    selected: userIds,
                    onChange: (ids) => {
                        onUsers?.(ids);
                        setUserIds(ids);
                    },
                    noOptionsLabel: "Ninguém assumiu conversas nesta linha",
                },
                {
                    key: "tags",
                    label: "Tags",
                    options: tags,
                    selected: tagIds,
                    onChange: (ids) => {
                        onTags?.(ids);
                        setTagIds(ids);
                    },
                    noOptionsLabel: "Nenhuma tag nesta linha",
                },
            ]}
        />
    );
}

const abrir = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: LABEL }));
};

describe("ConversationFilterPopover", () => {
    it("as duas dimensões vivem no mesmo botão, cada uma na sua seção", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await abrir(user);
        expect(screen.getByText("Usuários")).toBeInTheDocument();
        expect(screen.getByText("Tags")).toBeInTheDocument();

        const secaoUsuarios = screen.getByRole("group", { name: "Usuários" });
        const secaoTags = screen.getByRole("group", { name: "Tags" });
        expect(secaoUsuarios).toContainElement(screen.getByRole("checkbox", { name: /Ana Souza/ }));
        expect(secaoTags).toContainElement(screen.getByRole("checkbox", { name: /VIP/ }));
    });

    it("marca em seções diferentes sem fechar, e o contador soma as duas", async () => {
        const user = userEvent.setup();
        const onUsers = vi.fn();
        const onTags = vi.fn();
        render(<Harness onUsers={onUsers} onTags={onTags} />);

        await abrir(user);
        await user.click(screen.getByRole("checkbox", { name: /Ana Souza/ }));
        // Multi-select: a lista continua aberta para a marcação seguinte.
        await user.click(screen.getByRole("checkbox", { name: /VIP/ }));

        expect(onUsers).toHaveBeenLastCalledWith(["ana"]);
        expect(onTags).toHaveBeenLastCalledWith(["vip"]);
        expect(screen.getByRole("button", { name: `${LABEL} (2 selecionados)` })).toBeInTheDocument();
    });

    it("clicar de novo desmarca", async () => {
        const user = userEvent.setup();
        const onUsers = vi.fn();
        render(<Harness onUsers={onUsers} />);

        await abrir(user);
        await user.click(screen.getByRole("checkbox", { name: /Bruno Lima/ }));
        await user.click(screen.getByRole("checkbox", { name: /Bruno Lima/ }));

        expect(onUsers).toHaveBeenLastCalledWith([]);
        expect(screen.getByRole("button", { name: LABEL })).toBeInTheDocument();
    });

    it("marca o estado selecionado para leitor de tela", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await abrir(user);
        expect(screen.getByRole("checkbox", { name: /Ana Souza/ })).toHaveAttribute("aria-checked", "false");
        await user.click(screen.getByRole("checkbox", { name: /Ana Souza/ }));
        expect(screen.getByRole("checkbox", { name: /Ana Souza/ })).toHaveAttribute("aria-checked", "true");
    });

    it("'Limpar seleção' só aparece com seleção e zera as duas seções", async () => {
        const user = userEvent.setup();
        const onUsers = vi.fn();
        const onTags = vi.fn();
        render(<Harness onUsers={onUsers} onTags={onTags} />);

        await abrir(user);
        expect(screen.queryByRole("button", { name: "Limpar seleção" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("checkbox", { name: /Ana Souza/ }));
        await user.click(screen.getByRole("checkbox", { name: /Orçamento/ }));
        await user.click(screen.getByRole("button", { name: "Limpar seleção" }));

        expect(onUsers).toHaveBeenLastCalledWith([]);
        expect(onTags).toHaveBeenLastCalledWith([]);
    });

    it("seção sem opção explica a causa em vez de sumir calada", async () => {
        const user = userEvent.setup();
        render(<Harness usuarios={[]} />);

        await abrir(user);
        expect(screen.getByText("Ninguém assumiu conversas nesta linha")).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: /VIP/ })).toBeInTheDocument();
    });

    it("busca só em lista grande, e atravessa as duas seções", async () => {
        const user = userEvent.setup();
        const muitos: FilterOption[] = Array.from({ length: 8 }, (_, i) => ({
            id: `u${i}`,
            label: i === 7 ? "Zoe Prado" : `Usuário ${i}`,
        }));
        render(<Harness usuarios={muitos} />);

        await abrir(user);
        const busca = screen.getByPlaceholderText("Buscar tag ou usuário...");

        // Casa em Usuários: a seção Tags some inteira enquanto a busca não bate.
        await user.type(busca, "zoe");
        expect(screen.getByRole("checkbox", { name: /Zoe Prado/ })).toBeInTheDocument();
        expect(screen.queryByRole("checkbox", { name: /Usuário 0/ })).not.toBeInTheDocument();
        expect(screen.queryByText("Tags")).not.toBeInTheDocument();

        // Casa em Tags: agora é a seção de usuários que sai.
        await user.clear(busca);
        await user.type(busca, "vip");
        expect(screen.getByRole("checkbox", { name: /VIP/ })).toBeInTheDocument();
        expect(screen.queryByText("Usuários")).not.toBeInTheDocument();

        await user.clear(busca);
        await user.type(busca, "xyz");
        expect(screen.getByText("Nada encontrado")).toBeInTheDocument();
    });

    it("sem opção em lugar nenhum não mostra busca", async () => {
        const user = userEvent.setup();
        render(<Harness usuarios={[]} tags={[]} />);

        await abrir(user);
        expect(screen.queryByPlaceholderText("Buscar tag ou usuário...")).not.toBeInTheDocument();
        expect(screen.getByText("Ninguém assumiu conversas nesta linha")).toBeInTheDocument();
        expect(screen.getByText("Nenhuma tag nesta linha")).toBeInTheDocument();
    });
});
