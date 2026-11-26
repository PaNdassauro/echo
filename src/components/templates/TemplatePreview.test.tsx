import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderInline } from "./TemplatePreview";

afterEach(cleanup);

const html = (text: string) => render(<p>{renderInline(text)}</p>).container.innerHTML;

describe("renderInline", () => {
  it("formata como o WhatsApp", () => {
    expect(html("Olá *Maria*, _até_ ~já~")).toBe("<p>Olá <strong>Maria</strong>, <em>até</em> <s>já</s></p>");
  });

  it("não formata dentro de palavra nem com espaço colado", () => {
    expect(html("site.com/minha_reserva_vip")).toBe("<p>site.com/minha_reserva_vip</p>");
    expect(html("R$ 2 * 3 * 4")).toBe("<p>R$ 2 * 3 * 4</p>");
  });
});

describe("renderInline colado", () => {
  it("formata marcadores encostados", () => {
    expect(html("*a*_b_")).toBe("<p><strong>a</strong><em>b</em></p>");
  });
});
