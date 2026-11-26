import { Link } from "react-router-dom";
import { ArrowLeft, Menu, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface ApiDocsHeaderProps {
    onOpenSidebar: () => void;
    onOpenSearch: () => void;
}

const ApiDocsHeader = ({ onOpenSidebar, onOpenSearch }: ApiDocsHeaderProps) => (
    // Material translúcido com o conteúdo passando por baixo. O fallback de
    // prefers-reduced-transparency vive em index.css (.api-docs-chrome).
    <header className="api-docs-chrome sticky top-0 z-50 shrink-0 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="flex h-14 items-center justify-between gap-2 px-3 sm:px-4">
            <div className="flex min-w-0 items-center gap-1.5">
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={onOpenSidebar}
                    aria-label="Abrir índice"
                    className="h-8 w-8 shrink-0 transition-transform duration-150 ease-out-strong active:scale-[0.96] motion-reduce:active:scale-100 md:hidden"
                >
                    <Menu className="h-4 w-4" />
                </Button>

                <Button asChild variant="ghost" size="icon" className="hidden h-8 w-8 shrink-0 md:inline-flex">
                    <Link to="/" aria-label="Voltar ao Echo">
                        <ArrowLeft className="h-4 w-4" />
                    </Link>
                </Button>

                <div className="flex min-w-0 items-center gap-2.5">
                    <img src="/echo-logo.png" alt="Echo" className="h-6 shrink-0" />
                    <div className="hidden h-5 w-px shrink-0 bg-border sm:block" />
                    <h1 className="hidden truncate text-sm font-semibold tracking-tight text-foreground sm:block">
                        Referência da API
                    </h1>
                    <Badge
                        variant="outline"
                        className="hidden h-5 shrink-0 border-border px-1.5 py-0 font-mono text-2xs text-muted-foreground sm:inline-flex"
                    >
                        v1
                    </Badge>
                </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
                {/* Também é a entrada de busca no touch, onde ⌘K não existe. */}
                <button
                    type="button"
                    onClick={onOpenSearch}
                    aria-label="Buscar na documentação"
                    className="flex h-8 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out-strong hover:bg-muted hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:active:scale-100"
                >
                    <Search aria-hidden className="h-3.5 w-3.5" />
                    <span className="hidden text-xs lg:inline">Buscar</span>
                    <kbd className="hidden rounded border border-border bg-background px-1 font-mono text-2xs lg:inline">
                        ⌘K
                    </kbd>
                </button>

                <Button asChild size="sm" variant="outline" className="h-8 text-xs">
                    <Link to="/auth">Dashboard</Link>
                </Button>
            </div>
        </div>
    </header>
);

export default ApiDocsHeader;
