import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import AccessibilitySettings from "./AccessibilitySettings";
import { DEFAULT_A11Y_PREFS, getA11yStorageKey, parseA11yPrefs } from "@/lib/accessibilityPrefs";

afterEach(() => {
  cleanup();
  localStorage.clear();
  const root = document.documentElement;
  root.style.removeProperty("font-size");
  root.style.removeProperty("--message-text-scale");
  delete root.dataset.motion;
  delete root.dataset.contrast;
});

const region = (name: string) => screen.getByRole("region", { name });
const stored = () => parseA11yPrefs(localStorage.getItem(getA11yStorageKey("u1")));

describe("AccessibilitySettings", () => {
  it("mostra as quatro opções de tamanho em cada seção, com Padrão marcado", () => {
    render(<AccessibilitySettings userId="u1" />);

    for (const name of ["Tamanho do texto do app", "Tamanho do texto das mensagens"]) {
      const options = within(region(name)).getAllByRole("button");
      expect(options.map((button) => button.textContent)).toEqual([
        "AaPequeno",
        "AaPadrão",
        "AaGrande",
        "AaMuito grande",
      ]);
      expect(within(region(name)).getByRole("button", { name: "Padrão" }).getAttribute("aria-pressed")).toBe("true");
    }
    expect(screen.getByRole("button", { name: "Restaurar padrão" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("aplica o tamanho do texto do app e das mensagens no <html> e lembra por usuário", () => {
    render(<AccessibilitySettings userId="u1" />);
    const root = document.documentElement;

    const app = within(region("Tamanho do texto do app"));
    fireEvent.click(app.getByRole("button", { name: "Muito grande" }));
    expect(root.style.fontSize).toBe("125%");
    expect(app.getByRole("button", { name: "Muito grande" }).getAttribute("aria-pressed")).toBe("true");
    expect(app.getByRole("button", { name: "Padrão" }).getAttribute("aria-pressed")).toBe("false");

    const messages = within(region("Tamanho do texto das mensagens"));
    fireEvent.click(messages.getByRole("button", { name: "Grande" }));
    expect(root.style.getPropertyValue("--message-text-scale")).toBe("1.15");
    expect(messages.getByRole("button", { name: "Grande" }).getAttribute("aria-pressed")).toBe("true");

    expect(stored()).toEqual({ ...DEFAULT_A11Y_PREFS, appTextSize: "xl", messageTextSize: "lg" });
  });

  it("liga e desliga movimento reduzido e alto contraste pela linha inteira", () => {
    render(<AccessibilitySettings userId="u1" />);
    const root = document.documentElement;

    const motion = screen.getByRole("switch", { name: "Reduzir animações" });
    expect(motion.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(motion);
    expect(motion.getAttribute("aria-checked")).toBe("true");
    expect(root.dataset.motion).toBe("reduce");

    const contrast = screen.getByRole("switch", { name: "Alto contraste" });
    fireEvent.click(contrast);
    expect(contrast.getAttribute("aria-checked")).toBe("true");
    expect(root.dataset.contrast).toBe("more");
    expect(stored()).toEqual({ ...DEFAULT_A11Y_PREFS, reduceMotion: true, highContrast: true });

    fireEvent.click(motion);
    expect(motion.getAttribute("aria-checked")).toBe("false");
    expect(root.dataset.motion).toBeUndefined();
  });

  it("restaurar padrão volta tudo e se desabilita sem perder o foco", () => {
    render(<AccessibilitySettings userId="u1" />);
    const root = document.documentElement;

    fireEvent.click(within(region("Tamanho do texto do app")).getByRole("button", { name: "Pequeno" }));
    fireEvent.click(screen.getByRole("switch", { name: "Alto contraste" }));

    const reset = screen.getByRole("button", { name: "Restaurar padrão" }) as HTMLButtonElement;
    expect(reset.getAttribute("aria-disabled")).toBe("false");
    reset.focus();
    fireEvent.click(reset);

    expect(root.style.fontSize).toBe("");
    expect(root.dataset.contrast).toBeUndefined();
    expect(stored()).toEqual(DEFAULT_A11Y_PREFS);
    expect(reset.getAttribute("aria-disabled")).toBe("true");
    expect(reset.disabled).toBe(false);
    expect(document.activeElement).toBe(reset);
    expect(screen.getByRole("switch", { name: "Alto contraste" }).getAttribute("aria-checked")).toBe("false");
  });

  it("marca o tamanho escolhido com um selo, não só com a cor", () => {
    render(<AccessibilitySettings userId="u1" />);
    const app = within(region("Tamanho do texto do app"));
    const badge = (name: string) => app.getByRole("button", { name }).querySelector("svg");
    expect(badge("Padrão")).not.toBeNull();
    expect(badge("Grande")).toBeNull();
    fireEvent.click(app.getByRole("button", { name: "Grande" }));
    expect(badge("Grande")).not.toBeNull();
    expect(badge("Padrão")).toBeNull();
  });

  it("restaurar já no padrão não faz nada", () => {
    render(<AccessibilitySettings userId="u1" />);
    fireEvent.click(screen.getByRole("button", { name: "Restaurar padrão" }));
    expect(localStorage.getItem(getA11yStorageKey("u1"))).toBeNull();
  });

  it("abre com a preferência já salva do usuário", () => {
    localStorage.setItem(
      getA11yStorageKey("u1"),
      JSON.stringify({ ...DEFAULT_A11Y_PREFS, messageTextSize: "xl", reduceMotion: true }),
    );
    render(<AccessibilitySettings userId="u1" />);

    const messages = within(region("Tamanho do texto das mensagens"));
    expect(messages.getByRole("button", { name: "Muito grande" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("switch", { name: "Reduzir animações" }).getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.style.getPropertyValue("--message-text-scale")).toBe("1.3");
  });
});
