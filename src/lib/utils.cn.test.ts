import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn com os tamanhos de fonte próprios", () => {
  it.each(["text-message", "text-message-xs", "text-2xs"])("%s convive com a cor de texto", (size) => {
    const out = cn(size, "text-chat-bubble-user-foreground").split(" ");
    expect(out).toContain(size);
    expect(out).toContain("text-chat-bubble-user-foreground");
  });

  it("a cor depois do tamanho também não apaga o tamanho", () => {
    expect(cn("text-primary", "text-message").split(" ")).toEqual(["text-primary", "text-message"]);
  });

  it("text-message substitui text-sm (e vice-versa)", () => {
    expect(cn("text-sm", "text-message")).toBe("text-message");
    expect(cn("text-message", "text-sm")).toBe("text-sm");
    expect(cn("text-xs text-muted-foreground", "text-message-xs")).toBe("text-muted-foreground text-message-xs");
  });

  it("variantes ficam separadas por modificador", () => {
    expect(cn("text-base md:text-sm", "md:text-message").split(" ")).toEqual(["text-base", "md:text-message"]);
  });
});
