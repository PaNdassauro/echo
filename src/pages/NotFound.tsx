import { useLocation, Link } from "react-router-dom";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { BottomNavigation } from "@/components/layout/BottomNavigation";

const NotFound = () => {
  const location = useLocation();
  const isMobile = useIsMobile();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    // dvh + navegação própria: em PWA standalone não há barra do navegador,
    // então um 404 sem saída interna era um beco sem saída literal.
    <div className={cn("flex min-h-dvh items-center justify-center bg-muted", isMobile && "pb-bottom-nav")}>
      <div className="px-6 text-center">
        <h1 className="mb-4 text-4xl font-bold tracking-tight">404</h1>
        <p className="mb-6 text-xl text-muted-foreground text-pretty">Página não encontrada</p>
        <Button asChild>
          <Link to="/dashboard">Ir para as conversas</Link>
        </Button>
      </div>
      {isMobile && <BottomNavigation />}
    </div>
  );
};

export default NotFound;
