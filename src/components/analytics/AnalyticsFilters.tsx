import { useState, useEffect } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { CalendarIcon, Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import type { DateRange } from "react-day-picker";

interface FilterOption {
    id: string;
    label: string;
}

interface AnalyticsFiltersProps {
    dateRange: { from: Date; to: Date };
    onDateRangeChange: (from: Date, to: Date) => void;
    selectedPhones: string[];
    onPhonesChange: (ids: string[]) => void;
    selectedSectors: string[];
    onSectorsChange: (ids: string[]) => void;
    selectedAgents: string[];
    onAgentsChange: (ids: string[]) => void;
    onReset: () => void;
}

function MultiSelectFilter({
    label,
    options,
    selected,
    onChange,
    isLoading,
}: {
    label: string;
    options: FilterOption[];
    selected: string[];
    onChange: (ids: string[]) => void;
    isLoading?: boolean;
}) {
    const [open, setOpen] = useState(false);

    const toggleOption = (id: string) => {
        if (selected.includes(id)) {
            onChange(selected.filter((s) => s !== id));
        } else {
            onChange([...selected, id]);
        }
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    className={cn(
                        "h-9 px-3 gap-2 border-border bg-card shadow-sm transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out",
                        selected.length > 0 && "border-primary/50 bg-primary/5"
                    )}
                >
                    <span className="text-sm">{label}</span>
                    {selected.length > 0 && (
                        <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                            {selected.length}
                        </Badge>
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-0" align="start">
                <ScrollArea className="h-64">
                    <div className="p-2 space-y-1">
                        {isLoading ? (
                            <div className="p-4 text-center text-sm text-muted-foreground">
                                Carregando…
                            </div>
                        ) : options.length === 0 ? (
                            <div className="p-4 text-center text-sm text-muted-foreground text-pretty">
                                Nenhuma opção disponível para este filtro no período.
                            </div>
                        ) : (
                            options.map((option) => (
                                <div
                                    key={option.id}
                                    className="flex items-center gap-2 p-2 rounded-md hover:bg-muted/50 cursor-pointer transition-colors"
                                    onClick={() => toggleOption(option.id)}
                                >
                                    <Checkbox
                                        checked={selected.includes(option.id)}
                                        onCheckedChange={() => toggleOption(option.id)}
                                    />
                                    <span className="text-sm truncate">{option.label}</span>
                                </div>
                            ))
                        )}
                    </div>
                </ScrollArea>
                {selected.length > 0 && (
                    <div className="border-t p-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="w-full text-xs"
                            onClick={() => onChange([])}
                        >
                            Limpar seleção
                        </Button>
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}

export function AnalyticsFilters({
    dateRange,
    onDateRangeChange,
    selectedPhones,
    onPhonesChange,
    selectedSectors,
    onSectorsChange,
    selectedAgents,
    onAgentsChange,
    onReset,
}: AnalyticsFiltersProps) {
    const { currentOrganization } = useOrganization();
    const [phones, setPhones] = useState<FilterOption[]>([]);
    const [sectors, setSectors] = useState<FilterOption[]>([]);
    const [agents, setAgents] = useState<FilterOption[]>([]);
    const [isLoadingOptions, setIsLoadingOptions] = useState(true);

    // Fetch filter options
    useEffect(() => {
        if (!currentOrganization?.id) return;

        const fetchOptions = async () => {
            setIsLoadingOptions(true);
            try {
                const [phonesRes, sectorsRes, agentsRes] = await Promise.all([
                    supabase
                        .from("phone_numbers")
                        .select("id, phone_number, display_name")
                        .eq("organization_id", currentOrganization.id),
                    supabase
                        .from("sectors")
                        .select("id, name")
                        .eq("organization_id", currentOrganization.id),
                    supabase
                        .from("organization_members")
                        .select("user_id, profiles!inner(id, full_name, email)")
                        .eq("organization_id", currentOrganization.id),
                ]);

                if (phonesRes.data) {
                    setPhones(
                        phonesRes.data.map((p) => ({
                            id: p.id,
                            label: p.display_name || p.phone_number,
                        }))
                    );
                }

                if (sectorsRes.data) {
                    setSectors(sectorsRes.data.map((s: any) => ({ id: s.id, label: s.name })));
                }

                if (agentsRes.data) {
                    setAgents(
                        agentsRes.data.map((a) => ({
                            id: a.user_id,
                            label: (a.profiles as { full_name?: string; email?: string })?.full_name ||
                                (a.profiles as { full_name?: string; email?: string })?.email ||
                                "Sem nome",
                        }))
                    );
                }
            } catch (err) {
                console.error("Error fetching filter options:", err);
            } finally {
                setIsLoadingOptions(false);
            }
        };

        fetchOptions();
    }, [currentOrganization?.id]);

    const hasFilters =
        selectedPhones.length > 0 ||
        selectedSectors.length > 0 ||
        selectedAgents.length > 0;

    const handleDateSelect = (range: DateRange | undefined) => {
        if (range?.from && range?.to) {
            onDateRangeChange(range.from, range.to);
        } else if (range?.from) {
            onDateRangeChange(range.from, range.from);
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-2 p-4 bg-card border border-border rounded-lg shadow-sm">
            <Filter className="h-4 w-4 text-muted-foreground" />

            {/* Date Range Picker */}
            <Popover>
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        className="h-9 px-3 gap-2 border-border bg-card shadow-sm"
                    >
                        <CalendarIcon className="h-4 w-4" />
                        <span className="text-sm">
                            {format(dateRange.from, "dd/MM", { locale: ptBR })} -{" "}
                            {format(dateRange.to, "dd/MM/yyyy", { locale: ptBR })}
                        </span>
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                        mode="range"
                        defaultMonth={dateRange.from}
                        selected={{ from: dateRange.from, to: dateRange.to }}
                        onSelect={handleDateSelect}
                        numberOfMonths={2}
                        locale={ptBR}
                    />
                    <div className="p-3 border-t border-border flex justify-end">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs h-8 text-muted-foreground hover:text-foreground"
                            onClick={() => onDateRangeChange(new Date(), new Date())}
                        >
                            Voltar para hoje
                        </Button>
                    </div>
                </PopoverContent>
            </Popover>

            <div className="h-6 w-px bg-border" />

            {/* Phone Filter */}
            <MultiSelectFilter
                label="Número"
                options={phones}
                selected={selectedPhones}
                onChange={onPhonesChange}
                isLoading={isLoadingOptions}
            />

            {/* Sector Filter */}
            <MultiSelectFilter
                label="Setor"
                options={sectors}
                selected={selectedSectors}
                onChange={onSectorsChange}
                isLoading={isLoadingOptions}
            />

            {/* Agent Filter */}
            <MultiSelectFilter
                label="Atendente"
                options={agents}
                selected={selectedAgents}
                onChange={onAgentsChange}
                isLoading={isLoadingOptions}
            />

            {/* Reset Button */}
            {hasFilters && (
                <>
                    <div className="h-6 w-px bg-border" />
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 px-2 text-muted-foreground hover:text-foreground"
                        onClick={onReset}
                    >
                        <X className="h-4 w-4 mr-1" />
                        Limpar filtros
                    </Button>
                </>
            )}
        </div>
    );
}
