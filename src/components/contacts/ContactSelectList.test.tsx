// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

interface Row {
    id: string;
    contact_name: string;
    contact_phone: string;
    contact_avatar_url: string | null;
    phone_number_id: string | null;
}

interface FakeQuery extends PromiseLike<{ data: Row[]; error: null }> {
    select: (cols: string) => FakeQuery;
    eq: (col: string, value: unknown) => FakeQuery;
    order: () => FakeQuery;
    limit: (n: number) => FakeQuery;
    or: (filters: string) => FakeQuery;
}

const LINE_GRUPO = "phone-vendas";
const LINE_OUTRA = "phone-financeiro";

const { state, calls, toastMock } = vi.hoisted(() => ({
    // `rows` é mutável para simular a resposta de cada escopo de busca.
    state: {
        rows: [
            {
                id: "conv-1",
                contact_name: "Ana Souza",
                contact_phone: "5511999990001",
                contact_avatar_url: null,
                phone_number_id: "phone-vendas",
            },
            {
                id: "conv-2",
                contact_name: "Bruno Lima",
                contact_phone: "5544988887777",
                contact_avatar_url: null,
                phone_number_id: "phone-vendas",
            },
        ] as Row[],
    },
    // Registro do que cada render pediu ao PostgREST: é onde o escopo por
    // linha/1:1 e a busca server-side ficam observáveis.
    calls: [] as Array<{
        table: string;
        eq: Array<[string, unknown]>;
        or?: string;
        select?: string;
        limit?: number;
    }>,
    toastMock: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => {
    const makeQuery = (table: string): FakeQuery => {
        const record: {
            table: string;
            eq: Array<[string, unknown]>;
            or?: string;
            select?: string;
            limit?: number;
        } = { table, eq: [] };
        calls.push(record);
        const query = {
            select: (cols: string) => {
                record.select = cols;
                return query;
            },
            eq: (col: string, value: unknown) => {
                record.eq.push([col, value]);
                return query;
            },
            order: () => query,
            limit: (n: number) => {
                record.limit = n;
                return query;
            },
            or: (filters: string) => {
                record.or = filters;
                return query;
            },
            then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
                Promise.resolve({ data: state.rows, error: null }).then(resolve),
        } as FakeQuery;
        return query;
    };
    return { supabase: { from: (table: string) => makeQuery(table) } };
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/contexts/OrganizationContext", () => ({
    useOrganization: () => ({ currentOrganization: { id: "org-1" } }),
}));

// As linhas acessíveis vêm da RLS em prod; no teste o hook é fixo para que o
// seletor tenha opções determinísticas.
vi.mock("@/hooks/useAccessiblePhoneNumbers", () => ({
    useAccessiblePhoneNumbers: () => ({
        phoneNumbers: [
            { id: LINE_GRUPO, displayName: "Vendas Geral", themeHue: 176 },
            { id: LINE_OUTRA, displayName: "Financeiro", themeHue: 20 },
        ],
        isLoading: false,
    }),
}));

class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
        ResizeObserverStub as unknown as typeof ResizeObserver;
}

// O Select do Radix usa Pointer Capture e scrollIntoView, que o jsdom não
// implementa — sem estes stubs o clique no seletor derruba o teste.
if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
}

const ContactSelectList = (await import("./ContactSelectList")).default;

afterEach(cleanup);
beforeEach(() => {
    calls.length = 0;
    toastMock.mockReset();
    state.rows = [
        {
            id: "conv-1",
            contact_name: "Ana Souza",
            contact_phone: "5511999990001",
            contact_avatar_url: null,
            phone_number_id: LINE_GRUPO,
        },
        {
            id: "conv-2",
            contact_name: "Bruno Lima",
            contact_phone: "5544988887777",
            contact_avatar_url: null,
            phone_number_id: LINE_GRUPO,
        },
    ];
});

const user = userEvent.setup({ pointerEventsCheck: 0 });

/** Só as consultas a `conversations` — o hook de linhas é mockado à parte. */
const convCalls = () => calls.filter((c) => c.table === "conversations");

describe("ContactSelectList", () => {
    it("começa escopado na linha do grupo e só em conversas 1:1", async () => {
        render(
            <ContactSelectList phoneNumberId={LINE_GRUPO} enabled onSelect={vi.fn()} />
        );

        await waitFor(() => expect(screen.getByText("Ana Souza")).toBeInTheDocument());

        const [call] = convCalls();
        expect(call.eq).toEqual([
            ["is_group", false],
            ["channel", "whatsapp"],
            ["phone_number_id", LINE_GRUPO],
        ]);
        expect(call.select).toContain("contact_avatar_url");
    });

    it("não consulta enquanto desabilitado", () => {
        render(
            <ContactSelectList phoneNumberId={LINE_GRUPO} enabled={false} onSelect={vi.fn()} />
        );
        expect(convCalls()).toHaveLength(0);
    });

    it("busca no servidor por nome e por dígitos", async () => {
        render(<ContactSelectList phoneNumberId={LINE_GRUPO} enabled onSelect={vi.fn()} />);
        await waitFor(() => expect(screen.getByText("Ana Souza")).toBeInTheDocument());

        await user.type(screen.getByPlaceholderText(/buscar por nome/i), "9992");

        // O filtro server-side é o que evita perder contatos no corte de 1000
        // linhas do PostgREST; filtro em memória passaria neste teste à toa.
        await waitFor(() => {
            const last = convCalls()[convCalls().length - 1];
            expect(last.or).toContain("contact_name.ilike.%9992%");
            expect(last.or).toContain("contact_phone.ilike.%9992%");
        });
    });

    it("devolve o contato clicado com telefone, nome e linha de origem", async () => {
        const onSelect = vi.fn();
        render(<ContactSelectList phoneNumberId={LINE_GRUPO} enabled onSelect={onSelect} />);
        await waitFor(() => expect(screen.getByText("Bruno Lima")).toBeInTheDocument());

        await user.click(screen.getByText("Bruno Lima"));

        expect(onSelect).toHaveBeenCalledWith(
            expect.objectContaining({
                phone: "5544988887777",
                name: "Bruno Lima",
                phoneNumberId: LINE_GRUPO,
            })
        );
    });

    it("troca o escopo para outra linha — a ponte entre números", async () => {
        render(<ContactSelectList phoneNumberId={LINE_GRUPO} enabled onSelect={vi.fn()} />);
        await waitFor(() => expect(screen.getByText("Ana Souza")).toBeInTheDocument());

        // Contato que existe SÓ na Financeiro.
        state.rows = [
            {
                id: "conv-9",
                contact_name: "Carla Financeiro",
                contact_phone: "5511911112222",
                contact_avatar_url: null,
                phone_number_id: LINE_OUTRA,
            },
        ];

        await user.click(screen.getByRole("combobox"));
        await user.click(await screen.findByText("Financeiro"));

        await waitFor(() => {
            const last = convCalls()[convCalls().length - 1];
            expect(last.eq).toEqual([
                ["is_group", false],
                ["channel", "whatsapp"],
                ["phone_number_id", LINE_OUTRA],
            ]);
        });
        expect(await screen.findByText("Carla Financeiro")).toBeInTheDocument();
    });

    it("em 'Todos os números' não filtra por linha — a RLS é o gate", async () => {
        render(<ContactSelectList phoneNumberId={LINE_GRUPO} enabled onSelect={vi.fn()} />);
        await waitFor(() => expect(screen.getByText("Ana Souza")).toBeInTheDocument());

        await user.click(screen.getByRole("combobox"));
        await user.click(await screen.findByText("Todos os números"));

        await waitFor(() => {
            const last = convCalls()[convCalls().length - 1];
            expect(last.eq).toEqual([["is_group", false], ["channel", "whatsapp"]]);
            // Teto bruto maior porque a dedupe corta linhas depois da resposta.
            expect(last.limit).toBe(200);
        });
    });

    it("dedupe: a mesma pessoa em duas linhas aparece uma vez, com nome real", async () => {
        state.rows = [
            {
                id: "conv-a",
                contact_name: "5511999990001",
                contact_phone: "5511999990001",
                contact_avatar_url: null,
                phone_number_id: LINE_GRUPO,
            },
            {
                id: "conv-b",
                contact_name: "Ana Souza",
                contact_phone: "551199990001", // mesma pessoa, sem o 9
                contact_avatar_url: null,
                phone_number_id: LINE_OUTRA,
            },
        ];

        render(<ContactSelectList phoneNumberId={LINE_GRUPO} enabled onSelect={vi.fn()} />);

        await waitFor(() => expect(screen.getByText("Ana Souza")).toBeInTheDocument());
        // Sem dedupe apareceriam duas linhas para a mesma pessoa.
        expect(screen.queryByText("+55 11 99999-0001")).not.toBeInTheDocument();
        expect(screen.getAllByRole("button").filter((b) => b.textContent?.includes("Ana"))).toHaveLength(1);
    });

    it("exclui quem já está no grupo mesmo com variação do 9º dígito", async () => {
        const onSelect = vi.fn();
        render(
            <ContactSelectList
                phoneNumberId={LINE_GRUPO}
                enabled
                // A linha 1:1 tem 5511999990001; o grupo devolve a forma sem o 9.
                excludedPhones={["551199990001"]}
                onSelect={onSelect}
            />
        );
        await waitFor(() => expect(screen.getByText("Ana Souza")).toBeInTheDocument());

        expect(screen.getByText("no grupo")).toBeInTheDocument();
        await user.click(screen.getByText("Ana Souza"));
        expect(onSelect).not.toHaveBeenCalled();
    });

    it("marca como adicionado quem já foi selecionado, sem travar o clique", async () => {
        const onSelect = vi.fn();
        render(
            <ContactSelectList
                phoneNumberId={LINE_GRUPO}
                enabled
                selectedPhones={["5511999990001"]}
                onSelect={onSelect}
            />
        );
        await waitFor(() => expect(screen.getByText("Ana Souza")).toBeInTheDocument());

        expect(screen.getByText("adicionado")).toBeInTheDocument();
        // Clicar de novo é como se desmarca no CreateGroupDialog.
        await user.click(screen.getByText("Ana Souza"));
        expect(onSelect).toHaveBeenCalledTimes(1);
    });
});
