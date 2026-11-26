import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Message } from "@/hooks/chat/useMessages";
import type { Note } from "@/hooks/chat/useNotes";
import { clearMediaSizes, rememberMediaSize } from "@/lib/mediaSizeCache";

type VirtuosoProps = {
  data: Array<{ id: string; _type: string }>;
  firstItemIndex: number;
  followOutput: unknown;
  defaultItemHeight: number;
  atBottomThreshold: number;
  increaseViewportBy: unknown;
  skipAnimationFrameInResizeObserver: unknown;
  computeItemKey: (index: number, item: unknown) => string;
  rangeChanged: (range: { startIndex: number; endIndex: number }) => void;
  itemContent: (index: number, item: unknown) => ReactNode;
};

const holder = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  bubbles: [] as Array<Record<string, unknown>>,
}));

const wheelSpy = vi.hoisted(() => vi.fn(() => vi.fn()));
vi.mock("@/lib/wheelScroll", () => ({ attachWheelLimiter: wheelSpy }));

vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  const Virtuoso = React.forwardRef((props: Record<string, unknown>, _ref) => {
    holder.calls.push(props);
    return null;
  });
  return { Virtuoso };
});
vi.mock("../MessageBubble", () => ({
  default: (props: Record<string, unknown>) => {
    holder.bubbles.push(props);
    return <div data-testid="bubble" />;
  },
}));
vi.mock("./TypingBubble", () => ({ default: () => null }));
vi.mock("./PendingUploadBubble", () => ({ PendingUploads: () => null }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

const preloadSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mediaPreload", () => ({
  createMediaPreloader: () => ({ preload: preloadSpy, cancel: vi.fn(), size: () => 0 }),
}));

const { default: MessageList } = await import("./MessageList");

const mk = (i: number, extra: Partial<Message> = {}): Message =>
  ({
    id: `m-${i}`,
    content: `texto ${i}`,
    direction: "inbound",
    status: "delivered",
    message_type: "text",
    created_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    ...extra,
  }) as unknown as Message;

const all = Array.from({ length: 400 }, (_, i) => mk(i));
const noop = () => {};

const list = (props: { messages: Message[]; notes?: Note[]; hasMore?: boolean; conversationId?: string; onLoadMore?: () => void; isLoadingMore?: boolean }) => (
  <MessageList
    conversationId={props.conversationId ?? "c1"}
    messages={props.messages}
    notes={props.notes ?? []}
    conversation={{ is_group: false }}
    hasMore={props.hasMore ?? true}
    isLoadingMore={props.isLoadingMore ?? false}
    onLoadMore={props.onLoadMore}
    onReply={noop}
    onEdit={noop}
    onDelete={noop}
    onReact={noop}
    onQuotedClick={noop}
    onDeleteNote={noop}
  />
);

const last = () => holder.calls[holder.calls.length - 1] as unknown as VirtuosoProps;

afterEach(() => {
  cleanup();
  clearMediaSizes();
  holder.calls.length = 0;
  holder.bubbles.length = 0;
  preloadSpy.mockClear();
  wheelSpy.mockClear();
});

describe("MessageList + Virtuoso", () => {
  it("nenhum render pareia os 400 itens com o índice antigo (prepend de 200)", () => {
    const { rerender } = render(list({ messages: all.slice(200) }));
    rerender(list({ messages: all }));
    const big = holder.calls.filter((c) => (c.data as unknown[]).length === 400);
    expect(big.length).toBeGreaterThan(0);
    for (const c of big) expect(c.firstItemIndex).toBe(99800);
  });

  it("props do Virtuoso", () => {
    render(list({ messages: all.slice(0, 5) }));
    const p = last();
    expect(p.followOutput).toBe(false);
    expect(p.defaultItemHeight).toBe(90);
    expect(p.atBottomThreshold).toBe(32);
    expect(p.increaseViewportBy).toEqual({ top: 600, bottom: 200 });
    expect(p.skipAnimationFrameInResizeObserver).toBe(true);
    expect(p.computeItemKey(0, { ...all[0], _type: "message", clientKey: "c1" })).toBe("c1");
  });

  it("rangeChanged pagina cedo, só perto do topo", () => {
    const onLoadMore = vi.fn();
    render(list({ messages: all.slice(0, 200), onLoadMore }));
    const p = last();
    p.rangeChanged({ startIndex: p.firstItemIndex + 100, endIndex: p.firstItemIndex + 120 });
    expect(onLoadMore).not.toHaveBeenCalled();
    p.rangeChanged({ startIndex: p.firstItemIndex + 10, endIndex: p.firstItemIndex + 30 });
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("não pagina durante o carregamento", () => {
    const onLoadMore = vi.fn();
    render(list({ messages: all.slice(0, 200), onLoadMore, isLoadingMore: true }));
    const p = last();
    p.rangeChanged({ startIndex: p.firstItemIndex + 10, endIndex: p.firstItemIndex + 30 });
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("a caixa da mídia é travada por mensagem; outra conversa decide de novo", () => {
    const img = mk(0, {
      message_type: "image",
      media_url: "https://x/img.png",
    } as Partial<Message>);
    const messages = [img, mk(1)];
    const renderImage = () => {
      const p = last();
      holder.bubbles.length = 0;
      render(<>{p.itemContent(p.firstItemIndex, p.data[0])}</>);
      return holder.bubbles[holder.bubbles.length - 1].mediaBox;
    };

    const { rerender } = render(list({ messages }));
    const first = renderImage();
    expect(first).toBeTruthy();

    rememberMediaSize("https://x/img.png", 1000, 500);
    rerender(list({ messages: [{ ...img }, mk(1)] }));
    const second = renderImage();
    expect(second).toBe(first);
    expect((second as { source: string }).source).toBe("fallback");

    rerender(list({ messages: [{ ...img }, mk(1)], conversationId: "c2" }));
    const third = renderImage();
    expect((third as { source: string }).source).toBe("cache");
  });

  it("nota mais antiga que a primeira mensagem só entra sem hasMore", () => {
    const old = { id: "n1", created_at: new Date(Date.UTC(2026, 8, 1)).toISOString() } as unknown as Note;
    const { rerender } = render(list({ messages: all.slice(0, 5), notes: [old], hasMore: true }));
    expect(last().data.some((i) => i.id === "n1")).toBe(false);
    rerender(list({ messages: all.slice(0, 5), notes: [old], hasMore: false }));
    expect(last().data.some((i) => i.id === "n1")).toBe(true);
  });

  it("rangeChanged com startIndex menor pré-carrega para cima; igual não pré-carrega", () => {
    render(list({ messages: all.slice(0, 200) }));
    const p = last();
    const f = p.firstItemIndex;
    p.rangeChanged({ startIndex: f + 100, endIndex: f + 120 });
    expect(preloadSpy).not.toHaveBeenCalled();
    p.rangeChanged({ startIndex: f + 90, endIndex: f + 110 });
    expect(preloadSpy).toHaveBeenCalledTimes(1);
    expect(preloadSpy.mock.calls[0][1]).toBe(89);
    expect(preloadSpy.mock.calls[0][2]).toBe(-1);
    expect(preloadSpy.mock.calls[0][3]).toBe(10);
    // Descendo, é o índice de baixo que cresce primeiro: também pré-carrega.
    p.rangeChanged({ startIndex: f + 90, endIndex: f + 111 });
    expect(preloadSpy).toHaveBeenCalledTimes(2);
    expect(preloadSpy.mock.calls[1][1]).toBe(112);
    expect(preloadSpy.mock.calls[1][2]).toBe(1);
    p.rangeChanged({ startIndex: f + 90, endIndex: f + 111 });
    expect(preloadSpy).toHaveBeenCalledTimes(2);
    p.rangeChanged({ startIndex: f + 95, endIndex: f + 115 });
    expect(preloadSpy).toHaveBeenCalledTimes(3);
    expect(preloadSpy.mock.calls[2][1]).toBe(116);
    expect(preloadSpy.mock.calls[1][2]).toBe(1);
  });

  it("liga o limitador de roda quando o Virtuoso entrega o scroller e desliga ao sair", () => {
    const detach = vi.fn();
    wheelSpy.mockReturnValueOnce(detach);
    const { unmount } = render(list({ messages: all.slice(0, 5) }));
    expect(wheelSpy).not.toHaveBeenCalled();
    const scroller = document.createElement("div");
    const scrollerRef = last() as unknown as { scrollerRef: (el: HTMLElement | null) => void };
    act(() => scrollerRef.scrollerRef(scroller));
    expect(wheelSpy).toHaveBeenCalledTimes(1);
    expect(wheelSpy.mock.calls[0]).toEqual([scroller]);
    unmount();
    expect(detach).toHaveBeenCalledTimes(1);
  });
});
