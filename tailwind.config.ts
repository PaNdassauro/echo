import type { Config } from "tailwindcss";
import type { PluginAPI } from "tailwindcss/types/config";

/**
 * "Reduzir animações" das preferências (data-motion="reduce" no <html>, ver
 * src/lib/accessibilityPrefs.ts) vale como o pedido do sistema nas variantes
 * core `motion-reduce:` e `motion-safe:`.
 * - motion-reduce = sistema pede OU preferência forçada (array = variantes
 *   paralelas: a regra sai uma vez em cada forma).
 * - motion-safe   = sistema não pede E preferência não forçada.
 */
const MOTION_VARIANTS: Record<string, string | string[]> = {
  "motion-reduce": ["@media (prefers-reduced-motion: reduce)", ':root[data-motion="reduce"] &'],
  "motion-safe": '@media (prefers-reduced-motion: no-preference) { :root:not([data-motion="reduce"]) & }',
};

/**
 * Um addVariant("motion-reduce") comum não basta: no Tailwind 3.4 as variantes
 * core de movimento são registradas DEPOIS dos plugins do usuário
 * (resolvePlugins → afterVariants, que nem o `corePlugins` desliga) e o
 * variantMap.set do core sobrescreveria a nossa. O objeto da API é o mesmo para
 * todos os plugins, então interceptamos o addVariant só para esses dois nomes:
 * o core continua registrando-as na mesma posição (mesma ordem no CSS), com a
 * nossa definição. Depois dos dois, o addVariant original volta. Prova:
 * src/lib/accessibilityPrefs.test.ts gera o CSS com esta config.
 */
function motionPreferenceVariants(api: PluginAPI) {
  type AnyAddVariant = (name: string, definition: unknown, ...rest: unknown[]) => void;
  const original = api.addVariant as AnyAddVariant;
  const pending = new Set(Object.keys(MOTION_VARIANTS));
  const intercept: AnyAddVariant = (name, definition, ...rest) => {
    const override = MOTION_VARIANTS[name];
    if (override === undefined) return original(name, definition, ...rest);
    pending.delete(name);
    if (pending.size === 0) api.addVariant = original as PluginAPI["addVariant"];
    return original(name, override, ...rest);
  };
  api.addVariant = intercept as PluginAPI["addVariant"];
}

export default {
  darkMode: ["class"],
  // hover: só em dispositivo com ponteiro que paira — no toque o :hover não gruda.
  future: { hoverOnlyWhenSupported: true },
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      // O breakpoint xs: já era usado em várias telas mas NÃO existia no
      // Tailwind — as classes xs:* não geravam CSS nenhum.
      screens: {
        xs: "480px",
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        "chat-bubble-user": {
          DEFAULT: "hsl(var(--chat-bubble-user))",
          foreground: "hsl(var(--chat-bubble-user-foreground))",
        },
        "chat-bubble-contact": {
          DEFAULT: "hsl(var(--chat-bubble-contact))",
          foreground: "hsl(var(--chat-bubble-contact-foreground))",
        },
        "status-active": "hsl(var(--status-active))",
        "status-pending": "hsl(var(--status-pending))",
        "status-closed": "hsl(var(--status-closed))",
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
          4: "hsl(var(--chart-4))",
          5: "hsl(var(--chart-5))",
        },
      },
      // Degrau tipográfico já usado ~67× como text-[10px] ad-hoc — formalizado
      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "0.875rem", letterSpacing: "0.01em" }],
        // Texto das bolhas: text-sm / text-xs multiplicados pela preferência
        // "Tamanho do texto das mensagens" (--message-text-scale no <html>).
        message: ["calc(0.875rem * var(--message-text-scale, 1))", { lineHeight: "calc(1.25rem * var(--message-text-scale, 1))" }],
        "message-xs": ["calc(0.75rem * var(--message-text-scale, 1))", { lineHeight: "calc(1rem * var(--message-text-scale, 1))" }],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
        // Pontinho do "digitando". Loop contínuo (não é UI interrompível, então
        // keyframes é o certo aqui) e só toca opacity/transform — fora de layout
        // e paint. O escalonamento entre os três pontos vem do animation-delay.
        "typing-dot": {
          "0%, 60%, 100%": {
            opacity: "0.35",
            transform: "translateY(0)",
          },
          "30%": {
            opacity: "1",
            transform: "translateY(-3px)",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "typing-dot": "typing-dot 1.3s ease-in-out infinite",
      },
      // Fonte única: as curvas vivem como CSS vars em index.css (:root); aqui
      // só referenciamos — mudar lá muda tudo, sem divergência.
      transitionTimingFunction: {
        "out-strong": "var(--ease-out-strong)",
        "in-out-strong": "var(--ease-in-out-strong)",
        drawer: "var(--ease-drawer)",
      },
      // O plugin typography vem com cinzas hardcoded — amarrar aos tokens do
      // design system para o prose acompanhar todos os presets de tema.
      typography: {
        DEFAULT: {
          css: {
            "--tw-prose-body": "hsl(var(--foreground) / 0.9)",
            "--tw-prose-headings": "hsl(var(--foreground))",
            "--tw-prose-lead": "hsl(var(--foreground) / 0.8)",
            "--tw-prose-links": "hsl(var(--primary))",
            "--tw-prose-bold": "hsl(var(--foreground))",
            "--tw-prose-counters": "hsl(var(--muted-foreground))",
            "--tw-prose-bullets": "hsl(var(--muted-foreground))",
            "--tw-prose-hr": "hsl(var(--border))",
            "--tw-prose-quotes": "hsl(var(--foreground))",
            "--tw-prose-quote-borders": "hsl(var(--border))",
            "--tw-prose-captions": "hsl(var(--muted-foreground))",
            "--tw-prose-code": "hsl(var(--foreground))",
            "--tw-prose-pre-code": "hsl(var(--foreground))",
            "--tw-prose-pre-bg": "hsl(var(--muted))",
            "--tw-prose-th-borders": "hsl(var(--border))",
            "--tw-prose-td-borders": "hsl(var(--border))",
            "--tw-prose-invert-body": "hsl(var(--foreground) / 0.9)",
            "--tw-prose-invert-headings": "hsl(var(--foreground))",
            "--tw-prose-invert-lead": "hsl(var(--foreground) / 0.8)",
            "--tw-prose-invert-links": "hsl(var(--primary))",
            "--tw-prose-invert-bold": "hsl(var(--foreground))",
            "--tw-prose-invert-counters": "hsl(var(--muted-foreground))",
            "--tw-prose-invert-bullets": "hsl(var(--muted-foreground))",
            "--tw-prose-invert-hr": "hsl(var(--border))",
            "--tw-prose-invert-quotes": "hsl(var(--foreground))",
            "--tw-prose-invert-quote-borders": "hsl(var(--border))",
            "--tw-prose-invert-captions": "hsl(var(--muted-foreground))",
            "--tw-prose-invert-code": "hsl(var(--foreground))",
            "--tw-prose-invert-pre-code": "hsl(var(--foreground))",
            "--tw-prose-invert-pre-bg": "hsl(var(--muted))",
            "--tw-prose-invert-th-borders": "hsl(var(--border))",
            "--tw-prose-invert-td-borders": "hsl(var(--border))",
          },
        },
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    require("@tailwindcss/typography"),
    // Coluna da lista de conversas arrastada abaixo de 368px (o container
    // "sidebar" só existe no desktop, em ResizableListColumn): no celular a
    // variante nunca casa. Em rem, não px: em container query o rem segue o
    // font-size do <html>, então o degrau acompanha o "Tamanho do texto do app"
    // (23rem = 368px em 100%, 460px em 125%), junto com o conteúdo, que é rem.
    ({ addVariant }) => {
      addVariant("sidebar-narrow", "@container sidebar (max-width: 22.999rem)");
      // Degrau abaixo: < 330px (20.625rem) já não cabe o rótulo "Nova Conversa" ao lado de 4 botões.
      addVariant("sidebar-tight", "@container sidebar (max-width: 20.624rem)");
    },
    motionPreferenceVariants,
  ],
} satisfies Config;
