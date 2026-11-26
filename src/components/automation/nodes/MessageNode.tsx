import { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { MessageSquare } from "lucide-react";

function MessageNodeComponent({ data, selected }: NodeProps) {
    const message = (data as any).message || "";
    const preview = message.length > 50 ? message.substring(0, 50) + "…" : message;

    return (
        <div
            className={`px-4 py-3 rounded-lg border-2 bg-background shadow-md transition-[border-color,box-shadow] duration-150 ease-out min-w-[180px] max-w-[250px] ${selected ? "border-primary ring-2 ring-primary/20" : "border-blue-500"
                }`}
        >
            <Handle
                type="target"
                position={Position.Top}
                className="!bg-blue-500 !w-3 !h-3"
            />

            <div className="flex items-center gap-2 mb-2">
                <div className="bg-blue-500 text-white p-1.5 rounded-md">
                    <MessageSquare className="h-4 w-4" />
                </div>
                <span className="font-semibold text-sm">{(data as any).label || "Mensagem"}</span>
            </div>

            {preview ? (
                <p className="text-xs text-muted-foreground line-clamp-2">{preview}</p>
            ) : (
                <p className="text-xs text-muted-foreground italic">Mensagem não configurada</p>
            )}

            <Handle
                type="source"
                position={Position.Bottom}
                className="!bg-blue-500 !w-3 !h-3"
            />
        </div>
    );
}

export const MessageNode = memo(MessageNodeComponent);
