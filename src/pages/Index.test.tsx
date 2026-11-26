import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const getSession = vi.hoisted(() => vi.fn());
const consultarPrecisaSetup = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { getSession } } }));
vi.mock("@/lib/primeiroAcesso", () => ({ consultarPrecisaSetup }));

import Index from "./Index";

const Local = () => {
  const { pathname, search } = useLocation();
  return <span data-testid="local">{pathname + search}</span>;
};

const abrir = (url = "/") => {
  window.history.replaceState(null, "", url);
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="*" element={<Local />} />
      </Routes>
    </MemoryRouter>,
  );
};

const destino = async (esperado: string) => {
  await waitFor(() => expect(screen.getByTestId("local").textContent).toBe(esperado));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  consultarPrecisaSetup.mockResolvedValue(false);
  getSession.mockResolvedValue({ data: { session: null } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("Index: redirecionador da raiz", () => {
  it("instalação nova vai para /setup, sem nem olhar a sessão", async () => {
    consultarPrecisaSetup.mockResolvedValue(true);
    abrir();

    await destino("/setup");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("com sessão vai para /dashboard", async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: "t" } } });
    abrir();

    await destino("/dashboard");
  });

  it("sem sessão vai para /auth", async () => {
    abrir();

    await destino("/auth");
  });

  it("falha ao ler a sessão cai em /auth", async () => {
    getSession.mockRejectedValue(new Error("storage indisponível"));
    abrir();

    await destino("/auth");
  });

  it("enquanto consulta mostra um indicador de carregamento", () => {
    consultarPrecisaSetup.mockReturnValue(new Promise(() => {}));
    abrir();

    expect(screen.getByRole("status", { name: "Carregando" })).toBeTruthy();
  });

  it("link de nova senha na raiz vai para /auth mantendo o token, sem consultar nada", async () => {
    abrir("/?token_hash=a1b2c3d4e5f6a1b2c3d4e5f6&type=recovery");

    await destino("/auth?token_hash=a1b2c3d4e5f6a1b2c3d4e5f6&type=recovery");
    expect(consultarPrecisaSetup).not.toHaveBeenCalled();
  });
});
