import { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { GitBranch } from "lucide-react";

function ConditionNodeComponent({ data, selected }: NodeProps) {
    const conditions = (data as any).conditions || [];

    return (
        <div
            className={`px-4 py-3 rounded-lg border-2 bg-background shadow-md transition-[border-color,box-shadow] duration-150 ease-out min-w-[180px] max-w-[250px] ${selected ? "border-primary ring-2 ring-primary/20" : "border-red-500"
                }`}
        >
            <Handle
                type="target"
                position={Position.Top}
                className="!bg-red-500 !w-3 !h-3"
            />

            <div className="flex items-center gap-2 mb-2">
                <div className="bg-red-500 text-white p-1.5 rounded-md">
                    <GitBranch className="h-4 w-4" />
                </div>
                <span className="font-semibold text-sm">{(data as any).label || "Condição"}</span>
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
                {conditions.length > 0 ? (
                    conditions.map((cond: any, i: number) => (
                        <div key={i} className="flex items-center gap-1">
                            <span className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 px-1.5 py-0.5 rounded font-medium">
                                {String.fromCharCode(65 + i)}
                            </span>
                            <span className="truncate">{cond.value || "…"}</span>
                        </div>
                    ))
                ) : (
                    <p className="italic">Nenhuma condição</p>
                )}
                <div className="flex items-center gap-1 pt-1 border-t">
                    <span className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded font-medium">
                        ✱
                    </span>
                    <span>Padrão</span>
                </div>
            </div>

            {/* Multiple output handles based on conditions */}
            <div className="absolute -bottom-3 left-0 right-0 flex justify-around">
                {conditions.map((_: any, i: number) => (
                    <Handle
                        key={i}
                        type="source"
                        position={Position.Bottom}
                        id={String.fromCharCode(97 + i)} // a, b, c…
                        className="!bg-red-500 !w-3 !h-3 !relative !transform-none"
                        style={{ left: `${(i + 1) * (100 / (conditions.length + 2))}%` }}
                    />
                ))}
                <Handle
                    type="source"
                    position={Position.Bottom}
                    id="default"
                    className="!bg-gray-500 !w-3 !h-3 !relative !transform-none"
                    style={{ left: `${(conditions.length + 1) * (100 / (conditions.length + 2))}%` }}
                />
            </div>
        </div>
    );
}

export const ConditionNode = memo(ConditionNodeComponent);
