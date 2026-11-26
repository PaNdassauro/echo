import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { getMethodBadgeClass, STATIC_PAGES, type EndpointCategory } from "@/data/apiDocsData";

interface ApiDocsCommandPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    categories: EndpointCategory[];
}

interface SearchEntry {
    slug: string;
    label: string;
    method?: string;
    path?: string;
    group: string;
    internal?: boolean;
    /** Texto extra que o cmdk considera no match, sem aparecer na linha. */
    keywords: string[];
}

const ApiDocsCommandPalette = ({ open, onOpenChange, categories }: ApiDocsCommandPaletteProps) => {
    const navigate = useNavigate();

    const entries = useMemo<SearchEntry[]>(() => {
        const staticEntries: SearchEntry[] = STATIC_PAGES.map((page) => ({
            slug: page.slug,
            label: page.label,
            group: "Introdução",
            keywords: ["introdução", "começar", page.label],
        }));

        const endpointEntries = categories.flatMap((category) =>
            category.items.map((item) => ({
                slug: item.slug,
                label: item.description,
                method: item.method,
                path: item.path,
                group: category.category,
                internal: category.internal,
                // Nomes de parâmetro entram no índice: quem lembra do campo mas
                // não do endpoint ("typing_ms") acha assim mesmo.
                keywords: [
                    item.path,
                    item.method,
                    item.slug,
                    ...(item.pathParams ?? []).map((p) => p.name),
                    ...(item.queryParams ?? []).map((p) => p.name),
                    ...(item.bodyFields ?? []).map((p) => p.name),
                ],
            })),
        );

        return [...staticEntries, ...endpointEntries];
    }, [categories]);

    const grouped = useMemo(() => {
        const map = new Map<string, SearchEntry[]>();
        for (const entry of entries) {
            const list = map.get(entry.group);
            if (list) list.push(entry);
            else map.set(entry.group, [entry]);
        }
        return [...map.entries()];
    }, [entries]);

    const [query, setQuery] = useState("");

    const handleSelect = (slug: string) => {
        onOpenChange(false);
        navigate(`/api-docs/${slug}`);
    };

    return (
        // shouldFilter fica no default (true): o índice é local, ~44 itens, e o
        // matcher do cmdk resolve. O GlobalSearchDialog do app desliga porque a
        // busca dele é no servidor — copiar aquele shell quebraria o filtro.
        <CommandDialog open={open} onOpenChange={onOpenChange}>
            <CommandInput
                placeholder="Buscar endpoint, parâmetro ou seção…"
                value={query}
                onValueChange={setQuery}
            />
            <CommandList>
                <CommandEmpty className="text-pretty">
                    {query ? `Nenhum endpoint ou seção com “${query}”. Tente o nome do campo ou o caminho.` : "Nenhum resultado."}
                </CommandEmpty>
                {grouped.map(([group, items]) => (
                    <CommandGroup key={group} heading={group.replace("QR Service - ", "Interno · ")}>
                        {items.map((entry) => (
                            <CommandItem
                                key={entry.slug}
                                value={`${entry.label} ${entry.keywords.join(" ")}`}
                                onSelect={() => handleSelect(entry.slug)}
                                className="group gap-2"
                            >
                                {entry.method ? (
                                    <span
                                        aria-hidden
                                        className={cn(
                                            "shrink-0 rounded px-1 font-mono text-xs font-semibold leading-4",
                                            getMethodBadgeClass(entry.method),
                                        )}
                                    >
                                        {entry.method}
                                    </span>
                                ) : null}
                                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                                {/* O realce da linha selecionada pinta o fundo com
                                    accent; sem herdar accent-foreground, estes dois
                                    sumiam contra ele. */}
                                {entry.internal && (
                                    <Lock
                                        aria-hidden
                                        className="h-3 w-3 shrink-0 text-muted-foreground group-data-[selected=true]:text-accent-foreground"
                                    />
                                )}
                                {entry.path && (
                                    <span className="hidden shrink-0 font-mono text-2xs text-muted-foreground group-data-[selected=true]:text-accent-foreground/75 sm:inline">
                                        {entry.path}
                                    </span>
                                )}
                            </CommandItem>
                        ))}
                    </CommandGroup>
                ))}
            </CommandList>
        </CommandDialog>
    );
};

export default ApiDocsCommandPalette;
