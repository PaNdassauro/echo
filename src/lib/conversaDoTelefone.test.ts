import { afterEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { avisoConversaDeOutra, buscarConversaDoTelefone } from "./conversaDoTelefone";

const LINHA = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  rpc.mockReset();
  vi.restoreAllMocks();
});

describe("buscarConversaDoTelefone", () => {
  it("chama a RPC com linha e telefone", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await buscarConversaDoTelefone(LINHA, "5511999998888");
    expect(rpc).toHaveBeenCalledWith("conversa_do_telefone_na_linha", {
      p_phone_number_id: LINHA,
      p_telefone: "5511999998888",
    });
  });

  it("visível: devolve o id", async () => {
    rpc.mockResolvedValue({ data: [{ conversation_id: CONV, visivel: true, dono: "Ana" }], error: null });
    await expect(buscarConversaDoTelefone(LINHA, "5511999998888")).resolves.toEqual({ tipo: "visivel", id: CONV });
  });

  it("não visível: devolve a dona", async () => {
    rpc.mockResolvedValue({ data: [{ conversation_id: null, visivel: false, dono: "Ana" }], error: null });
    await expect(buscarConversaDoTelefone(LINHA, "5511999998888")).resolves.toEqual({ tipo: "de_outra", dono: "Ana" });
  });

  it("não visível e sem dona conhecida: dono nulo", async () => {
    rpc.mockResolvedValue({ data: [{ conversation_id: null, visivel: false, dono: null }], error: null });
    await expect(buscarConversaDoTelefone(LINHA, "5511999998888")).resolves.toEqual({ tipo: "de_outra", dono: null });
  });

  it("0 linhas: nenhuma", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(buscarConversaDoTelefone(LINHA, "5511999998888")).resolves.toEqual({ tipo: "nenhuma" });
  });

  it("resposta fora do contrato lança", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({ data: [{ conversation_id: "x", visivel: "sim" }], error: null });
    await expect(buscarConversaDoTelefone(LINHA, "5511999998888")).rejects.toThrow();
  });

  it("visível sem id é resposta fora do contrato e lança", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({ data: [{ conversation_id: null, visivel: true, dono: "Ana" }], error: null });
    await expect(buscarConversaDoTelefone(LINHA, "5511999998888")).rejects.toThrow();
  });

  it("erro da RPC lança o erro", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const erro = { message: "boom", code: "42501" };
    rpc.mockResolvedValue({ data: null, error: erro });
    await expect(buscarConversaDoTelefone(LINHA, "5511999998888")).rejects.toBe(erro);
  });
});

describe("avisoConversaDeOutra", () => {
  it("com dona", () => {
    expect(avisoConversaDeOutra("Ana")).toEqual({
      title: "Esta conversa já está com Ana",
      description: "Peça para quem está atendendo compartilhar ou transferir a conversa com você.",
    });
  });
  it("sem dona", () => {
    expect(avisoConversaDeOutra(null).title).toBe("Esta conversa já está em atendimento");
  });
});
