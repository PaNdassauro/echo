import { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { Square, AlertTriangle } from "lucide-react";

function ButtonNodeComponent({ data, selected }: NodeProps) {
    const buttons = (data as any).buttons || [];

    return (
        <div
            className={`px-4 py-3 rounded-lg border-2 bg-background shadow-md transition-[border-color,box-shadow] duration-150 ease-out min-w-[180px] max-w-[250px] ${selected ? "border-primary ring-2 ring-primary/20" : "border-amber-500"
                }`}
        >
            <Handle
                type="target"
                position={Position.Top}
                className="!bg-amber-500 !w-3 !h-3"
            />

            <div className="flex items-center gap-2 mb-2">
                <div className="bg-amber-500 text-white p-1.5 rounded-md">
                    <Square className="h-4 w-4" />
                </div>
                <span className="font-semibold text-sm">{(data as any).label || "Botões"}</span>
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
                {(data as any).body ? (
                    <p className="line-clamp-2">{(data as any).body}</p>
                ) : (
                    <p className="italic">Configurar mensagem…</p>
                )}
                <div className="flex flex-wrap gap-1 pt-1 border-t">
                    {buttons.length > 0 ? (
                        buttons.map((btn: any, i: number) => (
                            <span
                                key={i}
                                className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded text-xs"
                            >
                                {btn.title || `Botão ${i + 1}`}
                            </span>
                        ))
                    ) : (
                        <span className="italic">Nenhum botão</span>
                    )}
                </div>
                <div className="flex items-center gap-1 pt-1 text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" />
                    <span className="text-xs">QR: enviado como texto</span>
                </div>
            </div>

            <Handle
                type="source"
                position={Position.Bottom}
                className="!bg-amber-500 !w-3 !h-3"
            />
        </div>
    );
}

export const ButtonNode = memo(ButtonNodeComponent);
