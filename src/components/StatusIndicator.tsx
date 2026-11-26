import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useSystemAlerts } from '@/hooks/useSystemAlerts';
import type { AlertSeverity } from '@/types/system-alerts';

interface StatusIndicatorProps {
  className?: string;
  size?: 'sm' | 'md';
}

// Tokens do design system: as cores cruas (yellow-500 etc.) davam ~1.8:1 em
// presets como o whatsapp; status-active/pending/destructive seguem o tema.
const severityColors: Record<AlertSeverity, string> = {
  normal: 'text-status-active',
  warning: 'text-status-pending',
  critical: 'text-destructive',
};

const severityBgColors: Record<AlertSeverity, string> = {
  normal: 'bg-status-active/10',
  warning: 'bg-status-pending/10',
  critical: 'bg-destructive/10',
};

const severityLabels: Record<AlertSeverity, string> = {
  normal: 'Status Normal',
  warning: 'Aviso',
  critical: 'Alerta Importante',
};

/**
 * Único sinal de saúde do sistema no header. Popover por CLIQUE: o tooltip
 * hover-only era inacessível no touch — exatamente onde ele mais importa.
 */
export function StatusIndicator({ className, size = 'md' }: StatusIndicatorProps) {
  const { activeAlert, isLoading } = useSystemAlerts();

  if (isLoading || !activeAlert) {
    return null;
  }

  const iconSize = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';
  // Alvo maior no touch sem esticar o header compacto: caixa de 36px com
  // margem negativa compensando (o h-11 puro crescia o header da lista em 12px)
  const containerSize =
    size === 'sm' ? 'h-9 w-9 -my-1.5 md:my-0 md:h-6 md:w-6' : 'h-11 w-11 -my-1.5 md:my-0 md:h-8 md:w-8';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center justify-center rounded-full transition-[opacity,transform] duration-150 ease-out',
            'active:scale-[0.96] hover:opacity-80',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            severityBgColors[activeAlert.severity],
            containerSize,
            className
          )}
          aria-label={`${severityLabels[activeAlert.severity]}: ${activeAlert.title}`}
        >
          <AlertCircle
            className={cn(iconSize, severityColors[activeAlert.severity])}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="max-w-xs w-auto">
        <div className="space-y-1">
          <p className="text-sm font-semibold">{activeAlert.title}</p>
          <p className="text-xs text-muted-foreground">{activeAlert.message}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
