import { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { FileUp } from "lucide-react";

function MediaNodeComponent({ data, selected }: NodeProps) {
    const filename = (data as any).filename || "";
    const preview = filename
        ? (filename.length > 30 ? filename.substring(0, 30) + "…" : filename)
        : null;

    return (
        <div
            className={`px-4 py-3 rounded-lg border-2 bg-background shadow-md transition-[border-color,box-shadow] duration-150 ease-out min-w-[180px] max-w-[250px] ${selected ? "border-primary ring-2 ring-primary/20" : "border-teal-500"
                }`}
        >
            <Handle
                type="target"
                position={Position.Top}
                className="!bg-teal-500 !w-3 !h-3"
            />

            <div className="flex items-center gap-2 mb-2">
                <div className="bg-teal-500 text-white p-1.5 rounded-md">
                    <FileUp className="h-4 w-4" />
                </div>
                <span className="font-semibold text-sm">{(data as any).label || "Arquivo"}</span>
            </div>

            {preview ? (
                <p className="text-xs text-muted-foreground line-clamp-2">{preview}</p>
            ) : (
                <p className="text-xs text-muted-foreground italic">Arquivo não configurado</p>
            )}

            <Handle
                type="source"
                position={Position.Bottom}
                className="!bg-teal-500 !w-3 !h-3"
            />
        </div>
    );
}

export const MediaNode = memo(MediaNodeComponent);
