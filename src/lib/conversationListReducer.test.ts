import { describe, expect, it } from "vitest";
import type { Conversation } from "@/types/conversation";
import type { ConversationRow } from "./conversationRealtime";
import {
  applyAssigneeEvent,
  applyAssigneeSnapshot,
  applyConversationEvent,
  linhaNoEscopo,
  mergeRefreshedRow,
  reconcileFetched,
} from "./conversationListReducer";

const LINE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ANA = "11111111-1111-4111-8111-111111111111";
const BRUNO = "22222222-2222-4222-8222-222222222222";
const CONV_1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const CONV_2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const CONV_3 = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";

const T0 = "2026-09-24T12:00:00.000Z";
const T1 = "2026-09-24T12:05:00.000Z";
const T2 = "2026-09-24T12:10:00.000Z";

const conv = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: CONV_1,
  contact_name: "Contato",
  contact_phone: "5511999990001",
  last_message_at: T0,
  status: "open",
  phone_number_id: LINE_A,
  sector_id: null,
  assigned_to: null,
  is_group: false,
  contact_avatar_url: null,
  contact_avatar_updated_at: null,
  profiles: null,
  co_assignee_ids: [],
  ...overrides,
});

const row = (overrides: Partial<ConversationRow> = {}): ConversationRow => ({
  id: CONV_1,
  contact_name: "Contato",
  contact_phone: "5511999990001",
  last_message_at: T0,
  status: "open",
  phone_number_id: LINE_A,
  sector_id: null,
  assigned_to: null,
  is_group: false,
  contact_avatar_url: null,
  contact_avatar_updated_at: null,
  ...overrides,
});

const asMap = (...rows: Conversation[]) => new Map(rows.map((r) => [r.id, r]));
const set = (...ids: string[]): ReadonlySet<string> => new Set(ids);
// `null` = nenhum número selecionado (conjunto vazio).
const ctx = (numeros: ReadonlySet<string> | null = set(LINE_A), members: [string, Conversation["profiles"]][] = []) => ({
  numeros: numeros ?? set(),
  memberProfiles: new Map(members),
});

describe("reconcileFetched", () => {
  const opts = { numeroId: LINE_A, escopo: set(LINE_A), startedAt: Date.parse(T1), complete: true };

  it("patch local mais novo vence o snapshot do fetch", () => {
    const local = conv({ last_message_at: T2, contact_name: "Local" });
    const remote = conv({ last_message_at: T1, contact_name: "Remoto" });
    const out = reconcileFetched([local], asMap(remote), opts);
    expect(out).toEqual([local]);
  });

  it("empate ou fetch mais novo → fica a versão do fetch", () => {
    const local = conv({ last_message_at: T1, contact_name: "Local" });
    const remote = conv({ last_message_at: T1, contact_name: "Remoto" });
    expect(reconcileFetched([local], asMap(remote), opts)[0]).toBe(remote);
  });

  it("insert local sobrevive quando o fetch foi parcial", () => {
    const local = conv({ id: CONV_2, last_message_at: T0 });
    const remote = conv({ id: CONV_1 });
    const out = reconcileFetched([local], asMap(remote), { ...opts, complete: false });
    expect(out.map((c) => c.id)).toEqual([CONV_2, CONV_1]);
  });

  it("insert local sobrevive quando é mais novo que o início do fetch", () => {
    const local = conv({ id: CONV_2, last_message_at: T2 });
    const remote = conv({ id: CONV_1 });
    const out = reconcileFetched([local], asMap(remote), opts);
    expect(out.map((c) => c.id)).toEqual([CONV_2, CONV_1]);
  });

  it("linha ausente do fetch completo e mais velha que startedAt cai", () => {
    const local = conv({ id: CONV_2, last_message_at: T0 });
    const remote = conv({ id: CONV_1 });
    const out = reconcileFetched([local], asMap(remote), opts);
    expect(out.map((c) => c.id)).toEqual([CONV_1]);
  });

  it("linhas de um número fora do escopo são descartadas", () => {
    const other = conv({ id: CONV_3, phone_number_id: LINE_B, last_message_at: T2 });
    const remote = conv({ id: CONV_1 });
    const out = reconcileFetched([other], asMap(remote), { ...opts, complete: false });
    expect(out.map((c) => c.id)).toEqual([CONV_1]);
  });

  it("devolve prev quando nada muda", () => {
    const local = conv({ last_message_at: T2 });
    const remote = conv({ last_message_at: T1 });
    const prev = [local];
    expect(reconcileFetched(prev, asMap(remote), opts)).toBe(prev);
  });
});

describe("applyConversationEvent — upsert", () => {
  it("insere no início quando a conversa não existe, com profiles do mapa", () => {
    const ana = { first_name: "Ana", last_name: "Souza", email: null };
    const prev = [conv({ id: CONV_2 })];
    const out = applyConversationEvent(
      prev,
      { type: "upsert", row: row({ assigned_to: ANA, contact_name: null }) },
      ctx(set(LINE_A), [[ANA, ana]]),
    );
    expect(out.map((c) => c.id)).toEqual([CONV_1, CONV_2]);
    expect(out[0].contact_name).toBe("");
    expect(out[0].profiles).toBe(ana);
    expect(out[0].co_assignee_ids).toEqual([]);
  });

  it("atualiza campos e preserva co_assignee_ids", () => {
    const prev = [conv({ co_assignee_ids: [BRUNO] })];
    const out = applyConversationEvent(
      prev,
      { type: "upsert", row: row({ contact_name: "Novo", last_message_at: T1 }) },
      ctx(),
    );
    expect(out).not.toBe(prev);
    expect(out[0].contact_name).toBe("Novo");
    expect(out[0].last_message_at).toBe(T1);
    expect(out[0].co_assignee_ids).toEqual([BRUNO]);
  });

  it("mantém profiles quando o dono não mudou e troca quando mudou", () => {
    const ana = { first_name: "Ana", last_name: null, email: null };
    const bruno = { first_name: "Bruno", last_name: null, email: null };
    const prev = [conv({ assigned_to: ANA, profiles: ana })];
    const same = applyConversationEvent(
      prev,
      { type: "upsert", row: row({ assigned_to: ANA, last_message_at: T1 }) },
      ctx(set(LINE_A), [[BRUNO, bruno]]),
    );
    expect(same[0].profiles).toBe(ana);
    const changed = applyConversationEvent(
      prev,
      { type: "upsert", row: row({ assigned_to: BRUNO }) },
      ctx(set(LINE_A), [[BRUNO, bruno]]),
    );
    expect(changed[0].profiles).toBe(bruno);
  });

  it("remove a conversa quando ela mudou para outra linha", () => {
    const prev = [conv(), conv({ id: CONV_2 })];
    const out = applyConversationEvent(
      prev,
      { type: "upsert", row: row({ phone_number_id: LINE_B }) },
      ctx(),
    );
    expect(out.map((c) => c.id)).toEqual([CONV_2]);
  });

  it("row de outra linha que não estava aqui → prev", () => {
    const prev = [conv()];
    const out = applyConversationEvent(
      prev,
      { type: "upsert", row: row({ id: CONV_2, phone_number_id: LINE_B }) },
      ctx(),
    );
    expect(out).toBe(prev);
  });

  it("sem linha selecionada → só remove se existir", () => {
    const prev = [conv()];
    expect(applyConversationEvent(prev, { type: "upsert", row: row() }, ctx(null))).toEqual([]);
    expect(applyConversationEvent(prev, { type: "upsert", row: row({ id: CONV_2 }) }, ctx(null))).toBe(prev);
  });

  it("row sem número nenhum não entra e tira a que já estava", () => {
    const prev = [conv()];
    expect(applyConversationEvent(prev, { type: "upsert", row: row({ phone_number_id: null }) }, ctx())).toEqual([]);
    expect(
      applyConversationEvent(prev, { type: "upsert", row: row({ id: CONV_2, phone_number_id: null }) }, ctx()),
    ).toBe(prev);
  });

  it("row sem direction mantém a prévia existente", () => {
    const prev = [conv({ last_message_preview: "oi", last_message_direction: "inbound" })];
    const out = applyConversationEvent(
      prev,
      { type: "upsert", row: row({ last_message_at: T1 }) },
      ctx(),
    );
    expect(out[0].last_message_preview).toBe("oi");
    expect(out[0].last_message_direction).toBe("inbound");
  });

  it("row com direction null limpa a prévia", () => {
    const prev = [conv({ last_message_preview: "oi", last_message_direction: "inbound" })];
    const out = applyConversationEvent(
      prev,
      { type: "upsert", row: row({ last_message_direction: null, last_message_content: null }) },
      ctx(),
    );
    expect(out[0].last_message_preview).toBeUndefined();
    expect(out[0].last_message_direction).toBeUndefined();
  });

  it("row com direction gera a prévia pelo tipo", () => {
    const out = applyConversationEvent(
      [conv()],
      {
        type: "upsert",
        row: row({ last_message_direction: "outbound", last_message_type: "image", last_message_content: null }),
      },
      ctx(),
    );
    expect(out[0].last_message_preview).toBe("📷 Imagem");
    expect(out[0].last_message_direction).toBe("outbound");
  });

  it("eco sem mudança devolve prev", () => {
    const prev = [conv()];
    expect(applyConversationEvent(prev, { type: "upsert", row: row() }, ctx())).toBe(prev);
  });
});

describe("applyConversationEvent — delete", () => {
  it("remove por id e devolve prev se ausente", () => {
    const prev = [conv(), conv({ id: CONV_2 })];
    expect(applyConversationEvent(prev, { type: "delete", id: CONV_1 }, ctx()).map((c) => c.id)).toEqual([CONV_2]);
    expect(applyConversationEvent(prev, { type: "delete", id: CONV_3 }, ctx())).toBe(prev);
  });
});

describe("applyAssigneeEvent", () => {
  it("add é idempotente", () => {
    const prev = [conv()];
    const once = applyAssigneeEvent(prev, { type: "add", conversationId: CONV_1, userId: BRUNO });
    expect(once[0].co_assignee_ids).toEqual([BRUNO]);
    expect(applyAssigneeEvent(once, { type: "add", conversationId: CONV_1, userId: BRUNO })).toBe(once);
  });

  it("remove é idempotente e não muta o array anterior", () => {
    const prev = [conv({ co_assignee_ids: [ANA, BRUNO] })];
    const out = applyAssigneeEvent(prev, { type: "remove", conversationId: CONV_1, userId: ANA });
    expect(out[0].co_assignee_ids).toEqual([BRUNO]);
    expect(prev[0].co_assignee_ids).toEqual([ANA, BRUNO]);
    expect(applyAssigneeEvent(out, { type: "remove", conversationId: CONV_1, userId: ANA })).toBe(out);
  });

  it("conversa ausente → prev", () => {
    const prev = [conv()];
    expect(applyAssigneeEvent(prev, { type: "add", conversationId: CONV_2, userId: ANA })).toBe(prev);
  });
});

describe("mergeRefreshedRow", () => {
  it("null remove a conversa (saiu do escopo da RLS)", () => {
    const prev = [conv(), conv({ id: CONV_2 })];
    expect(mergeRefreshedRow(prev, CONV_1, null, set(LINE_A)).map((c) => c.id)).toEqual([CONV_2]);
  });

  it("row de um número fora do escopo remove", () => {
    const prev = [conv()];
    expect(mergeRefreshedRow(prev, CONV_1, conv({ phone_number_id: LINE_B }), set(LINE_A))).toEqual([]);
  });

  it("escopo vazio remove (nenhum número selecionado)", () => {
    expect(mergeRefreshedRow([conv()], CONV_1, conv(), set())).toEqual([]);
  });

  it("substitui no lugar ou insere no início", () => {
    const fresh = conv({ contact_name: "Refetch", co_assignee_ids: [ANA] });
    const replaced = mergeRefreshedRow([conv({ id: CONV_2 }), conv()], CONV_1, fresh, set(LINE_A));
    expect(replaced[1]).toBe(fresh);
    const inserted = mergeRefreshedRow([conv({ id: CONV_2 })], CONV_1, fresh, set(LINE_A));
    expect(inserted[0]).toBe(fresh);
  });

  it("com vários números no escopo, aceita a row de qualquer um deles", () => {
    const daB = conv({ phone_number_id: LINE_B, contact_name: "Da B" });
    const out = mergeRefreshedRow([conv({ id: CONV_2 })], CONV_1, daB, set(LINE_A, LINE_B));
    expect(out[0]).toBe(daB);
  });

  it("conversa que passou de um número do escopo para outro fica uma vez só", () => {
    const movida = conv({ phone_number_id: LINE_B });
    const out = mergeRefreshedRow([conv({ phone_number_id: LINE_A })], CONV_1, movida, set(LINE_A, LINE_B));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(movida);
  });
});

describe("reconcileFetched — touched", () => {
  const base = {
    id: "c1", contact_name: "A", contact_phone: "1", last_message_at: "2026-09-24T10:00:00+00:00",
    status: "active", phone_number_id: "p1", assigned_to: null,
  } as unknown as Conversation;
  it("empate + tocado durante o fetch → fica a versão local (fechar não mexe no timestamp)", () => {
    const local = { ...base, status: "closed" };
    const fetched = new Map([[base.id, base]]);
    const out = reconcileFetched([local], fetched, {
      numeroId: "p1", escopo: set("p1"), startedAt: 0, complete: true, touched: new Set(["c1"]),
    });
    expect(out[0].status).toBe("closed");
  });
  it("empate sem marca → fica a versão do fetch (cache velho perde)", () => {
    const local = { ...base, status: "closed" };
    const fetched = new Map([[base.id, base]]);
    const out = reconcileFetched([local], fetched, { numeroId: "p1", escopo: set("p1"), startedAt: 0, complete: true });
    expect(out[0].status).toBe("active");
  });
});

describe("reconcileFetched — vários números no escopo", () => {
  const ambos = set(LINE_A, LINE_B);
  const optsA = { numeroId: LINE_A, escopo: ambos, startedAt: Date.parse(T1), complete: true };
  const optsB = { numeroId: LINE_B, escopo: ambos, startedAt: Date.parse(T1), complete: true };

  it("o fetch de um número não mexe nas conversas dos outros do escopo", () => {
    // Antiga e fora do fetch de A: se fosse de A, cairia. Sendo de B, fica como está.
    const daB = conv({ id: CONV_3, phone_number_id: LINE_B, last_message_at: T0 });
    const daA = conv({ id: CONV_1, last_message_at: T0, contact_name: "Local" });
    const remotaA = conv({ id: CONV_1, last_message_at: T1, contact_name: "Remota" });

    const out = reconcileFetched([daA, daB], asMap(remotaA), optsA);

    expect(out).toEqual([remotaA, daB]);
    expect(out[1]).toBe(daB);
  });

  it("o fetch de um número que ainda não chegou não apaga nada do outro", () => {
    const daA = conv({ id: CONV_1 });
    const daB = conv({ id: CONV_3, phone_number_id: LINE_B });
    const prev = [daA, daB];
    // A chega vazio e completo: a conversa local de A (antiga) cai; a de B fica.
    const out = reconcileFetched(prev, asMap(), optsA);
    expect(out).toEqual([daB]);
  });

  it("fetch parcial de B acrescenta e não tira nada de A nem de B", () => {
    const daA = conv({ id: CONV_1 });
    const daB = conv({ id: CONV_3, phone_number_id: LINE_B, last_message_at: T0 });
    const nova = conv({ id: CONV_2, phone_number_id: LINE_B, last_message_at: T1 });
    const out = reconcileFetched([daA, daB], asMap(nova), { ...optsB, complete: false });
    expect(out.map((c) => c.id)).toEqual([CONV_1, CONV_3, CONV_2]);
  });

  it("o que é de fora do escopo sai, no meio dos que ficam", () => {
    const foraDoEscopo = conv({ id: CONV_2, phone_number_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", last_message_at: T2 });
    const daB = conv({ id: CONV_3, phone_number_id: LINE_B });
    const out = reconcileFetched([foraDoEscopo, daB], asMap(conv()), optsA);
    expect(out.map((c) => c.id)).toEqual([CONV_3, CONV_1]);
  });

  it("devolve prev quando nada muda, com vários números", () => {
    const daA = conv({ id: CONV_1, last_message_at: T2 });
    const daB = conv({ id: CONV_3, phone_number_id: LINE_B });
    const prev = [daA, daB];
    expect(reconcileFetched(prev, asMap(conv({ last_message_at: T1 })), optsA)).toBe(prev);
  });

  it("conversa sem número nenhum não sobrevive ao reconcile", () => {
    const semNumero = conv({ id: CONV_2, phone_number_id: null });
    const out = reconcileFetched([semNumero], asMap(conv()), optsA);
    expect(out.map((c) => c.id)).toEqual([CONV_1]);
  });

  it("linha do fetch que já não está no escopo não entra", () => {
    // O escopo mudou entre o início do fetch e o commit.
    const daB = conv({ id: CONV_3, phone_number_id: LINE_B });
    const out = reconcileFetched([], asMap(daB), { ...optsB, escopo: set(LINE_A) });
    expect(out).toEqual([]);
  });

  it("local fora do escopo cujo id o fetch traz: vale a versão do fetch, nunca a velha", () => {
    // Cache velho de um número que saiu do escopo, e o servidor diz que a conversa agora é de A.
    const velha = conv({ phone_number_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", last_message_at: T2 });
    const remota = conv({ phone_number_id: LINE_A, last_message_at: T1 });
    const out = reconcileFetched([velha], asMap(remota), { ...optsA, escopo: set(LINE_A) });
    expect(out).toEqual([remota]);
    expect(out[0]).toBe(remota);
  });
});

describe("reconcileFetched — conversa que mudou de número durante o fetch", () => {
  const ambos = set(LINE_A, LINE_B);
  const optsA = { numeroId: LINE_A, escopo: ambos, startedAt: Date.parse(T1), complete: true };
  const optsB = { numeroId: LINE_B, escopo: ambos, startedAt: Date.parse(T1), complete: true };
  const ids = (rows: Conversation[]) => rows.map((c) => c.id);

  it("A → B: a local de A e a de B no fetch viram uma só (empate, sem marca)", () => {
    const antes = conv({ phone_number_id: LINE_A, last_message_at: T1 });
    const depois = conv({ phone_number_id: LINE_B, last_message_at: T1 });

    const out = reconcileFetched([antes], asMap(depois), optsB);

    expect(ids(out)).toEqual([CONV_1]);
    expect(out[0]).toBe(depois);
  });

  it("A → B com empate e id tocado: continua uma só (a local vence, como sempre no empate tocado)", () => {
    const antes = conv({ phone_number_id: LINE_A, last_message_at: T1, status: "closed" });
    const depois = conv({ phone_number_id: LINE_B, last_message_at: T1, status: "active" });

    const out = reconcileFetched([antes], asMap(depois), { ...optsB, touched: new Set([CONV_1]) });

    expect(ids(out)).toEqual([CONV_1]);
    expect(out[0]).toBe(antes);
  });

  it("B → A: o mesmo no sentido contrário", () => {
    const antes = conv({ phone_number_id: LINE_B, last_message_at: T1 });
    const depois = conv({ phone_number_id: LINE_A, last_message_at: T1 });

    const out = reconcileFetched([antes], asMap(depois), optsA);

    expect(ids(out)).toEqual([CONV_1]);
    expect(out[0]).toBe(depois);
  });

  it("B → A com empate e id tocado", () => {
    const antes = conv({ phone_number_id: LINE_B, last_message_at: T1 });
    const depois = conv({ phone_number_id: LINE_A, last_message_at: T1 });

    const out = reconcileFetched([antes], asMap(depois), { ...optsA, touched: new Set([CONV_1]) });

    expect(ids(out)).toEqual([CONV_1]);
  });

  it("os dois fetches chegam em sequência (A velho, B novo): uma só no fim, do número novo", () => {
    const naA = conv({ phone_number_id: LINE_A, last_message_at: T1 });
    const naB = conv({ phone_number_id: LINE_B, last_message_at: T1 });

    const depoisDeA = reconcileFetched([], asMap(naA), { ...optsA, complete: false });
    const depoisDeB = reconcileFetched(depoisDeA, asMap(naB), optsB);

    expect(ids(depoisDeB)).toEqual([CONV_1]);
    expect(depoisDeB[0].phone_number_id).toBe(LINE_B);
  });

  it("os dois fetches chegam na ordem inversa (B novo, A velho): continua uma só", () => {
    const naA = conv({ phone_number_id: LINE_A, last_message_at: T1 });
    const naB = conv({ phone_number_id: LINE_B, last_message_at: T1 });

    const depoisDeB = reconcileFetched([], asMap(naB), { ...optsB, complete: false });
    const depoisDeA = reconcileFetched(depoisDeB, asMap(naA), optsA);

    expect(ids(depoisDeA)).toEqual([CONV_1]);
  });

  it("a conversa movida com mensagem nova depois do fetch fica com a versão mais nova", () => {
    const local = conv({ phone_number_id: LINE_B, last_message_at: T2 });
    const velha = conv({ phone_number_id: LINE_A, last_message_at: T1 });

    const out = reconcileFetched([local], asMap(velha), optsA);

    expect(ids(out)).toEqual([CONV_1]);
    expect(out[0]).toBe(local);
  });

  it("um prev que já traz o mesmo id duas vezes sai com ele uma vez só", () => {
    const a = conv({ phone_number_id: LINE_A });
    const b = conv({ phone_number_id: LINE_B });
    const out = reconcileFetched([a, b], asMap(), { ...optsA, complete: false });
    expect(ids(out)).toEqual([CONV_1]);
  });

  it("o fetch que traz o id das duas pontas ao mesmo tempo não duplica", () => {
    // Incremental: as duas versões da conversa movida no mesmo mapa não existem
    // (a chave é o id), mas o local pode ter as duas por um bug anterior.
    const a = conv({ phone_number_id: LINE_A, last_message_at: T0 });
    const b = conv({ phone_number_id: LINE_B, last_message_at: T0 });
    const nova = conv({ phone_number_id: LINE_B, last_message_at: T1 });
    const out = reconcileFetched([a, b], asMap(nova), optsB);
    expect(ids(out)).toEqual([CONV_1]);
    expect(out[0]).toBe(nova);
  });
});

describe("linhaNoEscopo", () => {
  it("sem número, ou com um número fora do escopo, a linha não entra", () => {
    expect(linhaNoEscopo(null, set(LINE_A))).toBe(false);
    expect(linhaNoEscopo(LINE_B, set(LINE_A))).toBe(false);
    expect(linhaNoEscopo(LINE_A, set(LINE_A))).toBe(true);
  });
});

describe("applyConversationEvent — vários números", () => {
  const ambos = ctx(set(LINE_A, LINE_B));

  it("aceita o evento de qualquer número do escopo", () => {
    const out = applyConversationEvent(
      [conv()],
      { type: "upsert", row: row({ id: CONV_2, phone_number_id: LINE_B }) },
      ambos,
    );
    expect(out.map((c) => c.id)).toEqual([CONV_2, CONV_1]);
    expect(out[0].phone_number_id).toBe(LINE_B);
  });

  it("conversa que passou de A para B (os dois no escopo) fica no lugar, com o número novo", () => {
    const prev = [conv({ id: CONV_2 }), conv()];
    const out = applyConversationEvent(prev, { type: "upsert", row: row({ phone_number_id: LINE_B }) }, ambos);
    expect(out.map((c) => c.id)).toEqual([CONV_2, CONV_1]);
    expect(out[1].phone_number_id).toBe(LINE_B);
  });

  it("conversa que passou para um número de fora do escopo some", () => {
    const fora = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const out = applyConversationEvent([conv()], { type: "upsert", row: row({ phone_number_id: fora }) }, ambos);
    expect(out).toEqual([]);
  });

  it("evento de um número fora do escopo, de conversa que não estava aqui → prev", () => {
    const prev = [conv()];
    const fora = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const out = applyConversationEvent(prev, { type: "upsert", row: row({ id: CONV_2, phone_number_id: fora }) }, ambos);
    expect(out).toBe(prev);
  });
});

describe("reconcileFetched — conversa que o realtime tirou da lista durante o fetch", () => {
  const ambos = set(LINE_A, LINE_B);
  const optsCompleto = { numeroId: LINE_A, escopo: ambos, startedAt: Date.parse(T1), complete: true };
  const optsIncremental = { numeroId: LINE_A, escopo: ambos, startedAt: 0, complete: false };
  const ids = (rows: Conversation[]) => rows.map((c) => c.id);

  it("o snapshot lido antes do DELETE não a traz de volta (completo)", () => {
    // O DELETE já tirou CONV_1 do estado; o fetch, lido antes dele, ainda a devolve.
    const prev = [conv({ id: CONV_2 })];
    const out = reconcileFetched(prev, asMap(conv(), conv({ id: CONV_2 })), {
      ...optsCompleto,
      removidos: set(CONV_1),
    });
    expect(ids(out)).toEqual([CONV_2]);
  });

  it("nem no incremental, que nunca remove e a deixaria ali até o completo periódico", () => {
    const prev = [conv({ id: CONV_2 })];
    const out = reconcileFetched(prev, asMap(conv()), { ...optsIncremental, removidos: set(CONV_1) });
    expect(out).toBe(prev);
  });

  it("a que saiu para um número fora do escopo também não volta", () => {
    // Movida de A para um número que a tela não mostra: o evento a tirou, e o snapshot de A a tem.
    const prev: Conversation[] = [];
    const out = reconcileFetched(prev, asMap(conv({ phone_number_id: LINE_A })), {
      ...optsCompleto,
      removidos: set(CONV_1),
    });
    expect(out).toEqual([]);
  });

  it("só barra o marcado: as outras do fetch entram", () => {
    const out = reconcileFetched([], asMap(conv(), conv({ id: CONV_2 }), conv({ id: CONV_3 })), {
      ...optsCompleto,
      removidos: set(CONV_2),
    });
    expect(ids(out).sort()).toEqual([CONV_1, CONV_3].sort());
  });

  it("não interfere com a que ainda está em memória: o local decide, como sempre", () => {
    const local = conv({ last_message_at: T2, contact_name: "Local" });
    const remoto = conv({ last_message_at: T1, contact_name: "Remoto" });
    const out = reconcileFetched([local], asMap(remoto), { ...optsCompleto, removidos: set(CONV_1) });
    expect(out).toEqual([local]);
  });

  it("sem a marca o comportamento é o de sempre (volta)", () => {
    const out = reconcileFetched([], asMap(conv()), optsCompleto);
    expect(ids(out)).toEqual([CONV_1]);
  });

  it("marca de um id que o fetch nem trouxe não muda nada", () => {
    const igual = conv();
    const prev = [igual];
    const out = reconcileFetched(prev, asMap(igual), { ...optsCompleto, removidos: set(CONV_3) });
    expect(out).toBe(prev);
  });

  it("um id só marcado como tocado entra pelo fetch: tocar não é remover", () => {
    // Co-responsável apagado de uma conversa que não está em memória também marca `touched`.
    const out = reconcileFetched([], asMap(conv()), { ...optsCompleto, touched: set(CONV_1) });
    expect(ids(out)).toEqual([CONV_1]);
  });
});

describe("reconcileFetched — conteúdo igual não troca a referência", () => {
  const opts = { numeroId: LINE_A, escopo: set(LINE_A), startedAt: Date.parse(T1), complete: true };
  const ids = (rows: Conversation[]) => rows.map((c) => c.id);

  it("fetch com o mesmo conteúdo, em objetos novos e com co_assignee_ids em outra ordem, devolve prev", () => {
    const ana = { first_name: "Ana", last_name: "Souza", email: "ana@x.com" };
    const local = conv({ last_message_at: T1, profiles: ana, co_assignee_ids: [ANA, BRUNO] });
    const remote = conv({ last_message_at: T1, profiles: { ...ana }, co_assignee_ids: [BRUNO, ANA] });
    const prev = [local];

    const out = reconcileFetched(prev, asMap(remote), opts);

    expect(out).toBe(prev);
    expect(out[0]).toBe(local);
  });

  it("status, dono, co-responsável ou profiles diferentes: vale a versão do fetch", () => {
    const local = conv({
      last_message_at: T1,
      status: "open",
      co_assignee_ids: [ANA],
      profiles: { first_name: "Ana", last_name: null, email: null },
    });
    const mudancas: Partial<Conversation>[] = [
      { status: "closed" },
      { assigned_to: BRUNO },
      { co_assignee_ids: [ANA, BRUNO] },
      { profiles: { first_name: "Bruno", last_name: null, email: null } },
    ];
    for (const mudanca of mudancas) {
      const remote = { ...local, ...mudanca };
      expect(reconcileFetched([local], asMap(remote), opts)[0]).toBe(remote);
    }
  });

  it("uma linha igual e outra mudada: o array é novo, e a igual continua sendo a local", () => {
    const igual = conv({ id: CONV_1, last_message_at: T1 });
    const mudou = conv({ id: CONV_2, last_message_at: T1, status: "open" });
    const prev = [igual, mudou];

    const out = reconcileFetched(
      prev,
      asMap(conv({ id: CONV_1, last_message_at: T1 }), conv({ id: CONV_2, last_message_at: T1, status: "closed" })),
      opts,
    );

    expect(out).not.toBe(prev);
    expect(out[0]).toBe(igual);
    expect(out[1].status).toBe("closed");
  });

  it("linha nova no fetch: o array é novo, e as iguais continuam sendo a local", () => {
    const igual = conv({ id: CONV_1, last_message_at: T1 });
    const prev = [igual];

    const out = reconcileFetched(
      prev,
      asMap(conv({ id: CONV_1, last_message_at: T1 }), conv({ id: CONV_2, last_message_at: T1 })),
      opts,
    );

    expect(ids(out)).toEqual([CONV_1, CONV_2]);
    expect(out[0]).toBe(igual);
  });

  it("sem numeroId (revalidação incremental, que junta números) só acrescenta e atualiza", () => {
    const daA = conv({ id: CONV_1, phone_number_id: LINE_A, last_message_at: T0 });
    const daB = conv({ id: CONV_2, phone_number_id: LINE_B, last_message_at: T0 });
    const atualizada = conv({ id: CONV_1, phone_number_id: LINE_A, last_message_at: T1 });

    const out = reconcileFetched([daA, daB], asMap(atualizada), {
      escopo: set(LINE_A, LINE_B),
      startedAt: 0,
      complete: false,
    });

    expect(ids(out)).toEqual([CONV_1, CONV_2]);
    expect(out[0]).toBe(atualizada);
    expect(out[1]).toBe(daB);
  });
});

describe("applyAssigneeSnapshot", () => {
  const ambos = set(LINE_A, LINE_B);
  const retrato = (...pares: Array<[string, string[]]>) => new Map(pares);

  it("inclui o co-responsável que entrou e tira o que saiu, numa consulta só", () => {
    const prev = [
      conv({ id: CONV_1, co_assignee_ids: [] }),
      conv({ id: CONV_2, co_assignee_ids: [ANA] }),
      conv({ id: CONV_3, co_assignee_ids: [ANA, BRUNO] }),
    ];
    const out = applyAssigneeSnapshot(prev, retrato([CONV_1, [BRUNO]], [CONV_3, [ANA]]), { escopo: ambos });

    expect(out.map((c) => c.co_assignee_ids)).toEqual([[BRUNO], [], [ANA]]);
  });

  it("conversa que o retrato não cita fica sem co-responsável", () => {
    const out = applyAssigneeSnapshot([conv({ co_assignee_ids: [ANA] })], retrato(), { escopo: ambos });
    expect(out[0].co_assignee_ids).toEqual([]);
  });

  it("os ids que o realtime tocou depois da consulta ficam como estão", () => {
    const tocada = conv({ id: CONV_1, co_assignee_ids: [ANA] });
    const outra = conv({ id: CONV_2, co_assignee_ids: [] });
    const out = applyAssigneeSnapshot([tocada, outra], retrato([CONV_2, [BRUNO]]), {
      escopo: ambos,
      ignorar: set(CONV_1),
    });

    expect(out[0]).toBe(tocada);
    expect(out[1].co_assignee_ids).toEqual([BRUNO]);
  });

  it("conversa de fora do escopo nunca é mexida", () => {
    const fora = conv({ id: CONV_2, phone_number_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", co_assignee_ids: [ANA] });
    const out = applyAssigneeSnapshot([fora], retrato(), { escopo: ambos });
    expect(out[0]).toBe(fora);
  });

  it("devolve prev quando nada muda, e a ordem dos ids não conta", () => {
    const prev = [conv({ id: CONV_1, co_assignee_ids: [ANA, BRUNO] }), conv({ id: CONV_2, co_assignee_ids: [] })];
    const out = applyAssigneeSnapshot(prev, retrato([CONV_1, [BRUNO, ANA]]), { escopo: ambos });
    expect(out).toBe(prev);
  });

  it("conversa sem co_assignee_ids conta como vazia", () => {
    const prev = [conv({ co_assignee_ids: undefined })];
    expect(applyAssigneeSnapshot(prev, retrato(), { escopo: ambos })).toBe(prev);
  });

  it("não muta o array nem as conversas de antes", () => {
    const original = conv({ co_assignee_ids: [ANA] });
    const prev = [original];
    const out = applyAssigneeSnapshot(prev, retrato([CONV_1, [BRUNO]]), { escopo: ambos });

    expect(out).not.toBe(prev);
    expect(original.co_assignee_ids).toEqual([ANA]);
    expect(prev[0]).toBe(original);
  });
});
