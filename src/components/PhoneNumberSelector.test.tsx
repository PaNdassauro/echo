// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

/**
 * O seletor só exibe e deixa escolher: quem restaura, valida e troca a seleção é
 * o Dashboard. O `onSelect` no mount (para "sincronizar metadados" ou escolher o
 * primeiro número) era a corrida que fechava a conversa aberta por deep link,
 * porque escolher um número limpa a conversa.
 */

// O projeto não roda vitest com `globals`: sem isto o DOM de um teste sobra no
// seguinte.
afterEach(cleanup);

const h = vi.hoisted(() => ({
  telefones: [] as unknown[],
  consultas: 0,
}));

vi.mock("@/integrations/supabase/client", () => {
  const canal = () => {
    const c: Record<string, unknown> = {};
    c.on = () => c;
    c.subscribe = () => c;
    return c;
  };
  return {
    supabase: {
      from: () => {
        h.consultas += 1;
        const resultado = Promise.resolve({ data: h.telefones, error: null });
        const c: Record<string, unknown> = {};
        c.select = () => c;
        c.eq = () => c;
        c.order = () => resultado;
        return c;
      },
      channel: canal,
      removeChannel: () => undefined,
    },
  };
});
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ currentOrganization: { id: "org-1", name: "Org" } }),
}));
vi.mock("@/hooks/useInstagramConexoes", () => ({ useInstagramConexoes: () => ({ data: [] }) }));
// Sessão QR sem resposta: o selo de conexão não é o assunto aqui.
vi.mock("@/lib/qrService", () => ({ qrFetch: () => Promise.resolve({ ok: false }) }));

const { default: PhoneNumberSelector } = await import("./PhoneNumberSelector");

// O Select do Radix usa Pointer Capture e scrollIntoView, que o jsdom não
// implementa.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const user = userEvent.setup({ pointerEventsCheck: 0 });

const telefone = (id: string, nome: string, connection_type: string) => ({
  id,
  phone_number_id: `meta-${id}`,
  display_name: nome,
  phone_number: "5511",
  is_active: true,
  theme_hue: 176,
  connection_type,
  phone_number_sessions: [],
});

beforeEach(() => {
  h.consultas = 0;
  h.telefones = [telefone("p1", "Comercial", "business_api"), telefone("p2", "Suporte", "qr")];
});

describe("PhoneNumberSelector", () => {
  it.each([
    ["número restaurado que ainda vale", "p1"],
    ["sem número selecionado", null],
    ["número selecionado que não existe mais", "removido"],
  ])("não chama onSelect ao carregar a lista: %s", async (_caso, selecionado) => {
    const onSelect = vi.fn();
    render(<PhoneNumberSelector selectedPhoneNumberId={selecionado} onSelect={onSelect} />);

    // Espera a lista chegar: com ela o seletor deixa de ser o aviso "Nenhum número".
    await waitFor(() => expect(screen.queryByText("Nenhum número")).toBeNull());
    await waitFor(() => expect(h.consultas).toBeGreaterThan(0));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("org sem número mostra o aviso e também não chama onSelect, mesmo com seleção velha", async () => {
    h.telefones = [];
    const onSelect = vi.fn();
    render(<PhoneNumberSelector selectedPhoneNumberId="p1" onSelect={onSelect} />);

    await waitFor(() => expect(h.consultas).toBeGreaterThan(0));
    expect(screen.getByText("Nenhum número")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("escolher um número chama onSelect só com o id dele", async () => {
    const onSelect = vi.fn();
    render(<PhoneNumberSelector selectedPhoneNumberId="p1" onSelect={onSelect} />);

    await user.click(await screen.findByRole("combobox"));
    await user.click(await screen.findByText("Suporte"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("p2");
  });
});

describe("PhoneNumberSelector: caixa conjunta", () => {
  it("com 2 ou mais números o primeiro item é a Caixa conjunta, e escolhê-lo NÃO chama onSelect com o sentinela", async () => {
    const onSelect = vi.fn();
    const onSelecionarConjunta = vi.fn();
    render(
      <PhoneNumberSelector
        selectedPhoneNumberId="p1"
        onSelect={onSelect}
        onSelecionarConjunta={onSelecionarConjunta}
        numerosDaConjunta={["p1", "p2"]}
      />,
    );

    await user.click(await screen.findByRole("combobox"));
    const opcoes = await screen.findAllByRole("option");
    expect(opcoes[0].textContent).toContain("Caixa conjunta");
    expect(opcoes[0].textContent).toContain("2 números");

    await user.click(opcoes[0]);
    expect(onSelecionarConjunta).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("o item da conjunta acompanha o fundo quando destacado: contagem e anel dos pontos têm variante de foco", async () => {
    render(
      <PhoneNumberSelector
        selectedPhoneNumberId="p1"
        onSelect={vi.fn()}
        onSelecionarConjunta={vi.fn()}
        numerosDaConjunta={["p1", "p2"]}
      />,
    );
    await user.click(await screen.findByRole("combobox"));
    const item = (await screen.findAllByRole("option"))[0];
    expect(item.className).toMatch(/(^|\s)group(\s|$)/);
    expect(item.querySelector(".group-focus\\:text-accent-foreground")?.textContent).toContain("2 números");
    const pontos = item.querySelectorAll(".group-focus\\:ring-accent");
    expect(pontos.length).toBeGreaterThan(0);
  });

  it("sem números para juntar (lista vazia) o item não diz '0 números'", async () => {
    render(
      <PhoneNumberSelector
        selectedPhoneNumberId="p1"
        onSelect={vi.fn()}
        onSelecionarConjunta={vi.fn()}
        numerosDaConjunta={[]}
      />,
    );
    await user.click(await screen.findByRole("combobox"));
    const item = (await screen.findAllByRole("option"))[0];
    expect(item.textContent).toContain("Caixa conjunta");
    expect(item.textContent).not.toContain("número");
    expect(item.querySelectorAll(".group-focus\\:ring-accent").length).toBe(0);
  });

  it("sem numerosDaConjunta (mapa ainda não chegou) usa os números do próprio seletor", async () => {
    render(
      <PhoneNumberSelector
        selectedPhoneNumberId="p1"
        onSelect={vi.fn()}
        onSelecionarConjunta={vi.fn()}
      />,
    );
    await user.click(await screen.findByRole("combobox"));
    const item = (await screen.findAllByRole("option"))[0];
    expect(item.textContent).toContain("2 números");
  });

  it("sem onSelecionarConjunta o item não aparece", async () => {
    render(<PhoneNumberSelector selectedPhoneNumberId="p1" onSelect={vi.fn()} />);
    await user.click(await screen.findByRole("combobox"));
    await screen.findAllByRole("option");
    expect(screen.queryByText("Caixa conjunta")).toBeNull();
  });

  it("com 1 número só o item não aparece", async () => {
    h.telefones = [telefone("p1", "Comercial", "business_api")];
    render(<PhoneNumberSelector selectedPhoneNumberId="p1" onSelect={vi.fn()} onSelecionarConjunta={vi.fn()} />);
    await user.click(await screen.findByRole("combobox"));
    await screen.findAllByRole("option");
    expect(screen.queryByText("Caixa conjunta")).toBeNull();
  });

  it("na conjunta o gatilho mostra Caixa conjunta, tem o botão Escolher números e some o selo de conexão", async () => {
    const onEscolherNumeros = vi.fn();
    render(
      <PhoneNumberSelector
        selectedPhoneNumberId="p2"
        onSelect={vi.fn()}
        conjunta
        onSelecionarConjunta={vi.fn()}
        onEscolherNumeros={onEscolherNumeros}
      />,
    );

    const gatilho = await screen.findByRole("combobox");
    expect(gatilho.textContent).toContain("Caixa conjunta");
    expect(gatilho.textContent).not.toContain("Suporte");
    expect(screen.queryByTitle("WhatsApp desconectado")).toBeNull();
    expect(screen.queryByTitle("WhatsApp conectado")).toBeNull();

    const botao = screen.getByRole("button", { name: "Escolher números" });
    // Dentro do cabeçalho do preset whatsapp (texto branco) o ícone só aparece com a classe dos botões da barra.
    expect(botao.className).toContain("theme-sidebar-action-button");
    await user.click(botao);
    expect(onEscolherNumeros).toHaveBeenCalledTimes(1);
  });

  it("no modo número não há botão Escolher números e escolher um número chama onSelect", async () => {
    const onSelect = vi.fn();
    render(
      <PhoneNumberSelector
        selectedPhoneNumberId="p1"
        onSelect={onSelect}
        onSelecionarConjunta={vi.fn()}
        onEscolherNumeros={vi.fn()}
      />,
    );
    await screen.findByRole("combobox");
    expect(screen.queryByRole("button", { name: "Escolher números" })).toBeNull();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByText("Suporte"));
    expect(onSelect).toHaveBeenCalledWith("p2");
  });

  it("na conjunta, escolher um número chama onSelect (sai da conjunta)", async () => {
    const onSelect = vi.fn();
    render(
      <PhoneNumberSelector
        selectedPhoneNumberId="p1"
        onSelect={onSelect}
        conjunta
        onSelecionarConjunta={vi.fn()}
      />,
    );
    await user.click(await screen.findByRole("combobox"));
    await user.click(await screen.findByText("Comercial"));
    expect(onSelect).toHaveBeenCalledWith("p1");
  });
});
