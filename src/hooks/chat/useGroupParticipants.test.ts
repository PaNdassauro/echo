import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useGroupParticipants, GROUP_PARTICIPANTS_TTL_MS } from "./useGroupParticipants";

const qrFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/qrService", () => ({ qrFetch }));

const DB_ID = "phone-uuid";
const GROUP_A = "111111@g.us";
const GROUP_B = "222222@g.us";

/** Resposta do qr-service com um participante por telefone informado. */
const groupResponse = (phones: string[], meta: Record<string, unknown> = {}) => ({
  ok: true,
  json: async () => ({
    success: true,
    group: {
      ...meta,
      participants: phones.map((phone) => ({
        id: `${phone}@s.whatsapp.net`,
        jid: `${phone}@s.whatsapp.net`,
        phone,
        isAdmin: false,
        isSuperAdmin: false,
      })),
    },
  }),
});

const phonesOf = (participants: { phone: string }[]) => participants.map((p) => p.phone);

const groupProps = (groupJid: string) => ({
  isGroup: true,
  groupJid,
  phoneNumberDbId: DB_ID,
  isQrConnection: true,
});

const dmProps = { isGroup: false, groupJid: null, phoneNumberDbId: DB_ID, isQrConnection: true };

beforeEach(() => {
  qrFetch.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useGroupParticipants", () => {
  it("carrega os participantes do grupo aberto", async () => {
    qrFetch.mockResolvedValue(groupResponse(["5511111111111", "5522222222222"]));

    const { result } = renderHook((props: Parameters<typeof useGroupParticipants>[0]) =>
      useGroupParticipants(props), { initialProps: groupProps(GROUP_A) });

    await waitFor(() => expect(result.current.participants).toHaveLength(2));
    expect(phonesOf(result.current.participants)).toEqual(["5511111111111", "5522222222222"]);
    // picture=0: a menção não paga a consulta da foto do grupo
    expect(qrFetch).toHaveBeenCalledWith(
      `/groups/${DB_ID}/${encodeURIComponent(GROUP_A)}?picture=0`
    );
  });

  // A regressão relatada: o @ ficava sem lista ao voltar para um grupo já visto.
  it("mantém a lista ao sair para um 1:1 e voltar ao mesmo grupo, sem refetch", async () => {
    qrFetch.mockResolvedValue(groupResponse(["5511111111111"]));

    const { result, rerender } = renderHook((props: Parameters<typeof useGroupParticipants>[0]) =>
      useGroupParticipants(props), { initialProps: groupProps(GROUP_A) });
    await waitFor(() => expect(result.current.participants).toHaveLength(1));

    rerender(dmProps);
    expect(result.current.participants).toEqual([]);

    rerender(groupProps(GROUP_A));
    expect(phonesOf(result.current.participants)).toEqual(["5511111111111"]);
    expect(qrFetch).toHaveBeenCalledTimes(1);
  });

  it("não mostra os participantes do grupo anterior ao alternar entre grupos", async () => {
    qrFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path.includes(encodeURIComponent(GROUP_A))
          ? groupResponse(["5511111111111"])
          : groupResponse(["5533333333333", "5544444444444"])
      )
    );

    const { result, rerender } = renderHook((props: Parameters<typeof useGroupParticipants>[0]) =>
      useGroupParticipants(props), { initialProps: groupProps(GROUP_A) });
    await waitFor(() => expect(phonesOf(result.current.participants)).toEqual(["5511111111111"]));

    rerender(groupProps(GROUP_B));
    await waitFor(() => expect(phonesOf(result.current.participants)).toEqual(["5533333333333", "5544444444444"]));

    rerender(groupProps(GROUP_A));
    expect(phonesOf(result.current.participants)).toEqual(["5511111111111"]);
  });

  it("resposta atrasada de um grupo não sobrescreve o grupo já aberto", async () => {
    let releaseA: () => void = () => {};
    qrFetch.mockImplementation((path: string) => {
      if (path.includes(encodeURIComponent(GROUP_A))) {
        return new Promise((resolve) => {
          releaseA = () => resolve(groupResponse(["5511111111111"]));
        });
      }
      return Promise.resolve(groupResponse(["5533333333333"]));
    });

    const { result, rerender } = renderHook((props: Parameters<typeof useGroupParticipants>[0]) =>
      useGroupParticipants(props), { initialProps: groupProps(GROUP_A) });

    rerender(groupProps(GROUP_B));
    await waitFor(() => expect(phonesOf(result.current.participants)).toEqual(["5533333333333"]));

    // Libera a resposta de A e deixa o React aplicar o que vier antes de checar.
    await act(async () => {
      releaseA();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(phonesOf(result.current.participants)).toEqual(["5533333333333"]);
  });

  it("falha do serviço não entra no cache — reabrir o grupo tenta de novo", async () => {
    qrFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ success: false, error: "Session not connected" }),
    });

    const { result, rerender } = renderHook((props: Parameters<typeof useGroupParticipants>[0]) =>
      useGroupParticipants(props), { initialProps: groupProps(GROUP_A) });
    await waitFor(() => expect(qrFetch).toHaveBeenCalledTimes(1));
    expect(result.current.participants).toEqual([]);

    qrFetch.mockResolvedValue(groupResponse(["5511111111111"]));
    rerender(dmProps);
    rerender(groupProps(GROUP_A));

    await waitFor(() => expect(phonesOf(result.current.participants)).toEqual(["5511111111111"]));
    expect(qrFetch).toHaveBeenCalledTimes(2);
  });

  it("revalida quando o cache passa do TTL (participante entrou/saiu)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    qrFetch.mockResolvedValue(groupResponse(["5511111111111"]));

    const { result, rerender } = renderHook((props: Parameters<typeof useGroupParticipants>[0]) =>
      useGroupParticipants(props), { initialProps: groupProps(GROUP_A) });
    await waitFor(() => expect(result.current.participants).toHaveLength(1));

    vi.advanceTimersByTime(GROUP_PARTICIPANTS_TTL_MS + 1);
    qrFetch.mockResolvedValue(groupResponse(["5511111111111", "5555555555555"]));
    rerender(dmProps);
    rerender(groupProps(GROUP_A));

    await waitFor(() => expect(result.current.participants).toHaveLength(2));
    expect(qrFetch).toHaveBeenCalledTimes(2);
  });

  it("participante @lid sem telefone cai para o id, sem quebrar a lista", async () => {
    qrFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        group: { participants: [{ id: "260200000001001@lid", isLid: true }] },
      }),
    });

    const { result } = renderHook((props: Parameters<typeof useGroupParticipants>[0]) =>
      useGroupParticipants(props), { initialProps: groupProps(GROUP_A) });

    await waitFor(() => expect(result.current.participants).toHaveLength(1));
    expect(result.current.participants[0]).toMatchObject({
      jid: "260200000001001@lid",
      phone: "260200000001001",
      isLid: true,
    });
  });

  it("me.id chega em `group.me` quando o serviço manda", async () => {
    qrFetch.mockResolvedValue(
      groupResponse(["5511111111111"], { me: { id: "999@lid", isAdmin: true } })
    );

    const { result } = renderHook((props: Parameters<typeof useGroupParticipants>[0]) =>
      useGroupParticipants(props), { initialProps: groupProps(GROUP_A) });

    await waitFor(() => expect(result.current.group?.me).toEqual({ id: "999@lid", isAdmin: true }));
  });

  it("announce e me da resposta chegam em `group`; é null antes da resposta e em 1:1", async () => {
    qrFetch.mockResolvedValue(groupResponse(["5511111111111"], { announce: true, me: { isAdmin: false } }));

    const { result, rerender } = renderHook((props: Parameters<typeof useGroupParticipants>[0]) =>
      useGroupParticipants(props), { initialProps: groupProps(GROUP_A) });
    expect(result.current.group).toBeNull();

    await waitFor(() => expect(result.current.group).toEqual({ announce: true, me: { isAdmin: false } }));
    expect(result.current.participants[0].isAdmin).toBe(false);

    rerender(dmProps);
    expect(result.current.group).toBeNull();

    // volta ao grupo: serve do cache, com os dois
    rerender(groupProps(GROUP_A));
    expect(result.current.group).toEqual({ announce: true, me: { isAdmin: false } });
    expect(qrFetch).toHaveBeenCalledTimes(1);
  });

  it("refetch() ignora o cache e busca de novo, atualizando `group`", async () => {
    qrFetch.mockResolvedValueOnce(groupResponse(["5511111111111"], { announce: true, me: { isAdmin: false } }));

    const { result } = renderHook((props: Parameters<typeof useGroupParticipants>[0]) =>
      useGroupParticipants(props), { initialProps: groupProps(GROUP_A) });
    await waitFor(() => expect(result.current.group?.me).toEqual({ isAdmin: false }));

    qrFetch.mockResolvedValueOnce(groupResponse(["5511111111111"], { announce: true, me: { isAdmin: true } }));
    act(() => result.current.refetch());

    await waitFor(() => expect(result.current.group?.me).toEqual({ isAdmin: true }));
    expect(qrFetch).toHaveBeenCalledTimes(2);
  });

  it("refetch() fora de um grupo não faz nada", () => {
    const { result } = renderHook((props: Parameters<typeof useGroupParticipants>[0]) =>
      useGroupParticipants(props), { initialProps: dmProps });
    act(() => result.current.refetch());
    expect(qrFetch).not.toHaveBeenCalled();
  });
});
