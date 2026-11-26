import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const consultas = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  single: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => {
  const cadeia = (tabela: string) => {
    const resultado = { data: [], error: null };
    const c: Record<string, unknown> = {};
    for (const metodo of ["select", "eq", "order"]) c[metodo] = () => c;
    c.maybeSingle = () => {
      consultas.maybeSingle(tabela);
      return Promise.resolve({ data: null, error: null });
    };
    c.single = () => {
      consultas.single(tabela);
      return Promise.resolve({ data: null, error: { code: "PGRST116" } });
    };
    c.then = (ok: (valor: typeof resultado) => unknown) => Promise.resolve(resultado).then(ok);
    return c;
  };
  return { supabase: { from: cadeia } };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import ApiKeysSettings from "./ApiKeysSettings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ApiKeysSettings", () => {
  it("lê o webhook com maybeSingle: organização sem webhook não gera erro 406", async () => {
    render(<ApiKeysSettings userId="u1" organizationId="org-1" />);
    await waitFor(() => expect(consultas.maybeSingle).toHaveBeenCalledWith("organization_webhooks"));
    expect(consultas.single).not.toHaveBeenCalled();
    expect(screen.queryByText(/erro/i)).toBeNull();
  });
});
