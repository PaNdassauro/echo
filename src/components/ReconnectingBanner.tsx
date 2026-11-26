import { useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import {
  subscribeRealtimeHealth,
  getRealtimeHealthVersion,
  isRealtimeDegraded,
} from "@/lib/realtimeHealth";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useSustainedFlag } from "@/hooks/useSustainedFlag";

/**
 * Todo fechamento do socket (heartbeat sem resposta, troca de rede, aba
 * suspensa, reinício do Realtime) derruba os canais, e o backoff reassina em
 * 1–3 s. A faixa só vale para queda que dura mais que isso.
 */
export const RECONNECT_GRACE_MS = 5000;

/**
 * Faixa global de reconexão do realtime: visível enquanto algum canal estiver
 * caído (antes, a queda era silenciosa e a lista congelava até um F5).
 * Quando o próprio navegador está offline, o OfflineBanner cobre o caso.
 */
export function ReconnectingBanner() {
  useSyncExternalStore(subscribeRealtimeHealth, getRealtimeHealthVersion);
  const isOnline = useOnlineStatus();
  const show = useSustainedFlag(isRealtimeDegraded() && isOnline, RECONNECT_GRACE_MS);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={!show}
      className={`fixed inset-x-0 top-0 z-[190] flex items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] text-xs font-medium text-amber-950 transition-[transform,visibility] duration-200 ease-out ${
        // invisible junto do transform: mesma risca de 1px do OfflineBanner
        // em zoom fracionário (translateY(-100%) arredonda sub-pixel).
        show ? "translate-y-0 visible" : "-translate-y-full invisible pointer-events-none"
      }`}
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Conexão instável. As mensagens continuam chegando, com alguns segundos de atraso
    </div>
  );
}
