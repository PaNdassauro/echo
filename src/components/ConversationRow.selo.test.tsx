import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationRow, type ConversationRowActions, type ConversationRowProps } from "./ConversationRow";

afterEach(cleanup);

const acao = () => vi.fn();
const actions: ConversationRowActions = {
  select: acao(),
  keyDown: acao(),
  addTag: acao(),
  removeTag: acao(),
  assignToMe: acao(),
  resolveAndAssign: acao(),
  swipeClose: acao(),
  swipeMarkRead: acao(),
  toggleUnread: acao(),
  exportConversation: acao(),
  transfer: acao(),
  togglePinned: acao(),
  toggleArchived: acao(),
  setMutedUntil: acao(),
};

const props = (extra: Partial<ConversationRowProps>): ConversationRowProps => ({
  conversation: {
    id: "c1",
    contact_name: "Maria Souza",
    contact_phone: "5511999999999",
    last_message_at: new Date().toISOString(),
    status: "active",
    assigned_to: null,
    phone_number_id: "n1",
  },
  isLast: false,
  isSelected: false,
  viewMode: "normal",
  isMobile: false,
  canClose: true,
  showAssignButton: false,
  emDisparos: false,
  seloDisparos: false,
  seloIa: false,
  sectorIsolationEnabled: false,
  sector: undefined,
  convTags: [],
  tagsForLine: [],
  unreadCount: 0,
  isMarkedUnread: false,
  failedCount: 0,
  hasDraft: false,
  isPinned: false,
  isArchived: false,
  isMuted: false,
  isAssigning: false,
  isExporting: false,
  actions,
  ...extra,
});

describe("ConversationRow: selo do número", () => {
  it.each(["normal", "compact"] as const)("mostra o selo na visão %s quando o número vem", (viewMode) => {
    render(<ConversationRow {...props({ viewMode, numeroNome: "Vendas API", numeroHue: 200 })} />);
    expect(screen.getByRole("img", { name: "Número: Vendas API" })).toBeTruthy();
  });

  it.each(["normal", "compact"] as const)("não renderiza nada fora da caixa conjunta (visão %s)", (viewMode) => {
    render(<ConversationRow {...props({ viewMode, numeroNome: null, numeroHue: null })} />);
    expect(screen.queryByRole("img", { name: /^Número:/ })).toBeNull();
  });

  it("sem as props (modo número) também não renderiza", () => {
    render(<ConversationRow {...props({})} />);
    expect(screen.queryByRole("img", { name: /^Número:/ })).toBeNull();
  });

  it("visão compacta sem selo (modo número): o horário não encolhe, como antes do selo existir", () => {
    const { container } = render(<ConversationRow {...props({ viewMode: "compact" })} />);
    const horario = container.querySelector("span.tabular-nums") as HTMLElement;
    expect(horario.parentElement?.className).toContain("shrink-0");
    expect(horario.parentElement?.className).not.toContain("max-w-[55%]");
  });

  it("visão compacta com selo: o bloco do horário tem teto, o horário cede (encolhe e trunca) e o selo leva piso e teto", () => {
    const { container } = render(<ConversationRow {...props({ viewMode: "compact", numeroNome: "Vendas Suporte", numeroHue: null })} />);
    const horario = container.querySelector("span.tabular-nums") as HTMLElement;
    expect(horario.parentElement?.className).toContain("max-w-[55%]");
    expect(horario.parentElement?.className).toContain("shrink-0");
    expect(horario.parentElement?.className).not.toContain("min-w-0");
    expect(horario.className).toContain("truncate");
    expect(horario.className).toContain("min-w-0");
    expect(horario.className).not.toMatch(/(^|\s)shrink-0(\s|$)/);
    const selo = screen.getByRole("img", { name: "Número: Vendas Suporte" });
    expect(selo.className).toContain("min-w-[calc(10ch+2.25rem)]");
    expect(selo.className).toContain("max-w-[18ch]");
    expect(selo.className).not.toContain("shrink-0");
    // Coluna estreita: o selo segue com ponto e nome (sem variante que o reduza); só perde o piso
    // para o nome truncar dentro da pílula em vez de a linha estourar.
    expect(selo.className).toContain("sidebar-narrow:min-w-0");
    expect(selo.className).not.toContain("sidebar-narrow:max-w-none");
    expect(selo.textContent).toContain("Vendas Suporte");
  });

  it("visão normal com selo, horário longo e Assumir: o horário cede (encolhe e trunca) e o selo mantém o nome e o piso", () => {
    const antigo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { container } = render(
      <ConversationRow
        {...props({
          viewMode: "normal",
          showAssignButton: true,
          numeroNome: "Vendas Suporte",
          numeroHue: 200,
          conversation: { ...props({}).conversation, last_message_at: antigo },
        })}
      />,
    );
    const selo = screen.getByRole("img", { name: "Número: Vendas Suporte" });
    // O nome inteiro está no DOM (truncado só por CSS) e o selo tem piso e teto de largura.
    expect(selo.textContent).toContain("Vendas Suporte");
    expect(selo.className).toContain("min-w-[calc(10ch+2.25rem)]");
    expect(selo.className).toContain("max-w-[18ch]");
    expect(selo.className).not.toContain("shrink-0");
    expect(screen.getByRole("button", { name: /assumir/i })).toBeTruthy();

    const horario = Array.from(container.querySelectorAll("p")).find((p) => /há/.test(p.textContent ?? "")) as HTMLElement;
    expect(horario.className).toContain("truncate");
    expect(horario.className).toContain("min-w-0");
    expect(horario.className).toContain("whitespace-nowrap");
    expect(horario.className).not.toMatch(/(^|\s)shrink-0(\s|$)/);
  });

  it.each(["normal", "compact"] as const)("visão %s com nome curto: o selo fica na largura natural, sem piso nem teto", (viewMode) => {
    render(<ConversationRow {...props({ viewMode, numeroNome: "Comercial", numeroHue: 200 })} />);
    const selo = screen.getByRole("img", { name: "Número: Comercial" });
    expect(selo.className).not.toContain("min-w-[calc(10ch+2.25rem)]");
    expect(selo.className).not.toContain("max-w-[18ch]");
    expect(selo.className).toMatch(/(^|\s)shrink-0(\s|$)/);
    // Coluna estreita: pode encolher e truncar o nome só se de fato não couber; nunca vira só o ponto.
    expect(selo.className).toContain("sidebar-narrow:shrink");
    expect(selo.className).toContain("sidebar-narrow:min-w-0");
  });

  it("visão compacta com selo, horário longo e nome de contato longo: o selo mantém o nome e o horário cede", () => {
    const antigo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const { container } = render(
      <ConversationRow
        {...props({
          viewMode: "compact",
          numeroNome: "Vendas Suporte",
          numeroHue: 200,
          conversation: { ...props({}).conversation, contact_name: "Maria Fernanda de Albuquerque Souza Pimentel", last_message_at: antigo },
        })}
      />,
    );
    const selo = screen.getByRole("img", { name: "Número: Vendas Suporte" });
    expect(selo.textContent).toContain("Vendas Suporte");
    expect(selo.className).toContain("min-w-[calc(10ch+2.25rem)]");
    const horario = container.querySelector("span.tabular-nums") as HTMLElement;
    expect(horario.textContent).toMatch(/3 horas/);
    expect(horario.className).toContain("truncate");
    expect(horario.className).toContain("min-w-0");
    // O nome do contato é o que absorve a falta de espaço: já era min-w-0 e trunca.
    const nome = screen.getByTitle("Maria Fernanda de Albuquerque Souza Pimentel");
    expect(nome.className).toContain("truncate");
    expect(nome.parentElement?.className).toContain("min-w-0");
  });

  it("visão normal sem selo (modo número): o horário não encolhe, como antes", () => {
    const { container } = render(<ConversationRow {...props({ viewMode: "normal" })} />);
    const horario = Array.from(container.querySelectorAll("p")).find((p) => /há/.test(p.textContent ?? "")) as HTMLElement;
    expect(horario.className).toMatch(/(^|\s)shrink-0(\s|$)/);
    expect(horario.className).not.toContain("whitespace-nowrap");
  });

  it("na visão normal o selo fica depois do horário, e na compacta, antes", () => {
    const normal = render(<ConversationRow {...props({ viewMode: "normal", numeroNome: "Suporte", numeroHue: null })} />);
    const textoNormal = normal.container.textContent ?? "";
    expect(textoNormal.indexOf("há")).toBeLessThan(textoNormal.indexOf("Suporte"));
    cleanup();

    const compacta = render(<ConversationRow {...props({ viewMode: "compact", numeroNome: "Suporte", numeroHue: null })} />);
    const selo = compacta.container.querySelector('[aria-label="Número: Suporte"]');
    const horario = compacta.container.querySelector("span.tabular-nums");
    expect(selo).toBeTruthy();
    expect(horario).toBeTruthy();
    // DOCUMENT_POSITION_FOLLOWING (4): o horário vem depois do selo.
    expect((selo as Node).compareDocumentPosition(horario as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
