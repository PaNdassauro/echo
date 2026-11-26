import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Troca de conversa entre números (caixa conjunta): o `useConversation` ainda guarda a
 * conversa anterior no primeiro render da nova. O hook confere o alvo por dentro
 * (`alvoDeContato`), e a assinatura de presença (`presence-subscribe`, tráfego real na
 * sessão do WhatsApp) só pode sair para o número e o contato da MESMA conversa.
 */

const h = vi.hoisted(() => ({ chamadas: [] as Array<{ caminho: string; corpo: unknown }> }));

vi.mock("@/lib/qrService", () => ({
  qrFetch: (caminho: string, opcoes?: { body?: string }) => {
    h.chamadas.push({ caminho, corpo: opcoes?.body ? JSON.parse(opcoes.body) : null });
    return Promise.resolve({ ok: true });
  },
}));
vi.mock("@/lib/presencaPorNumero", () => ({ assinarPresenca: () => () => undefined }));

const { useTypingPresence } = await import("./useTypingPresence");

type Conversa = { id: string; contact_phone: string; channel?: "whatsapp" | "instagram"; is_group?: boolean };

const subscribes = () => h.chamadas.filter((c) => c.caminho.startsWith("/message/presence-subscribe/"));

beforeEach(() => {
  h.chamadas = [];
});
afterEach(cleanup);

const renderizar = (inicial: { conversationId: string; numero: string; conversa: Conversa | null }) =>
  renderHook(
    (p: { conversationId: string; numero: string; conversa: Conversa | null }) =>
      useTypingPresence({
        conversationId: p.conversationId,
        phoneNumberDbId: p.numero,
        conversation: p.conversa,
        isQrConnection: true,
      }),
    { initialProps: inicial },
  );

describe("presença ao trocar de conversa entre números", () => {
  const A: Conversa = { id: "A", contact_phone: "5511999990000" };
  const B: Conversa = { id: "B", contact_phone: "5521988880000" };

  it("conversa carregada do id aberto assina a presença no número dela", () => {
    renderizar({ conversationId: "A", numero: "num-1", conversa: A });
    expect(subscribes()).toEqual([{ caminho: "/message/presence-subscribe/num-1", corpo: { to: "5511999990000" } }]);
  });

  it("A -> B: no primeiro render da B (número 2, conversa A ainda carregada) NÃO assina nada", () => {
    const { rerender } = renderizar({ conversationId: "A", numero: "num-1", conversa: A });
    h.chamadas = [];

    rerender({ conversationId: "B", numero: "num-2", conversa: A });
    expect(subscribes()).toEqual([]);

    // Quando a B chega, assina no número 2 com o contato da B.
    rerender({ conversationId: "B", numero: "num-2", conversa: B });
    expect(subscribes()).toEqual([{ caminho: "/message/presence-subscribe/num-2", corpo: { to: "5521988880000" } }]);
  });

  it("Direct do Instagram nunca assina presença (ig:<id> não é telefone)", () => {
    const direct: Conversa = { id: "D", contact_phone: "ig:123", channel: "instagram" };
    renderizar({ conversationId: "D", numero: "num-1", conversa: direct });
    expect(subscribes()).toEqual([]);
  });
});
