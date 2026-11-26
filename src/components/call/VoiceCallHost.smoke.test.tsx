// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { VoiceCallProvider, useVoiceCalls } from "@/contexts/VoiceCallContext";
import VoiceCallHost from "@/components/call/VoiceCallHost";
import type { CallUpdate } from "@/lib/voiceCall";

/**
 * Smoke test do aviso de ligação com o provider REALMENTE montado.
 *
 * As garantias que o usuário pediu e que só aparecem em runtime:
 *   1. NÃO existe recusar — um atendente só atende ou deixa tocar, porque
 *      recusar encerraria a ligação para os outros e para quem ligou;
 *   2. ignorar não manda nada ao serviço;
 *   3. linha ocupada por outro atendente não gera aviso nenhum.
 *
 * O SSE é por linha e todo atendente recebe tudo, então (3) é o que impede dois
 * atendentes de brigarem pela mesma ligação.
 */

const endVoiceCall = vi.fn().mockResolvedValue(undefined);
const acceptVoiceCall = vi.fn().mockResolvedValue(undefined);
const startVoiceCall = vi.fn().mockResolvedValue({ callId: "OUT-1", to: "5511999999999" });

vi.mock("@/hooks/useVoiceCallCapability", () => ({
    useVoiceCallCapability: () => ({ data: true }),
}));

// Portão por linha (phone_numbers.voice_calls_enabled), mutável por teste.
const gate = vi.hoisted(() => ({ lineVoiceEnabled: true }));

vi.mock("@/integrations/supabase/client", () => {
    // phone_numbers responde o portão da linha; conversations não acha nome.
    const chainFor = (table: string) => {
        const chain: Record<string, unknown> = {};
        for (const method of ["select", "eq", "limit"]) chain[method] = () => chain;
        chain.maybeSingle = () =>
            Promise.resolve({ data: table === "phone_numbers" ? { voice_calls_enabled: gate.lineVoiceEnabled } : null });
        return chain;
    };
    return { supabase: { from: (table: string) => chainFor(table) } };
});

vi.mock("@/lib/voiceCall", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/voiceCall")>();
    return {
        ...actual,
        callEventsUrl: () => Promise.resolve("http://localhost/call/line-1/events"),
        endVoiceCall: (...args: unknown[]) => endVoiceCall(...args),
        acceptVoiceCall: (...args: unknown[]) => acceptVoiceCall(...args),
        startVoiceCall: (...args: unknown[]) => startVoiceCall(...args),
        CallAudioBridge: class {
            start = vi.fn().mockResolvedValue(undefined);
            stop = vi.fn();
            hangUp = vi.fn();
            setMuted = vi.fn();
        },
    };
});

interface FakeSource {
    onmessage: ((event: { data: string }) => void) | null;
    onerror: (() => void) | null;
    close: () => void;
}
const sources: FakeSource[] = [];

function ringing(overrides: Partial<CallUpdate> = {}): CallUpdate {
    return {
        callId: "CALL-1",
        peerJid: "5511988887777@s.whatsapp.net",
        direction: "incoming",
        isVideo: false,
        state: "incoming_ringing",
        startedAt: Date.now(),
        muted: false,
        ...overrides,
    };
}

function push(call: CallUpdate) {
    act(() => {
        sources[0]?.onmessage?.({ data: JSON.stringify({ type: "state", call }) });
    });
}

const Harness = () => {
    const { setLine } = useVoiceCalls();
    useEffect(() => { setLine("line-1", true, "user-1"); }, [setLine]);
    return null;
};

function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <VoiceCallProvider>
                <Harness />
                <VoiceCallHost />
            </VoiceCallProvider>
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    gate.lineVoiceEnabled = true;
    sources.length = 0;
    endVoiceCall.mockClear();
    acceptVoiceCall.mockClear();
    vi.stubGlobal("EventSource", class {
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        close = vi.fn();
        constructor() { sources.push(this as unknown as FakeSource); }
    });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
});

describe("aviso de ligação recebida", () => {
    it("mostra o card quando uma ligação entra", async () => {
        mount();
        await waitFor(() => expect(sources).toHaveLength(1));
        push(ringing());

        expect(await screen.findByText("Ligação recebida no WhatsApp")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /atender/i })).toBeInTheDocument();
    });

    it("ignorar não manda nada ao serviço — a ligação segue viva para os outros", async () => {
        mount();
        await waitFor(() => expect(sources).toHaveLength(1));
        push(ringing());
        await screen.findByText("Ligação recebida no WhatsApp");

        await userEvent.click(screen.getByRole("button", { name: "Ignorar" }));

        expect(endVoiceCall).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByText("Ligação recebida no WhatsApp")).not.toBeInTheDocument());
    });

    it("não oferece recusar: só atender ou deixar tocar", async () => {
        mount();
        await waitFor(() => expect(sources).toHaveLength(1));
        push(ringing());
        await screen.findByText("Ligação recebida no WhatsApp");

        expect(screen.queryByRole("button", { name: /recusar/i })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /atender/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Ignorar" })).toBeInTheDocument();
    });

    it("linha em ligação de outro atendente não gera aviso", async () => {
        mount();
        await waitFor(() => expect(sources).toHaveLength(1));
        push(ringing({ callId: "DE-OUTRO", state: "active" }));
        push(ringing({ callId: "NOVA" }));

        await waitFor(() => expect(screen.queryByText("Ligação recebida no WhatsApp")).not.toBeInTheDocument());
    });

    it("linha com ligação desligada nem abre o SSE", async () => {
        gate.lineVoiceEnabled = false;
        mount();
        // Espaço para a query do portão resolver e o efeito rodar.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(sources).toHaveLength(0);
    });

    it("com 'receber ligações' desligado, nada aparece", async () => {
        localStorage.setItem("echo_voice_calls_enabled_user-1", "false");
        mount();
        await waitFor(() => expect(sources).toHaveLength(1));
        push(ringing());

        await waitFor(() => expect(screen.queryByText("Ligação recebida no WhatsApp")).not.toBeInTheDocument());
    });

    it("atender abre o painel da ligação e aceita no serviço", async () => {
        mount();
        await waitFor(() => expect(sources).toHaveLength(1));
        push(ringing());
        await screen.findByText("Ligação recebida no WhatsApp");

        await userEvent.click(screen.getByRole("button", { name: /atender/i }));

        await waitFor(() => expect(acceptVoiceCall).toHaveBeenCalledWith("line-1", "CALL-1"));
        expect(await screen.findByRole("button", { name: /desligar/i })).toBeInTheDocument();
        expect(screen.queryByText("Ligação recebida no WhatsApp")).not.toBeInTheDocument();
    });
});
