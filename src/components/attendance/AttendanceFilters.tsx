import { useState } from "react";
import type { DateRange as DayPickerRange } from "react-day-picker";
import { ptBR } from "date-fns/locale";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
    KIND_OPTIONS,
    PERIOD_PRESETS,
    formatRangeLabel,
    type ConversationKind,
    type DateRange,
    type PeriodPreset,
} from "@/lib/attendanceReport";
import type { AgentOption, LineOption } from "@/hooks/useAttendanceReport";

const ALL_AGENTS = "__all__";

interface AttendanceFiltersProps {
    lines: LineOption[];
    lineId: string | null;
    onLineChange: (id: string) => void;
    preset: PeriodPreset;
    range: DateRange;
    onPresetChange: (preset: Exclude<PeriodPreset, "custom">) => void;
    onCustomRange: (range: DateRange) => void;
    kind: ConversationKind;
    onKindChange: (kind: ConversationKind) => void;
    agents: AgentOption[];
    agentId: string | null;
    onAgentChange: (id: string | null) => void;
}

/** Uma linha só, acima de tudo que ela filtra. Período primeiro. */
export function AttendanceFilters({
    lines,
    lineId,
    onLineChange,
    preset,
    range,
    onPresetChange,
    onCustomRange,
    kind,
    onKindChange,
    agents,
    agentId,
    onAgentChange,
}: AttendanceFiltersProps) {
    const [calendarOpen, setCalendarOpen] = useState(false);
    const [draft, setDraft] = useState<DayPickerRange | undefined>();

    // Atendente selecionada pode ter perdido o acesso à linha: ainda assim aparece
    const agentOptions =
        agentId && !agents.some((a) => a.id === agentId) ? [...agents, { id: agentId, label: "Atendente selecionada" }] : agents;

    return (
        <div className="flex flex-wrap items-center gap-2 p-3 sm:p-4 bg-card border border-border rounded-lg shadow-sm">
            <ToggleGroup
                type="single"
                value={preset === "custom" ? "" : preset}
                onValueChange={(value) => value && onPresetChange(value as Exclude<PeriodPreset, "custom">)}
                className="rounded-md border border-border p-0.5 gap-0.5"
                aria-label="Período"
            >
                {PERIOD_PRESETS.map((p) => (
                    <ToggleGroupItem
                        key={p.value}
                        value={p.value}
                        size="sm"
                        className="h-8 px-3 text-sm data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                    >
                        {p.label}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>

            <Popover
                open={calendarOpen}
                onOpenChange={(open) => {
                    setCalendarOpen(open);
                    if (open) setDraft({ from: range.start, to: range.end });
                }}
            >
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        className={cn("h-9 gap-2", preset === "custom" && "border-primary/50 bg-primary/5")}
                    >
                        <CalendarIcon className="h-4 w-4" />
                        <span className="tabular-nums">{preset === "all" ? "Desde o início" : formatRangeLabel(range)}</span>
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                        mode="range"
                        defaultMonth={draft?.from ?? range.start}
                        selected={draft}
                        onSelect={setDraft}
                        numberOfMonths={2}
                        locale={ptBR}
                        disabled={{ after: new Date() }}
                    />
                    <div className="p-3 border-t border-border flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setCalendarOpen(false)}>
                            Cancelar
                        </Button>
                        <Button
                            size="sm"
                            disabled={!draft?.from}
                            onClick={() => {
                                if (!draft?.from) return;
                                onCustomRange({ start: draft.from, end: draft.to ?? draft.from });
                                setCalendarOpen(false);
                            }}
                        >
                            Aplicar
                        </Button>
                    </div>
                </PopoverContent>
            </Popover>

            <div className="hidden sm:block h-6 w-px bg-border" />

            <Select value={lineId ?? undefined} onValueChange={onLineChange}>
                <SelectTrigger className="h-9 w-auto min-w-[150px]" aria-label="Linha">
                    <SelectValue placeholder="Linha" />
                </SelectTrigger>
                <SelectContent>
                    {lines.map((line) => (
                        <SelectItem key={line.id} value={line.id}>
                            {line.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            <Select value={agentId ?? ALL_AGENTS} onValueChange={(v) => onAgentChange(v === ALL_AGENTS ? null : v)}>
                <SelectTrigger
                    className={cn("h-9 w-auto min-w-[170px]", agentId && "border-primary/50 bg-primary/5")}
                    aria-label="Atendente"
                >
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={ALL_AGENTS}>Todas as atendentes</SelectItem>
                    {agentOptions.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                            {agent.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            <Select value={kind} onValueChange={(v) => onKindChange(v as ConversationKind)}>
                <SelectTrigger className={cn("h-9 w-auto min-w-[160px]", kind !== "all" && "border-primary/50 bg-primary/5")} aria-label="Conversas">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {KIND_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                            {o.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
