import { useEffect, useState } from "react";
import { Toaster as Sonner, toast } from "sonner";

import { useIsMobile } from "@/hooks/use-mobile";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const THEME_EVENT = "echo-theme-change";

/**
 * O app não monta ThemeProvider do next-themes: o tema é o preset em
 * data-app-theme (useLocalTheme), e os presets escuros põem .dark no <html>.
 * Ler a classe é a fonte de verdade que já existe — nada a sincronizar.
 */
function readIsDark(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

function useSonnerTheme(): "light" | "dark" {
  const [isDark, setIsDark] = useState(readIsDark);

  useEffect(() => {
    const sync = () => setIsDark(readIsDark());
    sync();
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);

  return isDark ? "dark" : "light";
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useSonnerTheme();
  const isMobile = useIsMobile();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      // Mesma borda que o Toaster do Radix (toast.tsx): topo no celular,
      // canto inferior direito no desktop — as notificações chegam sempre do mesmo lugar.
      position={isMobile ? "top-center" : "bottom-right"}
      duration={6000}
      visibleToasts={4}
      closeButton
      offset="24px"
      mobileOffset={{ top: "max(1rem, env(safe-area-inset-top))", left: "16px", right: "16px" }}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:!h-9 group-[.toast]:!px-3 group-[.toast]:!text-sm group-[.toast]:!bg-primary group-[.toast]:!text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
