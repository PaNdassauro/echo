import { ArrowRight, Lock, UsersRound } from "lucide-react";
import { Link } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
    findEndpointBySlug,
    getMethodBadgeClass,
    getModeBadge,
    GROUP_SEND_NOTICE,
    INTERNAL_NO_EQUIVALENT_NOTICE,
    INTERNAL_SURFACE_NOTICE,
    type EndpointCategory,
    type EndpointItem,
    type FieldDoc,
} from "@/data/apiDocsData";

interface ApiDocsEndpointProps {
    endpoint: EndpointItem;
    category?: EndpointCategory;
    paramValues: Record<string, string>;
    onUpdateParam: (key: string, value: string) => void;
}

const SectionHeading = ({ children }: { children: React.ReactNode }) => (
    // Sentence case, não uppercase: um micro-label gritante inverte a
    // hierarquia contra o título do endpoint, que é o elemento principal.
    <h2 className="mb-3 text-base font-semibold tracking-tight text-foreground">{children}</h2>
);

const TypeChip = ({ type }: { type: string }) => (
    <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-2xs text-primary">{type}</span>
);

const RequiredChip = () => (
    <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-2xs font-medium text-red-700 dark:text-red-400">
        obrigatório
    </span>
);

const ApiDocsEndpoint = ({
    endpoint,
    category,
    paramValues,
    onUpdateParam,
}: ApiDocsEndpointProps) => {
    const modeBadge = getModeBadge(endpoint.modes);
    const equivalent = findEndpointBySlug(endpoint.publicEquivalent)?.endpoint;

    return (
        <article className="max-w-3xl space-y-8">
            <header>
                <div className="mb-3 flex flex-wrap items-center gap-2.5">
                    <span
                        className={cn(
                            "rounded px-2.5 py-0.5 font-mono text-xs font-semibold",
                            getMethodBadgeClass(endpoint.method),
                        )}
                    >
                        {endpoint.method}
                    </span>
                    <code className="break-all font-mono text-sm font-medium text-foreground sm:text-base">
                        {endpoint.path}
                    </code>
                    {modeBadge && (
                        <span
                            className={cn("rounded px-2 py-0.5 text-xs font-medium", modeBadge.className)}
                        >
                            {modeBadge.label}
                        </span>
                    )}
                </div>

                {category?.internal && (
                    <div className="mb-4 flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
                        <Lock
                            aria-hidden
                            className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                        />
                        <div className="min-w-0">
                            <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                                Endpoint interno
                            </p>
                            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                                {INTERNAL_SURFACE_NOTICE}
                            </p>
                            {/* Dizer só "você não pode usar" deixa a pessoa sem
                                saída. Quando existe equivalente na Echo API, o
                                aviso vira um encaminhamento. */}
                            {equivalent ? (
                                <p className="mt-2 text-sm leading-relaxed text-foreground">
                                    Use{" "}
                                    <Link
                                        to={`/api-docs/${equivalent.slug}`}
                                        className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        <span className="font-mono">
                                            {equivalent.method} {equivalent.path}
                                        </span>
                                        <ArrowRight aria-hidden className="h-3.5 w-3.5" />
                                    </Link>{" "}
                                    — faz o mesmo com a sua API Key. O echo-api já conversa com este
                                    serviço por dentro.
                                </p>
                            ) : (
                                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                                    {INTERNAL_NO_EQUIVALENT_NOTICE}
                                </p>
                            )}
                        </div>
                    </div>
                )}

                <p className="text-sm leading-relaxed text-muted-foreground">
                    {endpoint.detailedDescription || endpoint.description}
                </p>

                {endpoint.groupCaveat && (
                    <div className="mt-4 flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
                        <UsersRound
                            aria-hidden
                            className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                        />
                        <div>
                            <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                                Enviando para grupo
                            </p>
                            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                                {GROUP_SEND_NOTICE}
                            </p>
                        </div>
                    </div>
                )}
            </header>

            {endpoint.pathParams?.length ? (
                <ParamSection
                    title="Parâmetros de rota"
                    params={endpoint.pathParams}
                    prefix="path"
                    values={paramValues}
                    onChange={onUpdateParam}
                />
            ) : null}

            {endpoint.queryParams?.length ? (
                <ParamSection
                    title="Parâmetros de query"
                    params={endpoint.queryParams}
                    prefix="query"
                    values={paramValues}
                    onChange={onUpdateParam}
                />
            ) : null}

            {endpoint.bodyFields?.length ? (
                <ParamSection
                    title="Corpo da requisição"
                    params={endpoint.bodyFields}
                    prefix="body"
                    values={paramValues}
                    onChange={onUpdateParam}
                />
            ) : null}

            {endpoint.responseFields?.length ? (
                <section>
                    <SectionHeading>Campos da resposta</SectionHeading>
                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full min-w-[32rem] text-sm">
                            <thead>
                                <tr className="border-b border-border bg-muted/50">
                                    <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                                        Nome
                                    </th>
                                    <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                                        Tipo
                                    </th>
                                    <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                                        Descrição
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {endpoint.responseFields.map((field, idx) => (
                                    <tr
                                        key={field.name}
                                        className={cn(
                                            "border-b border-border last:border-0",
                                            idx % 2 === 1 && "bg-muted/20",
                                        )}
                                    >
                                        <th
                                            scope="row"
                                            className="px-4 py-2.5 text-left font-mono text-xs font-medium text-foreground"
                                        >
                                            {field.name}
                                        </th>
                                        <td className="px-4 py-2.5">
                                            <TypeChip type={field.type} />
                                        </td>
                                        <td className="px-4 py-2.5 text-xs text-muted-foreground">
                                            {field.description}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            ) : null}

            {endpoint.responses?.length ? (
                <section>
                    <SectionHeading>Códigos de status</SectionHeading>
                    <div className="space-y-2">
                        {endpoint.responses.map((resp) => (
                            <div
                                key={resp.status}
                                className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-4 py-2.5"
                            >
                                <span
                                    aria-hidden
                                    className={cn(
                                        "h-2 w-2 shrink-0 rounded-full",
                                        resp.status >= 200 && resp.status < 300 ? "bg-emerald-500" : "bg-red-500",
                                    )}
                                />
                                <span className="w-8 shrink-0 font-mono text-sm font-semibold tabular-nums text-foreground">
                                    {resp.status}
                                </span>
                                <span className="text-sm text-muted-foreground">{resp.description}</span>
                            </div>
                        ))}
                    </div>
                </section>
            ) : null}
        </article>
    );
};

interface ParamSectionProps {
    title: string;
    params: FieldDoc[];
    prefix: string;
    values: Record<string, string>;
    onChange: (key: string, value: string) => void;
}

const ParamSection = ({ title, params, prefix, values, onChange }: ParamSectionProps) => (
    <section>
        <SectionHeading>{title}</SectionHeading>
        <p className="-mt-2 mb-3 text-xs text-muted-foreground">
            Preencher aqui atualiza o exemplo de código.
        </p>
        <div className="overflow-hidden rounded-lg border border-border">
            {params.map((param, idx) => (
                <div
                    key={param.name}
                    className={cn(
                        // Abaixo de 480px o input de 176px não cabe ao lado do
                        // nome + tipo + selo: empilha em vez de estourar.
                        "flex flex-col gap-2 px-4 py-3 xs:flex-row xs:items-start xs:justify-between xs:gap-4",
                        idx < params.length - 1 && "border-b border-border",
                        idx % 2 === 1 && "bg-muted/20",
                    )}
                >
                    <div className="min-w-0 flex-1">
                        <div className="mb-0.5 flex flex-wrap items-center gap-2">
                            <label
                                htmlFor={`${prefix}_${param.name}`}
                                className="font-mono text-xs font-semibold text-foreground"
                            >
                                {param.name}
                            </label>
                            <TypeChip type={param.type} />
                            {param.required && <RequiredChip />}
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">{param.description}</p>
                    </div>
                    <Input
                        id={`${prefix}_${param.name}`}
                        className="h-8 w-full shrink-0 bg-background font-mono text-xs xs:w-44"
                        value={values[`${prefix}_${param.name}`] || ""}
                        onChange={(e) => onChange(`${prefix}_${param.name}`, e.target.value)}
                        placeholder={param.defaultValue}
                        spellCheck={false}
                    />
                </div>
            ))}
        </div>
    </section>
);

export default ApiDocsEndpoint;
