import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { InstagramConexao } from "@/lib/instagramConexoes";

const estado = vi.hoisted(() => ({
  conexoes: [] as InstagramConexao[],
  role: "admin" as "admin" | "agent",
  configurar: vi.fn(),
  iniciar: vi.fn(),
  toast: vi.fn(),
  refetch: vi.fn(),
  erro: null as Error | null,
  abrindo: null as string | null,
}));

vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ currentOrganization: { id: ORG }, isSuperAdmin: false, userRole: estado.role }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: estado.toast }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () =>
            Promise.resolve({
              data: [
                { id: LINHA, display_name: "Vendas API", connection_type: "business_api" },
                { id: TESTE, display_name: "Suporte", connection_type: "qr" },
                { id: "ffffffff-0000-4000-8000-000000000000", display_name: "Velha", connection_type: "twilio" },
              ],
              error: null,
            }),
        }),
      }),
    }),
  },
}));
vi.mock("@/hooks/useInstagramConexoes", () => ({
  useInstagramConexoes: () => ({
    data: estado.erro ? undefined : estado.conexoes,
    isLoading: false,
    error: estado.erro,
    refetch: estado.refetch,
    isFetching: false,
  }),
  useConfigurarInstagram: () => ({ mutate: estado.configurar, isPending: false, variables: undefined }),
  useDesconectarInstagram: () => ({ mutate: vi.fn(), isPending: false }),
  useIniciarConexaoInstagram: () => ({ mutate: estado.iniciar, isPending: estado.abrindo !== null, variables: estado.abrindo }),
}));

const ORG = "00000000-0000-4000-8000-000000000001";
const LINHA = "00000000-0000-4000-8000-000000000002";
const TESTE = "00000000-0000-4000-8000-000000000003";

import InstagramConnections from "./InstagramConnections";

const conexao = (extra: Partial<InstagramConexao> = {}): InstagramConexao => ({
  id: "0f0e0d0c-0b0a-4908-8706-050403020100",
  organization_id: ORG,
  display_name: "@acme",
  ig_user_id: "178",
  ig_username: "acme",
  status: "connected",
  last_error: null,
  token_expires_at: "2099-01-01T00:00:00Z",
  connected_at: "2026-09-28T18:32:01Z",
  ligada: false,
  modo: "off",
  linha_id: LINHA,
  linha_nome: "Vendas API",
  linha_tipo: "business_api",
  conversas_so_direct: 1,
  cards_juntados: 0,
  pode_gerenciar: true,
  ...extra,
});

const montar = (url = "/settings?tab=appearance") =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <InstagramConnections />
    </MemoryRouter>,
  );

beforeEach(() => {
  estado.conexoes = [conexao()];
  estado.role = "admin";
  estado.configurar.mockReset();
  estado.iniciar.mockReset();
  estado.toast.mockReset();
  estado.refetch.mockReset();
  estado.erro = null;
  estado.abrindo = null;
});
afterEach(cleanup);

describe("aba Instagram", () => {
  it("cada conta é uma linha que diz com qual linha divide a caixa", () => {
    montar();
    expect(screen.getByText("@acme")).toBeTruthy();
    expect(screen.getByText("Vendas API")).toBeTruthy();
    expect(screen.getByText(/Divide a caixa com/)).toBeTruthy();
    expect(screen.getByText("Desligada")).toBeTruthy();
  });

  it("ligar chama a RPC com ligada = true", () => {
    montar();
    fireEvent.click(screen.getByRole("switch", { name: "Ligada" }));
    expect(estado.configurar).toHaveBeenCalledWith({ id: conexao().id, ligada: true }, expect.anything());
  });

  it("não-admin não conecta nem liga", () => {
    estado.role = "agent";
    estado.conexoes = [conexao({ pode_gerenciar: false })];
    montar();
    expect(screen.queryByRole("button", { name: /Conectar conta/ })).toBeNull();
    expect((screen.getByRole("switch", { name: "Ligada" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("conexão sem acesso válido não liga e oferece reconectar", () => {
    estado.conexoes = [conexao({ status: "disconnected" })];
    montar();
    expect((screen.getByRole("switch", { name: "Ligada" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reconectar" }));
    expect(estado.iniciar).toHaveBeenCalledWith(LINHA, expect.anything());
  });

  it("volta do login vira aviso", () => {
    montar("/settings?tab=appearance&instagram=ok&conta=acme");
    expect(estado.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Instagram conectado" }));
  });

  it("sem conta: mostra o vazio e o botão de conectar", () => {
    estado.conexoes = [];
    montar();
    expect(screen.getByText("Nenhuma conta do Instagram conectada")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Conectar conta/ })).toBeTruthy();
  });

  it("erro ao carregar oferece tentar de novo", () => {
    estado.erro = new Error("x");
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(estado.refetch).toHaveBeenCalled();
  });

  it("erro da conexão aparece como instrução, com o detalhe técnico guardado", () => {
    estado.conexoes = [conexao({ last_error: "renovação do token: código 190; reconecte a conta antes de 2026-11-27" })];
    montar();
    expect(screen.getByText("O Echo não conseguiu renovar o acesso ao Instagram. Reconecte a conta até 27/11/2026.")).toBeTruthy();
    expect(screen.getByText("Ver detalhe técnico")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconectar" })).toBeTruthy();
  });

  it("reconectar mostra que está abrindo o Instagram", () => {
    estado.conexoes = [conexao({ status: "disconnected" })];
    estado.abrindo = LINHA;
    montar();
    expect(screen.getByRole("button", { name: "Abrindo o Instagram…" })).toBeTruthy();
  });

  it("conectar: com linha livre mostra a escolha; com todas ocupadas, explica", async () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: /Conectar conta/ }));
    // Suporte (QR) está livre: nada de "todas ocupadas", nem enquanto carrega.
    expect(screen.queryByText(/Todas as linhas QR Code e Business API/)).toBeNull();
    expect(await screen.findByText("Divide a caixa com", { selector: "label" })).toBeTruthy();
    cleanup();

    estado.conexoes = [conexao(), conexao({ id: "1f0e0d0c-0b0a-4908-8706-050403020100", linha_id: TESTE, linha_nome: "Suporte" })];
    montar();
    fireEvent.click(screen.getByRole("button", { name: /Conectar conta/ }));
    expect(await screen.findByText(/Todas as linhas QR Code e Business API/)).toBeTruthy();
  });
});
