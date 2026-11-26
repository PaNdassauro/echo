import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no
// seguinte.
afterEach(cleanup);

// O `navigate` do react-router tem `locationPathname` nos próprios deps, então
// ganha identidade nova a cada navegação. O mock reproduz exatamente isso: o
// teste troca a referência e re-renderiza, como acontece ao clicar numa conversa.
let navigateAtual = vi.fn();
vi.mock("react-router-dom", () => ({
    useNavigate: () => navigateAtual,
}));

const canaisCriados: string[] = [];
const canaisRemovidos: string[] = [];

// Bindings postgres_changes registrados por canal, para o teste disparar os callbacks.
interface BindingFalso {
    canal: string;
    filtro: { event: string; table: string; filter?: string };
    cb: (payload: { old?: unknown; new?: unknown }) => void;
}
const bindings: BindingFalso[] = [];
// O callback de status de cada canal, para o teste reassinar (SUBSCRIBED de novo) ou derrubá-lo.
const statusPorCanal = new Map<string, (status: string) => void>();
// A próxima assinatura do canal global cai em CHANNEL_ERROR em vez de SUBSCRIBED.
let falharAProximaAssinatura = false;
// Linha que `from("messages").select().eq().maybeSingle()` devolve (mensagem alvo da reação).
let mensagemAlvo: Record<string, unknown> | null = null;

function canalFalso(nome: string) {
    const ch = {
        nome,
        on(_tipo: string, filtro: BindingFalso["filtro"], cb: BindingFalso["cb"]) {
            bindings.push({ canal: nome, filtro, cb });
            return ch;
        },
        subscribe(cb?: (status: string) => void) {
            if (cb) statusPorCanal.set(nome, cb);
            if (nome === "global-notifications" && falharAProximaAssinatura) {
                falharAProximaAssinatura = false;
                cb?.("CHANNEL_ERROR");
                return ch;
            }
            cb?.("SUBSCRIBED");
            return ch;
        },
        async send() {
            /* broadcast */
        },
    };
    return ch;
}

vi.mock("@/integrations/supabase/client", () => ({
    supabase: {
        channel: (nome: string) => {
            canaisCriados.push(nome);
            return canalFalso(nome);
        },
        removeChannel: (ch: { nome: string }) => {
            canaisRemovidos.push(ch.nome);
        },
        auth: {
            getUser: async () => ({ data: { user: { id: "user-1" } } }),
        },
        from: (tabela: string) => ({
            select: () => ({
                eq: () => ({
                    maybeSingle: async () => ({ data: tabela === "messages" ? mensagemAlvo : null, error: null }),
                }),
            }),
        }),
    },
}));

// O contexto real expõe callbacks estáveis (`useCallback(..., [])`), e o
// componente conta com isso. Devolver funções novas a cada render faria o mock
// mentir: os efeitos remontariam por culpa do teste, escondendo o que se mede.
const notificacoesEstaveis = {
    activeConversationId: null,
    incrementUnread: vi.fn(),
    incrementFailed: vi.fn(),
    handleNewMessage: vi.fn(),
    triggerConversationRefresh: vi.fn(),
    refreshUnreadCounts: vi.fn(),
    findConversation: vi.fn((): unknown => undefined),
    refreshConversationById: vi.fn(),
    isMuted: false,
};
vi.mock("@/contexts/NotificationContext", () => ({
    useNotifications: () => notificacoesEstaveis,
}));

const somEstavel = { playNotificationSound: vi.fn() };
vi.mock("@/hooks/useNotificationSound", () => ({
    useNotificationSound: () => somEstavel,
}));
vi.mock("@/hooks/usePushSubscription", () => ({ usePushSubscription: () => undefined }));
vi.mock("@/lib/nativeNotification", () => ({
    ensureNotificationPermission: vi.fn(),
    showNativeNotification: vi.fn(),
}));
vi.mock("@/lib/realtimeHealth", () => ({
    reportChannelHealth: vi.fn(),
    // Lidos pelo useRealtimeFallbackPoll (busca de reserva do não-lido).
    subscribeRealtimeHealth: () => () => {},
    getRealtimeHealthVersion: () => 0,
    isRealtimeDegraded: () => false,
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }));

const { GlobalNotificationListener } = await import("./GlobalNotificationListener");

beforeEach(() => {
    canaisCriados.length = 0;
    canaisRemovidos.length = 0;
    bindings.length = 0;
    statusPorCanal.clear();
    falharAProximaAssinatura = false;
    mensagemAlvo = null;
    navigateAtual = vi.fn();
    notificacoesEstaveis.refreshUnreadCounts.mockClear();
    somEstavel.playNotificationSound.mockClear();
    notificacoesEstaveis.incrementFailed.mockClear();
    notificacoesEstaveis.handleNewMessage.mockClear();
    notificacoesEstaveis.findConversation.mockImplementation(() => undefined);
});

describe("GlobalNotificationListener — estabilidade dos canais", () => {
    it("não recria os canais quando o navigate muda de identidade", async () => {
        const { rerender } = render(<GlobalNotificationListener />);

        // Os dois canais do componente: broadcast por usuário e o de postgres_changes.
        await waitFor(() => expect(canaisCriados).toHaveLength(2));
        expect(canaisCriados).toContain("user-user-1-notifications");
        expect(canaisCriados).toContain("global-notifications");

        // Simula navegar: o react-router entrega um navigate novo.
        for (let i = 0; i < 5; i++) {
            navigateAtual = vi.fn();
            rerender(<GlobalNotificationListener />);
        }
        await waitFor(() => expect(navigateAtual).toBeDefined());

        // Antes do fix, cada navegação derrubava e recriava os DOIS canais —
        // 5 cliques em conversa viravam 10 subscriptions novas em `messages`,
        // por aba. Ver project_realtime_channel_churn_front.
        expect(canaisCriados).toHaveLength(2);
        expect(canaisRemovidos).toHaveLength(0);
    });

    it("remove os canais que abriu ao desmontar", async () => {
        const { unmount } = render(<GlobalNotificationListener />);
        await waitFor(() => expect(canaisCriados).toHaveLength(2));

        unmount();

        expect(canaisRemovidos).toHaveLength(2);
        expect(new Set(canaisRemovidos)).toEqual(new Set(canaisCriados));
    });
});

describe("GlobalNotificationListener — não-lido ao reassinar o canal", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const opcoesDasChamadas = () => notificacoesEstaveis.refreshUnreadCounts.mock.calls.map(([opcoes]) => opcoes);

    it("a primeira assinatura da carga divide o voo inicial: a busca não é fresca", async () => {
        render(<GlobalNotificationListener />);
        await waitFor(() => expect(canaisCriados).toHaveLength(2));

        const globais = opcoesDasChamadas();
        expect(globais.length).toBeGreaterThan(0);
        expect(globais.every((opcoes) => !opcoes?.fresca)).toBe(true);
    });

    it("SUBSCRIBED de novo (rejoin silencioso do socket) pede uma busca fresca", async () => {
        render(<GlobalNotificationListener />);
        await waitFor(() => expect(statusPorCanal.has("global-notifications")).toBe(true));
        notificacoesEstaveis.refreshUnreadCounts.mockClear();

        statusPorCanal.get("global-notifications")?.("SUBSCRIBED");

        expect(notificacoesEstaveis.refreshUnreadCounts).toHaveBeenCalledTimes(1);
        expect(notificacoesEstaveis.refreshUnreadCounts).toHaveBeenCalledWith({ fresca: true });
    });

    it("depois de CHANNEL_ERROR, o canal novo que assina pede uma busca fresca", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        render(<GlobalNotificationListener />);
        await waitFor(() => expect(statusPorCanal.has("global-notifications")).toBe(true));
        notificacoesEstaveis.refreshUnreadCounts.mockClear();

        statusPorCanal.get("global-notifications")?.("CHANNEL_ERROR");
        // O backoff recria o canal; o fake assina na hora.
        await vi.advanceTimersByTimeAsync(1_000);

        expect(canaisCriados.filter((nome) => nome === "global-notifications")).toHaveLength(2);
        expect(notificacoesEstaveis.refreshUnreadCounts).toHaveBeenCalledWith({ fresca: true });
    });

    it("a primeira assinatura que só deu certo na segunda tentativa também conta como reassinatura", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        falharAProximaAssinatura = true;

        render(<GlobalNotificationListener />);
        await waitFor(() => expect(statusPorCanal.has("global-notifications")).toBe(true));
        // Nenhum SUBSCRIBED ainda: a primeira tentativa caiu.
        expect(canaisCriados.filter((nome) => nome === "global-notifications")).toHaveLength(1);
        notificacoesEstaveis.refreshUnreadCounts.mockClear();

        await vi.advanceTimersByTimeAsync(1_000);

        expect(canaisCriados.filter((nome) => nome === "global-notifications")).toHaveLength(2);
        expect(notificacoesEstaveis.refreshUnreadCounts).toHaveBeenCalledWith({ fresca: true });
    });
});

describe("GlobalNotificationListener — reação e falha", () => {
    const global = () => bindings.filter((b) => b.canal === "global-notifications");
    const bindingReacao = () => global().find((b) => b.filtro.table === "message_reactions");
    const bindingUpdate = () => global().find((b) => b.filtro.table === "messages" && b.filtro.event === "UPDATE");

    it("a reação vem de um binding INSERT em message_reactions no mesmo canal, só de cliente", async () => {
        render(<GlobalNotificationListener />);
        await waitFor(() => expect(canaisCriados).toHaveLength(2));

        expect(bindingReacao()?.filtro).toMatchObject({ event: "INSERT", filter: "is_from_me=eq.false" });
        expect(canaisCriados.filter((c) => c === "global-notifications")).toHaveLength(1);
    });

    it("UPDATE de metadata numa mensagem com reaction não toca som de reação", async () => {
        render(<GlobalNotificationListener />);
        await waitFor(() => expect(bindingUpdate()).toBeDefined());

        bindingUpdate()!.cb({
            old: { id: "m1" },
            new: { id: "m1", conversation_id: "c1", status: "delivered", reaction: "👍", content: "oi" },
        });
        await new Promise((r) => setTimeout(r, 10));

        expect(somEstavel.playNotificationSound).not.toHaveBeenCalled();
        expect(notificacoesEstaveis.handleNewMessage).not.toHaveBeenCalled();
    });

    it("INSERT de reação de uma conversa minha toca o som e reordena a lista", async () => {
        mensagemAlvo = {
            id: "m1", conversation_id: "c1", content: "proposta", message_type: "text",
            direction: "outbound", created_at: "2026-10-16T10:00:00Z", is_deleted: false,
        };
        notificacoesEstaveis.findConversation.mockImplementation(() => ({
            contact_name: "Cliente", assigned_to: "user-1", co_assignee_ids: [],
        }));
        render(<GlobalNotificationListener />);
        await waitFor(() => expect(bindingReacao()).toBeDefined());
        await waitFor(() => expect(canaisCriados).toHaveLength(2));

        bindingReacao()!.cb({ new: { id: "r1", message_id: "m1", emoji: "👍", is_from_me: false } });

        await waitFor(() => expect(somEstavel.playNotificationSound).toHaveBeenCalledTimes(1));
        expect(notificacoesEstaveis.handleNewMessage).toHaveBeenCalledTimes(1);
    });

    it("INSERT de reação de conversa de outro atendente reordena mas fica em silêncio (fail-closed)", async () => {
        mensagemAlvo = {
            id: "m1", conversation_id: "c1", content: "x", message_type: "text",
            direction: "outbound", created_at: null, is_deleted: false,
        };
        notificacoesEstaveis.findConversation.mockImplementation(() => ({
            contact_name: "Cliente", assigned_to: "outra-pessoa", co_assignee_ids: [],
        }));
        render(<GlobalNotificationListener />);
        await waitFor(() => expect(bindingReacao()).toBeDefined());
        await waitFor(() => expect(canaisCriados).toHaveLength(2));

        bindingReacao()!.cb({ new: { id: "r1", message_id: "m1", emoji: "👍", is_from_me: false } });

        await waitFor(() => expect(notificacoesEstaveis.handleNewMessage).toHaveBeenCalledTimes(1));
        expect(somEstavel.playNotificationSound).not.toHaveBeenCalled();
    });

    it("mensagem alvo ilegível (RLS) = nenhuma notificação", async () => {
        mensagemAlvo = null;
        render(<GlobalNotificationListener />);
        await waitFor(() => expect(bindingReacao()).toBeDefined());
        await waitFor(() => expect(canaisCriados).toHaveLength(2));

        bindingReacao()!.cb({ new: { id: "r1", message_id: "m1", emoji: "👍", is_from_me: false } });
        await new Promise((r) => setTimeout(r, 10));

        expect(somEstavel.playNotificationSound).not.toHaveBeenCalled();
        expect(notificacoesEstaveis.handleNewMessage).not.toHaveBeenCalled();
    });
});
