import { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { List, AlertTriangle } from "lucide-react";

function ListNodeComponent({ data, selected }: NodeProps) {
    const sections = (data as any).sections || [];
    const totalRows = sections.reduce((acc: number, s: any) => acc + (s.rows?.length || 0), 0);
    const buttonText = (data as any).buttonText || "Ver opções";

    return (
        <div
            className={`px-4 py-3 rounded-lg border-2 bg-background shadow-md transition-[border-color,box-shadow] duration-150 ease-out min-w-[180px] max-w-[250px] ${selected ? "border-primary ring-2 ring-primary/20" : "border-violet-500"
                }`}
        >
            <Handle
                type="target"
                position={Position.Top}
                className="!bg-violet-500 !w-3 !h-3"
            />

            <div className="flex items-center gap-2 mb-2">
                <div className="bg-violet-500 text-white p-1.5 rounded-md">
                    <List className="h-4 w-4" />
                </div>
                <span className="font-semibold text-sm">{(data as any).label || "Lista"}</span>
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
                {(data as any).body ? (
                    <p className="line-clamp-2">{(data as any).body}</p>
                ) : (
                    <p className="italic">Configurar mensagem…</p>
                )}
                <div className="flex items-center justify-between pt-1 border-t">
                    <span className="text-violet-600 dark:text-violet-400 font-medium">
                        [{buttonText}]
                    </span>
                    <span className="bg-violet-100 dark:bg-violet-900/30 px-1.5 py-0.5 rounded">
                        {totalRows} opções
                    </span>
                </div>
                <div className="flex items-center gap-1 pt-1 text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" />
                    <span className="text-xs">QR: enviado como texto</span>
                </div>
            </div>

            <Handle
                type="source"
                position={Position.Bottom}
                className="!bg-violet-500 !w-3 !h-3"
            />
        </div>
    );
}

export const ListNode = memo(ListNodeComponent);
