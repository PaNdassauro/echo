// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/** Busca global: o resultado diz em qual número a mensagem foi achada, em qualquer modo. */

afterEach(cleanup);

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const resultado = (id: string, numero: string, contato: string) => ({
  id,
  content: "Olá, tudo bem?",
  created_at: new Date().toISOString(),
  direction: "inbound",
  message_type: "text",
  conversation_id: `conv-${id}`,
  contact_name: contato,
  contact_phone: "5511999990000",
  is_group: false,
  phone_number_id: numero,
});

vi.mock("@/hooks/useGlobalSearch", () => ({
  useGlobalSearch: () => ({
    searchTerm: "olá",
    setSearchTerm: () => undefined,
    results: [resultado("m1", A, "Maria"), resultado("m2", B, "João")],
    isLoading: false,
    error: null,
    retry: () => undefined,
    filters: { messageTypes: [], direction: "all", dateRange: { from: null, to: null }, hasMedia: null },
    updateFilters: () => undefined,
    resetFilters: () => undefined,
    hasActiveFilters: false,
    activeFilterCount: 0,
    clear: () => undefined,
  }),
}));

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

const { GlobalSearchDialog } = await import("./GlobalSearchDialog");

const numeros = new Map([
  [A, { nome: "Comercial", hue: 200 }],
  [B, { nome: "Suporte", hue: null }],
]);

describe("GlobalSearchDialog: selo do número", () => {
  it("na conjunta cada resultado leva o selo do número em que foi achado", () => {
    render(<GlobalSearchDialog open onOpenChange={() => undefined} onSelectResult={() => undefined} phoneNumberIds={[A, B]} numerosPorId={numeros} />);
    expect(screen.getByRole("img", { name: "Número: Comercial" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Número: Suporte" })).toBeTruthy();
  });

  it("no modo número (um só número) o resultado também leva o selo", () => {
    render(<GlobalSearchDialog open onOpenChange={() => undefined} onSelectResult={() => undefined} phoneNumberIds={[A]} numerosPorId={numeros} />);
    expect(screen.getByRole("img", { name: "Número: Comercial" })).toBeTruthy();
  });

  it("sem o mapa de números nenhum selo", () => {
    render(<GlobalSearchDialog open onOpenChange={() => undefined} onSelectResult={() => undefined} phoneNumberIds={[A]} />);
    expect(screen.getByText("Maria")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /^Número:/ })).toBeNull();
  });

  it("o selo e o horário trocam para a cor do item destacado (o cmdk marca data-selected no item, e o fundo vira o accent)", () => {
    render(<GlobalSearchDialog open onOpenChange={() => undefined} onSelectResult={() => undefined} phoneNumberIds={[A, B]} numerosPorId={numeros} />);
    const selo = screen.getByRole("img", { name: "Número: Comercial" });
    expect(selo.className).toContain("group-data-[selected=true]:text-accent-foreground");
    expect(selo.className).toContain("group-data-[selected=true]:border-accent-foreground/40");
    // A base segue com a cor discreta: a variante só vale no item destacado.
    expect(selo.className).toContain("text-muted-foreground");
    const item = selo.closest("[cmdk-item]");
    expect(item?.className).toMatch(/(^|\s)group(\s|$)/);
    const horario = item?.querySelector("span.tabular-nums");
    expect(horario?.className).toContain("group-data-[selected=true]:text-accent-foreground");
  });
});
