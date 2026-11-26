import { useState, useRef } from "react";
import { Node } from "@xyflow/react";
import { X, Trash2, Plus, Minus, Webhook, FileUp, Loader2, File, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toUserMessage } from "@/lib/userFacingError";
import { publicAttachmentUrl } from "@/lib/runtimeConfig";
import {
    DEFAULT_MATCH_TYPE,
    KEYWORD_MATCH_TYPES,
    KEYWORD_MATCH_TYPE_LABELS,
    sanitizeKeywords,
} from "@/lib/automationTriggers";

interface NodePropertiesPanelProps {
    node: Node;
    onUpdate: (data: any) => void;
    onDelete: () => void;
    onClose: () => void;
}

export function NodePropertiesPanel({
    node,
    onUpdate,
    onDelete,
    onClose,
}: NodePropertiesPanelProps) {
    const renderProperties = () => {
        switch (node.type) {
            case "triggerNode":
                return <TriggerNodeProperties node={node} onUpdate={onUpdate} />;
            case "messageNode":
                return <MessageNodeProperties node={node} onUpdate={onUpdate} />;
            case "mediaNode":
                return <MediaNodeProperties node={node} onUpdate={onUpdate} />;
            case "listNode":
                return <ListNodeProperties node={node} onUpdate={onUpdate} />;
            case "buttonNode":
                return <ButtonNodeProperties node={node} onUpdate={onUpdate} />;
            case "conditionNode":
                return <ConditionNodeProperties node={node} onUpdate={onUpdate} />;
            case "delayNode":
                return <DelayNodeProperties node={node} onUpdate={onUpdate} />;
            case "businessHoursNode":
                return <BusinessHoursNodeProperties node={node} onUpdate={onUpdate} />;
            case "webhookNode":
                return <WebhookNodeProperties node={node} onUpdate={onUpdate} />;
            case "surveyNode":
                return <SurveyNodeProperties node={node} onUpdate={onUpdate} />;
            default:
                return <p className="text-sm text-muted-foreground">Selecione um nó para editar suas propriedades.</p>;
        }
    };

    const nodeTypeLabels: Record<string, string> = {
        triggerNode: "Gatilho",
        messageNode: "Mensagem",
        mediaNode: "Arquivo",
        listNode: "Lista",
        buttonNode: "Botões",
        conditionNode: "Condição",
        delayNode: "Aguardar",
        businessHoursNode: "Horário",
        webhookNode: "Webhook",
        surveyNode: "Pesquisa",
    };

    return (
        <div className="w-80 bg-background border-l p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <Badge variant="outline">{nodeTypeLabels[node.type || ""] || "Nó"}</Badge>
                    <h3 className="font-semibold mt-1">{(node.data as any)?.label as string || "Configurações"}</h3>
                </div>
                <Button variant="ghost" size="icon" onClick={onClose} aria-label="Fechar painel">
                    <X className="h-4 w-4" />
                </Button>
            </div>

            <Separator className="mb-4" />

            <div className="space-y-4">{renderProperties()}</div>

            {node.type !== "triggerNode" && (
                <>
                    <Separator className="my-4" />
                    <Button variant="destructive" size="sm" className="w-full" onClick={onDelete}>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Excluir nó
                    </Button>
                </>
            )}
        </div>
    );
}

interface TriggerConfig {
    type: string;
    config: {
        keywords?: string[];
        match_type?: string;
    };
}

function TriggerNodeProperties({ node, onUpdate }: { node: Node; onUpdate: (data: any) => void }) {
    const data = node.data as any;

    // Migrate from old format to new format if needed
    const triggers: TriggerConfig[] = data.triggers || [{
        type: data.triggerType || "keyword",
        config: { keywords: data.keywords || [], match_type: "contains" }
    }];

    const addTrigger = () => {
        onUpdate({ triggers: [...triggers, { type: "keyword", config: { keywords: [], match_type: DEFAULT_MATCH_TYPE } }] });
    };

    const removeTrigger = (index: number) => {
        if (triggers.length <= 1) return;
        onUpdate({ triggers: triggers.filter((_, i) => i !== index) });
    };

    const updateTriggerType = (index: number, type: string) => {
        const newTriggers = [...triggers];
        newTriggers[index] = { ...newTriggers[index], type, config: type === "keyword" ? { keywords: [], match_type: DEFAULT_MATCH_TYPE } : {} };
        onUpdate({ triggers: newTriggers });
    };

    const updateTriggerKeywords = (index: number, keywords: string[]) => {
        const newTriggers = [...triggers];
        newTriggers[index] = { ...newTriggers[index], config: { ...newTriggers[index].config, keywords } };
        onUpdate({ triggers: newTriggers });
    };

    const updateTriggerMatchType = (index: number, matchType: string) => {
        const newTriggers = [...triggers];
        newTriggers[index] = { ...newTriggers[index], config: { ...newTriggers[index].config, match_type: matchType } };
        onUpdate({ triggers: newTriggers });
    };

    const addKeyword = (triggerIndex: number) => {
        const currentKeywords = triggers[triggerIndex].config.keywords || [];
        updateTriggerKeywords(triggerIndex, [...currentKeywords, ""]);
    };

    const updateKeyword = (triggerIndex: number, keywordIndex: number, value: string) => {
        const currentKeywords = [...(triggers[triggerIndex].config.keywords || [])];
        currentKeywords[keywordIndex] = value;
        updateTriggerKeywords(triggerIndex, currentKeywords);
    };

    const removeKeyword = (triggerIndex: number, keywordIndex: number) => {
        const currentKeywords = triggers[triggerIndex].config.keywords || [];
        updateTriggerKeywords(triggerIndex, currentKeywords.filter((_, i) => i !== keywordIndex));
    };

    return (
        <>
            <div className="space-y-2">
                <Label>Nome do gatilho</Label>
                <Input
                    value={data.label || ""}
                    onChange={(e) => onUpdate({ label: e.target.value })}
                    placeholder="Ex: Boas-vindas"
                />
            </div>

            <div className="space-y-2">
                <Label>Gatilhos (OU)</Label>
                <p className="text-xs text-muted-foreground">
                    O fluxo inicia quando QUALQUER um desses gatilhos for acionado.
                </p>
            </div>

            {triggers.map((trigger, index) => (
                <div key={index}>
                    <div className="p-3 border rounded-md space-y-3">
                        <div className="flex items-center justify-between">
                            <Badge variant="outline">Gatilho {index + 1}</Badge>
                            {triggers.length > 1 && (
                                <Button variant="ghost" size="icon" onClick={() => removeTrigger(index)} aria-label={`Remover gatilho ${index + 1}`}>
                                    <Minus className="h-4 w-4" />
                                </Button>
                            )}
                        </div>

                        <Select
                            value={trigger.type}
                            onValueChange={(value) => updateTriggerType(index, value)}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="keyword">Palavra-chave</SelectItem>
                                <SelectItem value="message_received">Qualquer mensagem recebida</SelectItem>
                                <SelectItem value="message_sent">Mensagem enviada</SelectItem>
                                <SelectItem value="conversation_created">Nova conversa</SelectItem>
                            </SelectContent>
                        </Select>

                        {trigger.type === "keyword" && (
                            <div className="space-y-3">
                                <div className="space-y-2">
                                    <Label className="text-xs">Comparação</Label>
                                    <Select
                                        value={trigger.config.match_type || "contains"}
                                        onValueChange={(value) => updateTriggerMatchType(index, value)}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {KEYWORD_MATCH_TYPES.map((matchType) => (
                                                <SelectItem key={matchType} value={matchType}>
                                                    {KEYWORD_MATCH_TYPE_LABELS[matchType]}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">
                                        {trigger.config.match_type === "contains"
                                            ? "Dispara se a palavra aparecer em qualquer parte da mensagem — cuidado: uma frase de outro disparo que contenha esta palavra também dispara."
                                            : "Compara a mensagem inteira. É o recomendado para resposta de botão, onde o texto chega exatamente como no template."}
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <Label className="text-xs">Palavras-chave</Label>
                                    <div className="space-y-2">
                                        {(trigger.config.keywords || []).map((keyword: string, keywordIndex: number) => (
                                            <div key={keywordIndex} className="flex gap-2">
                                                <Input
                                                    value={keyword}
                                                    onChange={(e) => updateKeyword(index, keywordIndex, e.target.value)}
                                                    placeholder="Ex: oi, olá, menu"
                                                />
                                                <Button variant="ghost" size="icon" onClick={() => removeKeyword(index, keywordIndex)} aria-label="Remover palavra-chave">
                                                    <Minus className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        ))}
                                        <Button variant="outline" size="sm" onClick={() => addKeyword(index)} className="w-full">
                                            <Plus className="h-4 w-4 mr-2" />
                                            Adicionar palavra
                                        </Button>
                                    </div>
                                    {sanitizeKeywords(trigger.config.keywords || []).length === 0 && (
                                        <p className="flex items-start gap-1.5 text-xs text-destructive">
                                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                            Sem nenhuma palavra o fluxo nunca dispara. O nome do gatilho acima não é gatilho.
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}

                        {trigger.type === "message_sent" && (
                            <p className="text-xs text-muted-foreground">
                                Dispara quando uma mensagem for enviada pelo Echo (atendente ou API).
                            </p>
                        )}
                    </div>

                    {index < triggers.length - 1 && (
                        <div className="flex items-center justify-center py-2">
                            <Badge variant="secondary" className="text-xs">OU</Badge>
                        </div>
                    )}
                </div>
            ))}

            <Button variant="outline" size="sm" onClick={addTrigger} className="w-full">
                <Plus className="h-4 w-4 mr-2" />
                Adicionar gatilho (OU)
            </Button>
        </>
    );
}

function MessageNodeProperties({ node, onUpdate }: { node: Node; onUpdate: (data: any) => void }) {
    const data = node.data as any;

    return (
        <>
            <div className="space-y-2">
                <Label>Nome do nó</Label>
                <Input
                    value={data.label || ""}
                    onChange={(e) => onUpdate({ label: e.target.value })}
                    placeholder="Ex: Mensagem de boas-vindas"
                />
            </div>

            <div className="space-y-2">
                <Label>Mensagem</Label>
                <Textarea
                    value={data.message || ""}
                    onChange={(e) => onUpdate({ message: e.target.value })}
                    placeholder="Ex: Olá! Recebemos sua mensagem e já vamos atender."
                    rows={4}
                />
                <p className="text-xs text-muted-foreground">
                    Use *texto* para negrito e _texto_ para itálico.
                </p>
            </div>
        </>
    );
}

function MediaNodeProperties({ node, onUpdate }: { node: Node; onUpdate: (data: any) => void }) {
    const data = node.data as any;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const MAX_FILE_SIZE = 16 * 1024 * 1024; // 16MB

    const sanitizeFilename = (name: string) => {
        return name
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-zA-Z0-9.-]/g, "_")
            .replace(/_{2,}/g, "_");
    };

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setError(null);

        if (file.size > MAX_FILE_SIZE) {
            setError(`Arquivo muito grande. Máximo: 16MB`);
            return;
        }

        setUploading(true);

        try {
            const sanitizedName = sanitizeFilename(file.name);
            const storagePath = `automation/${Date.now()}_${sanitizedName}`;

            const { error: uploadError } = await supabase.storage
                .from('attachments')
                .upload(storagePath, file, {
                    contentType: file.type,
                    upsert: false
                });

            if (uploadError) {
                throw uploadError;
            }

            onUpdate({
                mediaUrl: publicAttachmentUrl(storagePath),
                filename: file.name,
                mimeType: file.type,
                fileSize: file.size,
                storagePath: storagePath
            });
        } catch (err: any) {
            console.error('Upload error:', err);
            setError(toUserMessage(err, 'Não foi possível enviar o arquivo. Verifique a conexão e tente de novo.'));
        } finally {
            setUploading(false);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        }
    };

    const handleRemoveFile = async () => {
        if (data.storagePath) {
            try {
                await supabase.storage
                    .from('attachments')
                    .remove([data.storagePath]);
            } catch (err) {
                console.error('Error removing file:', err);
            }
        }

        onUpdate({
            mediaUrl: "",
            filename: "",
            mimeType: "",
            fileSize: 0,
            storagePath: ""
        });
    };

    return (
        <>
            <div className="space-y-2">
                <Label>Nome do nó</Label>
                <Input
                    value={data.label || ""}
                    onChange={(e) => onUpdate({ label: e.target.value })}
                    placeholder="Ex: Enviar catálogo"
                />
            </div>

            <div className="space-y-2">
                <Label>Arquivo</Label>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="*/*"
                    onChange={handleFileSelect}
                    className="hidden"
                />

                {data.filename ? (
                    <div className="p-3 border rounded-md space-y-2">
                        <div className="flex items-center gap-2">
                            <File className="h-5 w-5 text-muted-foreground" />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{data.filename}</p>
                                {data.fileSize && (
                                    <p className="text-xs text-muted-foreground">
                                        {formatFileSize(data.fileSize)}
                                    </p>
                                )}
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                className="flex-1"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={uploading}
                            >
                                Trocar
                            </Button>
                            <Button
                                variant="destructive"
                                size="sm"
                                onClick={handleRemoveFile}
                                disabled={uploading}
                                aria-label="Remover arquivo"
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                ) : (
                    <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                    >
                        {uploading ? (
                            <>
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                Enviando…
                            </>
                        ) : (
                            <>
                                <FileUp className="h-4 w-4 mr-2" />
                                Selecionar arquivo
                            </>
                        )}
                    </Button>
                )}

                {error && (
                    <p className="text-xs text-destructive">{error}</p>
                )}

                <p className="text-xs text-muted-foreground">
                    Tamanho máximo: 16MB. Aceita qualquer tipo de arquivo.
                </p>
            </div>

            <div className="space-y-2">
                <Label>Legenda (opcional)</Label>
                <Textarea
                    value={data.caption || ""}
                    onChange={(e) => onUpdate({ caption: e.target.value })}
                    placeholder="Ex: Segue o catálogo em PDF"
                    rows={3}
                />
            </div>
        </>
    );
}

function ListNodeProperties({ node, onUpdate }: { node: Node; onUpdate: (data: any) => void }) {
    const data = node.data as any;
    const sections = data.sections || [];

    const updateSection = (sectionIndex: number, field: string, value: any) => {
        const newSections = [...sections];
        newSections[sectionIndex] = { ...newSections[sectionIndex], [field]: value };
        onUpdate({ sections: newSections });
    };

    const updateRow = (sectionIndex: number, rowIndex: number, field: string, value: string) => {
        const newSections = [...sections];
        newSections[sectionIndex].rows[rowIndex] = {
            ...newSections[sectionIndex].rows[rowIndex],
            [field]: value,
        };
        onUpdate({ sections: newSections });
    };

    const addRow = (sectionIndex: number) => {
        const newSections = [...sections];
        const newId = `opt${Date.now()}`;
        newSections[sectionIndex].rows.push({ id: newId, title: "", description: "" });
        onUpdate({ sections: newSections });
    };

    const removeRow = (sectionIndex: number, rowIndex: number) => {
        const newSections = [...sections];
        newSections[sectionIndex].rows = newSections[sectionIndex].rows.filter(
            (_: any, i: number) => i !== rowIndex
        );
        onUpdate({ sections: newSections });
    };

    return (
        <>
            <div className="space-y-2">
                <Label>Nome do nó</Label>
                <Input
                    value={data.label || ""}
                    onChange={(e) => onUpdate({ label: e.target.value })}
                    placeholder="Ex: Menu principal"
                />
            </div>

            <div className="space-y-2">
                <Label>Cabeçalho (opcional)</Label>
                <Input
                    value={data.header || ""}
                    onChange={(e) => onUpdate({ header: e.target.value })}
                    placeholder="Título da lista"
                    maxLength={60}
                />
            </div>

            <div className="space-y-2">
                <Label>Mensagem principal</Label>
                <Textarea
                    value={data.body || ""}
                    onChange={(e) => onUpdate({ body: e.target.value })}
                    placeholder="Ex: Escolha uma das opções abaixo"
                    rows={3}
                    maxLength={1024}
                />
            </div>

            <div className="space-y-2">
                <Label>Rodapé (opcional)</Label>
                <Input
                    value={data.footer || ""}
                    onChange={(e) => onUpdate({ footer: e.target.value })}
                    placeholder="Texto do rodapé"
                    maxLength={60}
                />
            </div>

            <div className="space-y-2">
                <Label>Texto do botão</Label>
                <Input
                    value={data.buttonText || ""}
                    onChange={(e) => onUpdate({ buttonText: e.target.value })}
                    placeholder="Ver opções"
                    maxLength={20}
                />
            </div>

            <Separator className="my-2" />

            {sections.map((section: any, sectionIndex: number) => (
                <div key={sectionIndex} className="space-y-2 p-3 border rounded-md">
                    <Label>Seção {sectionIndex + 1}</Label>
                    <Input
                        value={section.title || ""}
                        onChange={(e) => updateSection(sectionIndex, "title", e.target.value)}
                        aria-label={`Título da seção ${sectionIndex + 1}`}
                        placeholder="Ex: Serviços"
                        maxLength={24}
                    />

                    <div className="space-y-2 mt-2">
                        {section.rows?.map((row: any, rowIndex: number) => (
                            <div key={rowIndex} className="p-2 bg-muted/50 rounded-md space-y-1">
                                <div className="flex gap-2">
                                    <Input
                                        value={row.title || ""}
                                        onChange={(e) => updateRow(sectionIndex, rowIndex, "title", e.target.value)}
                                        aria-label={`Título da opção ${rowIndex + 1}`}
                                        placeholder="Ex: Falar com atendente"
                                        maxLength={24}
                                        className="flex-1"
                                    />
                                    <Button variant="ghost" size="icon" onClick={() => removeRow(sectionIndex, rowIndex)} aria-label="Remover opção">
                                        <Minus className="h-4 w-4" />
                                    </Button>
                                </div>
                                <Input
                                    value={row.description || ""}
                                    onChange={(e) => updateRow(sectionIndex, rowIndex, "description", e.target.value)}
                                    aria-label={`Descrição da opção ${rowIndex + 1} (opcional)`}
                                    placeholder="Descrição (opcional) — ex: Atendimento humano"
                                    maxLength={72}
                                />
                            </div>
                        ))}
                        <Button variant="outline" size="sm" className="w-full" onClick={() => addRow(sectionIndex)}>
                            <Plus className="h-4 w-4 mr-2" />
                            Adicionar opção
                        </Button>
                    </div>
                </div>
            ))}
        </>
    );
}

function ButtonNodeProperties({ node, onUpdate }: { node: Node; onUpdate: (data: any) => void }) {
    const data = node.data as any;
    const buttons = data.buttons || [];

    const updateButton = (index: number, value: string) => {
        const newButtons = [...buttons];
        newButtons[index] = { ...newButtons[index], title: value };
        onUpdate({ buttons: newButtons });
    };

    const addButton = () => {
        if (buttons.length >= 3) return;
        const newId = `btn${Date.now()}`;
        onUpdate({ buttons: [...buttons, { id: newId, title: "" }] });
    };

    const removeButton = (index: number) => {
        const newButtons = buttons.filter((_: any, i: number) => i !== index);
        onUpdate({ buttons: newButtons });
    };

    return (
        <>
            <div className="space-y-2">
                <Label>Nome do nó</Label>
                <Input
                    value={data.label || ""}
                    onChange={(e) => onUpdate({ label: e.target.value })}
                    placeholder="Ex: Confirmação"
                />
            </div>

            <div className="space-y-2">
                <Label>Mensagem</Label>
                <Textarea
                    value={data.body || ""}
                    onChange={(e) => onUpdate({ body: e.target.value })}
                    placeholder="Ex: Como podemos ajudar?"
                    rows={3}
                />
            </div>

            <div className="space-y-2">
                <Label>Botões (máx. 3)</Label>
                <div className="space-y-2">
                    {buttons.map((button: any, index: number) => (
                        <div key={index} className="flex gap-2">
                            <Input
                                value={button.title || ""}
                                onChange={(e) => updateButton(index, e.target.value)}
                                aria-label={`Texto do botão ${index + 1}`}
                                placeholder={index === 0 ? "Ex: Sim" : index === 1 ? "Ex: Não" : "Ex: Falar com atendente"}
                                maxLength={20}
                            />
                            <Button variant="ghost" size="icon" onClick={() => removeButton(index)} aria-label={`Remover botão ${index + 1}`}>
                                <Minus className="h-4 w-4" />
                            </Button>
                        </div>
                    ))}
                    {buttons.length < 3 && (
                        <Button variant="outline" size="sm" onClick={addButton} className="w-full">
                            <Plus className="h-4 w-4 mr-2" />
                            Adicionar botão
                        </Button>
                    )}
                </div>
            </div>
        </>
    );
}

function ConditionNodeProperties({ node, onUpdate }: { node: Node; onUpdate: (data: any) => void }) {
    const data = node.data as any;
    const conditions = data.conditions || [];

    const addCondition = () => {
        const newId = `cond${Date.now()}`;
        onUpdate({ conditions: [...conditions, { id: newId, value: "", targetHandle: String.fromCharCode(97 + conditions.length) }] });
    };

    const updateCondition = (index: number, value: string) => {
        const newConditions = [...conditions];
        newConditions[index] = { ...newConditions[index], value };
        onUpdate({ conditions: newConditions });
    };

    const removeCondition = (index: number) => {
        const newConditions = conditions.filter((_: any, i: number) => i !== index);
        onUpdate({ conditions: newConditions });
    };

    return (
        <>
            <div className="space-y-2">
                <Label>Nome do nó</Label>
                <Input
                    value={data.label || ""}
                    onChange={(e) => onUpdate({ label: e.target.value })}
                    placeholder="Ex: Verificar escolha"
                />
            </div>

            <div className="space-y-2">
                <Label>Condições</Label>
                <p className="text-xs text-muted-foreground">
                    Define para onde o fluxo segue baseado na resposta do usuário.
                </p>
                <div className="space-y-2">
                    {conditions.map((condition: any, index: number) => (
                        <div key={index} className="flex gap-2 items-center">
                            <Badge variant="outline" className="shrink-0">
                                {String.fromCharCode(65 + index)}
                            </Badge>
                            <Input
                                value={condition.value || ""}
                                onChange={(e) => updateCondition(index, e.target.value)}
                                aria-label={`Valor da resposta ${String.fromCharCode(65 + index)}`}
                                placeholder="Ex: sim"
                            />
                            <Button variant="ghost" size="icon" onClick={() => removeCondition(index)} aria-label={`Remover condição ${String.fromCharCode(65 + index)}`}>
                                <Minus className="h-4 w-4" />
                            </Button>
                        </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={addCondition} className="w-full">
                        <Plus className="h-4 w-4 mr-2" />
                        Adicionar condição
                    </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                    Se nenhuma condição corresponder, o fluxo segue pela saída "Padrão".
                </p>
            </div>
        </>
    );
}

function DelayNodeProperties({ node, onUpdate }: { node: Node; onUpdate: (data: any) => void }) {
    const data = node.data as any;

    return (
        <>
            <div className="space-y-2">
                <Label>Nome do nó</Label>
                <Input
                    value={data.label || ""}
                    onChange={(e) => onUpdate({ label: e.target.value })}
                    placeholder="Ex: Aguardar 5 segundos"
                />
            </div>

            <div className="space-y-2">
                <Label>Tempo de espera (segundos)</Label>
                <Input
                    type="number"
                    min={1}
                    max={300}
                    value={data.seconds || 5}
                    onChange={(e) => onUpdate({ seconds: parseInt(e.target.value, 10) || 5 })}
                />
                <p className="text-xs text-muted-foreground">
                    O fluxo continua após esse tempo. Máximo: 5 minutos.
                </p>
            </div>
        </>
    );
}
function WebhookNodeProperties({ node, onUpdate }: { node: Node; onUpdate: (data: any) => void }) {
    const data = node.data as any;

    return (
        <>
            <div className="space-y-2">
                <Label>Nome do nó</Label>
                <Input
                    value={data.label || ""}
                    onChange={(e) => onUpdate({ label: e.target.value })}
                    placeholder="Ex: Notificar CRM"
                />
            </div>

            <div className="space-y-2">
                <Label>URL do webhook</Label>
                <Input
                    value={data.url || ""}
                    onChange={(e) => onUpdate({ url: e.target.value })}
                    placeholder="https://seu-endpoint.com/webhook"
                    type="url"
                />
                <p className="text-xs text-muted-foreground">
                    O Echo envia os dados do contato e da conversa para essa URL.
                </p>
            </div>
        </>
    );
}

function BusinessHoursNodeProperties({ node, onUpdate }: { node: Node; onUpdate: (data: any) => void }) {
    const data = node.data as any;
    const days = data.days || ["1", "2", "3", "4", "5"];

    const dayLabels = [
        { value: "0", label: "Dom" },
        { value: "1", label: "Seg" },
        { value: "2", label: "Ter" },
        { value: "3", label: "Qua" },
        { value: "4", label: "Qui" },
        { value: "5", label: "Sex" },
        { value: "6", label: "Sáb" },
    ];

    const toggleDay = (dayValue: string) => {
        const newDays = days.includes(dayValue)
            ? days.filter((d: string) => d !== dayValue)
            : [...days, dayValue];
        onUpdate({ days: newDays });
    };

    return (
        <>
            <div className="space-y-2">
                <Label>Nome do nó</Label>
                <Input
                    value={data.label || ""}
                    onChange={(e) => onUpdate({ label: e.target.value })}
                    placeholder="Ex: Horário Comercial"
                />
            </div>

            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                    <Label>Abre às</Label>
                    <Input
                        type="time"
                        value={data.startTime || "09:00"}
                        onChange={(e) => onUpdate({ startTime: e.target.value })}
                    />
                </div>
                <div className="space-y-2">
                    <Label>Fecha às</Label>
                    <Input
                        type="time"
                        value={data.endTime || "18:00"}
                        onChange={(e) => onUpdate({ endTime: e.target.value })}
                    />
                </div>
            </div>

            <div className="space-y-2">
                <Label>Dias de funcionamento</Label>
                <div className="flex flex-wrap gap-1">
                    {dayLabels.map((day) => (
                        <button
                            key={day.value}
                            type="button"
                            onClick={() => toggleDay(day.value)}
                            className={`px-2 py-1 text-xs font-medium rounded transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 ${days.includes(day.value)
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                                }`}
                        >
                            {day.label}
                        </button>
                    ))}
                </div>
                <p className="text-xs text-muted-foreground">
                    O fluxo segue pela saída "Aberto" dentro do horário, ou "Fechado" fora.
                </p>
            </div>
        </>
    );
}

function SurveyNodeProperties({ node, onUpdate }: { node: Node; onUpdate: (data: any) => void }) {
    const data = node.data as any;
    const questions = data.questions || [];

    const updateQuestion = (index: number, field: string, value: any) => {
        const newQuestions = [...questions];
        newQuestions[index] = { ...newQuestions[index], [field]: value };
        if (field === "type" && value === "text") {
            delete newQuestions[index].listConfig;
        }
        if (field === "type" && value === "list" && !newQuestions[index].listConfig) {
            newQuestions[index].listConfig = {
                buttonText: "Ver opções",
                sections: [{ title: "Opções", rows: [{ id: `opt${Date.now()}`, title: "", description: "" }] }],
            };
        }
        onUpdate({ questions: newQuestions });
    };

    const addQuestion = () => {
        const newId = `q${Date.now()}`;
        onUpdate({ questions: [...questions, { id: newId, message: "", type: "text" }] });
    };

    const removeQuestion = (index: number) => {
        if (questions.length <= 1) return;
        onUpdate({ questions: questions.filter((_: any, i: number) => i !== index) });
    };

    const updateListRow = (qIndex: number, sIndex: number, rIndex: number, field: string, value: string) => {
        const newQuestions = [...questions];
        const sections = [...(newQuestions[qIndex].listConfig?.sections || [])];
        sections[sIndex] = { ...sections[sIndex] };
        sections[sIndex].rows = [...sections[sIndex].rows];
        sections[sIndex].rows[rIndex] = { ...sections[sIndex].rows[rIndex], [field]: value };
        newQuestions[qIndex] = { ...newQuestions[qIndex], listConfig: { ...newQuestions[qIndex].listConfig, sections } };
        onUpdate({ questions: newQuestions });
    };

    const addListRow = (qIndex: number, sIndex: number) => {
        const newQuestions = [...questions];
        const sections = [...(newQuestions[qIndex].listConfig?.sections || [])];
        sections[sIndex] = { ...sections[sIndex] };
        sections[sIndex].rows = [...sections[sIndex].rows, { id: `opt${Date.now()}`, title: "", description: "" }];
        newQuestions[qIndex] = { ...newQuestions[qIndex], listConfig: { ...newQuestions[qIndex].listConfig, sections } };
        onUpdate({ questions: newQuestions });
    };

    const removeListRow = (qIndex: number, sIndex: number, rIndex: number) => {
        const newQuestions = [...questions];
        const sections = [...(newQuestions[qIndex].listConfig?.sections || [])];
        sections[sIndex] = { ...sections[sIndex] };
        sections[sIndex].rows = sections[sIndex].rows.filter((_: any, i: number) => i !== rIndex);
        newQuestions[qIndex] = { ...newQuestions[qIndex], listConfig: { ...newQuestions[qIndex].listConfig, sections } };
        onUpdate({ questions: newQuestions });
    };

    return (
        <>
            <div className="space-y-2">
                <Label>Nome do nó</Label>
                <Input
                    value={data.label || ""}
                    onChange={(e) => onUpdate({ label: e.target.value })}
                    placeholder="Ex: Pesquisa de satisfação"
                />
            </div>

            <Separator className="my-2" />

            <div className="space-y-3">
                <Label>Perguntas</Label>
                {questions.map((question: any, qIndex: number) => (
                    <div key={question.id || qIndex} className="space-y-2 p-3 border rounded-md">
                        <div className="flex items-center justify-between">
                            <Badge variant="outline">Pergunta {qIndex + 1}</Badge>
                            {questions.length > 1 && (
                                <Button variant="ghost" size="icon" onClick={() => removeQuestion(qIndex)} aria-label={`Remover pergunta ${qIndex + 1}`}>
                                    <Minus className="h-4 w-4" />
                                </Button>
                            )}
                        </div>

                        <Textarea
                            value={question.message || ""}
                            onChange={(e) => updateQuestion(qIndex, "message", e.target.value)}
                            placeholder="Ex: Como você avalia o atendimento?"
                            rows={2}
                        />

                        <div className="space-y-1">
                            <Label className="text-xs">Tipo de resposta</Label>
                            <Select
                                value={question.type || "text"}
                                onValueChange={(value) => updateQuestion(qIndex, "type", value)}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="text">Texto livre</SelectItem>
                                    <SelectItem value="list">Lista interativa</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        {question.type === "list" && question.listConfig && (
                            <div className="space-y-2 mt-2 p-2 bg-muted/30 rounded-md">
                                <div className="space-y-1">
                                    <Label className="text-xs">Texto do botão</Label>
                                    <Input
                                        value={question.listConfig.buttonText || ""}
                                        onChange={(e) => {
                                            const newQuestions = [...questions];
                                            newQuestions[qIndex] = {
                                                ...newQuestions[qIndex],
                                                listConfig: { ...newQuestions[qIndex].listConfig, buttonText: e.target.value },
                                            };
                                            onUpdate({ questions: newQuestions });
                                        }}
                                        placeholder="Ver opções"
                                        maxLength={20}
                                    />
                                </div>

                                {(question.listConfig.sections || []).map((section: any, sIndex: number) => (
                                    <div key={sIndex} className="space-y-2">
                                        {section.rows?.map((row: any, rIndex: number) => (
                                            <div key={rIndex} className="p-2 bg-muted/50 rounded-md space-y-1">
                                                <div className="flex gap-2">
                                                    <Input
                                                        value={row.title || ""}
                                                        onChange={(e) => updateListRow(qIndex, sIndex, rIndex, "title", e.target.value)}
                                                        aria-label={`Título da opção ${rIndex + 1}`}
                                                        placeholder="Ex: Ótimo"
                                                        maxLength={24}
                                                        className="flex-1"
                                                    />
                                                    <Button variant="ghost" size="icon" onClick={() => removeListRow(qIndex, sIndex, rIndex)} aria-label="Remover opção">
                                                        <Minus className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                                <Input
                                                    value={row.description || ""}
                                                    onChange={(e) => updateListRow(qIndex, sIndex, rIndex, "description", e.target.value)}
                                                    placeholder="Descrição (opcional)"
                                                    maxLength={72}
                                                />
                                            </div>
                                        ))}
                                        <Button variant="outline" size="sm" className="w-full" onClick={() => addListRow(qIndex, sIndex)}>
                                            <Plus className="h-4 w-4 mr-2" />
                                            Adicionar opção
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ))}

                <Button variant="outline" size="sm" onClick={addQuestion} className="w-full">
                    <Plus className="h-4 w-4 mr-2" />
                    Adicionar pergunta
                </Button>
            </div>

            <Separator className="my-2" />

            <div className="space-y-2">
                <Label>Mensagem de conclusão (opcional)</Label>
                <Textarea
                    value={data.completionMessage || ""}
                    onChange={(e) => onUpdate({ completionMessage: e.target.value })}
                    placeholder="Obrigado pela sua resposta!"
                    rows={2}
                />
            </div>

            <div className="space-y-2">
                <Label>Lembrete se cliente parar de responder (opcional)</Label>
                <div className="flex items-center gap-2">
                    <Input
                        type="number"
                        min={1}
                        value={data.reminderDelayMinutes ?? 10}
                        onChange={(e) => onUpdate({ reminderDelayMinutes: Number(e.target.value) })}
                        className="w-24"
                    />
                    <span className="text-sm text-muted-foreground">minutos sem resposta</span>
                </div>
                <Textarea
                    value={data.reminderMessage || ""}
                    onChange={(e) => onUpdate({ reminderMessage: e.target.value })}
                    placeholder="Ainda está aí? Falta pouco para terminarmos a pesquisa 🙂"
                    rows={2}
                />
                <p className="text-xs text-muted-foreground">
                    Enviado uma vez por pergunta se o cliente ficar inativo. Deixe a mensagem em branco para desativar.
                </p>
            </div>

            <div className="space-y-2">
                <div className="flex items-center gap-2">
                    <Webhook className="h-4 w-4 text-muted-foreground" />
                    <Label>URL do webhook (opcional)</Label>
                </div>
                <Input
                    value={data.webhookUrl || ""}
                    onChange={(e) => onUpdate({ webhookUrl: e.target.value })}
                    placeholder="https://seu-endpoint.com/pesquisa"
                />
                <p className="text-xs text-muted-foreground">
                    Recebe um POST com todas as respostas ao concluir a pesquisa.
                </p>
            </div>
        </>
    );
}
