import { describe, expect, it } from "vitest";
import { parseLocationMessage, locationMapsUrl, parseCoordinateInput } from "./locationMessage";

describe("parseLocationMessage", () => {
  it("prefere metadata.location estruturado", () => {
    const loc = parseLocationMessage("[Localização: 0, 0]", {
      location: { lat: -23.55, lng: -46.63, name: "Praça da Sé", address: "Centro, SP" },
    });
    expect(loc).toEqual({
      lat: -23.55,
      lng: -46.63,
      name: "Praça da Sé",
      address: "Centro, SP",
      live: false,
    });
  });

  it("marca live location", () => {
    const loc = parseLocationMessage(null, { location: { lat: 1, lng: 2, live: true } });
    expect(loc?.live).toBe(true);
  });

  it("parseia a string legada da Cloud API", () => {
    const loc = parseLocationMessage("[Localização: -23.5505, -46.6333]", null);
    expect(loc).toMatchObject({ lat: -23.5505, lng: -46.6333, name: null });
  });

  it("aceita a variante sem acento", () => {
    expect(parseLocationMessage("[Localizacao: 10, 20]", null)).toMatchObject({ lat: 10, lng: 20 });
  });

  it("rejeita coordenadas fora do range", () => {
    expect(parseLocationMessage("[Localização: 91, 0]", null)).toBeNull();
    expect(parseLocationMessage(null, { location: { lat: 0, lng: 999 } })).toBeNull();
  });

  it("rejeita texto qualquer e metadata malformado", () => {
    expect(parseLocationMessage("olá mundo", null)).toBeNull();
    expect(parseLocationMessage(null, { location: { lat: "a", lng: "b" } })).toBeNull();
    expect(parseLocationMessage(null, null)).toBeNull();
  });

  it("gera link do Maps", () => {
    const loc = parseLocationMessage("[Localização: -23.5, -46.6]", null)!;
    expect(locationMapsUrl(loc)).toBe("https://maps.google.com/?q=-23.5,-46.6");
  });
});

describe("parseCoordinateInput", () => {
  it("aceita lat,lng cru", () => {
    expect(parseCoordinateInput("-23.5505, -46.6333")).toEqual({ lat: -23.5505, lng: -46.6333 });
  });

  it("aceita link do Maps com @lat,lng", () => {
    expect(
      parseCoordinateInput("https://www.google.com/maps/place/Pra%C3%A7a/@-23.55,-46.63,17z/data=x")
    ).toEqual({ lat: -23.55, lng: -46.63 });
  });

  it("aceita link com ?q=lat,lng e loc:", () => {
    expect(parseCoordinateInput("https://maps.google.com/?q=-23.55,-46.63")).toEqual({ lat: -23.55, lng: -46.63 });
    expect(parseCoordinateInput("https://maps.google.com/?q=loc:-23.55,-46.63")).toEqual({ lat: -23.55, lng: -46.63 });
  });

  it("aceita !3d/!4d de links de place", () => {
    expect(parseCoordinateInput("https://google.com/maps/x!3d-23.55!4d-46.63!x")).toEqual({ lat: -23.55, lng: -46.63 });
  });

  it("rejeita texto sem coordenadas e fora do range", () => {
    expect(parseCoordinateInput("praça da sé")).toBeNull();
    expect(parseCoordinateInput("91, 0")).toBeNull();
    expect(parseCoordinateInput("")).toBeNull();
  });
});
