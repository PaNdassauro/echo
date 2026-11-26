import { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { Zap, MessageSquare, Clock, Send, AlertTriangle } from "lucide-react";
import { sanitizeKeywords } from "@/lib/automationTriggers";

interface TriggerConfig {
    type: string;
    config: {
        keywords?: string[];
        match_type?: string;
    };
}

function TriggerNodeComponent({ data, selected }: NodeProps) {
    const triggerIcons: Record<string, React.ReactNode> = {
        keyword: <Zap className="h-4 w-4" />,
        message_received: <MessageSquare className="h-4 w-4" />,
        message_sent: <Send className="h-4 w-4" />,
        conversation_created: <Clock className="h-4 w-4" />,
    };

    const triggerLabels: Record<string, string> = {
        keyword: "Palavra-chave",
        message_received: "Msg recebida",
        message_sent: "Msg enviada",
        conversation_created: "Nova conversa",
    };

    // Support both old format (triggerType/keywords) and new format (triggers array)
    const nodeData = data as any;
    const triggers: TriggerConfig[] = nodeData.triggers || [{
        type: nodeData.triggerType || "keyword",
        config: { keywords: nodeData.keywords || [] }
    }];

    // Get first trigger for icon display
    const primaryTrigger = triggers[0];
    const triggerType = primaryTrigger?.type || "keyword";

    return (
        <div
            className={`px-4 py-3 rounded-lg border-2 bg-background shadow-md transition-[border-color,box-shadow] duration-150 ease-out min-w-[180px] ${selected ? "border-primary ring-2 ring-primary/20" : "border-green-500"
                }`}
        >
            <div className="flex items-center gap-2 mb-2">
                <div className="bg-green-500 text-white p-1.5 rounded-md">
                    {triggerIcons[triggerType] || triggerIcons.keyword}
                </div>
                <span className="font-semibold text-sm">{nodeData.label || "Gatilho"}</span>
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
                {triggers.map((trigger, index) => (
                    <div key={index}>
                        {index > 0 && <span className="text-green-600 font-medium">OU </span>}
                        <span className="font-medium">{triggerLabels[trigger.type] || trigger.type}</span>
                        {trigger.type === "keyword" && (() => {
                            const keywords = sanitizeKeywords(trigger.config.keywords || []);

                            // Sem palavra o fluxo nunca dispara: o nome do gatilho
                            // parece ser o gatilho e não é.
                            if (keywords.length === 0) {
                                return (
                                    <span className="ml-1 inline-flex items-center gap-1 text-destructive font-medium">
                                        <AlertTriangle className="h-3 w-3" />
                                        sem palavra-chave
                                    </span>
                                );
                            }

                            return (
                                <span className="ml-1">
                                    ({keywords.slice(0, 2).join(", ")}
                                    {keywords.length > 2 && ` +${keywords.length - 2}`})
                                    {trigger.config.match_type === "contains" && <span className="ml-1">· contém</span>}
                                </span>
                            );
                        })()}
                    </div>
                ))}
            </div>

            <Handle
                type="source"
                position={Position.Bottom}
                className="!bg-green-500 !w-3 !h-3"
            />
        </div>
    );
}

export const TriggerNode = memo(TriggerNodeComponent);
