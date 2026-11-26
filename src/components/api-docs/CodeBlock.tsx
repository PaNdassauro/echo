import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SnippetLine, TokenType } from "@/lib/api-docs/types";
import { CopyButton } from "./CopyButton";

/**
 * Cores por tipo de token, em pares light/dark.
 *
 * O tema padrão da aplicação (`echo`) é claro, então as variantes `-300`/`-400`
 * sozinhas ficariam ilegíveis sobre branco — cada entrada tem um tom escuro
 * para o claro e um claro para o escuro.
 */
const TOKEN_CLASS: Record<TokenType, string> = {
    keyword: "text-violet-700 dark:text-violet-300",
    function: "text-blue-700 dark:text-blue-300",
    string: "text-emerald-700 dark:text-emerald-300",
    number: "text-amber-700 dark:text-amber-300",
    boolean: "text-amber-700 dark:text-amber-300",
    null: "text-rose-700 dark:text-rose-300",
    punctuation: "text-muted-foreground",
    operator: "text-muted-foreground",
    comment: "italic text-muted-foreground/80",
    flag: "text-violet-700 dark:text-violet-300",
    url: "text-sky-700 dark:text-sky-300",
    property: "text-sky-700 dark:text-sky-300",
    variable: "text-foreground",
    plain: "text-foreground",
};

interface CodeBlockProps {
    lines: SnippetLine[];
    /** Texto puro para o botão de copiar. */
    copyValue: string;
    copyLabel: string;
    /** Conteúdo à esquerda do cabeçalho (rótulo ou tabs de linguagem). */
    header?: ReactNode;
    showLineNumbers?: boolean;
    className?: string;
}

export function CodeBlock({
    lines,
    copyValue,
    copyLabel,
    header,
    showLineNumbers = true,
    className,
}: CodeBlockProps) {
    return (
        <div className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}>
            <div className="flex min-h-9 items-center justify-between gap-2 border-b border-border bg-muted/40 pl-1 pr-1.5">
                <div className="min-w-0 flex-1">{header}</div>
                <CopyButton value={copyValue} label={copyLabel} />
            </div>

            {/* Scroll horizontal no bloco inteiro, não por linha: rolar linha a
                linha desalinharia o recuo. A calha de números fica sticky para
                não sair de vista junto. */}
            <div className="overflow-x-auto">
                <pre className="w-max min-w-full py-2.5 font-mono text-xs leading-relaxed">
                    <code>
                        {lines.map((line, idx) => (
                            <div key={idx} className="flex">
                                {showLineNumbers && (
                                    <span
                                        aria-hidden
                                        className="sticky left-0 z-10 w-9 shrink-0 select-none bg-card pr-3 text-right text-xs tabular-nums text-muted-foreground/45"
                                    >
                                        {idx + 1}
                                    </span>
                                )}
                                <span className={cn("whitespace-pre", !showLineNumbers && "pl-3", "pr-3")}>
                                    {line.tokens.length === 0 ? (
                                        " "
                                    ) : (
                                        line.tokens.map((token, tIdx) => (
                                            <span key={tIdx} className={TOKEN_CLASS[token.type]}>
                                                {token.text}
                                            </span>
                                        ))
                                    )}
                                </span>
                            </div>
                        ))}
                    </code>
                </pre>
            </div>
        </div>
    );
}
