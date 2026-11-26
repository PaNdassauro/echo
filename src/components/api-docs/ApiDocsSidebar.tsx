import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Lock, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
    getMethodBadgeClass,
    getModeBadge,
    STATIC_PAGES,
    type EndpointCategory,
} from "@/data/apiDocsData";

interface ApiDocsSidebarProps {
    categories: EndpointCategory[];
    activeSlug: string | undefined;
    /** Fecha o Sheet no mobile depois de navegar. */
    onNavigate: () => void;
}

const SHORT_METHOD: Record<string, string> = { DELETE: "DEL", PATCH: "PATCH" };

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
    <p className="px-2 pb-1.5 pt-4 text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
        {children}
    </p>
);

/**
 * Item de navegação. O indicador de ativo é um trilho de 2px que aparece
 * instantaneamente — navegar pela doc é ação repetida, e animar o realce
 * atrasaria justo o feedback que confirma o clique.
 */
const NavLink = ({
    to,
    active,
    onNavigate,
    className,
    children,
    title,
}: {
    to: string;
    active: boolean;
    onNavigate: () => void;
    className?: string;
    children: React.ReactNode;
    title?: string;
}) => (
    <Link
        to={to}
        onClick={onNavigate}
        title={title}
        aria-current={active ? "page" : undefined}
        className={cn(
            "relative flex w-full items-center gap-2 rounded-md py-1.5 pl-3 pr-2 text-xs",
            "transition-colors duration-150",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            "before:absolute before:left-0 before:top-1/2 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-primary before:transition-opacity",
            active
                ? "bg-primary/10 font-medium text-primary before:opacity-100"
                : "text-muted-foreground before:opacity-0 hover:bg-muted hover:text-foreground",
            className,
        )}
    >
        {children}
    </Link>
);

const ApiDocsSidebar = ({ categories, activeSlug, onNavigate }: ApiDocsSidebarProps) => {
    const [search, setSearch] = useState("");

    // Categoria do endpoint aberto começa expandida — chegar por deep-link e
    // não ver onde você está na árvore é desorientador.
    const [manuallyToggled, setManuallyToggled] = useState<Record<string, boolean>>({});

    const activeCategory = useMemo(
        () => categories.find((c) => c.items.some((i) => i.slug === activeSlug))?.category,
        [categories, activeSlug],
    );

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return categories;
        return categories
            .map((cat) => ({
                ...cat,
                items: cat.items.filter(
                    (item) =>
                        item.description.toLowerCase().includes(q) ||
                        item.path.toLowerCase().includes(q) ||
                        item.method.toLowerCase().includes(q),
                ),
            }))
            .filter((cat) => cat.items.length > 0);
    }, [search, categories]);

    const isSearching = search.trim().length > 0;
    const firstInternalIndex = categories.findIndex((c) => c.internal);

    return (
        <div className="flex h-full flex-col">
            <div className="shrink-0 border-b border-border p-3">
                <div className="relative">
                    <Search
                        aria-hidden
                        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Filtrar endpoints…"
                        aria-label="Filtrar endpoints"
                        className="h-8 border-border bg-background pl-8 text-xs"
                    />
                </div>
            </div>

            <nav aria-label="Documentação da API" className="flex-1 overflow-y-auto px-3 pb-6">
                <SectionLabel>Introdução</SectionLabel>
                {STATIC_PAGES.map((page) => (
                    <NavLink
                        key={page.slug}
                        to={`/api-docs/${page.slug}`}
                        active={activeSlug === page.slug}
                        onNavigate={onNavigate}
                    >
                        {page.label}
                    </NavLink>
                ))}

                {filtered.map((category) => {
                    const globalIdx = categories.findIndex((c) => c.category === category.category);
                    const expanded =
                        manuallyToggled[category.category] ??
                        (isSearching || category.category === activeCategory || globalIdx === 0);

                    return (
                        <div key={category.category}>
                            {globalIdx === 0 && <SectionLabel>Echo API</SectionLabel>}
                            {globalIdx === firstInternalIndex && firstInternalIndex > 0 && (
                                <SectionLabel>
                                    {/* Só "Interno": o rótulo completo quebrava em
                                        duas linhas na coluna de 256px. */}
                                    <span
                                        className="inline-flex items-center gap-1.5"
                                        title="Superfície server-to-server — exige Authorization: Bearer"
                                    >
                                        <Lock aria-hidden className="h-3 w-3" />
                                        Interno
                                    </span>
                                </SectionLabel>
                            )}

                            <Collapsible
                                open={expanded}
                                onOpenChange={(open) =>
                                    setManuallyToggled((prev) => ({ ...prev, [category.category]: open }))
                                }
                            >
                                <CollapsibleTrigger className="group w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                    <div className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-muted">
                                        <span className="flex min-w-0 items-center gap-2">
                                            <category.icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                            <span className="truncate">
                                                {category.category.replace("QR Service - ", "")}
                                            </span>
                                            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                                                {category.items.length}
                                            </span>
                                        </span>
                                        <ChevronRight
                                            aria-hidden
                                            className={cn(
                                                "h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-200 ease-out-strong",
                                                expanded && "rotate-90",
                                                "motion-reduce:transition-none",
                                            )}
                                        />
                                    </div>
                                </CollapsibleTrigger>

                                <CollapsibleContent>
                                    <div className="ml-3 mt-0.5 space-y-0.5">
                                        {category.items.map((item) => {
                                            // Na seção interna o selo de modo seria
                                            // redundante: tudo ali já é QR.
                                            const modeBadge = category.internal ? null : getModeBadge(item.modes);
                                            return (
                                                <NavLink
                                                    key={item.slug}
                                                    to={`/api-docs/${item.slug}`}
                                                    active={activeSlug === item.slug}
                                                    onNavigate={onNavigate}
                                                    title={
                                                        modeBadge
                                                            ? `${item.description} — ${modeBadge.label}`
                                                            : item.description
                                                    }
                                                >
                                                    <span
                                                        aria-hidden
                                                        className={cn(
                                                            "shrink-0 rounded px-1 py-0 font-mono text-xs font-semibold leading-4",
                                                            getMethodBadgeClass(item.method),
                                                        )}
                                                    >
                                                        {SHORT_METHOD[item.method] ?? item.method}
                                                    </span>
                                                    <span className="min-w-0 flex-1 truncate text-left">
                                                        {item.description}
                                                    </span>
                                                    {modeBadge && (
                                                        <span
                                                            className={cn(
                                                                "shrink-0 rounded px-1 text-xs font-medium leading-4",
                                                                modeBadge.className,
                                                            )}
                                                        >
                                                            {modeBadge.short}
                                                        </span>
                                                    )}
                                                </NavLink>
                                            );
                                        })}
                                    </div>
                                </CollapsibleContent>
                            </Collapsible>
                        </div>
                    );
                })}

                {isSearching && filtered.length === 0 && (
                    <p className="px-2 pt-6 text-xs text-muted-foreground">
                        Nada encontrado para <span className="font-medium text-foreground">“{search}”</span>.
                    </p>
                )}
            </nav>
        </div>
    );
};

export default ApiDocsSidebar;
