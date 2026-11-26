// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

/** Caixa conjunta: o grupo nasce no número escolhido em "Enviar pelo número" (só números QR). */

afterEach(cleanup);

const h = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  chamadas: [] as string[],
  corpos: [] as Array<{ participants?: string[] }>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      insert: (linha: Record<string, unknown>) => {
        h.inserts.push(linha);
        const r: Record<string, unknown> = {};
        r.select = () => r;
        r.single = () => Promise.resolve({ data: { id: "conversa-do-grupo" }, error: null });
        return r;
      },
    }),
  },
}));
vi.mock("@/lib/qrService", () => ({
  qrFetch: (caminho: string, init?: { body?: unknown }) => {
    h.chamadas.push(caminho);
    if (typeof init?.body === "string") h.corpos.push(JSON.parse(init.body));
    return Promise.resolve({ json: () => Promise.resolve({ success: true, groupJid: "123@g.us" }) });
  },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/EmojiPicker", () => ({ default: () => null }));
// Um contato do número antigo, para ter participante escolhido antes de trocar o número.
vi.mock("@/components/contacts/ContactSelectList", () => ({
  default: ({ onSelect }: { onSelect: (c: { phone: string; name: string }) => void }) => (
    <button onClick={() => onSelect({ phone: "5511999990000", name: "Contato do número antigo" })}>incluir contato</button>
  ),
}));
vi.mock("@/components/contacts/OwnLinesSelectList", () => ({ default: () => null }));
vi.mock("@/components/phone/PhoneNumberInput", () => ({ default: () => null }));

const { default: CreateGroupDialog } = await import("./CreateGroupDialog");

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
const user = userEvent.setup({ pointerEventsCheck: 0 });

const numeros = [
  { id: "n-qr1", displayName: "Suporte", themeHue: 176 },
  { id: "n-qr2", displayName: "Comercial", themeHue: null },
];

beforeEach(() => {
  h.inserts = [];
  h.chamadas = [];
  h.corpos = [];
});

const criar = async () => {
  fireEvent.change(screen.getByPlaceholderText("Digite o nome do grupo"), { target: { value: "Grupo Silva" } });
  await user.click(screen.getByRole("button", { name: /Criar só comigo/ }));
  await waitFor(() => expect(h.inserts).toHaveLength(1));
};

describe("CreateGroupDialog: Enviar pelo número", () => {
  it("cria o grupo no número preferido (o da conversa aberta)", async () => {
    render(<CreateGroupDialog open onOpenChange={vi.fn()} numerosPossiveis={numeros} numeroPreferidoId="n-qr2" />);
    expect(screen.getByLabelText("Enviar pelo número").textContent).toContain("Comercial");
    await criar();

    expect(h.chamadas[0]).toBe("/groups/n-qr2/create");
    expect(h.inserts[0].phone_number_id).toBe("n-qr2");
  });

  it("trocar o número muda onde o grupo é criado e a conversa gravada", async () => {
    render(<CreateGroupDialog open onOpenChange={vi.fn()} numerosPossiveis={numeros} numeroPreferidoId="n-qr2" />);
    await user.click(screen.getByLabelText("Enviar pelo número"));
    await user.click(await screen.findByRole("option", { name: /Suporte/ }));
    await criar();

    expect(h.chamadas[0]).toBe("/groups/n-qr1/create");
    expect(h.inserts[0].phone_number_id).toBe("n-qr1");
  });

  it("trocar o número zera os participantes escolhidos no anterior", async () => {
    render(<CreateGroupDialog open onOpenChange={vi.fn()} numerosPossiveis={numeros} numeroPreferidoId="n-qr2" />);
    await user.click(screen.getByRole("button", { name: "incluir contato" }));
    expect(screen.getByRole("button", { name: /Criar Grupo/ })).toBeInTheDocument();

    await user.click(screen.getByLabelText("Enviar pelo número"));
    await user.click(await screen.findByRole("option", { name: /Suporte/ }));
    await criar();

    expect(h.chamadas[0]).toBe("/groups/n-qr1/create");
    expect(h.corpos[0].participants).toEqual([]);
  });

  it("sem preferido o padrão é o primeiro número", async () => {
    render(<CreateGroupDialog open onOpenChange={vi.fn()} numerosPossiveis={numeros} />);
    await criar();
    expect(h.inserts[0].phone_number_id).toBe("n-qr1");
  });

  it("com um número só (modo número) não mostra o seletor e usa o phoneNumberId", async () => {
    render(<CreateGroupDialog open onOpenChange={vi.fn()} phoneNumberId="n-qr9" />);
    expect(screen.queryByLabelText("Enviar pelo número")).toBeNull();
    await criar();
    expect(h.chamadas[0]).toBe("/groups/n-qr9/create");
    expect(h.inserts[0].phone_number_id).toBe("n-qr9");
  });
});
