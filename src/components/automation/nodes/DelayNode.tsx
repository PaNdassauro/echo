import { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { Clock } from "lucide-react";

function DelayNodeComponent({ data, selected }: NodeProps) {
    const seconds = (data as any).seconds || 5;

    const formatTime = (secs: number) => {
        if (secs < 60) return `${secs} segundos`;
        const mins = Math.floor(secs / 60);
        const remainingSecs = secs % 60;
        if (remainingSecs === 0) return `${mins} minuto${mins > 1 ? "s" : ""}`;
        return `${mins}m ${remainingSecs}s`;
    };

    return (
        <div
            className={`px-4 py-3 rounded-lg border-2 bg-background shadow-md transition-[border-color,box-shadow] duration-150 ease-out min-w-[150px] ${selected ? "border-primary ring-2 ring-primary/20" : "border-gray-500"
                }`}
        >
            <Handle
                type="target"
                position={Position.Top}
                className="!bg-gray-500 !w-3 !h-3"
            />

            <div className="flex items-center gap-2 mb-1">
                <div className="bg-gray-500 text-white p-1.5 rounded-md">
                    <Clock className="h-4 w-4" />
                </div>
                <span className="font-semibold text-sm">{(data as any).label || "Aguardar"}</span>
            </div>

            <p className="text-xs text-muted-foreground text-center">
                {formatTime(seconds)}
            </p>

            <Handle
                type="source"
                position={Position.Bottom}
                className="!bg-gray-500 !w-3 !h-3"
            />
        </div>
    );
}

export const DelayNode = memo(DelayNodeComponent);
