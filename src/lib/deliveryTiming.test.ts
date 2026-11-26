import { describe, expect, it } from "vitest";
import { inboundSentAt, latestInboundSentAt, parseDeliveryTiming } from "./deliveryTiming";

describe("parseDeliveryTiming", () => {
  it("sem metadata não tem hora de envio", () => {
    expect(parseDeliveryTiming(null)).toEqual({ sentAt: null, deliveredLate: false });
    expect(parseDeliveryTiming({ forwarded: true })).toEqual({ sentAt: null, deliveredLate: false });
  });

  it("lê sent_at e delivered_late", () => {
    const timing = parseDeliveryTiming({ sent_at: "2026-09-21T15:00:00.000Z", delivered_late: true });
    expect(timing.sentAt?.toISOString()).toBe("2026-09-21T15:00:00.000Z");
    expect(timing.deliveredLate).toBe(true);
  });

  it("sent_at inválido é ignorado sem derrubar o resto", () => {
    expect(parseDeliveryTiming({ sent_at: "ontem", delivered_late: true })).toEqual({
      sentAt: null,
      deliveredLate: false,
    });
    expect(parseDeliveryTiming({ sent_at: 123 })).toEqual({ sentAt: null, deliveredLate: false });
  });
});

describe("latestInboundSentAt", () => {
  it("sem inbound devolve null", () => {
    expect(latestInboundSentAt([{ direction: "outbound", created_at: "2026-09-23T10:00:00Z" }])).toBeNull();
  });

  it("usa sent_at em vez da chegada", () => {
    const late = {
      direction: "inbound",
      created_at: "2026-09-23T04:27:00Z",
      metadata: { sent_at: "2026-09-21T20:00:00.000Z", delivered_late: true },
    };
    expect(inboundSentAt(late).toISOString()).toBe("2026-09-21T20:00:00.000Z");
    expect(latestInboundSentAt([late])?.toISOString()).toBe("2026-09-21T20:00:00.000Z");
  });

  it("pega o maior envio, não a última posição", () => {
    const fresh = { direction: "inbound", created_at: "2026-09-23T10:00:00Z" };
    const lateAfter = {
      direction: "inbound",
      created_at: "2026-09-23T11:00:00Z",
      metadata: { sent_at: "2026-09-21T20:00:00.000Z", delivered_late: true },
    };
    expect(latestInboundSentAt([fresh, lateAfter])?.toISOString()).toBe("2026-09-23T10:00:00.000Z");
  });
});
