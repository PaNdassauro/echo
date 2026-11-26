import { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { Clock } from "lucide-react";

function BusinessHoursNodeComponent({ data, selected }: NodeProps) {
    const startTime = (data as any).startTime || "09:00";
    const endTime = (data as any).endTime || "18:00";
    const days = (data as any).days || ["1", "2", "3", "4", "5"]; // 1=Mon, 5=Fri

    return (
        <div
            className={`px-4 py-3 rounded-lg border-2 bg-background shadow-md transition-[border-color,box-shadow] duration-150 ease-out min-w-[180px] ${selected ? "border-primary ring-2 ring-primary/20" : "border-amber-500"
                }`}
        >
            <Handle
                type="target"
                position={Position.Top}
                className="!bg-amber-500 !w-3 !h-3"
            />

            <div className="flex items-center gap-2 mb-2">
                <div className="bg-amber-500 text-white p-1.5 rounded-md">
                    <Clock className="h-4 w-4" />
                </div>
                <div>
                    <span className="font-semibold text-sm block leading-none">{(data as any).label || "Horário"}</span>
                    <span className="text-xs text-muted-foreground">Fuso: -03:00</span>
                </div>
            </div>

            <div className="text-xs text-muted-foreground space-y-2">
                <div className="flex items-center justify-between bg-amber-50 dark:bg-amber-950/30 p-1.5 rounded">
                    <span className="font-medium">{startTime}</span>
                    <span className="text-amber-500">➜</span>
                    <span className="font-medium">{endTime}</span>
                </div>

                <div className="flex justify-between items-center text-2xs uppercase font-bold text-muted-foreground/70">
                    <span className={days.includes("0") ? "text-primary" : ""}>D</span>
                    <span className={days.includes("1") ? "text-primary" : ""}>S</span>
                    <span className={days.includes("2") ? "text-primary" : ""}>T</span>
                    <span className={days.includes("3") ? "text-primary" : ""}>Q</span>
                    <span className={days.includes("4") ? "text-primary" : ""}>Q</span>
                    <span className={days.includes("5") ? "text-primary" : ""}>S</span>
                    <span className={days.includes("6") ? "text-primary" : ""}>S</span>
                </div>
            </div>

            <div className="absolute -bottom-3 left-0 right-0 flex justify-around">
                <div className="relative">
                    <Handle
                        type="source"
                        position={Position.Bottom}
                        id="open"
                        className="!bg-green-500 !w-3 !h-3 !relative !transform-none"
                    />
                    <span className="absolute top-4 left-1/2 -translate-x-1/2 text-2xs font-medium text-green-600">Aberto</span>
                </div>
                <div className="relative">
                    <Handle
                        type="source"
                        position={Position.Bottom}
                        id="closed"
                        className="!bg-red-500 !w-3 !h-3 !relative !transform-none"
                    />
                    <span className="absolute top-4 left-1/2 -translate-x-1/2 text-2xs font-medium text-red-600">Fechado</span>
                </div>
            </div>
        </div>
    );
}

export const BusinessHoursNode = memo(BusinessHoursNodeComponent);
