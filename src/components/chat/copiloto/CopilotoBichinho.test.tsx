import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { CopilotoBichinho } from "./CopilotoBichinho";

afterEach(cleanup);

describe("CopilotoBichinho", () => {
  it("parado: SVG nas cores do tema, sem as cores-marca nem a cor padrão da biblioteca", () => {
    const { container } = render(<CopilotoBichinho animado={false} />);
    const html = container.innerHTML;
    expect(container.querySelector("svg path, svg rect")).toBeTruthy();
    expect(html).toContain("currentColor");
    expect(html).toContain("hsl(var(--background))");
    expect(html).not.toMatch(/#010203|#040506|#ff6a1a/i);
    expect(html).not.toContain("<title>");
  });

  it("animado: monta o avatar no host (no próximo quadro) e o desmonta junto com o componente", async () => {
    const { container, unmount, rerender } = render(
      <CopilotoBichinho humor="ocioso" />,
    );
    const raiz = container.querySelector('[data-humor="ocioso"]');
    expect(raiz?.getAttribute("aria-hidden")).toBe("true");
    const host = raiz?.firstElementChild as HTMLElement;
    await waitFor(() => expect(host.childElementCount).toBeGreaterThan(0));
    rerender(<CopilotoBichinho humor="lendo" />);
    expect(container.querySelector('[data-humor="lendo"]')).toBeTruthy();
    unmount();
    expect(host.childElementCount).toBe(0);
  });

  it("trocar de animado para parado mantém o SVG parado (o destroy do avatar não o apaga)", async () => {
    const { container, rerender } = render(<CopilotoBichinho humor="ocioso" />);
    const host = container.querySelector('[data-humor="ocioso"]')
      ?.firstElementChild as HTMLElement;
    await waitFor(() => expect(host.childElementCount).toBeGreaterThan(0));
    rerender(<CopilotoBichinho humor="ocioso" animado={false} />);
    expect(container.querySelector("[data-humor] > span > svg")).toBeTruthy();
  });
});
