// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

/**
 * Caixa conjunta: o número escolhido em "Enviar pelo número" decide tudo o que sai do
 * diálogo — a busca e a criação da conversa (`phone_number_id`), o id da Meta enviado e
 * o canal (texto livre no QR, template na API).
 */

afterEach(cleanup);

const h = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  buscas: [] as Array<{ coluna: string; valor: unknown }>,
  // Linhas para as quais o diálogo chamou conversa_do_telefone_na_linha.
  rpcs: [] as string[],
  toast: vi.fn(),
  // O que a RPC devolve (0 ou 1 linha).
  rpcResposta: [] as Array<{ conversation_id: string; visivel: boolean; dono: string | null }>,
  invocacoes: [] as Array<{ nome: string; body: Record<string, unknown> }>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const consulta = () => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.in = () => c;
    c.is = () => c;
    c.order = () => c;
    c.eq = (coluna: string, valor: unknown) => {
      h.buscas.push({ coluna, valor });
      return c;
    };
    c.limit = () => Promise.resolve({ data: [], error: null });
    c.maybeSingle = () => Promise.resolve({ data: null, error: null });
    c.insert = (linha: Record<string, unknown>) => {
      h.inserts.push(linha);
      const r: Record<string, unknown> = {};
      r.select = () => r;
      r.single = () => Promise.resolve({ data: { id: "conversa-nova" }, error: null });
      return r;
    };
    return c;
  };
  return {
    supabase: {
      from: () => consulta(),
      rpc: (_nome: string, args: { p_phone_number_id: string }) => {
        h.rpcs.push(args.p_phone_number_id);
        return Promise.resolve({ data: h.rpcResposta, error: null });
      },
      functions: {
        invoke: (nome: string, opcoes: { body: Record<string, unknown> }) => {
          h.invocacoes.push({ nome, body: opcoes.body });
          if (nome === "whatsapp-templates") {
            return Promise.resolve({
              data: {
                data: [{ name: "boas_vindas", language: "pt_BR", status: "APPROVED", components: [{ type: "BODY", text: "Olá, tudo bem?" }] }],
              },
              error: null,
            });
          }
          return Promise.resolve({ data: { success: true }, error: null });
        },
      },
    },
  };
});
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ currentOrganization: { id: "org-1", name: "Org" } }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/EmojiPicker", () => ({ default: () => null }));
vi.mock("@/components/chat/ImportConversationsDialog", () => ({ default: () => null }));
vi.mock("@/components/templates/TemplateMediaHeaderInput", () => ({ default: () => null }));
// O campo de telefone tem país, bandeira e máscara: aqui só interessa o valor composto.
vi.mock("@/components/phone/PhoneNumberInput", () => ({
  default: ({ onChange, id }: { onChange: (digits: string, check: { ok: boolean; phone: string; error: string | null }) => void; id?: string }) => (
    <input
      id={id}
      aria-label="telefone"
      onChange={(e) => onChange(e.target.value, { ok: e.target.value.length > 0, phone: e.target.value, error: null })}
    />
  ),
}));

const { default: StartConversationDialog } = await import("./StartConversationDialog");

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
const user = userEvent.setup({ pointerEventsCheck: 0 });
const CONV_EXISTENTE = "44444444-4444-4444-8444-444444444444";

const numeros = [
  { id: "n-api", displayName: "Vendas API", themeHue: 200, metaPhoneNumberId: "meta-api", connectionType: "business_api" },
  { id: "n-qr1", displayName: "Suporte", themeHue: 176, metaPhoneNumberId: "qr_1", connectionType: "qr" },
  { id: "n-qr2", displayName: "Comercial", themeHue: null, metaPhoneNumberId: "qr_2", connectionType: "qr" },
];

const montar = (preferido?: string | null) =>
  render(
    <StartConversationDialog
      open
      onOpenChange={vi.fn()}
      userId="user-1"
      numerosPossiveis={numeros}
      numeroPreferidoId={preferido}
    />,
  );

const enviarTexto = async () => {
  fireEvent.change(screen.getByLabelText("telefone"), { target: { value: "5511999998888" } });
  fireEvent.change(await screen.findByPlaceholderText("Digite sua mensagem…"), { target: { value: "Olá!" } });
  await user.click(screen.getByRole("button", { name: "Enviar" }));
  await waitFor(() => expect(h.invocacoes.some((i) => i.nome === "whatsapp-send")).toBe(true));
};

beforeEach(() => {
  h.inserts = [];
  h.buscas = [];
  h.rpcs = [];
  h.rpcResposta = [];
  h.toast.mockClear();
  h.invocacoes = [];
});

describe("StartConversationDialog: Enviar pelo número", () => {
  it("mostra o seletor com mais de um número, e o padrão é o número da conversa aberta", async () => {
    montar("n-qr2");
    expect(await screen.findByLabelText("Enviar pelo número")).toBeInTheDocument();
    expect(screen.getByLabelText("Enviar pelo número").textContent).toContain("Comercial");
  });

  it("sem preferido (ou fora das opções) o padrão é o primeiro", async () => {
    montar("fora-do-escopo");
    expect((await screen.findByLabelText("Enviar pelo número")).textContent).toContain("Vendas API");
  });

  it("o texto livre sai pelo número escolhido: busca, cria a conversa e envia por ele", async () => {
    montar("n-qr1");
    await enviarTexto();

    expect(h.rpcs).toEqual(["n-qr1"]);
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0].phone_number_id).toBe("n-qr1");
    const envio = h.invocacoes.find((i) => i.nome === "whatsapp-send");
    expect(envio?.body.phoneNumberId).toBe("qr_1");
  });

  it("trocar o número no seletor muda de onde a conversa sai", async () => {
    montar("n-qr1");
    await user.click(await screen.findByLabelText("Enviar pelo número"));
    await user.click(await screen.findByRole("option", { name: /Comercial/ }));
    await enviarTexto();

    expect(h.inserts[0].phone_number_id).toBe("n-qr2");
    expect(h.rpcs).toEqual(["n-qr2"]);
    expect(h.invocacoes.find((i) => i.nome === "whatsapp-send")?.body.phoneNumberId).toBe("qr_2");
  });

  it("número de API oficial pede template, e não mostra o campo de texto livre", async () => {
    montar("n-api");
    await screen.findByLabelText("Enviar pelo número");
    expect(screen.queryByPlaceholderText("Digite sua mensagem…")).toBeNull();
    // Trocar para um número QR vira texto livre.
    await user.click(screen.getByLabelText("Enviar pelo número"));
    await user.click(await screen.findByRole("option", { name: /Suporte/ }));
    expect(await screen.findByPlaceholderText("Digite sua mensagem…")).toBeInTheDocument();
  });

  it("número de API oficial envia o template pelo id da Meta dele", async () => {
    montar("n-api");
    await user.click(await screen.findByText("boas_vindas"));
    fireEvent.change(screen.getByLabelText("telefone"), { target: { value: "5511999998888" } });
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(h.invocacoes.some((i) => i.nome === "whatsapp-send-template")).toBe(true));

    expect(h.inserts[0].phone_number_id).toBe("n-api");
    expect(h.rpcs).toEqual(["n-api"]);
    expect(h.invocacoes.find((i) => i.nome === "whatsapp-send-template")?.body.phoneNumberId).toBe("meta-api");
  });

  it("texto livre, conversa já é de outra pessoa: avisa a dona, não cria nem envia e mantém o diálogo aberto", async () => {
    const onOpenChange = vi.fn();
    h.rpcResposta = [{ conversation_id: null, visivel: false, dono: "Ana" }];
    render(<StartConversationDialog open onOpenChange={onOpenChange} userId="user-1" numerosPossiveis={numeros} numeroPreferidoId="n-qr1" />);
    fireEvent.change(screen.getByLabelText("telefone"), { target: { value: "5511999998888" } });
    fireEvent.change(await screen.findByPlaceholderText("Digite sua mensagem…"), { target: { value: "Olá!" } });
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith({
        title: "Esta conversa já está com Ana",
        description: "Peça para quem está atendendo compartilhar ou transferir a conversa com você.",
        variant: "destructive",
      }),
    );
    expect(h.inserts).toHaveLength(0);
    expect(h.invocacoes.some((i) => i.nome === "whatsapp-send")).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("texto livre, conversa visível: usa o id da RPC e não insere", async () => {
    h.rpcResposta = [{ conversation_id: CONV_EXISTENTE, visivel: true, dono: null }];
    montar("n-qr1");
    await enviarTexto();

    expect(h.inserts).toHaveLength(0);
    expect(h.invocacoes.find((i) => i.nome === "whatsapp-send")?.body.conversationId).toBe(CONV_EXISTENTE);
  });

  it("template, conversa já é de outra pessoa sem dona conhecida: aviso genérico, nada é criado nem enviado", async () => {
    h.rpcResposta = [{ conversation_id: null, visivel: false, dono: null }];
    montar("n-api");
    await user.click(await screen.findByText("boas_vindas"));
    fireEvent.change(screen.getByLabelText("telefone"), { target: { value: "5511999998888" } });
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Esta conversa já está em atendimento", variant: "destructive" })),
    );
    expect(h.inserts).toHaveLength(0);
    expect(h.invocacoes.some((i) => i.nome === "whatsapp-send-template")).toBe(false);
  });

  it("com um número só não mostra o seletor", async () => {
    render(
      <StartConversationDialog open onOpenChange={vi.fn()} userId="user-1" numerosPossiveis={[numeros[1]]} />,
    );
    await screen.findByPlaceholderText("Digite sua mensagem…");
    expect(screen.queryByLabelText("Enviar pelo número")).toBeNull();
  });

  it("sem a lista de números vale o que o pai mandou (modo número)", async () => {
    render(
      <StartConversationDialog
        open
        onOpenChange={vi.fn()}
        userId="user-1"
        phoneNumberId="qr_9"
        phoneNumberDbId="n-9"
        isQrConnection
      />,
    );
    await enviarTexto();
    expect(h.inserts[0].phone_number_id).toBe("n-9");
    expect(h.invocacoes.find((i) => i.nome === "whatsapp-send")?.body.phoneNumberId).toBe("qr_9");
  });

  it("caixa conjunta sem número carregado: Enviar fica desabilitado e nada sai, mesmo com as props do fallback", async () => {
    // A lista ainda vazia não pode cair nas props do modo número (que aqui apontam para um QR).
    render(
      <StartConversationDialog
        open
        onOpenChange={vi.fn()}
        userId="user-1"
        numerosPossiveis={[]}
        phoneNumberId="qr_1"
        phoneNumberDbId="n-qr1"
        isQrConnection
      />,
    );
    fireEvent.change(screen.getByLabelText("telefone"), { target: { value: "5511999998888" } });
    // Sem número, o canal não é texto livre (o fallback QR não vale): não há campo de mensagem.
    expect(screen.queryByPlaceholderText("Digite sua mensagem…")).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    // Só a lista de templates pode ter sido buscada: nenhum envio, nenhuma conversa nova.
    expect(h.invocacoes.filter((i) => i.nome !== "whatsapp-templates")).toHaveLength(0);
    expect(h.inserts).toHaveLength(0);
  });
});
