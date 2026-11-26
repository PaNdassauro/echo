import { WifiOff } from "lucide-react";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

/**
 * Faixa global de offline: sempre montada, entra/sai por transform (nunca
 * aparece do nada). Cobre o app inteiro — antes disso, a conexão caía e os
 * envios apenas falhavam em silêncio.
 */
export function OfflineBanner() {
  const isOnline = useOnlineStatus();

  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={isOnline}
      className={`fixed inset-x-0 top-0 z-[200] flex items-center justify-center gap-2 bg-destructive px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-sm font-medium text-destructive-foreground transition-[transform,visibility] duration-200 ease-out ${
        // invisible junto do transform: em zoom fracionário (90%/110%) o
        // translateY(-100%) arredonda sub-pixel e vazava uma risca de 1px
        // vermelha no topo; visibility respeita a transição (o slide-out
        // ainda anima) e zera o paint quando escondido.
        isOnline ? "-translate-y-full invisible pointer-events-none" : "translate-y-0 visible"
      }`}
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      Sem conexão — as mensagens serão enviadas quando você voltar
    </div>
  );
}
