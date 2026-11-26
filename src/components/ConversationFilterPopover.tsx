import { useMemo, useState, type ReactNode } from "react";
import { Check, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface FilterOption {
    id: string;
    label: string;
    /** Bolinha colorida à esquerda (tags). */
    color?: string;
    /** Iniciais no marcador redondo (usuários). */
    initials?: string;
}

export interface FilterGroup {
    key: string;
    /** Cabeçalho da seção: "Tags", "Usuários". */
    label: string;
    options: FilterOption[];
    selected: string[];
    onChange: (ids: string[]) => void;
    /** Não existe opção alguma nesta linha. */
    noOptionsLabel: string;
}

interface ConversationFilterPopoverProps {
    icon: ReactNode;
    /** Ex.: "Filtros" — a contagem selecionada é acrescentada sozinha. */
    label: string;
    searchPlaceholder: string;
    /** A busca não achou nada em nenhuma seção. */
    emptySearchLabel: string;
    groups: FilterGroup[];
    /** Tamanho do gatilho, para acompanhar os botões vizinhos da linha de ações. */
    triggerClassName?: string;
}

/** Acima disso a lista deixa de caber de olho e ganha campo de busca. */
const SEARCH_THRESHOLD = 8;

/**
 * Filtro multi-select da lista de conversas: UM gatilho de ícone (a linha de
 * ações não tem largura para rótulo em texto, nem para um botão por filtro) com
 * o total selecionado, abrindo uma seção por dimensão — tags e usuários.
 *
 * Semântica: OR dentro de cada seção, AND entre seções (quem chama intersecta).
 */
export const ConversationFilterPopover = ({
    icon,
    label,
    searchPlaceholder,
    emptySearchLabel,
    groups,
    triggerClassName,
}: ConversationFilterPopoverProps) => {
    const [searchQuery, setSearchQuery] = useState("");
    const [open, setOpen] = useState(false);

    const totalSelected = groups.reduce((sum, group) => sum + group.selected.length, 0);
    const totalOptions = groups.reduce((sum, group) => sum + group.options.length, 0);

    // Campo de busca só em lista grande: com três nomes o autoFocus abriria o
    // teclado do celular por cima da lista sem motivo.
    const showSearch = totalOptions > SEARCH_THRESHOLD;

    const visibleGroups = useMemo(() => {
        const needle = showSearch ? searchQuery.trim().toLowerCase() : "";
        return groups.map((group) => ({
            ...group,
            selectedSet: new Set(group.selected),
            matches: needle
                ? group.options.filter((option) => option.label.toLowerCase().includes(needle))
                : group.options,
            searching: needle.length > 0,
        }));
    }, [groups, searchQuery, showSearch]);

    // Com busca ativa, seção sem resultado desaparece; sem busca, ela explica
    // por que está vazia (ninguém assumiu / nenhuma tag nesta linha).
    const renderedGroups = visibleGroups.filter((group) => !group.searching || group.matches.length > 0);

    const triggerLabel = totalSelected > 0
        ? `${label} (${totalSelected} selecionado${totalSelected > 1 ? "s" : ""})`
        : label;

    const toggle = (group: (typeof visibleGroups)[number], id: string) => {
        group.onChange(
            group.selectedSet.has(id) ? group.selected.filter((s) => s !== id) : [...group.selected, id],
        );
    };

    return (
        <Popover
            open={open}
            onOpenChange={(isOpen) => {
                setOpen(isOpen);
                if (!isOpen) setSearchQuery("");
            }}
        >
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    size="icon"
                    className={cn("theme-sidebar-action-button relative h-9 w-9 shrink-0", triggerClassName)}
                    title={triggerLabel}
                    aria-label={triggerLabel}
                >
                    {icon}
                    {/* Filtro ativo como elemento FILHO com background próprio: o
                        tema whatsapp fixa background/color do botão e força
                        svg { color: currentColor } (index.css), então uma classe
                        de cor no gatilho ou no ícone ficaria invisível. */}
                    {totalSelected > 0 && (
                        <span
                            aria-hidden="true"
                            className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-2xs font-bold tabular-nums flex items-center justify-center ring-1 ring-card"
                        >
                            {totalSelected}
                        </span>
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-2" align="start">
                <div className="space-y-2">
                    {showSearch && (
                        <div className="relative">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                            <Input
                                placeholder={searchPlaceholder}
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="h-7 pl-7 text-xs"
                                autoFocus
                            />
                        </div>
                    )}
                    <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
                        {renderedGroups.length === 0 ? (
                            <p className="text-xs text-muted-foreground text-center py-2">
                                {emptySearchLabel}
                            </p>
                        ) : (
                            renderedGroups.map((group) => (
                                <div key={group.key} role="group" aria-label={group.label} className="space-y-1">
                                    <p className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        {group.label}
                                    </p>
                                    {group.matches.length === 0 ? (
                                        <p className="px-2 py-1 text-xs text-muted-foreground">
                                            {group.noOptionsLabel}
                                        </p>
                                    ) : (
                                        group.matches.map((option) => {
                                            const isSelected = group.selectedSet.has(option.id);
                                            return (
                                                <button
                                                    key={option.id}
                                                    role="checkbox"
                                                    aria-checked={isSelected}
                                                    onClick={() => toggle(group, option.id)}
                                                    className={cn(
                                                        "w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded hover:bg-accent active:bg-accent",
                                                        isSelected && "bg-accent",
                                                    )}
                                                >
                                                    {/* Caixa desenhada, não o Checkbox do shadcn: ele
                                                        renderiza um <button>, e button dentro de button
                                                        é HTML inválido. A linha inteira é o alvo. */}
                                                    <span
                                                        aria-hidden="true"
                                                        className={cn(
                                                            "h-4 w-4 shrink-0 rounded-sm border border-primary flex items-center justify-center",
                                                            isSelected && "bg-primary text-primary-foreground",
                                                        )}
                                                    >
                                                        {isSelected && <Check className="h-3 w-3" />}
                                                    </span>
                                                    {option.color && (
                                                        <div
                                                            className="w-3 h-3 rounded-full shrink-0"
                                                            style={{ backgroundColor: option.color }}
                                                        />
                                                    )}
                                                    {option.initials && (
                                                        <span className="w-4 h-4 shrink-0 rounded-full bg-primary/10 text-primary text-2xs font-medium flex items-center justify-center">
                                                            {option.initials}
                                                        </span>
                                                    )}
                                                    <span className="truncate" title={option.label}>{option.label}</span>
                                                </button>
                                            );
                                        })
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                    {totalSelected > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="w-full h-7 text-xs"
                            onClick={() => groups.forEach((group) => group.selected.length > 0 && group.onChange([]))}
                        >
                            Limpar seleção
                        </Button>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
};
