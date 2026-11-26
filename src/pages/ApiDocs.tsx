import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import {
    allEndpointCategories,
    findEndpointBySlug,
    isStaticPageSlug,
    type EndpointItem,
} from "@/data/apiDocsData";
import ApiDocsHeader from "@/components/api-docs/ApiDocsHeader";
import ApiDocsSidebar from "@/components/api-docs/ApiDocsSidebar";
import ApiDocsEndpoint from "@/components/api-docs/ApiDocsEndpoint";
import ApiDocsCodePanel from "@/components/api-docs/ApiDocsCodePanel";
import ApiDocsAuth from "@/components/api-docs/ApiDocsAuth";
import ApiDocsTutorial from "@/components/api-docs/ApiDocsTutorial";
import ApiDocsCommandPalette from "@/components/api-docs/ApiDocsCommandPalette";
import { publicFunctionUrl, qrServiceUrl } from "@/lib/runtimeConfig";

// sessionStorage, não localStorage: /api-docs é a única rota pública do app, e
// uma API key esquecida no localStorage fica legível por qualquer XSS em
// qualquer rota da mesma origem, sem prazo. Aqui ela morre com a aba.
const API_KEY_STORAGE = "echo_api_docs_key";

const readStoredApiKey = (): string => {
    try {
        return sessionStorage.getItem(API_KEY_STORAGE) ?? "";
    } catch {
        return "";
    }
};

const ApiDocs = () => {
    const { slug } = useParams<{ slug: string }>();
    const isMobile = useIsMobile();
    // Bases mostradas nos exemplos: o endereço público da instalação, lido na hora (a doc é pública).
    const baseUrl = publicFunctionUrl("echo-api");
    const qrBaseUrl = qrServiceUrl();

    const [paramValues, setParamValues] = useState<Record<string, string>>({});
    const [apiKey, setApiKeyState] = useState(readStoredApiKey);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);

    const scrollRef = useRef<HTMLElement>(null);

    const lookup = useMemo(() => findEndpointBySlug(slug), [slug]);
    const currentEndpoint: EndpointItem | null = lookup?.endpoint ?? null;
    const isStaticPage = isStaticPageSlug(slug);

    // Rolar de volta ao topo ao trocar de endpoint. Sem isso, clicar num item
    // novo deixava você no meio dele, com o scroll herdado do anterior.
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: 0 });
        setParamValues({});
    }, [slug]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setPaletteOpen((open) => !open);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    const setApiKey = useCallback((value: string) => {
        setApiKeyState(value);
        try {
            if (value) sessionStorage.setItem(API_KEY_STORAGE, value);
            else sessionStorage.removeItem(API_KEY_STORAGE);
        } catch {
            /* modo privado — a chave só não persiste entre recarregamentos */
        }
    }, []);

    const handleUpdateParam = useCallback((key: string, value: string) => {
        setParamValues((prev) => ({ ...prev, [key]: value }));
    }, []);

    // Slug desconhecido (typo, endpoint removido) volta para a introdução. É
    // síncrono porque o dado é local — não precisa de estado de carregamento.
    if (!lookup && !isStaticPage) {
        return <Navigate to="/api-docs/auth" replace />;
    }

    const sidebar = (
        <ApiDocsSidebar
            categories={allEndpointCategories}
            activeSlug={slug}
            onNavigate={() => setSidebarOpen(false)}
        />
    );

    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <ApiDocsHeader
                onOpenSidebar={() => setSidebarOpen(true)}
                onOpenSearch={() => setPaletteOpen(true)}
            />

            <div className="flex flex-1 overflow-hidden">
                {isMobile ? (
                    <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
                        <SheetContent side="left" className="w-[86vw] max-w-xs p-0">
                            <SheetTitle className="sr-only">Índice da documentação</SheetTitle>
                            {sidebar}
                        </SheetContent>
                    </Sheet>
                ) : (
                    <aside className="w-64 shrink-0 border-r border-border bg-muted/20">{sidebar}</aside>
                )}

                {/* Scroll nativo em vez de ScrollArea do Radix: numa página de
                    leitura o scrollbar customizado não paga a indireção, e o
                    reset ao topo vira um scrollTo direto no ref. */}
                <main
                    ref={scrollRef}
                    className="flex-1 overflow-y-auto overflow-x-hidden focus-visible:outline-none"
                    tabIndex={-1}
                >
                    <div className="flex min-h-full flex-col xl:flex-row">
                        <div className="min-w-0 flex-1 px-4 py-6 sm:px-6 md:px-8 md:py-8">
                            {/* key no slug: remonta o conteúdo e dispara o fade de
                                entrada a cada troca de endpoint — sem ele, o reset
                                de scroll parece um salto. Só opacidade, 150ms: nada
                                que atrase quem está navegando.
                                O easing vai pela var porque `ease-*` do
                                tailwindcss-animate lê animationTimingFunction, e o
                                easing do projeto vive em transitionTimingFunction. */}
                            <div
                                key={slug}
                                className="animate-in fade-in duration-150 [animation-timing-function:var(--ease-out-strong)] motion-reduce:animate-none"
                            >
                                {slug === "auth" ? (
                                    <ApiDocsAuth baseUrl={baseUrl} />
                                ) : slug === "tutorial" ? (
                                    <ApiDocsTutorial />
                                ) : currentEndpoint ? (
                                    <ApiDocsEndpoint
                                        endpoint={currentEndpoint}
                                        category={lookup?.category}
                                        paramValues={paramValues}
                                        onUpdateParam={handleUpdateParam}
                                    />
                                ) : null}
                            </div>
                        </div>

                        {/* Um único mount do painel: montá-lo duas vezes (uma
                            por breakpoint) daria dois estados de API key. Abaixo
                            de xl ele empilha; de xl pra cima vira 3ª coluna. */}
                        <div className="w-full shrink-0 border-t border-border xl:sticky xl:top-0 xl:h-full xl:w-[400px] xl:self-start xl:overflow-y-auto xl:border-l xl:border-t-0">
                            <ApiDocsCodePanel
                                endpoint={currentEndpoint}
                                baseUrl={baseUrl}
                                qrServiceUrl={qrBaseUrl}
                                apiKey={apiKey}
                                onApiKeyChange={setApiKey}
                                paramValues={paramValues}
                            />
                        </div>
                    </div>
                </main>
            </div>

            <ApiDocsCommandPalette
                open={paletteOpen}
                onOpenChange={setPaletteOpen}
                categories={allEndpointCategories}
            />
        </div>
    );
};

export default ApiDocs;
