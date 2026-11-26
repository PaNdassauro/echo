import { describe, expect, it } from "vitest";
import { formatUnreadCount, hasRingableUnreadIncrease, isConversationUnread, unreadWeight, type RingableIncreaseContext } from "./unread";

describe("isConversationUnread", () => {
  it("destaca por contador, por marcação manual, ou pelos dois", () => {
    expect(isConversationUnread(3, false)).toBe(true);
    expect(isConversationUnread(0, true)).toBe(true);
    expect(isConversationUnread(3, true)).toBe(true);
  });

  it("não destaca conversa lida e sem marcação", () => {
    expect(isConversationUnread(0, false)).toBe(false);
  });
});

describe("unreadWeight", () => {
  it("marcação manual vale 1 — é o que o badge mostra", () => {
    expect(unreadWeight(0, true)).toBe(1);
    expect(unreadWeight(1, false)).toBe(1);
  });

  it("o badge da marcação manual sai como \"1\"", () => {
    expect(formatUnreadCount(unreadWeight(0, true))).toBe("1");
  });

  it("mensagem nova numa conversa marcada não soma em dobro", () => {
    // A conversa marcada que recebe 4 mensagens vale 4, não 5: a marcação não
    // representa mensagem nenhuma, só garante o piso quando não há contador.
    expect(unreadWeight(4, true)).toBe(4);
  });

  it("conversa lida e sem marcação pesa 0", () => {
    expect(unreadWeight(0, false)).toBe(0);
  });
});

describe("formatUnreadCount", () => {
  it("mostra o número até 99 e satura depois", () => {
    expect(formatUnreadCount(1)).toBe("1");
    expect(formatUnreadCount(99)).toBe("99");
    expect(formatUnreadCount(100)).toBe("99+");
  });
});

describe("hasRingableUnreadIncrease", () => {
  const ctx = (over: Partial<RingableIncreaseContext> = {}): RingableIncreaseContext => ({
    userId: "eu",
    activeConversationId: null,
    tabHidden: false,
    isMuted: () => false,
    ownership: (id) => (id === "minha" ? { assignedTo: "eu", coAssigneeIds: [] } : id === "co" ? { assignedTo: "outro", coAssigneeIds: ["eu"] } : id === "alheia" ? { assignedTo: "outro", coAssigneeIds: [] } : undefined),
    ...over,
  });

  it("toca quando conversa minha ou em que sou co-dono ganha não-lido", () => {
    expect(hasRingableUnreadIncrease(new Map(), new Map([["minha", 1]]), ctx())).toBe(true);
    expect(hasRingableUnreadIncrease(new Map([["co", 1]]), new Map([["co", 2]]), ctx())).toBe(true);
  });

  it("não toca sem aumento, em conversa alheia ou desconhecida (fail-closed)", () => {
    expect(hasRingableUnreadIncrease(new Map([["minha", 2]]), new Map([["minha", 2]]), ctx())).toBe(false);
    expect(hasRingableUnreadIncrease(new Map([["minha", 3]]), new Map([["minha", 1]]), ctx())).toBe(false);
    expect(hasRingableUnreadIncrease(new Map(), new Map([["alheia", 1]]), ctx())).toBe(false);
    expect(hasRingableUnreadIncrease(new Map(), new Map([["sumida", 1]]), ctx())).toBe(false);
  });

  it("silenciada não toca; conversa aberta com a aba visível não toca, com a aba escondida toca", () => {
    expect(hasRingableUnreadIncrease(new Map(), new Map([["minha", 1]]), ctx({ isMuted: () => true }))).toBe(false);
    expect(hasRingableUnreadIncrease(new Map(), new Map([["minha", 1]]), ctx({ activeConversationId: "minha" }))).toBe(false);
    expect(hasRingableUnreadIncrease(new Map(), new Map([["minha", 1]]), ctx({ activeConversationId: "minha", tabHidden: true }))).toBe(true);
  });

  it("sem usuário carregado não toca", () => {
    expect(hasRingableUnreadIncrease(new Map(), new Map([["minha", 1]]), ctx({ userId: null }))).toBe(false);
  });
});
