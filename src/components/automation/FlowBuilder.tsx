import { useCallback, useRef, useState, useEffect } from "react";
import {
    ReactFlow,
    Background,
    Controls,
    MiniMap,
    addEdge,
    useNodesState,
    useEdgesState,
    Connection,
    Edge,
    Node,
    ReactFlowProvider,
    useReactFlow,
    Panel,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { Undo2, Redo2 } from "lucide-react";

import { TriggerNode } from "./nodes/TriggerNode";
import { MessageNode } from "./nodes/MessageNode";
import { MediaNode } from "./nodes/MediaNode";
import { ListNode } from "./nodes/ListNode";
import { ButtonNode } from "./nodes/ButtonNode";
import { ConditionNode } from "./nodes/ConditionNode";
import { DelayNode } from "./nodes/DelayNode";
import { BusinessHoursNode } from "./nodes/BusinessHoursNode";
import { WebhookNode } from "./nodes/WebhookNode";
import { SurveyNode } from "./nodes/SurveyNode";
import { NodePalette } from "./NodePalette";
import { NodePropertiesPanel } from "./NodePropertiesPanel";

const nodeTypes = {
    triggerNode: TriggerNode,
    messageNode: MessageNode,
    mediaNode: MediaNode,
    listNode: ListNode,
    buttonNode: ButtonNode,
    conditionNode: ConditionNode,
    delayNode: DelayNode,
    businessHoursNode: BusinessHoursNode,
    webhookNode: WebhookNode,
    surveyNode: SurveyNode,
};

interface FlowBuilderProps {
    initialData: {
        nodes: Node[];
        edges: Edge[];
        viewport?: { x: number; y: number; zoom: number };
    };
    /** Retornar false sinaliza falha: o fluxo continua marcado como não-salvo. */
    onSave: (data: { nodes: Node[]; edges: Edge[] }) => void | boolean | Promise<void | boolean>;
    saving?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
}

const MAX_HISTORY = 50;

let nodeId = 0;
const getNodeId = () => `node_${nodeId++}`;

function FlowBuilderInner({ initialData, onSave, saving, onDirtyChange }: FlowBuilderProps) {
    const reactFlowWrapper = useRef<HTMLDivElement>(null);
    const [nodes, setNodes, onNodesChange] = useNodesState(initialData.nodes || []);
    const [edges, setEdges, onEdgesChange] = useEdgesState(initialData.edges || []);
    const [selectedNode, setSelectedNode] = useState<Node | null>(null);
    const { screenToFlowPosition, setViewport, getNodes, getEdges } = useReactFlow();

    // Undo/redo por snapshot: captura ANTES de cada mutação estrutural (mover,
    // adicionar, conectar, deletar). Edição de texto fica com o undo nativo do campo.
    const pastRef = useRef<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
    const futureRef = useRef<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
    // Refs não re-renderizam: contadores em estado habilitam/desabilitam os botões
    const [historySize, setHistorySize] = useState({ past: 0, future: 0 });
    const [dirty, setDirty] = useState(false);
    // Sequência de edições: o save só limpa o dirty se nada mudou durante o await
    const editSeqRef = useRef(0);
    const markDirty = useCallback(() => {
        editSeqRef.current++;
        setDirty(true);
    }, []);

    useEffect(() => {
        onDirtyChange?.(dirty);
    }, [dirty, onDirtyChange]);

    const takeSnapshot = useCallback(() => {
        pastRef.current = [
            ...pastRef.current.slice(-(MAX_HISTORY - 1)),
            { nodes: getNodes(), edges: getEdges() },
        ];
        futureRef.current = [];
        markDirty();
        setHistorySize({ past: pastRef.current.length, future: 0 });
    }, [getNodes, getEdges, markDirty]);

    const undo = useCallback(() => {
        const previous = pastRef.current[pastRef.current.length - 1];
        if (!previous) return;
        pastRef.current = pastRef.current.slice(0, -1);
        futureRef.current = [...futureRef.current, { nodes: getNodes(), edges: getEdges() }];
        setNodes(previous.nodes);
        setEdges(previous.edges);
        setSelectedNode(null);
        markDirty();
        setHistorySize({ past: pastRef.current.length, future: futureRef.current.length });
    }, [getNodes, getEdges, setNodes, setEdges, markDirty]);

    const redo = useCallback(() => {
        const next = futureRef.current[futureRef.current.length - 1];
        if (!next) return;
        futureRef.current = futureRef.current.slice(0, -1);
        pastRef.current = [...pastRef.current, { nodes: getNodes(), edges: getEdges() }];
        setNodes(next.nodes);
        setEdges(next.edges);
        setSelectedNode(null);
        markDirty();
        setHistorySize({ past: pastRef.current.length, future: futureRef.current.length });
    }, [getNodes, getEdges, setNodes, setEdges, markDirty]);

    // Set initial viewport
    useEffect(() => {
        if (initialData.viewport) {
            setViewport(initialData.viewport);
        }
    }, []);

    // Initialize node ID counter
    useEffect(() => {
        const maxId = nodes.reduce((max, node) => {
            const match = node.id.match(/node_(\d+)/);
            if (match) {
                return Math.max(max, parseInt(match[1], 10));
            }
            return max;
        }, 0);
        nodeId = maxId + 1;
    }, []);

    const onConnect = useCallback(
        (params: Connection) => {
            takeSnapshot();
            setEdges((eds) => addEdge({ ...params, animated: true, style: { stroke: "hsl(var(--primary))" } }, eds));
        },
        [setEdges, takeSnapshot]
    );

    const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
        setSelectedNode(node);
    }, []);

    const onPaneClick = useCallback(() => {
        setSelectedNode(null);
    }, []);

    const onDragOver = useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
    }, []);

    const onDrop = useCallback(
        (event: React.DragEvent) => {
            event.preventDefault();

            const type = event.dataTransfer.getData("application/reactflow");
            if (!type) return;

            const position = screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
            });

            const newNode: Node = {
                id: getNodeId(),
                type,
                position,
                data: getDefaultNodeData(type),
            };

            takeSnapshot();
            setNodes((nds) => nds.concat(newNode));
        },
        [screenToFlowPosition, setNodes, takeSnapshot]
    );

    // Toque/teclado: drag HTML5 não existe em touch e a paleta era inoperável
    // por Tab — clique insere o nó no centro do viewport, com offset em cascata
    // para inserções seguidas não se sobreporem.
    const addNodeSeqRef = useRef(0);
    const addNodeAtCenter = useCallback(
        (type: string) => {
            const cascade = (addNodeSeqRef.current++ % 6) * 32;
            const position = screenToFlowPosition({
                x: window.innerWidth / 2 + cascade,
                y: window.innerHeight / 2 + cascade,
            });

            const newNode: Node = {
                id: getNodeId(),
                type,
                position,
                data: getDefaultNodeData(type),
            };

            takeSnapshot();
            setNodes((nds) => nds.concat(newNode));
        },
        [screenToFlowPosition, setNodes, takeSnapshot]
    );

    const updateNodeData = useCallback(
        (nodeId: string, data: any) => {
            setNodes((nds) =>
                nds.map((node) => {
                    if (node.id === nodeId) {
                        return { ...node, data: { ...node.data, ...data } };
                    }
                    return node;
                })
            );
            // Also update selected node
            setSelectedNode((prev) => (prev?.id === nodeId ? { ...prev, data: { ...prev.data, ...data } } : prev));
            markDirty();
            // Mutação nova invalida o redo — senão "Refazer" após digitar
            // aplicava um futuro capturado antes do texto e o revertia em silêncio
            if (futureRef.current.length > 0) {
                futureRef.current = [];
                setHistorySize((prev) => ({ ...prev, future: 0 }));
            }
        },
        [setNodes, markDirty]
    );

    const deleteNode = useCallback(
        (nodeId: string) => {
            takeSnapshot();
            setNodes((nds) => nds.filter((node) => node.id !== nodeId));
            setEdges((eds) => eds.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
            setSelectedNode(null);
        },
        [setNodes, setEdges, takeSnapshot]
    );

    // Guarda de voo: Ctrl+S segurado disparava saves concorrentes que
    // intercalavam o delete+insert de automation_triggers (duplicava triggers)
    const saveInFlightRef = useRef(false);
    const handleSave = useCallback(async () => {
        if (saveInFlightRef.current) return;
        saveInFlightRef.current = true;
        const seq = editSeqRef.current;
        try {
            const result = await onSave({ nodes: getNodes(), edges: getEdges() });
            // Edições feitas DURANTE o save não entraram no payload: mantém dirty
            if (result !== false && editSeqRef.current === seq) setDirty(false);
        } finally {
            saveInFlightRef.current = false;
        }
    }, [onSave, getNodes, getEdges]);

    // Antes: 1 clique apagava a aresta (fácil demais no meio de um fluxo denso).
    // Agora: 1º clique seleciona (fica "armada", em vermelho), 2º clique apaga —
    // e Delete/Backspace também apagam a seleção (deleteKeyCode).
    const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
        if (edge.selected) {
            takeSnapshot();
            setEdges((eds) => eds.filter((e) => e.id !== edge.id));
        }
    }, [setEdges, takeSnapshot]);

    // Ctrl/Cmd+Z desfaz, +Shift refaz, Ctrl/Cmd+S salva. Em campo de texto o
    // undo fica nativo do campo; o S sempre intercepta o "salvar página".
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            const key = e.key.toLowerCase();
            const inField = (e.target as HTMLElement)?.closest?.(
                "input, textarea, select, [contenteditable=true]"
            );

            if (key === "s") {
                e.preventDefault();
                handleSave();
            } else if (key === "z" && !inField) {
                e.preventDefault();
                if (e.shiftKey) redo();
                else undo();
            } else if (key === "y" && !inField) {
                e.preventDefault();
                redo();
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [handleSave, undo, redo]);

    return (
        <div className="h-full w-full flex">
            {/* Node Palette Sidebar */}
            <NodePalette onAddNode={addNodeAtCenter} />

            {/* Flow Canvas */}
            <div className="flex-1 h-full" ref={reactFlowWrapper}>
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onNodeClick={onNodeClick}
                    onPaneClick={onPaneClick}
                    onEdgeClick={onEdgeClick}
                    onNodeDragStart={takeSnapshot}
                    onBeforeDelete={async ({ nodes: toRemove, edges: edgesToRemove }) => {
                        // Delete com seleção vazia também chega aqui — sem isto,
                        // apertar Delete à toa marcava "não salvo" e poluía o undo
                        if (toRemove.length > 0 || edgesToRemove.length > 0) takeSnapshot();
                        return true;
                    }}
                    onDragOver={onDragOver}
                    onDrop={onDrop}
                    nodeTypes={nodeTypes}
                    fitView
                    snapToGrid
                    snapGrid={[15, 15]}
                    edgesReconnectable
                    deleteKeyCode={['Delete', 'Backspace']}
                    defaultEdgeOptions={{
                        animated: true,
                        style: { stroke: "hsl(var(--primary))", strokeWidth: 2 },
                    }}
                    edgesFocusable
                    elementsSelectable
                >
                    <Background gap={15} />
                    <Controls />
                    <MiniMap
                        nodeColor={(node) => {
                            switch (node.type) {
                                case "triggerNode":
                                    return "#22c55e";
                                case "messageNode":
                                    return "#3b82f6";
                                case "mediaNode":
                                    return "#14b8a6";
                                case "listNode":
                                    return "#8b5cf6";
                                case "buttonNode":
                                    return "#f59e0b";
                                case "conditionNode":
                                    return "#ef4444";
                                case "delayNode":
                                    return "#6b7280";
                                case "businessHoursNode":
                                    return "#f59e0b";
                                case "webhookNode":
                                    return "#10b981";
                                case "surveyNode":
                                    return "#ec4899";
                                default:
                                    return "#a1a1aa";
                            }
                        }}
                    />
                    <Panel position="top-right" className="flex items-center gap-2">
                        {dirty && !saving && (
                            <span className="text-xs text-muted-foreground bg-background/90 border rounded-md px-2 py-1.5">
                                Alterações não salvas
                            </span>
                        )}
                        <button
                            onClick={undo}
                            disabled={historySize.past === 0}
                            title="Desfazer (Ctrl+Z)"
                            aria-label="Desfazer"
                            className="bg-background border rounded-md p-2 text-foreground hover:bg-accent transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-40 disabled:pointer-events-none"
                        >
                            <Undo2 className="h-4 w-4" />
                        </button>
                        <button
                            onClick={redo}
                            disabled={historySize.future === 0}
                            title="Refazer (Ctrl+Shift+Z)"
                            aria-label="Refazer"
                            className="bg-background border rounded-md p-2 text-foreground hover:bg-accent transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-40 disabled:pointer-events-none"
                        >
                            <Redo2 className="h-4 w-4" />
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            title="Salvar (Ctrl+S)"
                            className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50"
                        >
                            {saving ? "Salvando…" : "Salvar fluxo"}
                        </button>
                    </Panel>
                </ReactFlow>
            </div>

            {/* Properties Panel */}
            {selectedNode && (
                <NodePropertiesPanel
                    node={selectedNode}
                    onUpdate={(data) => updateNodeData(selectedNode.id, data)}
                    onDelete={() => deleteNode(selectedNode.id)}
                    onClose={() => setSelectedNode(null)}
                />
            )}
        </div>
    );
}

function getDefaultNodeData(type: string): Record<string, any> {
    switch (type) {
        case "triggerNode":
            return { label: "Gatilho", triggerType: "keyword", keywords: [] };
        case "messageNode":
            return { label: "Mensagem", message: "" };
        case "mediaNode":
            return { label: "Arquivo", mediaUrl: "", caption: "", filename: "", mimeType: "" };
        case "listNode":
            return {
                label: "Lista",
                header: "",
                body: "",
                footer: "",
                buttonText: "Ver opções",
                sections: [
                    {
                        title: "Opções",
                        rows: [
                            { id: "opt1", title: "Opção 1", description: "" },
                            { id: "opt2", title: "Opção 2", description: "" },
                        ],
                    },
                ],
            };
        case "buttonNode":
            return {
                label: "Botões",
                body: "",
                buttons: [
                    { id: "btn1", title: "Botão 1" },
                    { id: "btn2", title: "Botão 2" },
                ],
            };
        case "conditionNode":
            return {
                label: "Condição",
                conditions: [
                    { id: "cond1", value: "", targetHandle: "a" },
                ],
                defaultHandle: "default",
            };
        case "delayNode":
            return { label: "Aguardar", seconds: 5 };
        case "webhookNode":
            return { label: "Webhook", url: "" };
        case "surveyNode":
            return {
                label: "Pesquisa",
                questions: [
                    { id: "q1", message: "", type: "text" },
                ],
                completionMessage: "",
                reminderDelayMinutes: 10,
                reminderMessage: "",
                webhookUrl: "",
            };
        case "businessHoursNode":
            return {
                label: "Horário",
                startTime: "09:00",
                endTime: "18:00",
                days: ["1", "2", "3", "4", "5"],
            };
        default:
            return { label: "Nó" };
    }
}

export function FlowBuilder(props: FlowBuilderProps) {
    return (
        <ReactFlowProvider>
            <FlowBuilderInner {...props} />
        </ReactFlowProvider>
    );
}
