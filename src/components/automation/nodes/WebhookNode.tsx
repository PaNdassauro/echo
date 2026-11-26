import { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { Webhook } from "lucide-react";

function WebhookNodeComponent({ data, selected }: NodeProps) {
    const url = (data as any).url || "";
    const preview = url.length > 50 ? url.substring(0, 50) + "…" : url;

    return (
        <div
            className={`px-4 py-3 rounded-lg border-2 bg-background shadow-md transition-[border-color,box-shadow] duration-150 ease-out min-w-[180px] max-w-[250px] ${selected ? "border-primary ring-2 ring-primary/20" : "border-emerald-500"
                }`}
        >
            <Handle
                type="target"
                position={Position.Top}
                className="!bg-emerald-500 !w-3 !h-3"
            />

            <div className="flex items-center gap-2 mb-2">
                <div className="bg-emerald-500 text-white p-1.5 rounded-md">
                    <Webhook className="h-4 w-4" />
                </div>
                <span className="font-semibold text-sm">{(data as any).label || "Webhook"}</span>
            </div>

            {preview ? (
                <p className="text-xs text-muted-foreground break-all line-clamp-2">{preview}</p>
            ) : (
                <p className="text-xs text-muted-foreground italic">URL não configurada</p>
            )}

            <Handle
                type="source"
                position={Position.Bottom}
                className="!bg-emerald-500 !w-3 !h-3"
            />
        </div>
    );
}

export const WebhookNode = memo(WebhookNodeComponent);
