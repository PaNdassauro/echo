import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { ExternalLink } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { publicFunctionUrl } from "@/lib/runtimeConfig";

const ApiDocsTutorial = () => {
    const webhookUrl = publicFunctionUrl("whatsapp-webhook");

    const steps = [
        {
            number: 1,
            title: "Apps Meta for Developers",
            content: (
                <div className="space-y-3 text-sm text-foreground/80">
                    <p>Crie um aplicativo no painel de desenvolvedores do Facebook:</p>
                    <ol className="list-decimal list-inside space-y-1.5 ml-2 text-muted-foreground">
                        <li>
                            Acesse{" "}
                            <a
                                href="https://developers.facebook.com/"
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary hover:underline underline-offset-2 [text-underline-position:from-font] [text-decoration-thickness:from-font] inline-flex items-center gap-1"
                            >
                                developers.facebook.com
                                <ExternalLink className="w-3 h-3" />
                            </a>
                        </li>
                        <li>Vá em “Meus Apps” → “Criar App”</li>
                        <li>
                            Selecione <strong className="text-foreground">"Business"</strong> como tipo
                        </li>
                        <li>Preencha as informações necessárias</li>
                    </ol>
                </div>
            ),
        },
        {
            number: 2,
            title: "Configurar o produto WhatsApp",
            content: (
                <div className="space-y-3 text-sm text-foreground/80">
                    <p>No painel do seu app:</p>
                    <ol className="list-decimal list-inside space-y-1.5 ml-2 text-muted-foreground">
                        <li>
                            Selecione <strong className="text-foreground">“Adicionar Produto”</strong>
                        </li>
                        <li>Encontre “WhatsApp” e selecione “Configurar”</li>
                        <li>Siga os passos para vincular seu número de telefone</li>
                    </ol>
                </div>
            ),
        },
        {
            number: 3,
            title: "Configurar o webhook",
            content: (
                <div className="space-y-4">
                    {/* Webhook URL box */}
                    <div className="bg-muted/50 p-4 rounded-lg border border-border space-y-3">
                        <div>
                            <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                                URL de callback
                            </Label>
                            <div className="mt-1.5 flex items-center gap-2">
                                <code className="min-w-0 flex-1 break-all rounded-md border bg-background px-3 py-2 font-mono text-xs">
                                    {webhookUrl}
                                </code>
                                <CopyButton value={webhookUrl} label="URL de callback" className="shrink-0" />
                            </div>
                        </div>
                        <div>
                            <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                                Verify Token
                            </Label>
                            <p className="text-xs text-muted-foreground mt-1">
                                Crie uma senha segura e use a mesma no painel do Meta.
                            </p>
                        </div>
                    </div>

                    <div className="text-sm text-foreground/80 space-y-1.5">
                        <p>No painel do WhatsApp:</p>
                        <ol className="list-decimal list-inside space-y-1.5 ml-2 text-muted-foreground">
                            <li>
                                Vá em <strong className="text-foreground">“Configuração”</strong> →{" "}
                                <strong className="text-foreground">“Webhook”</strong>
                            </li>
                            <li>Selecione “Editar” e insira a URL acima</li>
                            <li>
                                Inscreva-se nos eventos:{" "}
                                <Badge variant="secondary" className="font-mono text-xs">
                                    messages
                                </Badge>
                            </li>
                        </ol>
                    </div>
                </div>
            ),
        },
        {
            number: 4,
            title: "Obter Credenciais",
            content: (
                <div className="text-sm text-foreground/80 space-y-2">
                    <p>Você precisará destas informações para configurar o Echo:</p>
                    <ul className="space-y-2 ml-2 text-muted-foreground">
                        <li className="flex items-start gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 mt-1.5" />
                            <span>
                                <strong className="text-foreground">Phone Number ID:</strong> Encontrado na aba
                                “Introdução”
                            </span>
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 mt-1.5" />
                            <span>
                                <strong className="text-foreground">Access Token:</strong> Gere um token permanente
                                em “Configurações do Negócio”
                            </span>
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 mt-1.5" />
                            <span>
                                <strong className="text-foreground">Verify Token:</strong> A senha que você criou
                                no passo anterior
                            </span>
                        </li>
                    </ul>
                </div>
            ),
        },
    ];

    return (
        <div className="max-w-3xl space-y-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                    Guia de configuração
                </h1>
                <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
                    Siga este guia para configurar a integração com a API do WhatsApp Business e conectar
                    ao Echo.
                </p>
            </header>

            <div className="space-y-6">
                {steps.map((step) => (
                    <div key={step.number} className="rounded-xl border border-border overflow-hidden">
                        <div className="bg-muted/30 px-5 py-3 border-b border-border flex items-center gap-3">
                            <div className="w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary text-xs font-bold">
                                {step.number}
                            </div>
                            <h3 className="text-sm font-semibold text-foreground">{step.title}</h3>
                        </div>
                        <div className="px-5 py-4">{step.content}</div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default ApiDocsTutorial;
