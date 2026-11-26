import { describe, expect, it } from "vitest";
import type { Message } from "@/hooks/chat/useMessages";
import type { Note } from "@/hooks/chat/useNotes";
import {
  START_INDEX,
  buildTimeline,
  computeDayStarts,
  nextFirstIndex,
  tailIds,
  timelineItemKey,
  type FirstIndexState,
  type TimelineItem,
} from "./timeline";

const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ id: `m-${from + i}` }));
const msg = (id: string, created_at: string, extra: Partial<Message> = {}): Message =>
  ({ id, created_at, ...extra }) as unknown as Message;
const note = (id: string, created_at: string): Note => ({ id, created_at }) as unknown as Note;

describe("nextFirstIndex", () => {
  const base = (): FirstIndexState => nextFirstIndex(null, ids(200, 400));

  it("inicial", () => {
    expect(base().firstIndex).toBe(START_INDEX);
  });
  it("append não muda", () => {
    expect(nextFirstIndex(base(), [...ids(200, 400), { id: "novo" }]).firstIndex).toBe(100000);
  });
  it("prepend de 200", () => {
    expect(nextFirstIndex(base(), ids(0, 400)).firstIndex).toBe(99800);
  });
  it("prepend de 50 + append de 1 no mesmo array", () => {
    expect(nextFirstIndex(base(), [...ids(150, 400), { id: "novo" }]).firstIndex).toBe(99950);
  });
  it("primeiro item apagado", () => {
    expect(nextFirstIndex(base(), ids(201, 400)).firstIndex).toBe(100001);
  });
  it("outra conversa", () => {
    expect(nextFirstIndex(base(), [{ id: "x1" }, { id: "x2" }]).firstIndex).toBe(100000);
  });
  it("vazio", () => {
    const prev = nextFirstIndex(base(), ids(0, 400));
    expect(nextFirstIndex(prev, []).firstIndex).toBe(100000);
  });
  it("mesma referência devolve o mesmo objeto", () => {
    const items = ids(0, 10);
    const a = nextFirstIndex(null, items);
    expect(nextFirstIndex(a, items)).toBe(a);
  });
});

describe("buildTimeline", () => {
  const messages = [msg("a", "2026-10-10T10:00:00Z"), msg("b", "2026-10-10T11:00:00Z")];
  it("nota mais antiga que a primeira mensagem: cai com hasMore, fica sem", () => {
    const notes = [note("n", "2026-10-09T10:00:00Z")];
    expect(buildTimeline(messages, notes, true).map((i) => i.id)).toEqual(["a", "b"]);
    expect(buildTimeline(messages, notes, false).map((i) => i.id)).toEqual(["n", "a", "b"]);
  });
  it("nota com o mesmo instante da primeira mensagem é mantida", () => {
    expect(buildTimeline(messages, [note("n", "2026-10-10T10:00:00Z")], true)).toHaveLength(3);
  });
  it("empate: a mensagem vem primeiro", () => {
    expect(buildTimeline(messages, [note("n", "2026-10-10T10:00:00Z")], true).map((i) => i.id)).toEqual(["a", "n", "b"]);
  });
});

describe("computeDayStarts", () => {
  const items = [
    { id: "a", created_at: "2026-10-10T12:00:00" },
    { id: "b", created_at: "2026-10-10T13:00:00" },
    { id: "c", created_at: "2026-10-11T12:00:00" },
  ];
  it("item 0 só sem hasMore", () => {
    expect(computeDayStarts(items, true).has("a")).toBe(false);
    expect(computeDayStarts(items, false).has("a")).toBe(true);
  });
  it("virada de dia aparece, mesmo dia não", () => {
    const s = computeDayStarts(items, true);
    expect(s.has("c")).toBe(true);
    expect(s.has("b")).toBe(false);
  });
});

describe("tailIds", () => {
  it("os 3 últimos, com clientKey", () => {
    const s = tailIds([{ id: "1" }, { id: "2" }, { id: "3", clientKey: "k3" }, { id: "4" }, { id: "5" }]);
    expect([...s].sort()).toEqual(["3", "4", "5", "k3"]);
  });
});

describe("timelineItemKey", () => {
  it("clientKey vence; nota ganha prefixo", () => {
    const m = { ...msg("m1", "2026-10-10T10:00:00Z", { clientKey: "c1" }), _type: "message" } as unknown as TimelineItem;
    const n = { ...note("n1", "2026-10-10T10:00:00Z"), _type: "note" } as unknown as TimelineItem;
    expect(timelineItemKey(0, m)).toBe("c1");
    expect(timelineItemKey(0, n)).toBe("note:n1");
  });
});
