import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { corDoNumero } from "@/lib/caixaConjunta";
import { SeloNumero } from "./SeloNumero";

afterEach(cleanup);

// O jsdom normaliza hsl() para rgb(): a comparação é com a mesma conversão.
const normal = (cor: string) => {
  const el = document.createElement("div");
  el.style.backgroundColor = cor;
  return el.style.backgroundColor;
};
// O ponto é o único elemento estilizado do selo.
const corDoPonto = (hue: number | null, nome = "Suporte") => {
  const { container, unmount } = render(<SeloNumero nome={nome} hue={hue} />);
  const cor = container.querySelector<HTMLElement>("[style]")?.style.backgroundColor ?? "";
  unmount();
  return cor;
};

describe("SeloNumero", () => {
  it("mostra o nome do número, com o nome no title e no aria-label", () => {
    render(<SeloNumero nome="Vendas API" hue={200} />);
    const selo = screen.getByRole("img", { name: "Número: Vendas API" });
    expect(selo.getAttribute("title")).toBe("Vendas API");
    expect(selo.textContent).toContain("Vendas API");
  });

  it("pinta o ponto com o matiz do número", () => {
    // Matizes diferentes têm de sair cores diferentes na tela (um componente que ignorasse
    // o hue passaria com a mesma cor para os dois).
    expect(corDoPonto(120)).toBe(normal(corDoNumero(120)));
    expect(corDoPonto(200)).toBe(normal(corDoNumero(200)));
    expect(corDoPonto(120)).not.toBe(corDoPonto(200));
  });

  it("número sem matiz pinta o teal da marca", () => {
    expect(corDoPonto(null)).toBe(normal(corDoNumero(null)));
    expect(corDoPonto(null)).toBe(normal("hsl(176, 65%, 55%)"));
  });

  it("o selo não tem variante para coluna estreita: o ponto e o nome ficam sempre visíveis", () => {
    // Regra de produto: o selo nunca encolhe para só o ponto (nem com a inicial dentro).
    const { container } = render(<SeloNumero nome="Suporte" hue={240} />);
    expect(container.innerHTML).not.toContain("sidebar-narrow");
    expect(container.querySelectorAll("[style]")).toHaveLength(1);
    const selo = screen.getByRole("img", { name: "Número: Suporte" });
    expect(selo.textContent).toBe("Suporte");
  });

  it("o nome trunca dentro do selo (min-w-0 + truncate) quando não cabe", () => {
    render(<SeloNumero nome="Vendas Suporte Premium" hue={null} />);
    const selo = screen.getByRole("img", { name: /^Número:/ });
    expect(selo.className).toContain("min-w-0");
    expect(selo.querySelector(".truncate")?.textContent).toBe("Vendas Suporte Premium");
  });
});
