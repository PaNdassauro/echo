import { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { ClipboardList } from "lucide-react";

function SurveyNodeComponent({ data, selected }: NodeProps) {
    const questions = (data as any).questions || [];
    const firstMessage = questions[0]?.message || "";

    return (
        <div
            className={`px-4 py-3 rounded-lg border-2 bg-background shadow-md transition-[border-color,box-shadow] duration-150 ease-out min-w-[180px] max-w-[250px] ${selected ? "border-primary ring-2 ring-primary/20" : "border-pink-500"
                }`}
        >
            <Handle
                type="target"
                position={Position.Top}
                className="!bg-pink-500 !w-3 !h-3"
            />

            <div className="flex items-center gap-2 mb-2">
                <div className="bg-pink-500 text-white p-1.5 rounded-md">
                    <ClipboardList className="h-4 w-4" />
                </div>
                <span className="font-semibold text-sm">{(data as any).label || "Pesquisa"}</span>
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
                {firstMessage ? (
                    <p className="line-clamp-2">{firstMessage}</p>
                ) : (
                    <p className="italic">Configurar perguntas…</p>
                )}
                <div className="flex items-center justify-between pt-1 border-t">
                    <span className="text-pink-600 dark:text-pink-400 font-medium">
                        {questions.length} {questions.length === 1 ? "pergunta" : "perguntas"}
                    </span>
                </div>
            </div>

            <Handle
                type="source"
                position={Position.Bottom}
                className="!bg-pink-500 !w-3 !h-3"
            />
        </div>
    );
}

export const SurveyNode = memo(SurveyNodeComponent);
