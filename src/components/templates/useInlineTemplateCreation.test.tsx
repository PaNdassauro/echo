import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetaTemplate } from "@/lib/templatesApi";

const fetchOrgTemplates = vi.fn<(orgId: string, name?: string) => Promise<MetaTemplate[]>>();
const toast = vi.fn();

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/templatesApi", () => ({
  fetchOrgTemplates: (orgId: string, name?: string) => fetchOrgTemplates(orgId, name),
  rejectedReasonLabel: (r: string | undefined) => (r && r !== "NONE" ? r : null),
}));
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ currentOrganization: { id: "org-1" } }),
}));
vi.mock("@/components/templates/TemplateBuilderDialog", () => ({ default: () => null }));

import { APPROVAL_POLL_MS, APPROVAL_WATCH_MS, approvalPollDelay, useInlineTemplateCreation } from "./useInlineTemplateCreation";

const tpl = (status: string, extra: Partial<MetaTemplate> = {}): MetaTemplate => ({
  id: "t1",
  name: "aviso",
  language: "pt_BR",
  status,
  category: "UTILITY",
  components: [],
  ...extra,
});

// O hook não expõe handleSaved: dispara pelo onSaved do dialog renderizado.
function saveThrough(result: ReturnType<typeof renderHook<ReturnType<typeof useInlineTemplateCreation>, unknown>>["result"], status: string) {
  const dialog = result.current.dialog as { props: { onSaved: (s: { name: string; language: string; status: string; headerMedia: null }) => void } };
  act(() => dialog.props.onSaved({ name: "aviso", language: "pt_BR", status, headerMedia: null }));
}

describe("useInlineTemplateCreation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchOrgTemplates.mockReset();
    toast.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("espera a aprovação e entrega o template uma vez", async () => {
    const onApproved = vi.fn();
    const onSaved = vi.fn();
    fetchOrgTemplates.mockResolvedValueOnce([tpl("PENDING")]).mockResolvedValueOnce([tpl("APPROVED")]);
    const { result } = renderHook(() => useInlineTemplateCreation({ onApproved, onSaved }));

    saveThrough(result, "PENDING");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(result.current.notice).not.toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS));
    expect(onApproved).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS));
    expect(onApproved).toHaveBeenCalledWith(expect.objectContaining({ status: "APPROVED" }), { headerMedia: null });
    expect(fetchOrgTemplates).toHaveBeenCalledWith("org-1", "aviso");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Template aviso aprovado" }));
    expect(result.current.notice).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS * 3));
    expect(fetchOrgTemplates).toHaveBeenCalledTimes(2);
  });

  it("aprovado na hora busca o template sem esperar o timer", async () => {
    const onApproved = vi.fn();
    fetchOrgTemplates.mockResolvedValue([tpl("APPROVED")]);
    const { result } = renderHook(() => useInlineTemplateCreation({ onApproved }));
    saveThrough(result, "APPROVED");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it("recusa para de consultar", async () => {
    fetchOrgTemplates.mockResolvedValue([tpl("REJECTED", { rejected_reason: "PROMOTIONAL" })]);
    const { result } = renderHook(() => useInlineTemplateCreation({ onApproved: vi.fn() }));
    saveThrough(result, "PENDING");
    await act(() => vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS * 4));
    expect(fetchOrgTemplates).toHaveBeenCalledTimes(1);
    expect(result.current.notice).not.toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
  });

  it("espaça as voltas depois das primeiras", () => {
    expect([0, 3, 4, 9, 10].map(approvalPollDelay)).toEqual([5_000, 5_000, 15_000, 15_000, 30_000]);
  });

  it("erro de rede numa volta não encerra e o prazo vira aviso de tempo esgotado", async () => {
    fetchOrgTemplates.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([tpl("PENDING")]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useInlineTemplateCreation({ onApproved: vi.fn() }));
    saveThrough(result, "PENDING");
    await act(() => vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS * 2));
    expect(fetchOrgTemplates).toHaveBeenCalledTimes(2);
    // A volta que cruza o prazo ainda consulta uma vez; depois para.
    await act(() => vi.advanceTimersByTimeAsync(APPROVAL_WATCH_MS + 30_000));
    const calls = fetchOrgTemplates.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(fetchOrgTemplates.mock.calls.length).toBe(calls);
    expect(result.current.notice).not.toBeNull();
  });

  it("reset (troca de conversa) cancela a espera", async () => {
    const onApproved = vi.fn();
    fetchOrgTemplates.mockResolvedValue([tpl("APPROVED")]);
    const { result } = renderHook(() => useInlineTemplateCreation({ onApproved }));
    saveThrough(result, "PENDING");
    act(() => result.current.reset());
    await act(() => vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS * 3));
    expect(fetchOrgTemplates).not.toHaveBeenCalled();
    expect(onApproved).not.toHaveBeenCalled();
  });
});
