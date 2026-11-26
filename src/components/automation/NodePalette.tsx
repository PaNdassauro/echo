import { DragEvent } from "react";
import { MessageSquare, List, Square, GitBranch, Clock, Zap, Webhook, FileUp, ClipboardList } from "lucide-react";

interface NodeTypeItem {
    type: string;
    label: string;
    description: string;
    icon: React.ReactNode;
    color: string;
}

const nodeTypes: NodeTypeItem[] = [
    {
        type: "messageNode",
        label: "Mensagem",
        description: "Envia uma mensagem de texto",
        icon: <MessageSquare className="h-5 w-5" />,
        color: "bg-blue-500",
    },
    {
        type: "mediaNode",
        label: "Arquivo",
        description: "Envia um arquivo ou documento",
        icon: <FileUp className="h-5 w-5" />,
        color: "bg-teal-500",
    },
    {
        type: "listNode",
        label: "Lista",
        description: "Envia uma lista interativa",
        icon: <List className="h-5 w-5" />,
        color: "bg-violet-500",
    },
    {
        type: "buttonNode",
        label: "Botões",
        description: "Envia botões de resposta rápida",
        icon: <Square className="h-5 w-5" />,
        color: "bg-amber-500",
    },
    {
        type: "conditionNode",
        label: "Condição",
        description: "Ramifica baseado na resposta",
        icon: <GitBranch className="h-5 w-5" />,
        color: "bg-red-500",
    },
    {
        type: "delayNode",
        label: "Aguardar",
        description: "Espera antes de continuar",
        icon: <Clock className="h-5 w-5" />,
        color: "bg-gray-500",
    },
    {
        type: "businessHoursNode",
        label: "Horário",
        description: "Ramifica por horário comercial",
        icon: <Clock className="h-5 w-5" />,
        color: "bg-amber-500",
    },
    {
        type: "webhookNode",
        label: "Webhook",
        description: "Envia dados para uma URL externa",
        icon: <Webhook className="h-5 w-5" />,
        color: "bg-emerald-500",
    },
    {
        type: "surveyNode",
        label: "Pesquisa",
        description: "Envia perguntas sequenciais ao cliente",
        icon: <ClipboardList className="h-5 w-5" />,
        color: "bg-pink-500",
    },
];

interface NodePaletteProps {
    /** Insere o nó no canvas (clique/Enter) — drag HTML5 não existe em touch. */
    onAddNode?: (type: string) => void;
}

export function NodePalette({ onAddNode }: NodePaletteProps) {
    const onDragStart = (event: DragEvent, nodeType: string) => {
        event.dataTransfer.setData("application/reactflow", nodeType);
        event.dataTransfer.effectAllowed = "move";
    };

    return (
        <div className="w-64 bg-background border-r p-4 overflow-y-auto">
            <div className="mb-4">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                    Componentes
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                    Arraste para a área de edição ou toque para adicionar
                </p>
            </div>

            <div className="space-y-2">
                {nodeTypes.map((nodeType) => (
                    // button: adiciona por clique/Enter/Space (touch e teclado);
                    // o drag continua funcionando como atalho no desktop.
                    <button
                        key={nodeType.type}
                        type="button"
                        onClick={() => onAddNode?.(nodeType.type)}
                        className="w-full p-3 border rounded-lg text-left cursor-grab active:cursor-grabbing active:scale-[0.96] transition-[background-color,border-color,transform] duration-150 ease-out hover:border-primary/50 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        draggable
                        onDragStart={(e) => onDragStart(e as unknown as DragEvent, nodeType.type)}
                        aria-label={`Adicionar nó ${nodeType.label}: ${nodeType.description}`}
                    >
                        <div className="flex items-center gap-3">
                            <div className={`${nodeType.color} p-2 rounded-md text-white`}>
                                {nodeType.icon}
                            </div>
                            <div>
                                <div className="font-medium text-sm">{nodeType.label}</div>
                                <div className="text-xs text-muted-foreground">
                                    {nodeType.description}
                                </div>
                            </div>
                        </div>
                    </button>
                ))}
            </div>

            <div className="mt-6 p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-2 text-green-600 mb-2">
                    <Zap className="h-4 w-4" />
                    <span className="font-medium text-sm">Gatilho</span>
                </div>
                <p className="text-xs text-muted-foreground">
                    O nó de gatilho inicia o fluxo. Configure as palavras-chave ou condições para ativar o fluxo.
                </p>
            </div>

            <div className="mt-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                <p className="text-xs text-amber-700 dark:text-amber-400">
                    <strong>Dica:</strong> Mensagens interativas (listas e botões) só funcionam dentro da janela de 24h do WhatsApp.
                </p>
            </div>
        </div>
    );
}
