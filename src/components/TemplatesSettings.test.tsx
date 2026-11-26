import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ fetchOrgTemplates: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());

vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ currentOrganization: { id: "org-1" }, isLoading: false, userRole: "admin" }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/components/templates/TemplateBuilderDialog", () => ({ default: () => null }));
vi.mock("@/lib/templatesApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/templatesApi")>()),
  fetchOrgTemplates: api.fetchOrgTemplates,
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));

import TemplatesSettings from "./TemplatesSettings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TemplatesSettings", () => {
  it("sem Cloud API conectada mostra o estado vazio, sem toast de erro", async () => {
    api.fetchOrgTemplates.mockRejectedValue(new Error("WhatsApp não configurado. Verifique as configurações."));
    render(<TemplatesSettings />);
    expect(await screen.findByText("A Cloud API do WhatsApp não está conectada.")).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();
  });

  it("outra falha ao listar continua avisando com toast", async () => {
    api.fetchOrgTemplates.mockRejectedValue(new Error("Meta API error: token inválido"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<TemplatesSettings />);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })));
    expect(screen.queryByText("A Cloud API do WhatsApp não está conectada.")).toBeNull();
  });

  it("com Cloud API e sem templates oferece criar o primeiro", async () => {
    api.fetchOrgTemplates.mockResolvedValue([]);
    render(<TemplatesSettings />);
    expect(await screen.findByText("Nenhum template ainda.")).toBeTruthy();
  });
});
