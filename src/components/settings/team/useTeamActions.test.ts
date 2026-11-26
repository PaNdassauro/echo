import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke } } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { useTeamActions } from "./useTeamActions";
import type { TeamCoreState } from "./useTeamManagement";

const L1 = "00000000-0000-4000-8000-000000000001";
const L2 = "00000000-0000-4000-8000-000000000002";

const refreshAll = vi.fn().mockResolvedValue(undefined);

// Só os campos que o useTeamActions lê; o resto do estado de equipe não entra nestes testes.
const core = {
  orgId: "00000000-0000-4000-8000-0000000000aa",
  members: [],
  setMembers: vi.fn(),
  phoneNumbers: [
    { id: L1, display_name: "Vendas" },
    { id: L2, display_name: "Suporte" },
  ],
  refreshAll,
} as unknown as TeamCoreState;

const usar = () => renderHook(() => useTeamActions(core)).result.current;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  window.__ECHO_CONFIG__ = { supabaseUrl: "https://echo.exemplo.com", siteUrl: "https://echo.exemplo.com", supabaseAnonKey: "anon" };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.__ECHO_CONFIG__ = undefined;
});

describe("useTeamActions.sendInvitations", () => {
  it("um link por número, com o estado do e-mail de cada um", async () => {
    invoke
      .mockResolvedValueOnce({
        data: { success: true, existingUser: false, email: "nao_configurado", invitation: { inviteUrl: "https://echo.exemplo.com/auth?invite=t1", phoneNumberName: "Vendas" } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { success: true, existingUser: false, emailSent: true, invitation: { inviteUrl: "https://echo.exemplo.com/auth?invite=t2" } },
        error: null,
      });

    const resultado = await usar().sendInvitations({ email: "ana@exemplo.com", phoneNumberIds: [L1, L2] });

    expect(invoke).toHaveBeenCalledWith("send-invitation", { body: { email: "ana@exemplo.com", phoneNumberId: L1 } });
    expect(resultado).toEqual({
      vinculados: 0,
      criados: [
        { phoneNumberId: L1, phoneNumberName: "Vendas", url: "https://echo.exemplo.com/auth?invite=t1", email: "nao_configurado" },
        // sem phoneNumberName na resposta: o nome vem da lista de números
        { phoneNumberId: L2, phoneNumberName: "Suporte", url: "https://echo.exemplo.com/auth?invite=t2", email: "enviado" },
      ],
    });
    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it("pessoa com conta é vinculada na hora: avisa por toast e não devolve link", async () => {
    invoke.mockResolvedValue({ data: { success: true, existingUser: true, message: "ok" }, error: null });

    const resultado = await usar().sendInvitations({ email: "ana@exemplo.com", phoneNumberIds: [L1] });

    expect(resultado).toEqual({ vinculados: 1, criados: [] });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Membro vinculado" }));
  });

  it("erro da edge devolve null e avisa com toast destrutivo", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("Falha ao convidar") });

    const resultado = await usar().sendInvitations({ email: "ana@exemplo.com", phoneNumberIds: [L1] });

    expect(resultado).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Não foi possível enviar convite", variant: "destructive" }));
    expect(refreshAll).not.toHaveBeenCalled();
  });

  it("resposta sem o link do convite novo é erro, não sucesso silencioso", async () => {
    invoke.mockResolvedValue({ data: { success: true, existingUser: false, email: "enviado" }, error: null });

    const resultado = await usar().sendInvitations({ email: "ana@exemplo.com", phoneNumberIds: [L1] });

    expect(resultado).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
  });

  it("e-mail inválido nem chama a edge", async () => {
    const resultado = await usar().sendInvitations({ email: "sem-arroba", phoneNumberIds: [L1] });

    expect(resultado).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("useTeamActions.copyInviteLink", () => {
  it("monta o link com o endereço do site e copia", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await usar().copyInviteLink("token-1");

    expect(writeText).toHaveBeenCalledWith("https://echo.exemplo.com/auth?invite=token-1");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Link copiado" }));
  });

  it("navegador que recusa o clipboard mostra o link para copiar à mão", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("sem permissão", "NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await usar().copyInviteLink("token-1");

    expect(toast).toHaveBeenCalledWith({
      title: "Não foi possível copiar sozinho",
      description: "https://echo.exemplo.com/auth?invite=token-1",
    });
  });
});
