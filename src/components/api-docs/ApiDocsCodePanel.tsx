import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Lock, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
import { findEndpointBySlug, getAuthProfile, type EndpointItem } from "@/data/apiDocsData";
import { buildSnippetLines } from "@/lib/api-docs/generators";
import { isSuccessStatus, resolveErrorBody } from "@/lib/api-docs/errorResponses";
import { highlightJson } from "@/lib/api-docs/jsonHighlight";
import { resolveRequest } from "@/lib/api-docs/resolveRequest";
import { linesToText } from "@/lib/api-docs/tokens";
import { SNIPPET_LANGUAGES, SNIPPET_LANGUAGE_LABELS } from "@/lib/api-docs/types";
import { useSnippetLanguage } from "@/hooks/useSnippetLanguage";
import { CodeBlock } from "./CodeBlock";
import { CopyButton } from "./CopyButton";
import { IconSwap } from "@/components/ui/icon-swap";

interface ApiDocsCodePanelProps {
    endpoint: EndpointItem | null;
    baseUrl: string;
    qrServiceUrl: string;
    apiKey: string;
    onApiKeyChange: (key: string) => void;
    paramValues: Record<string, string>;
}

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
    <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
        {children}
    </span>
);

const ApiDocsCodePanel = ({
    endpoint,
    baseUrl,
    qrServiceUrl,
    apiKey,
    onApiKeyChange,
    paramValues,
}: ApiDocsCodePanelProps) => {
    const { language, setLanguage } = useSnippetLanguage();
    const [revealKey, setRevealKey] = useState(false);

    // Status derivado, não estado solto: antes o 401 selecionado persistia ao
    // navegar para um endpoint sem 401 e o painel exibia um erro inventado.
    const [explicitStatus, setExplicitStatus] = useState<number | null>(null);
    useEffect(() => setExplicitStatus(null), [endpoint?.slug]);

    const ctx = useMemo(
        () => ({ baseUrl, qrServiceUrl, apiKey, paramValues }),
        [baseUrl, qrServiceUrl, apiKey, paramValues],
    );

    const request = useMemo(() => resolveRequest(endpoint, ctx), [endpoint, ctx]);
    const snippetLines = useMemo(
        () => buildSnippetLines(language, endpoint, ctx),
        [language, endpoint, ctx],
    );
    const snippetText = useMemo(() => linesToText(snippetLines), [snippetLines]);

    const statuses = useMemo(
        () => endpoint?.responses?.map((r) => r.status) ?? [200],
        [endpoint],
    );
    const selectedStatus =
        explicitStatus !== null && statuses.includes(explicitStatus) ? explicitStatus : statuses[0];

    const responseText = useMemo(() => {
        if (!endpoint) return '{\n  "status": "ok"\n}';
        return isSuccessStatus(selectedStatus)
            ? endpoint.response
            : resolveErrorBody(endpoint, selectedStatus);
    }, [endpoint, selectedStatus]);

    const responseLines = useMemo(() => highlightJson(responseText), [responseText]);
    const isInternal = endpoint ? getAuthProfile(endpoint) === "qr-bearer" : false;
    const equivalent = findEndpointBySlug(endpoint?.publicEquivalent)?.endpoint;

    return (
        <div className="flex flex-col gap-4 bg-muted/30 p-4">
            {/* Credencial */}
            <div>
                <label htmlFor="api-docs-key" className="mb-1.5 flex items-center justify-between">
                    <FieldLabel>API Key</FieldLabel>
                    {apiKey && (
                        <button
                            type="button"
                            onClick={() => onApiKeyChange("")}
                            className="text-xs text-muted-foreground transition-[color,transform] duration-150 ease-out hover:text-foreground active:scale-[0.96] motion-reduce:active:scale-100"
                        >
                            Limpar
                        </button>
                    )}
                </label>
                <div className="flex items-center overflow-hidden rounded-lg border border-border bg-background focus-within:ring-2 focus-within:ring-ring">
                    <Lock aria-hidden className="ml-3 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <Input
                        id="api-docs-key"
                        // Página pública: a chave nasce mascarada e só é revelada
                        // sob pedido. Fica em sessionStorage, morre com a aba.
                        type={revealKey ? "text" : "password"}
                        value={apiKey}
                        onChange={(e) => onApiKeyChange(e.target.value)}
                        placeholder="Cole sua API Key"
                        autoComplete="off"
                        spellCheck={false}
                        className="h-8 border-0 bg-transparent font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus-visible:ring-0 focus-visible:ring-offset-0"
                    />
                    <button
                        type="button"
                        onClick={() => setRevealKey((v) => !v)}
                        aria-label={revealKey ? "Ocultar API Key" : "Revelar API Key"}
                        className="mr-1 rounded p-1.5 text-muted-foreground transition-[color,transform] duration-150 ease-out hover:text-foreground active:scale-[0.96] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <IconSwap
                            active={revealKey ? "hide" : "show"}
                            durationMs={150}
                            icons={{
                                hide: <EyeOff className="h-3.5 w-3.5" />,
                                show: <Eye className="h-3.5 w-3.5" />,
                            }}
                        />
                    </button>
                </div>
                {isInternal && (
                    <p className="mt-1.5 flex gap-1.5 text-xs leading-relaxed text-muted-foreground">
                        <TriangleAlert
                            aria-hidden
                            className="mt-px h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
                        />
                        <span>
                            Este endpoint é interno e ignora a API Key — ele exige{" "}
                            <code className="font-mono">Authorization: Bearer</code>, então o exemplo usa
                            um placeholder de propósito.
                            {equivalent && (
                                <>
                                    {" "}
                                    Para usar a sua chave,{" "}
                                    <Link
                                        to={`/api-docs/${equivalent.slug}`}
                                        className="font-medium text-primary underline underline-offset-2 hover:no-underline"
                                    >
                                        vá para {equivalent.method} {equivalent.path}
                                    </Link>
                                    .
                                </>
                            )}
                        </span>
                    </p>
                )}
            </div>

            {/* URL resolvida */}
            <div>
                <FieldLabel>URL</FieldLabel>
                <div className="mt-1.5 flex items-start gap-1 rounded-lg border border-border bg-background p-2.5">
                    <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">
                        <span className="text-muted-foreground">{request.method}</span>{" "}
                        <span className="text-foreground">{request.url}</span>
                    </code>
                    <CopyButton value={request.url} label="URL" className="-mr-1 -mt-1 shrink-0" />
                </div>
            </div>

            {/* Snippet */}
            <CodeBlock
                lines={snippetLines}
                copyValue={snippetText}
                copyLabel={SNIPPET_LANGUAGE_LABELS[language]}
                header={
                    <div role="tablist" aria-label="Linguagem do exemplo" className="flex items-center gap-0.5 overflow-x-auto scrollbar-hide">
                        {SNIPPET_LANGUAGES.map((lang) => (
                            <button
                                key={lang}
                                role="tab"
                                aria-selected={language === lang}
                                onClick={() => setLanguage(lang)}
                                className={cn(
                                    "shrink-0 rounded px-2 py-1 text-2xs font-medium",
                                    "transition-[color,background-color,transform] duration-150 ease-out-strong",
                                    "active:scale-[0.96] motion-reduce:active:scale-100",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    language === lang
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground",
                                )}
                            >
                                {SNIPPET_LANGUAGE_LABELS[lang]}
                            </button>
                        ))}
                    </div>
                }
            />

            {/* Resposta */}
            <div>
                <div className="mb-1.5 flex items-center gap-2">
                    <FieldLabel>Resposta</FieldLabel>
                    {statuses.length > 1 && (
                        <div className="flex flex-wrap items-center gap-1">
                            {statuses.map((status) => (
                                <button
                                    key={status}
                                    onClick={() => setExplicitStatus(status)}
                                    aria-pressed={selectedStatus === status}
                                    className={cn(
                                        "flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-2xs",
                                        "transition-[color,background-color,transform] duration-150 ease-out-strong",
                                        "active:scale-[0.96] motion-reduce:active:scale-100",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        selectedStatus === status
                                            ? "bg-primary/15 text-foreground"
                                            : "text-muted-foreground hover:text-foreground",
                                    )}
                                >
                                    <span
                                        aria-hidden
                                        className={cn(
                                            "h-1.5 w-1.5 rounded-full",
                                            isSuccessStatus(status) ? "bg-emerald-500" : "bg-red-500",
                                        )}
                                    />
                                    {status}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
                <CodeBlock
                    lines={responseLines}
                    copyValue={responseText}
                    copyLabel="resposta"
                    showLineNumbers={false}
                    header={
                        <span className="pl-2 font-mono text-2xs text-muted-foreground">
                            {selectedStatus}
                        </span>
                    }
                />
            </div>
        </div>
    );
};

export default ApiDocsCodePanel;
