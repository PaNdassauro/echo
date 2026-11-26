import { useState, useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Clock, Loader2 } from "lucide-react";

interface ScheduleMessagePopoverProps {
  onSchedule: (scheduledAt: Date) => Promise<{ success: boolean; error?: string }>;
  disabled?: boolean;
  /** Botão que abre o seletor (o padrão é o relógio redondo do composer). Recebe ref e props do Radix. */
  trigger?: ReactNode;
  /** Frase abaixo do título. */
  description?: string;
}

export default function ScheduleMessagePopover({
  onSchedule,
  disabled = false,
  trigger,
  description = "A mensagem será enviada automaticamente no horário escolhido.",
}: ScheduleMessagePopoverProps) {
  const [open, setOpen] = useState(false);
  const [scheduledDate, setScheduledDate] = useState<Date | null>(null);
  const [isScheduling, setIsScheduling] = useState(false);

  // Format date for datetime-local input (expects local time without timezone)
  const formatDateTimeLocal = (date: Date | null): string => {
    if (!date) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  // Get minimum date (now + 5 minutes) in local time
  const getMinDate = (): string => {
    const min = new Date();
    min.setMinutes(min.getMinutes() + 5);
    return formatDateTimeLocal(min);
  };

  const handleDateTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value) {
      const date = new Date(value);
      setScheduledDate(date);
    } else {
      setScheduledDate(null);
    }
  };

  const handleSchedule = useCallback(async () => {
    if (!scheduledDate) return;

    // Validate minimum time
    const minTime = new Date();
    minTime.setMinutes(minTime.getMinutes() + 5);
    if (scheduledDate < minTime) {
      return;
    }

    setIsScheduling(true);
    const result = await onSchedule(scheduledDate);
    setIsScheduling(false);

    if (result.success) {
      setOpen(false);
      setScheduledDate(null);
    }
  }, [scheduledDate, onSchedule]);

  const isValidDate = scheduledDate && scheduledDate > new Date(Date.now() + 5 * 60 * 1000);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger ?? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            className="rounded-full h-10 w-10 shrink-0"
            title="Agendar mensagem"
          >
            <Clock className="w-5 h-5" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="space-y-4">
          <div className="space-y-2">
            <h4 className="font-medium">Agendar mensagem</h4>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="schedule-datetime" className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Data e horário
            </Label>
            <Input
              id="schedule-datetime"
              type="datetime-local"
              value={formatDateTimeLocal(scheduledDate)}
              onChange={handleDateTimeChange}
              min={getMinDate()}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">
              Mínimo de 5 minutos no futuro
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={isScheduling}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSchedule}
              disabled={!isValidDate || isScheduling}
            >
              {isScheduling ? (
                <Loader2 className="w-4 h-4 animate-spin mr-1" />
              ) : (
                <Clock className="w-4 h-4 mr-1" />
              )}
              Agendar
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
