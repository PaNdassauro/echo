import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Sparkles, RefreshCw, Send, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Message {
    role: 'user' | 'assistant';
    content: string;
}

interface AIInsightsProps {
    orgId: string;
    startDate: string;
    endDate: string;
}

export function AIInsights({ orgId, startDate, endDate }: AIInsightsProps) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [inputValue, setInputValue] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const scrollAreaRef = useRef<HTMLDivElement>(null);

    // Scroll to bottom when messages change
    useEffect(() => {
        if (scrollAreaRef.current) {
            const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
            if (scrollContainer) {
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
            }
        }
    }, [messages]);

    const generateInsights = async (customMessage?: string) => {
        setIsLoading(true);

        const newMessages: Message[] = customMessage
            ? [...messages, { role: 'user', content: customMessage }]
            : [];

        if (customMessage) {
            setMessages(newMessages);
            setInputValue("");
        }

        try {
            const { data, error } = await supabase.functions.invoke('generate-insights', {
                body: {
                    orgId,
                    startDate,
                    endDate,
                    messages: newMessages.length > 0 ? newMessages : undefined
                }
            });

            if (error) throw error;
            if (data.error) throw new Error(data.error);

            if (customMessage) {
                setMessages([...newMessages, { role: 'assistant', content: data.insight }]);
            } else {
                setMessages([{ role: 'assistant', content: data.insight }]);
            }

            if (!customMessage) toast({ title: "Análise pronta" });
        } catch (error: any) {
            console.error("Error generating insights:", error);
            toast({
                title: "Não foi possível gerar os insights",
                description: toUserMessage(error, "Tente de novo em instantes."),
                variant: "destructive",
            });
        } finally {
            setIsLoading(false);
        }
    };

    const handleSendMessage = (e: React.FormEvent) => {
        e.preventDefault();
        if (!inputValue.trim() || isLoading) return;
        generateInsights(inputValue);
    };

    return (
        <Card className="h-[700px] flex flex-col border-border shadow-lg shadow-purple-500/5">
            <CardHeader className="border-b bg-muted/30 py-4">
                <div className="flex items-center justify-between">
                    <div className="space-y-1">
                        <CardTitle className="flex items-center gap-2 text-purple-500">
                            <Sparkles className="h-5 w-5" />
                            Análise com IA
                        </CardTitle>
                        <CardDescription>
                            Análise estratégica do período selecionado
                        </CardDescription>
                    </div>
                    {messages.length > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setMessages([])}
                            disabled={isLoading}
                            className="text-muted-foreground hover:text-purple-600"
                        >
                            Limpar Conversa
                        </Button>
                    )}
                </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden p-0 flex flex-col relative">
                <ScrollArea ref={scrollAreaRef} className="flex-1 p-4">
                    {messages.length > 0 ? (
                        <div className="space-y-6 max-w-4xl mx-auto pb-8">
                            {messages.map((msg, i) => (
                                <div
                                    key={i}
                                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                                >
                                    <div className={`max-w-[85%] rounded-2xl p-4 ${msg.role === 'user'
                                            ? 'bg-purple-600 text-white selection:bg-purple-400'
                                            : 'bg-muted/50 border border-border text-foreground'
                                        }`}>
                                        <div className="prose prose-sm dark:prose-invert max-w-none 
                                            prose-p:leading-relaxed prose-headings:mb-2 prose-headings:mt-4
                                            prose-ul:my-2 prose-li:my-1
                                            [&>*:first-child]:mt-0
                                        ">
                                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                {msg.content}
                                            </ReactMarkdown>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            {isLoading && (
                                <div className="flex justify-start">
                                    <div className="bg-muted/50 rounded-2xl p-4 flex items-center gap-2">
                                        <RefreshCw className="h-4 w-4 animate-spin text-purple-500" />
                                        <span className="text-sm italic">IA está analisando…</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 min-h-[400px]">
                            <div className="bg-purple-500/10 p-6 rounded-full mb-6">
                                <Sparkles className="h-12 w-12 text-purple-500 opacity-70" />
                            </div>
                            <h3 className="text-xl font-semibold mb-2 text-foreground">Pronto para analisar?</h3>
                            <p className="text-center text-pretty max-w-sm mb-8">
                                Gere uma análise detalhada do desempenho do atendimento neste período.
                            </p>
                            <Button
                                onClick={() => generateInsights()}
                                disabled={isLoading}
                                className="bg-purple-600 hover:bg-purple-700 h-11 px-8 rounded-full shadow-lg shadow-purple-500/20"
                            >
                                {isLoading ? (
                                    <>
                                        <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
                                        Gerando análise…
                                    </>
                                ) : (
                                    <>
                                        <Sparkles className="mr-2 h-5 w-5" />
                                        Gerar análise
                                    </>
                                )}
                            </Button>
                        </div>
                    )}
                </ScrollArea>

                {messages.length > 0 && (
                    <div className="p-4 border-t bg-background/80 backdrop-blur-sm sticky bottom-0">
                        <div className="max-w-4xl mx-auto space-y-3">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1 ml-1">
                                <AlertCircle className="h-3 w-3" />
                                Esta conversa não será salva ao fechar a página.
                            </div>
                            <form onSubmit={handleSendMessage} className="flex gap-2">
                                <Input
                                    value={inputValue}
                                    onChange={(e) => setInputValue(e.target.value)}
                                    placeholder="Faça uma pergunta sobre estes dados…"
                                    className="flex-1 focus-visible:ring-purple-500 border-border"
                                    disabled={isLoading}
                                />
                                <Button
                                    type="submit"
                                    disabled={isLoading || !inputValue.trim()}
                                    className="bg-purple-600 hover:bg-purple-700 shrink-0"
                                >
                                    <Send className="h-4 w-4" />
                                </Button>
                            </form>
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
