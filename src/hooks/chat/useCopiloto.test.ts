import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotoMensagem } from "@/lib/copiloto";

const h = vi.hoisted(() => ({
  invocacoes: [] as Array<{ nome: string; body: Record<string, unknown> }>,
  respostas: [] as Array<{
    resolver: (v: { data: unknown; error: null }) => void;
  }>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: (nome: string, opcoes: { body: Record<string, unknown> }) => {
        h.invocacoes.push({ nome, body: opcoes.body });
        return new Promise((resolver) => h.respostas.push({ resolver }));
      },
    },
  },
}));

import { __zerarMemoriaDoCopiloto, useCopiloto } from "./useCopiloto";

const agora = () => new Date(Date.now() - 30_000).toISOString();
const inbound = (id: string): CopilotoMensagem => ({
  id,
  direction: "inbound",
  created_at: agora(),
});
const outbound = (id: string): CopilotoMensagem => ({
  id,
  direction: "outbound",
  created_at: agora(),
});
const ok = (texto: string) => ({
  data: {
    status: "ok",
    momento: "Cliente quer o orçamento em maio",
    sugestoes: [{ texto, intencao: "responder", porque: "responde o pedido" }],
    analisado_ate: "x",
  },
  error: null as null,
});

beforeEach(() => {
  vi.useFakeTimers();
  __zerarMemoriaDoCopiloto();
  h.invocacoes.length = 0;
  h.respostas.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Props = {
  conversationId: string | null;
  messages: CopilotoMensagem[];
  ligado: boolean;
};
const montar = (inicial: Props) =>
  renderHook((p: Props) => useCopiloto(p), { initialProps: inicial });

describe("useCopiloto", () => {
  it("desligado fica oculto e não chama a IA", () => {
    const { result } = montar({
      conversationId: "c1",
      messages: [inbound("a")],
      ligado: false,
    });
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current.estado.fase).toBe("oculto");
    expect(h.invocacoes).toHaveLength(0);
  });

  it("debounce: rajada do cliente vira UMA chamada, para a última inbound", async () => {
    const { result, rerender } = montar({
      conversationId: "c1",
      messages: [inbound("a")],
      ligado: true,
    });
    expect(result.current.estado.fase).toBe("ocioso");
    act(() => vi.advanceTimersByTime(800));
    rerender({
      conversationId: "c1",
      messages: [inbound("a"), inbound("b")],
      ligado: true,
    });
    act(() => vi.advanceTimersByTime(800));
    expect(h.invocacoes).toHaveLength(0);
    act(() => vi.advanceTimersByTime(800));
    expect(h.invocacoes).toEqual([
      { nome: "copiloto", body: { conversationId: "c1" } },
    ]);
    expect(result.current.estado.fase).toBe("lendo");

    await act(async () =>
      h.respostas[0].resolver(ok("Maio funciona bem para nós!")),
    );
    expect(result.current.estado).toMatchObject({
      fase: "pronto",
      momento: "Cliente quer o orçamento em maio",
    });
  });

  it("resposta do atendente consome as sugestões", async () => {
    const { result, rerender } = montar({
      conversationId: "c1",
      messages: [inbound("a")],
      ligado: true,
    });
    act(() => vi.advanceTimersByTime(2_000));
    await act(async () => h.respostas[0].resolver(ok("Oi!")));
    expect(result.current.estado.fase).toBe("pronto");
    rerender({
      conversationId: "c1",
      messages: [inbound("a"), outbound("b")],
      ligado: true,
    });
    expect(result.current.estado.fase).toBe("ocioso");
  });

  it("trocar de conversa no meio não mistura: o resultado fica na conversa de origem", async () => {
    const { result, rerender } = montar({
      conversationId: "c1",
      messages: [inbound("a")],
      ligado: true,
    });
    act(() => vi.advanceTimersByTime(2_000));
    rerender({ conversationId: "c2", messages: [outbound("z")], ligado: true });
    await act(async () => h.respostas[0].resolver(ok("Para a c1")));
    expect(result.current.estado.fase).toBe("ocioso");
    rerender({ conversationId: "c1", messages: [inbound("a")], ligado: true });
    expect(result.current.estado).toMatchObject({ fase: "pronto" });
    expect(h.invocacoes).toHaveLength(1);
  });

  it("sem chave na org some da tela e não pergunta de novo naquela org; outra org segue", async () => {
    const { result, rerender } = renderHook(
      (p: Props & { organizacaoId: string }) => useCopiloto(p),
      {
        initialProps: {
          conversationId: "c1",
          messages: [inbound("a")],
          ligado: true,
          organizacaoId: "org-a",
        },
      },
    );
    act(() => vi.advanceTimersByTime(2_000));
    await act(async () =>
      h.respostas[0].resolver({
        data: { status: "indisponivel", motivo: "sem_chave" },
        error: null,
      }),
    );
    expect(result.current.estado.fase).toBe("oculto");
    rerender({
      conversationId: "c2",
      messages: [inbound("x")],
      ligado: true,
      organizacaoId: "org-a",
    });
    act(() => vi.advanceTimersByTime(20_000));
    expect(h.invocacoes).toHaveLength(1);
    rerender({
      conversationId: "c3",
      messages: [inbound("y")],
      ligado: true,
      organizacaoId: "org-b",
    });
    expect(result.current.estado.fase).toBe("ocioso");
    act(() => vi.advanceTimersByTime(2_000));
    expect(h.invocacoes).toHaveLength(2);
  });

  it("faixa que desmonta no meio da análise: a que montar de novo recebe o resultado", async () => {
    const primeira = montar({
      conversationId: "c1",
      messages: [inbound("a")],
      ligado: true,
    });
    act(() => vi.advanceTimersByTime(2_000));
    expect(primeira.result.current.estado.fase).toBe("lendo");
    primeira.unmount();
    const segunda = montar({
      conversationId: "c1",
      messages: [inbound("a")],
      ligado: true,
    });
    expect(segunda.result.current.estado.fase).toBe("lendo");
    await act(async () => h.respostas[0].resolver(ok("Chegou")));
    expect(segunda.result.current.estado).toMatchObject({ fase: "pronto" });
  });

  it("resposta fora do contrato vira erro, e 'tentar de novo' chama outra vez", async () => {
    const { result } = montar({
      conversationId: "c1",
      messages: [inbound("a")],
      ligado: true,
    });
    act(() => vi.advanceTimersByTime(2_000));
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () =>
      h.respostas[0].resolver({ data: { status: "ok" }, error: null }),
    );
    erro.mockRestore();
    expect(result.current.estado.fase).toBe("erro");
    act(() => result.current.atualizar());
    expect(h.invocacoes).toHaveLength(2);
    expect(result.current.estado.fase).toBe("lendo");
  });
});
