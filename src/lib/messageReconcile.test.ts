import { describe, expect, it } from "vitest";
import {
  mergeIncomingMessage,
  mergeRefreshedRows,
  settleOptimistic,
  stripAgentNameHeader,
  type ReconcilableMessage,
} from "./messageReconcile";

type Msg = ReconcilableMessage & { created_at: string };

const WAMID = "3EB0000000000000000002";
const REAL_ID = "00000000-0000-4000-8000-000000000006";

const temp = (over: Partial<Msg> = {}): Msg => ({
  id: "temp-1",
  clientKey: "temp-1",
  direction: "outbound",
  status: "sending",
  content: "fghjikol",
  whatsapp_message_id: null,
  created_at: "2026-10-13T20:05:38Z",
  ...over,
});

// Linha gravada pelo whatsapp-send numa linha com append_agent_name.
const real = (over: Partial<Msg> = {}): Msg => ({
  id: REAL_ID,
  direction: "outbound",
  status: "sent",
  content: "*Bruno yyy*\n\nfghjikol",
  whatsapp_message_id: WAMID,
  created_at: "2026-10-13T20:05:38Z",
  ...over,
});

const inbound: Msg = {
  id: "in-1",
  direction: "inbound",
  status: "delivered",
  content: "oi",
  whatsapp_message_id: "ABC",
  created_at: "2026-10-13T20:00:00Z",
};

describe("stripAgentNameHeader", () => {
  it("tira só o cabeçalho *Nome* + linha em branco do append_agent_name", () => {
    expect(stripAgentNameHeader("*Bruno yyy*\n\nfghjikol")).toBe("fghjikol");
    expect(stripAgentNameHeader("*negrito* no meio")).toBe("*negrito* no meio");
    expect(stripAgentNameHeader("sem cabeçalho")).toBe("sem cabeçalho");
  });
});

describe("mergeIncomingMessage", () => {
  it("realtime antes da resposta: substitui a temp 'sending' no lugar pelo conteúdo normalizado, herdando o clientKey", () => {
    const prev = [inbound, temp()];
    const next = mergeIncomingMessage(prev, real());
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ id: REAL_ID, clientKey: "temp-1", status: "sent" });
  });

  it("resposta antes do realtime: casa pelo wamid mesmo com a temp já 'sent'", () => {
    const prev = [inbound, temp({ status: "sent", whatsapp_message_id: WAMID })];
    const next = mergeIncomingMessage(prev, real());
    expect(next.map((m) => m.id)).toEqual(["in-1", REAL_ID]);
    expect(next[1].clientKey).toBe("temp-1");
  });

  it("linha que já está na lista pelo id devolve a mesma referência", () => {
    const prev = [inbound, real()];
    expect(mergeIncomingMessage(prev, real())).toBe(prev);
  });

  it("inbound nunca casa com bolha otimista: anexa no fim", () => {
    const prev = [temp()];
    const next = mergeIncomingMessage(prev, inbound);
    expect(next.map((m) => m.id)).toEqual(["temp-1", "in-1"]);
  });

  it("outbound sem par (eco do aparelho, automação) anexa no fim", () => {
    const prev = [temp({ content: "outra coisa" })];
    const next = mergeIncomingMessage(prev, real());
    expect(next.map((m) => m.id)).toEqual(["temp-1", REAL_ID]);
  });

  it("append_agent_name desligado e texto do usuário começando com *negrito* + linha em branco casa cru", () => {
    const texto = "*Oi*\n\ntudo bem?";
    const prev = [temp({ content: texto })];
    const next = mergeIncomingMessage(prev, real({ content: texto }));
    expect(next.map((m) => m.id)).toEqual([REAL_ID]);
  });

  it("com duas temps de mesmo texto, casa a que ainda está 'sending', não a já 'sent' de outro wamid", () => {
    const sent = temp({ id: "temp-0", clientKey: "temp-0", status: "sent", whatsapp_message_id: "OUTRO" });
    const sending = temp({ id: "temp-1", clientKey: "temp-1" });
    const next = mergeIncomingMessage([sent, sending], real());
    expect(next.map((m) => m.id)).toEqual(["temp-0", REAL_ID]);
    expect(next[1].clientKey).toBe("temp-1");
  });

  it("invoke estourou no navegador mas o servidor enviou: a linha real substitui a bolha de erro", () => {
    const prev = [inbound, temp({ status: "error" })];
    const next = mergeIncomingMessage(prev, real());
    expect(next.map((m) => m.id)).toEqual(["in-1", REAL_ID]);
    expect(next[1].clientKey).toBe("temp-1");
  });
});

describe("settleOptimistic", () => {
  it("linha real ainda não chegou: a temp vira 'sent' com o wamid", () => {
    const next = settleOptimistic([inbound, temp()], "temp-1", WAMID);
    expect(next[1]).toMatchObject({ id: "temp-1", status: "sent", whatsapp_message_id: WAMID });
  });

  it("linha real já chegou pelo realtime ou pelo sync: a temp órfã sai e a real herda o clientKey", () => {
    // Cenário do fantasma: sync anexou a linha real sem casar (caminho antigo).
    const prev = [inbound, temp(), real()];
    const next = settleOptimistic(prev, "temp-1", WAMID);
    expect(next.map((m) => m.id)).toEqual(["in-1", REAL_ID]);
    expect(next[1].clientKey).toBe("temp-1");
  });

  it("sem wamid na resposta: só promove a temp, sem procurar par", () => {
    const next = settleOptimistic([temp(), real()], "temp-1", null);
    expect(next.map((m) => m.id)).toEqual(["temp-1", REAL_ID]);
    expect(next[0].status).toBe("sent");
  });

  it("reenvio de linha persistida: a própria linha com o wamid novo não conta como 'landed'", () => {
    const persisted = real({ id: REAL_ID, status: "sending", whatsapp_message_id: WAMID, clientKey: REAL_ID });
    const next = settleOptimistic([persisted], REAL_ID, WAMID);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: REAL_ID, status: "sent" });
  });
});

describe("ordens de chegada ponta a ponta", () => {
  const sequence = (steps: Array<(prev: Msg[]) => Msg[]>) =>
    steps.reduce((acc, step) => step(acc), [inbound, temp()] as Msg[]);

  const viaRealtime = (prev: Msg[]) => mergeIncomingMessage(prev, real());
  const viaSync = (prev: Msg[]) => [real()].reduce(mergeIncomingMessage, prev);
  const viaResponse = (prev: Msg[]) => settleOptimistic(prev, "temp-1", WAMID);

  it.each([
    ["realtime → resposta", [viaRealtime, viaResponse]],
    ["resposta → realtime", [viaResponse, viaRealtime]],
    ["resposta → sync → realtime (canal caído na hora do INSERT)", [viaResponse, viaSync, viaRealtime]],
    ["sync → resposta", [viaSync, viaResponse]],
    ["sync → realtime → resposta", [viaSync, viaRealtime, viaResponse]],
  ] as Array<[string, Array<(prev: Msg[]) => Msg[]>]>)("%s termina com uma bolha só", (_nome, steps) => {
    const final = sequence(steps);
    expect(final.map((m) => m.id)).toEqual(["in-1", REAL_ID]);
    expect(final[1]).toMatchObject({ status: "sent", whatsapp_message_id: WAMID, clientKey: "temp-1" });
  });
});

describe("mergeRefreshedRows", () => {
  type Row = { id: string; status?: string; content?: string; quoted_content?: string | null; clientKey?: string; error?: string; metadata?: Record<string, unknown> | null };
  const base: Row[] = [
    { id: "a", status: "sent", content: "oi", quoted_content: "citação", clientKey: "temp-9" },
    { id: "b", status: "delivered", content: "tudo bem?" },
  ];

  it("aplica recibo perdido (✓ → lido) e preserva quoted_* e clientKey", () => {
    const next = mergeRefreshedRows(base, [{ id: "a", status: "read", content: "oi", error_message: null }]);
    expect(next[0]).toMatchObject({ id: "a", status: "read", quoted_content: "citação", clientKey: "temp-9" });
    expect(next[1]).toBe(base[1]);
  });

  it("falha vira erro com a mensagem, como o UPDATE do realtime", () => {
    const next = mergeRefreshedRows(base, [{ id: "b", status: "failed", error_message: "número inválido" }]);
    expect(next[1]).toMatchObject({ status: "error", error: "número inválido" });
  });

  it("edição e apagado para todos entram", () => {
    const next = mergeRefreshedRows<Row & { is_deleted?: boolean }>(base, [
      { id: "a", status: "sent", content: "oi (editado)", is_edited: true },
      { id: "b", status: "delivered", content: "tudo bem?", is_deleted: true },
    ]);
    expect(next[0]).toMatchObject({ content: "oi (editado)" });
    expect(next[1]).toMatchObject({ is_deleted: true });
  });

  it("sem mudança devolve a mesma referência; metadata igual por valor não conta como mudança", () => {
    const withMeta: Row[] = [{ id: "a", status: "read", metadata: { x: 1 } }];
    expect(mergeRefreshedRows(withMeta, [{ id: "a", status: "read", metadata: { x: 1 }, error_message: null }])).toBe(withMeta);
    expect(mergeRefreshedRows(base, [])).toBe(base);
  });

  it("linha que não está na lista é ignorada (linha nova é papel do sync)", () => {
    const next = mergeRefreshedRows(base, [{ id: "zzz", status: "read" }]);
    expect(next).toBe(base);
  });
});
