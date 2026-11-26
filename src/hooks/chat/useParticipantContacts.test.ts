import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  clearParticipantContactsCache,
  useParticipantContacts,
  PARTICIPANT_CONTACTS_CHUNK,
  PARTICIPANT_CONTACTS_TTL_MS,
} from "./useParticipantContacts";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));

const DB_ID = "phone-uuid";
const OTHER_DB_ID = "outro-phone-uuid";
const GROUP_A = "111111@g.us";
const GROUP_B = "222222@g.us";

type Row = {
  input_phone: string;
  conversation_id: string;
  contact_name: string;
  contact_phone: string;
  avatar_url: string | null;
  matched_phone_number_id: string;
  same_phone_number: boolean;
  name_is_phone_like: boolean;
};

const row = (phone: string, overrides: Partial<Row> = {}): Row => ({
  input_phone: phone,
  conversation_id: `conv-${phone}`,
  contact_name: `Contato ${phone}`,
  contact_phone: phone,
  avatar_url: null,
  matched_phone_number_id: DB_ID,
  same_phone_number: true,
  name_is_phone_like: false,
  ...overrides,
});

const props = (phones: string[], scopeKey = GROUP_A, phoneNumberDbId = DB_ID) => ({
  phones,
  phoneNumberDbId,
  enabled: true,
  scopeKey,
});

beforeEach(() => {
  rpc.mockReset();
  clearParticipantContactsCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useParticipantContacts", () => {
  it("resolve telefone para a conversa 1:1 existente", async () => {
    rpc.mockResolvedValue({ data: [row("5511999990001")], error: null });

    const { result } = renderHook(() => useParticipantContacts(props(["5511999990001"])));

    await waitFor(() => expect(result.current["5511999990001"]).toBeDefined());
    expect(result.current["5511999990001"]).toEqual({
      conversationId: "conv-5511999990001",
      name: "Contato 5511999990001",
      avatarUrl: null,
      contactPhone: "5511999990001",
      phoneNumberId: DB_ID,
      sameConnection: true,
    });
    expect(rpc).toHaveBeenCalledWith("resolve_group_participant_contacts", {
      p_phone_number_id: DB_ID,
      p_phones: ["5511999990001"],
    });
  });

  it("expõe o vínculo mesmo quando o contact_name é só o telefone", async () => {
    // name_is_phone_like: abrir a conversa e o avatar continuam valendo; só o
    // nome é descartado, para não exibir número como se fosse nome.
    rpc.mockResolvedValue({
      data: [row("5511999990001", { contact_name: "5511999990001", name_is_phone_like: true })],
      error: null,
    });

    const { result } = renderHook(() => useParticipantContacts(props(["5511999990001"])));

    await waitFor(() => expect(result.current["5511999990001"]).toBeDefined());
    expect(result.current["5511999990001"].name).toBeUndefined();
    expect(result.current["5511999990001"].conversationId).toBe("conv-5511999990001");
  });

  it("devolve contactPhone da linha, que pode divergir do consultado", async () => {
    // Caso do 9º dígito: a 1:1 foi salva sem o 9 e o grupo manda com o 9.
    rpc.mockResolvedValue({
      data: [row("5511999990001", { contact_phone: "551199990001" })],
      error: null,
    });

    const { result } = renderHook(() => useParticipantContacts(props(["5511999990001"])));

    await waitFor(() => expect(result.current["5511999990001"]).toBeDefined());
    expect(result.current["5511999990001"].contactPhone).toBe("551199990001");
  });

  it("cache quente não dispara RPC de novo", async () => {
    rpc.mockResolvedValue({ data: [row("5511999990001")], error: null });

    const first = renderHook(() => useParticipantContacts(props(["5511999990001"])));
    await waitFor(() => expect(first.result.current["5511999990001"]).toBeDefined());
    expect(rpc).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderHook(() => useParticipantContacts(props(["5511999990001"])));
    // Já resolvido no primeiro render, sem esperar rede.
    expect(second.result.current["5511999990001"]).toBeDefined();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("telefone sem vínculo é cacheado NEGATIVAMENTE", async () => {
    // Sem isso, um grupo de 200 pessoas sem 1:1 pagaria um RPC a cada abertura.
    rpc.mockResolvedValue({ data: [], error: null });

    const first = renderHook(() => useParticipantContacts(props(["5511999990001"])));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(first.result.current["5511999990001"]).toBeUndefined();
    first.unmount();

    renderHook(() => useParticipantContacts(props(["5511999990001"])));
    await new Promise((r) => setTimeout(r, 350));
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("falha do RPC não vira cache", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "sessão expirada" } });

    const first = renderHook(() => useParticipantContacts(props(["5511999990001"])));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    first.unmount();

    rpc.mockResolvedValue({ data: [row("5511999990001")], error: null });
    const second = renderHook(() => useParticipantContacts(props(["5511999990001"])));
    await waitFor(() => expect(second.result.current["5511999990001"]).toBeDefined());
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("resposta atrasada do grupo A não repinta o grupo B", async () => {
    let resolveA: (value: { data: Row[]; error: null }) => void = () => {};
    rpc.mockImplementationOnce(
      () => new Promise((resolve) => { resolveA = resolve; }),
    );

    const { result, rerender } = renderHook(
      (p: Parameters<typeof useParticipantContacts>[0]) => useParticipantContacts(p),
      { initialProps: props(["5511111111111"], GROUP_A) },
    );
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    // Troca para o grupo B ANTES da resposta de A chegar.
    rpc.mockResolvedValue({ data: [row("5522222222222")], error: null });
    rerender(props(["5522222222222"], GROUP_B));
    await waitFor(() => expect(result.current["5522222222222"]).toBeDefined());

    resolveA({ data: [row("5511111111111")], error: null });

    // O telefone de A não entra no mapa exposto (não está nos phones atuais).
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current["5511111111111"]).toBeUndefined();
    expect(result.current["5522222222222"]).toBeDefined();

    // Mas a escrita no cache valeu: voltar para A não paga RPC de novo.
    const callsBefore = rpc.mock.calls.length;
    rerender(props(["5511111111111"], GROUP_A));
    await new Promise((r) => setTimeout(r, 350));
    expect(result.current["5511111111111"]).toBeDefined();
    expect(rpc).toHaveBeenCalledTimes(callsBefore);
  });

  it("chunk de 300: lista grande vira várias chamadas", async () => {
    const phones = Array.from({ length: PARTICIPANT_CONTACTS_CHUNK + 5 }, (_, i) =>
      String(55110000000000 + i),
    );
    rpc.mockResolvedValue({ data: [], error: null });

    renderHook(() => useParticipantContacts(props(phones)));

    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    const sizes = rpc.mock.calls.map((c) => (c[1] as { p_phones: string[] }).p_phones.length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(phones.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(PARTICIPANT_CONTACTS_CHUNK);
  });

  it("não consulta quando desabilitado ou sem número conectado", async () => {
    renderHook(() => useParticipantContacts({ ...props(["5511999990001"]), enabled: false }));
    renderHook(() => useParticipantContacts({ ...props(["5511999990001"]), phoneNumberDbId: null }));
    renderHook(() => useParticipantContacts(props([])));

    await new Promise((r) => setTimeout(r, 350));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("o escopo do cache inclui o número conectado", async () => {
    rpc.mockResolvedValue({ data: [row("5511999990001")], error: null });

    const first = renderHook(() => useParticipantContacts(props(["5511999990001"])));
    await waitFor(() => expect(first.result.current["5511999990001"]).toBeDefined());
    first.unmount();

    // Outro número conectado = outro escopo de busca: não pode reusar o cache.
    renderHook(() =>
      useParticipantContacts(props(["5511999990001"], GROUP_A, OTHER_DB_ID)),
    );
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(rpc).toHaveBeenLastCalledWith("resolve_group_participant_contacts", {
      p_phone_number_id: OTHER_DB_ID,
      p_phones: ["5511999990001"],
    });
  });

  it("telefone novo na lista consulta só o que falta", async () => {
    rpc.mockResolvedValue({ data: [row("5511111111111")], error: null });

    const { result, rerender } = renderHook(
      (p: Parameters<typeof useParticipantContacts>[0]) => useParticipantContacts(p),
      { initialProps: props(["5511111111111"]) },
    );
    await waitFor(() => expect(result.current["5511111111111"]).toBeDefined());

    rpc.mockResolvedValue({ data: [row("5522222222222")], error: null });
    rerender(props(["5511111111111", "5522222222222"]));

    await waitFor(() => expect(result.current["5522222222222"]).toBeDefined());
    expect(rpc).toHaveBeenLastCalledWith("resolve_group_participant_contacts", {
      p_phone_number_id: DB_ID,
      p_phones: ["5522222222222"],
    });
  });

  it("cache expirado revalida", async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValue({ data: [row("5511999990001")], error: null });

    const first = renderHook(() => useParticipantContacts(props(["5511999990001"])));
    await vi.advanceTimersByTimeAsync(300);
    expect(rpc).toHaveBeenCalledTimes(1);
    first.unmount();

    await vi.advanceTimersByTimeAsync(PARTICIPANT_CONTACTS_TTL_MS + 1000);

    renderHook(() => useParticipantContacts(props(["5511999990001"])));
    await vi.advanceTimersByTimeAsync(300);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
