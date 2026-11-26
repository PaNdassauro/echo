import { useEffect } from "react";
import { clearPhoneThemeInlineTokens, getCurrentAppThemePreset } from "@/hooks/useLocalTheme";
import { hslToRgb, relativeLuminance } from "@/lib/colorContrast";

// ── Contraste WCAG ─────────────────────────────────────────────────────────
// O hue é escolhido pelo usuário por número: em 65% 55% (a cor da marca),
// texto branco dava ~1,8:1 em TODO botão primário. Em vez de um L fixo,
// desce a lightness a partir de 55% até o primeiro degrau em que o branco
// passa 4,5:1 — matiz escuro (azul) fica vibrante, claro (amarelo) escurece
// só o necessário.
function contrastWithWhite(h: number, s: number, l: number): number {
  return 1.05 / (relativeLuminance(hslToRgb(h, s, l)) + 0.05);
}

function accessiblePrimaryLightness(hue: number, saturation = 65): number {
  for (let l = 55; l >= 26; l--) {
    if (contrastWithWhite(hue, saturation, l) >= 4.5) return l;
  }
  return 26;
}

export const usePhoneTheme = (themeHue: number | null) => {
  useEffect(() => {
    const applyPhoneTheme = () => {
      const hue = themeHue ?? 174; // Default to Echo teal
      if (import.meta.env.DEV) {
        console.log("[usePhoneTheme] Updating theme hue to:", hue);
      }
      const root = document.documentElement;
      root.style.setProperty("--phone-theme-hue", `${hue}`);
      root.style.setProperty("--phone-theme-color", `${hue} 65% 55%`);

      // Presets de paleta fixa não podem ser recoloridos pelo hue do número.
      if (getCurrentAppThemePreset() !== "echo") {
        clearPhoneThemeInlineTokens(root);
        return;
      }

      // Light mode colors — superfícies com texto branco usam o L acessível;
      // 65% 55% (cor pura da marca) sobrevive só em --phone-theme-color (swatch)
      const accessibleL = accessiblePrimaryLightness(hue);
      const primaryHsl = `${hue} 65% ${accessibleL}%`;
      root.style.setProperty("--primary", primaryHsl);
      root.style.setProperty("--accent", primaryHsl);
      root.style.setProperty("--ring", primaryHsl);
      root.style.setProperty("--foreground", `${hue} 40% 15%`);
      root.style.setProperty("--card-foreground", `${hue} 40% 15%`);
      root.style.setProperty("--popover-foreground", `${hue} 40% 15%`);
      root.style.setProperty("--secondary", `${hue} 30% 96%`);
      root.style.setProperty("--secondary-foreground", `${hue} 40% 15%`);
      root.style.setProperty("--muted", `${hue} 20% 96%`);
      root.style.setProperty("--muted-foreground", `${hue} 15% 38%`);
      root.style.setProperty("--border", `${hue} 25% 90%`);
      root.style.setProperty("--input", `${hue} 25% 90%`);
      root.style.setProperty("--sidebar-background", `${hue} 35% 98%`);
      root.style.setProperty("--sidebar-foreground", `${hue} 40% 15%`);
      root.style.setProperty("--sidebar-primary", primaryHsl);
      root.style.setProperty("--sidebar-accent", `${hue} 25% 96%`);
      root.style.setProperty("--sidebar-accent-foreground", `${hue} 40% 15%`);
      root.style.setProperty("--sidebar-border", `${hue} 25% 90%`);
      root.style.setProperty("--sidebar-ring", primaryHsl);
      root.style.setProperty("--chat-bubble-user", primaryHsl);
      root.style.setProperty("--chat-bubble-contact-foreground", `${hue} 40% 15%`);

    };

    applyPhoneTheme();
    window.addEventListener("echo-theme-change", applyPhoneTheme);

    return () => window.removeEventListener("echo-theme-change", applyPhoneTheme);
  }, [themeHue]);
};
