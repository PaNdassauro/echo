import { Lock, Shield, Users, Webhook } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { webhookEvents } from "@/data/apiDocsData";
import { highlightJson } from "@/lib/api-docs/jsonHighlight";
import { CodeBlock } from "./CodeBlock";
import { CopyButton } from "./CopyButton";
import { Link } from "react-router-dom";

interface ApiDocsAuthProps {
    baseUrl: string;
}

interface InfoCard {
    icon: LucideIcon;
    title: string;
    desc: string;
    /** Só o card de aviso recebe acento — três caixas tintadas em sequência
     *  leem como pilha de alerta, não como informação. */
    tone: "neutral" | "warning";
}

const INFO_CARDS: InfoCard[] = [
    {
        icon: Lock,
        tone: "neutral",
        title: "Escopo por organização",
        desc: "Cada API Key é vinculada a uma organização. Todas as operações são filtradas automaticamente para retornar apenas dados da organização associada à chave — você nunca precisa enviar organization_id.",
    },
    {
        icon: Users,
        tone: "neutral",
        title: "Multi-tenancy",
        desc: "O mesmo contato pode ter conversas com múltiplas organizações. Cada uma vê apenas as próprias conversas e dados, com isolamento completo.",
    },
    {
        icon: Shield,
        tone: "warning",
        title: "Guarde a chave no servidor",
        desc: "A API Key dá acesso total aos dados da sua organização. Use-a apenas a partir do seu backend — nunca a exponha em código de frontend, app mobile ou repositório público.",
    },
];

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
        {children}
    </section>
);

const Code = ({ children }: { children: React.ReactNode }) => (
    <code className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-xs text-primary">
        {children}
    </code>
);

const ApiDocsAuth = ({ baseUrl }: ApiDocsAuthProps) => (
    <div className="max-w-3xl space-y-10">
        <header>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                Autenticação
            </h1>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
                Toda requisição à Echo API — exceto <Code>/health</Code> — precisa da sua API Key no
                cabeçalho <Code>x-api-key</Code>. Crie e revogue chaves em{" "}
                <Link to="/settings?tab=api" className="font-medium text-foreground underline underline-offset-2 [text-underline-position:from-font] [text-decoration-thickness:from-font]">Configurações → API</Link>.
            </p>
        </header>

        <div className="overflow-hidden rounded-xl border border-border">
            <div className="border-b border-border bg-muted/30 px-5 py-3">
                <h2 className="text-sm font-semibold">Header obrigatório</h2>
            </div>
            <div className="px-5 py-4">
                <code className="block rounded-lg bg-primary/5 px-3 py-2 font-mono text-sm text-primary">
                    x-api-key: YOUR_API_KEY
                </code>
            </div>
        </div>

        <div className="grid gap-3">
            {INFO_CARDS.map((card) => (
                <div
                    key={card.title}
                    className={cn(
                        "flex items-start gap-4 rounded-xl border px-5 py-4",
                        card.tone === "warning"
                            ? "border-amber-500/40 bg-amber-500/5"
                            : "border-border bg-card",
                    )}
                >
                    <card.icon
                        aria-hidden
                        className={cn(
                            "mt-0.5 h-5 w-5 shrink-0",
                            card.tone === "warning"
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground",
                        )}
                    />
                    <div>
                        <h3
                            className={cn(
                                "text-sm font-semibold",
                                card.tone === "warning"
                                    ? "text-amber-700 dark:text-amber-300"
                                    : "text-foreground",
                            )}
                        >
                            {card.title}
                        </h3>
                        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{card.desc}</p>
                    </div>
                </div>
            ))}
        </div>

        <Section title="URL base">
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-4 py-2.5">
                <code className="min-w-0 break-all font-mono text-sm">{baseUrl}</code>
                <CopyButton value={baseUrl} label="URL base" className="shrink-0" />
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
                O endpoint <Code>GET /health</Code> não exige autenticação e responde{" "}
                <Code>{`{ "status": "ok" }`}</Code> — use-o para checar conectividade.
            </p>
        </Section>

        <Section title="Superfícies e credenciais">
            {/* A confusão que mais custa tempo: os endpoints marcados como
                internos rodam em outro host e nem leem o header x-api-key. */}
            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[34rem] text-sm">
                    <thead>
                        <tr className="border-b border-border bg-muted/50 text-left">
                            <th scope="col" className="px-4 py-2.5 text-xs font-medium text-muted-foreground">
                                Superfície
                            </th>
                            <th scope="col" className="px-4 py-2.5 text-xs font-medium text-muted-foreground">
                                Header
                            </th>
                            <th scope="col" className="px-4 py-2.5 text-xs font-medium text-muted-foreground">
                                Quem pode usar
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr className="border-b border-border">
                            <th scope="row" className="px-4 py-3 text-left text-xs font-medium text-foreground">
                                Echo API
                            </th>
                            <td className="px-4 py-3 font-mono text-xs text-muted-foreground">x-api-key</td>
                            <td className="px-4 py-3 text-xs text-muted-foreground">
                                Qualquer integração, com a sua API Key
                            </td>
                        </tr>
                        <tr className="bg-muted/20">
                            <th scope="row" className="px-4 py-3 text-left text-xs font-medium text-foreground">
                                QR Service <span className="font-normal text-muted-foreground">(interno)</span>
                            </th>
                            <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                                Authorization: Bearer
                            </td>
                            <td className="px-4 py-3 text-xs text-muted-foreground">
                                Só server-to-server — exige JWT de sessão ou service-role key
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </Section>

        <section className="border-t border-border pt-8">
            <div className="mb-3 flex items-center gap-3">
                <Webhook aria-hidden className="h-5 w-5 text-primary" />
                <h2 className="text-xl font-semibold tracking-tight text-foreground">Webhooks</h2>
            </div>
            <p className="mb-6 max-w-prose text-sm leading-relaxed text-muted-foreground">
                Configure a URL em <Link to="/settings?tab=api" className="font-medium text-foreground underline underline-offset-2 [text-underline-position:from-font] [text-decoration-thickness:from-font]">Configurações → API</Link>{" "}
                para receber estes eventos por <Code>POST</Code>.
            </p>

            <div className="space-y-4">
                {webhookEvents.map((event) => (
                    <div key={event.name}>
                        <div className="mb-1.5">
                            <h3 className="font-mono text-sm font-semibold text-foreground">{event.name}</h3>
                            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                                {event.description}
                            </p>
                        </div>
                        <CodeBlock
                            lines={highlightJson(event.payload)}
                            copyValue={event.payload}
                            copyLabel={`payload de ${event.name}`}
                            showLineNumbers={false}
                            header={
                                <span className="pl-2 font-mono text-2xs text-muted-foreground">payload</span>
                            }
                        />
                    </div>
                ))}
            </div>
        </section>
    </div>
);

export default ApiDocsAuth;
