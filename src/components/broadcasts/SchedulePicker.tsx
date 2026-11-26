import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SelectableCard } from "./SelectableCard";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Calendar, Clock, Send } from "lucide-react";

interface SchedulePickerProps {
    scheduleType: "now" | "scheduled";
    scheduledDate: Date | null;
    onScheduleTypeChange: (type: "now" | "scheduled") => void;
    onDateChange: (date: Date | null) => void;
}

export default function SchedulePicker({
    scheduleType,
    scheduledDate,
    onScheduleTypeChange,
    onDateChange,
}: SchedulePickerProps) {
    const handleDateTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        if (value) {
            // datetime-local gives us a local time string like "2026-01-16T12:30"
            // We need to parse this as local time and keep it that way
            const date = new Date(value);
            onDateChange(date);
        } else {
            onDateChange(null);
        }
    };

    // Format date for datetime-local input (expects local time without timezone)
    const formatDateTimeLocal = (date: Date | null): string => {
        if (!date) return "";
        // Get local date/time components
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}`;
    };

    // Get minimum date (now + 5 minutes) in local time
    const getMinDate = (): string => {
        const min = new Date();
        min.setMinutes(min.getMinutes() + 5);
        return formatDateTimeLocal(min);
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Quando enviar?</CardTitle>
                <CardDescription>
                    Escolha se deseja enviar imediatamente ou agendar para uma data futura.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-4" role="radiogroup" aria-label="Quando enviar">
                    <SelectableCard
                        name="broadcast-schedule"
                        label="Enviar agora"
                        selected={scheduleType === "now"}
                        onSelect={() => onScheduleTypeChange("now")}
                    >
                        <span className="flex items-center gap-3">
                            <span className={`p-2 rounded-full shrink-0 ${scheduleType === "now" ? "bg-primary/10" : "bg-muted"}`}>
                                <Send className={`h-5 w-5 ${scheduleType === "now" ? "text-primary" : "text-muted-foreground"}`} />
                            </span>
                            <span className="block">
                                <span className="block font-medium">Enviar agora</span>
                                <span className="block text-sm text-muted-foreground">
                                    O disparo começará imediatamente após a criação.
                                </span>
                            </span>
                        </span>
                    </SelectableCard>

                    <SelectableCard
                        name="broadcast-schedule"
                        label="Agendar para depois"
                        selected={scheduleType === "scheduled"}
                        onSelect={() => onScheduleTypeChange("scheduled")}
                    >
                        <span className="flex items-center gap-3">
                            <span className={`p-2 rounded-full shrink-0 ${scheduleType === "scheduled" ? "bg-primary/10" : "bg-muted"}`}>
                                <Calendar className={`h-5 w-5 ${scheduleType === "scheduled" ? "text-primary" : "text-muted-foreground"}`} />
                            </span>
                            <span className="block">
                                <span className="block font-medium">Agendar para depois</span>
                                <span className="block text-sm text-muted-foreground">
                                    Escolha uma data e horário específicos.
                                </span>
                            </span>
                        </span>
                    </SelectableCard>
                </div>

                {/* The datetime field sits OUTSIDE the option card on purpose: nesting a
                    real input inside the card's <label> makes clicks on the input activate
                    the card's radio. Being a sibling also drops the magic `pl-12` that was
                    faking alignment under the icon. */}
                {scheduleType === "scheduled" && (
                    <div className="rounded-md border bg-muted/30 p-4">
                        <Label htmlFor="broadcast-scheduled-at" className="flex items-center gap-2 mb-2">
                            <Clock className="h-4 w-4" />
                            Data e horário (horário de Brasília)
                        </Label>
                        <Input
                            id="broadcast-scheduled-at"
                            type="datetime-local"
                            value={formatDateTimeLocal(scheduledDate)}
                            onChange={handleDateTimeChange}
                            min={getMinDate()}
                            className="max-w-xs"
                        />
                        <p className="text-xs text-muted-foreground mt-2">
                            O disparo será processado automaticamente no horário agendado.
                        </p>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
