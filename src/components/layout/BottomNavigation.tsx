import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MessageSquare, BarChart3, Radio, Zap, Settings, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconSwap } from "@/components/ui/icon-swap";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  matchPaths?: string[];
}

const menuItems: NavItem[] = [
  {
    path: "/broadcasts",
    label: "Disparos",
    icon: Radio,
  },
  {
    path: "/automations",
    label: "Fluxos",
    icon: Zap,
  },
  {
    path: "/analytics",
    label: "Relatórios",
    icon: BarChart3,
  },
];

export function BottomNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (item: NavItem) => {
    if (item.matchPaths) {
      return item.matchPaths.some((p) => location.pathname.startsWith(p));
    }
    return location.pathname.startsWith(item.path);
  };

  const isChatActive = location.pathname.startsWith("/dashboard");
  const isSettingsActive = location.pathname.startsWith("/settings");
  const isMenuItemActive = menuItems.some((item) => isActive(item));

  const handleMenuItemClick = (path: string) => {
    navigate(path);
    setMenuOpen(false);
  };

  // Item da barra: indicador ATIVO não-cromático (barra de 2px + peso da
  // fonte), além da cor — cor sozinha não passa para daltônicos.
  const barItemClass = (active: boolean) =>
    cn(
      "relative flex flex-col items-center justify-center gap-1 p-2 rounded-lg",
      "transition-[color,transform] duration-150 ease-out",
      "active:bg-accent/50 active:scale-[0.96] touch-manipulation",
      active ? "text-primary" : "text-muted-foreground"
    );

  const activeBar = (
    <span aria-hidden="true" className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-full bg-primary" />
  );

  return (
    <>
      {/* Menu — Drawer (vaul) em vez do painel à mão: Escape, focus trap,
          role=dialog, scroll lock e swipe-to-dismiss vêm do primitivo. */}
      <Drawer open={menuOpen} onOpenChange={setMenuOpen}>
        <DrawerContent id="bottom-nav-menu" className="safe-area-bottom">
          <DrawerTitle className="sr-only">Menu de navegação</DrawerTitle>
          <div className="p-4 space-y-2">
            {menuItems.map((item) => {
              const active = isActive(item);
              const Icon = item.icon;
              return (
                <button
                  key={item.path}
                  onClick={() => handleMenuItemClick(item.path)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-4 w-full p-4 rounded-xl transition-colors",
                    "active:bg-accent touch-manipulation",
                    active
                      ? "bg-primary/10 text-primary font-semibold"
                      : "text-foreground hover:bg-accent"
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                  <span className="font-medium">{item.label}</span>
                </button>
              );
            })}
          </div>
        </DrawerContent>
      </Drawer>

      {/* Bottom navigation bar */}
      <nav
        aria-label="Navegação principal"
        className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t border-border safe-area-bottom"
      >
        <div className="flex items-center justify-between h-16 px-8">
          {/* Menu button - Left */}
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            aria-expanded={menuOpen}
            aria-controls="bottom-nav-menu"
            aria-label={menuOpen ? "Fechar menu de navegação" : "Abrir menu de navegação"}
            className={barItemClass(menuOpen || isMenuItemActive)}
          >
            {isMenuItemActive && !menuOpen && activeBar}
            <IconSwap
              active={menuOpen ? "close" : "menu"}
              durationMs={150}
              icons={{
                menu: <Menu className="h-5 w-5" aria-hidden="true" />,
                close: <X className="h-5 w-5" aria-hidden="true" />,
              }}
            />
            <span className={cn("text-2xs", isMenuItemActive ? "font-semibold" : "font-medium")}>Menu</span>
          </button>

          {/* Chat button - Center */}
          <button
            onClick={() => navigate("/dashboard")}
            aria-current={isChatActive ? "page" : undefined}
            className={barItemClass(isChatActive)}
          >
            {isChatActive && activeBar}
            <MessageSquare className="h-5 w-5" aria-hidden="true" />
            <span className={cn("text-2xs", isChatActive ? "font-semibold" : "font-medium")}>Conversas</span>
          </button>

          {/* Settings button - Right */}
          <button
            onClick={() => navigate("/settings")}
            aria-current={isSettingsActive ? "page" : undefined}
            className={barItemClass(isSettingsActive)}
          >
            {isSettingsActive && activeBar}
            <Settings className="h-5 w-5" aria-hidden="true" />
            <span className={cn("text-2xs", isSettingsActive ? "font-semibold" : "font-medium")}>Config</span>
          </button>
        </div>
      </nav>
    </>
  );
}
