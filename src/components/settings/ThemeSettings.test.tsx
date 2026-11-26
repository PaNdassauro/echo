import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import ThemeSettings from "./ThemeSettings";
import { APP_THEME_PRESETS, DARK_PRESETS, getCustomThemeStorageKey, getThemeStorageKey } from "@/hooks/useLocalTheme";

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.appTheme;
  document.documentElement.classList.remove("dark");
  document.getElementById("echo-custom-theme")?.remove();
  document.documentElement.removeAttribute("style");
});

const group = (name: string) => screen.getByRole("region", { name });

describe("ThemeSettings", () => {
  it("mostra um cartão por preset, separados em claros e escuros", () => {
    render(<ThemeSettings userId="u1" />);

    const light = within(group("Claros")).getAllByRole("button");
    const dark = within(group("Escuros")).getAllByRole("button");

    expect(light).toHaveLength(APP_THEME_PRESETS.length - DARK_PRESETS.size);
    expect(dark).toHaveLength(DARK_PRESETS.size);
    expect(within(group("Escuros")).getByRole("button", { name: /Nord/ })).toBeTruthy();
    expect(within(group("Claros")).getByRole("button", { name: /Lavanda/ })).toBeTruthy();
  });

  it("aplica o preset escolhido, liga .dark só nos escuros e lembra por usuário", () => {
    render(<ThemeSettings userId="u1" />);
    const root = document.documentElement;

    fireEvent.click(screen.getByRole("button", { name: /Breu/ }));
    expect(root.dataset.appTheme).toBe("breu");
    expect(root.classList.contains("dark")).toBe(true);
    expect(screen.getByRole("button", { name: /Breu/ }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /Lavanda/ }));
    expect(root.dataset.appTheme).toBe("lavanda");
    expect(root.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(getThemeStorageKey("u1"))).toBe("lavanda");
  });

  describe("tema personalizado", () => {
    const customCard = () => within(group("Personalizado")).getByRole("button", { name: /Personalizado/ });
    const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
    // O primeiro clique aplica o tema (assíncrono por causa da imagem): espera o editor assentar.
    const openEditor = async () => {
      fireEvent.click(customCard());
      await screen.findByRole("button", { name: "Aplicar tema" });
    };

    it("vem antes dos presets e oferece imagem de fundo sem mostrar controles vazios", async () => {
      render(<ThemeSettings userId="u1" />);
      const regions = screen.getAllByRole("region").map((region) => region.getAttribute("aria-labelledby"));
      expect(regions[0]).toBe("theme-group-custom");

      await openEditor();
      expect(screen.getByRole("button", { name: "Escolher imagem" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remover" })).toBeNull();
      expect(screen.queryByText("Desfoque")).toBeNull();
      expect(screen.queryByText("Dither")).toBeNull();
    });

    it("recusa arquivo que não é imagem aceita", async () => {
      render(<ThemeSettings userId="u1" />);
      await openEditor();
      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error("sem input de arquivo");
      fireEvent.change(input, { target: { files: [new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })] } });
      expect(screen.getByRole("alert").textContent).toMatch(/JPG, PNG, WebP/);
    });

    it("mostra a região Personalizado com o cartão não selecionado", () => {
      render(<ThemeSettings userId="u1" />);
      expect(customCard().getAttribute("aria-pressed")).toBe("false");
    });

    it("valida o hex da cor principal e normaliza no blur", async () => {
      render(<ThemeSettings userId="u1" />);
      await openEditor();
      const input = field("Cor principal");

      fireEvent.change(input, { target: { value: "#zz" } });
      fireEvent.blur(input);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByText(/#RGB ou #RRGGBB/)).toBeTruthy();

      fireEvent.change(input, { target: { value: "#E11D48" } });
      expect(input.getAttribute("aria-invalid")).toBeNull();
      fireEvent.blur(input);
      expect(input.value).toBe("#e11d48");

      fireEvent.change(input, { target: { value: "#abc" } });
      fireEvent.blur(input);
      expect(input.value).toBe("#aabbcc");
    });

    it("o botão do swatch abre o seletor e o campo de texto continua mandando no tema", async () => {
      render(<ThemeSettings userId="u1" />);
      await openEditor();
      const swatch = screen.getByRole("button", { name: "Escolher cor principal" });
      expect(screen.queryAllByRole("slider")).toHaveLength(0);

      fireEvent.click(swatch);
      expect((await screen.findAllByRole("slider")).length).toBeGreaterThanOrEqual(2);

      fireEvent.change(field("Cor principal"), { target: { value: "#e11d48" } });
      expect(field("Cor principal").value).toBe("#e11d48");
      expect(swatch.style.backgroundColor).toBe("rgb(225, 29, 72)");
    });

    it("não há input de cor nativo e cada campo tem um único nome acessível", async () => {
      render(<ThemeSettings userId="u1" />);
      await openEditor();
      expect(document.querySelector('input[type="color"]')).toBeNull();
      expect(screen.getAllByLabelText("Cor principal")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Escolher fundo do app" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Escolher bolha enviada" })).toBeTruthy();
    });

    it("aplica com base escura, persiste e marca o cartão", async () => {
      render(<ThemeSettings userId="u1" />);
      await openEditor();
      const root = document.documentElement;

      fireEvent.click(screen.getByRole("radio", { name: "Escura" }));
      fireEvent.click(screen.getByRole("button", { name: "Aplicar tema" }));

      expect(root.dataset.appTheme).toBe("custom");
      expect(root.classList.contains("dark")).toBe(true);
      expect(document.getElementById("echo-custom-theme")).not.toBeNull();
      expect(localStorage.getItem(getThemeStorageKey("u1"))).toBe("custom");
      const saved = JSON.parse(localStorage.getItem(getCustomThemeStorageKey("u1")) ?? "{}") as { base?: string };
      expect(saved.base).toBe("dark");
      expect(customCard().getAttribute("aria-pressed")).toBe("true");
    });

    it("avisa quando a cor principal foi ajustada", async () => {
      render(<ThemeSettings userId="u1" />);
      await openEditor();
      fireEvent.change(field("Cor principal"), { target: { value: "#ffff00" } });

      const status = screen.getByRole("status");
      expect(status.textContent).toContain("Ajustamos");
      expect(status.textContent).toContain("cor principal");
    });

    it("o editor só abre pelo cartão e fecha no segundo clique", async () => {
      render(<ThemeSettings userId="u1" />);
      expect(screen.queryByLabelText("Cor principal")).toBeNull();
      expect(customCard().getAttribute("aria-expanded")).toBe("false");

      await openEditor();
      expect(customCard().getAttribute("aria-expanded")).toBe("true");
      expect(customCard().getAttribute("aria-pressed")).toBe("true");
      // Sem tema salvo, o primeiro clique já aplica o rascunho (padrão).
      expect(localStorage.getItem(getThemeStorageKey("u1"))).toBe("custom");

      fireEvent.change(field("Cor principal"), { target: { value: "#e11d48" } });
      fireEvent.click(screen.getByRole("button", { name: "Aplicar tema" }));
      await screen.findByRole("button", { name: "Aplicar tema" });
      const saved = JSON.parse(localStorage.getItem(getCustomThemeStorageKey("u1")) ?? "{}") as { primary?: string };
      expect(saved.primary).toBe("#e11d48");

      fireEvent.click(customCard());
      expect(screen.queryByLabelText("Cor principal")).toBeNull();
      expect(customCard().getAttribute("aria-pressed")).toBe("true");
    });

    it("trocar para um preset remove o estilo do personalizado", async () => {
      render(<ThemeSettings userId="u1" />);
      await openEditor();
      fireEvent.click(screen.getByRole("button", { name: "Aplicar tema" }));
      expect(document.getElementById("echo-custom-theme")).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /Breu/ }));
      expect(document.getElementById("echo-custom-theme")).toBeNull();
      expect(document.documentElement.dataset.appTheme).toBe("breu");
    });
  });
});
