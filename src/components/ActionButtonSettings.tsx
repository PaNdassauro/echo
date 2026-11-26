
import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useOrganization } from "@/contexts/OrganizationContext";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { PlaceholderUrlInput, type PlaceholderUrlInputHandle } from "@/components/action-buttons/PlaceholderUrlInput";
import { PlaceholderPalette } from "@/components/action-buttons/PlaceholderPalette";
import {
    Loader2, Save, CheckCircle, Zap, ExternalLink, Code,
    Send, Phone, MessageSquare, Bell, Star, Heart, Bookmark, Share2,
    Upload, Download, FileText, User, Users, Settings, Mail, Calendar,
    Clock, MapPin, Link, Globe, Briefcase, ShoppingCart, CreditCard, Plus,
    FileSpreadsheet, Trash2,
    type LucideIcon
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ActionButtonType } from "@/hooks/useActionButton";
import { toUserMessage } from "@/lib/userFacingError";

// Available icons for button customization
const AVAILABLE_ICONS: { name: string; icon: LucideIcon; label: string }[] = [
    { name: 'plus', icon: Plus, label: 'Criar' },
    { name: 'zap', icon: Zap, label: 'Raio' },
    { name: 'send', icon: Send, label: 'Enviar' },
    { name: 'phone', icon: Phone, label: 'Telefone' },
    { name: 'message-square', icon: MessageSquare, label: 'Mensagem' },
    { name: 'bell', icon: Bell, label: 'Sino' },
    { name: 'star', icon: Star, label: 'Estrela' },
    { name: 'heart', icon: Heart, label: 'Coração' },
    { name: 'bookmark', icon: Bookmark, label: 'Marcador' },
    { name: 'share-2', icon: Share2, label: 'Compartilhar' },
    { name: 'upload', icon: Upload, label: 'Upload' },
    { name: 'download', icon: Download, label: 'Download' },
    { name: 'file-text', icon: FileText, label: 'Documento' },
    { name: 'user', icon: User, label: 'Usuário' },
    { name: 'users', icon: Users, label: 'Grupo' },
    { name: 'settings', icon: Settings, label: 'Config' },
    { name: 'mail', icon: Mail, label: 'Email' },
    { name: 'calendar', icon: Calendar, label: 'Calendário' },
    { name: 'clock', icon: Clock, label: 'Relógio' },
    { name: 'map-pin', icon: MapPin, label: 'Local' },
    { name: 'link', icon: Link, label: 'Link' },
    { name: 'globe', icon: Globe, label: 'Web' },
    { name: 'briefcase', icon: Briefcase, label: 'Negócio' },
    { name: 'shopping-cart', icon: ShoppingCart, label: 'Carrinho' },
    { name: 'credit-card', icon: CreditCard, label: 'Pagamento' },
];

const getIconComponent = (iconName: string): LucideIcon => {
    const found = AVAILABLE_ICONS.find(i => i.name === iconName);
    return found?.icon || Zap;
};

interface PhoneNumber {
    id: string;
    display_name: string | null;
    phone_number: string | null;
}

interface ActionButtonConfig {
    id: string | null;
    position: number;
    label: string;
    button_type: ActionButtonType;
    url: string;
    icon: string;
    is_active: boolean;
    selected_phone_ids: string[];
}

const defaultButtonConfig = (position: number): ActionButtonConfig => ({
    id: null,
    position,
    label: `Ação ${position}`,
    button_type: 'webhook',
    url: "",
    icon: 'zap',
    is_active: false,
    selected_phone_ids: [],
});

const WEBHOOK_PAYLOAD_EXAMPLE = `{
  "event": "action_button.clicked",
  "timestamp": "2024-01-15T10:30:00Z",
  "button_label": "Enviar para CRM",
  "contact": {
    "id": "conv-uuid-123",
    "name": "João Silva",
    "phone": "+5511999999999"
  },
  "agent": {
    "id": "user-uuid-456",
    "name": "Maria Atendente",
    "email": "maria@empresa.com"
  },
  "organization": {
    "id": "org-uuid-789",
    "name": "Minha Empresa"
  },
  "phone_number": {
    "id": "phone-uuid-abc",
    "display_name": "Atendimento",
    "number": "+5511888888888"
  }
}`;

interface ButtonCardProps {
    buttonConfig: ActionButtonConfig;
    title: string;
    phoneNumbers: PhoneNumber[];
    saving: boolean;
    onChange: (next: ActionButtonConfig) => void;
    onSave: () => void;
    onRemove: () => void;
}

function ButtonCard({
    buttonConfig,
    title,
    phoneNumbers,
    saving,
    onChange,
    onSave,
    onRemove,
}: ButtonCardProps) {
    const urlInputRef = useRef<PlaceholderUrlInputHandle>(null);

    const togglePhone = (phoneId: string) => {
        const isSelected = buttonConfig.selected_phone_ids.includes(phoneId);
        onChange({
            ...buttonConfig,
            selected_phone_ids: isSelected
                ? buttonConfig.selected_phone_ids.filter(id => id !== phoneId)
                : [...buttonConfig.selected_phone_ids, phoneId],
        });
    };

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1">
                        <CardTitle className="flex items-center gap-2 text-lg">
                            <Zap className="w-4 h-4" />
                            {title}
                        </CardTitle>
                        <CardDescription>
                            {buttonConfig.button_type === 'webhook' && "Envia dados da conversa para um webhook"}
                            {buttonConfig.button_type === 'link' && "Abre um link externo em nova aba"}
                            {buttonConfig.button_type === 'import_history' && "Abre o importador de histórico de conversa (CSV)"}
                        </CardDescription>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onRemove}
                        disabled={saving}
                        className="h-11 w-11 sm:h-8 sm:w-8 text-muted-foreground hover:text-destructive shrink-0"
                        title="Remover botão"
                        aria-label="Remover botão"
                    >
                        <Trash2 className="w-4 h-4" />
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                        <Label>Ativar botão</Label>
                        <p className="text-xs text-muted-foreground">
                            Quando ativo, aparece no cabeçalho da conversa.
                        </p>
                    </div>
                    <Switch
                        checked={buttonConfig.is_active}
                        onCheckedChange={(checked) => onChange({ ...buttonConfig, is_active: checked })}
                    />
                </div>

                <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                        <Label>Texto do botão</Label>
                        <Input
                            placeholder="Ex: Enviar ao CRM"
                            value={buttonConfig.label}
                            onChange={(e) => onChange({ ...buttonConfig, label: e.target.value })}
                            maxLength={15}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label>Tipo</Label>
                        <Select
                            value={buttonConfig.button_type}
                            onValueChange={(value: ActionButtonType) => onChange({
                                ...buttonConfig,
                                button_type: value,
                                url: value === 'import_history' ? '' : buttonConfig.url,
                            })}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="webhook">
                                    <div className="flex items-center gap-2">
                                        <Code className="w-3 h-3" />
                                        Webhook
                                    </div>
                                </SelectItem>
                                <SelectItem value="link">
                                    <div className="flex items-center gap-2">
                                        <ExternalLink className="w-3 h-3" />
                                        Link
                                    </div>
                                </SelectItem>
                                <SelectItem value="import_history">
                                    <div className="flex items-center gap-2">
                                        <FileSpreadsheet className="w-3 h-3" />
                                        Importar histórico
                                    </div>
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label>Ícone</Label>
                        <Select
                            value={buttonConfig.icon}
                            onValueChange={(value) => onChange({ ...buttonConfig, icon: value })}
                        >
                            <SelectTrigger>
                                <SelectValue>
                                    {(() => {
                                        const IconComp = getIconComponent(buttonConfig.icon);
                                        return (
                                            <div className="flex items-center gap-2">
                                                <IconComp className="w-4 h-4" />
                                            </div>
                                        );
                                    })()}
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-h-60">
                                {AVAILABLE_ICONS.map(({ name, icon: Icon, label }) => (
                                    <SelectItem key={name} value={name}>
                                        <div className="flex items-center gap-2">
                                            <Icon className="w-4 h-4" />
                                            <span>{label}</span>
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                {(buttonConfig.button_type === 'webhook' || buttonConfig.button_type === 'link') && (
                    <div className="space-y-2">
                        <Label>{buttonConfig.button_type === 'webhook' ? 'URL do Webhook' : 'URL do Link'}</Label>
                        <PlaceholderUrlInput
                            ref={urlInputRef}
                            value={buttonConfig.url}
                            onChange={(url) => onChange({ ...buttonConfig, url })}
                            placeholder={buttonConfig.button_type === 'webhook'
                                ? "https://seu-servidor.com/webhook"
                                : "https://seu-crm.com/contato?phone={contact.phone}"}
                        />
                        {buttonConfig.button_type === 'link' ? (
                            <PlaceholderPalette
                                onInsert={(token) => urlInputRef.current?.insertAtCursor(token)}
                            />
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                Recebe um POST com os dados da conversa quando o botão for acionado.
                            </p>
                        )}
                    </div>
                )}

                {buttonConfig.button_type === 'import_history' && (
                    <Alert>
                        <FileSpreadsheet className="w-4 h-4" />
                        <AlertDescription>
                            Ao clicar no botão dentro de uma conversa 1:1, abre um diálogo para enviar um CSV
                            exportado do WhatsApp e anexar o histórico àquela conversa. Não aparece em grupos.
                        </AlertDescription>
                    </Alert>
                )}

                {phoneNumbers.length > 0 && (
                    <div className="space-y-2">
                        <Label>Números habilitados</Label>
                        <p className="text-xs text-muted-foreground mb-2">
                            Selecione em quais números o botão aparece. Sem seleção, aparece em todos.
                        </p>
                        <div className="border rounded-md p-3 space-y-2 max-h-32 overflow-y-auto">
                            {phoneNumbers.map((phone) => (
                                <div key={phone.id} className="flex items-center space-x-2">
                                    <Checkbox
                                        id={`phone-${buttonConfig.position}-${phone.id}`}
                                        checked={buttonConfig.selected_phone_ids.includes(phone.id)}
                                        onCheckedChange={() => togglePhone(phone.id)}
                                    />
                                    <label
                                        htmlFor={`phone-${buttonConfig.position}-${phone.id}`}
                                        className="text-sm leading-none cursor-pointer"
                                    >
                                        {phone.display_name || phone.phone_number || phone.id}
                                    </label>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </CardContent>
            <CardFooter className="flex justify-between items-center border-t px-6 py-4 bg-muted/20">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {buttonConfig.id && buttonConfig.is_active && (
                        <>
                            <CheckCircle className="w-4 h-4 text-green-500" />
                            <span>Ativo</span>
                        </>
                    )}
                </div>
                <Button onClick={onSave} disabled={saving} size="sm">
                    {saving ? (
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    ) : (
                        <Save className="w-4 h-4 mr-2" />
                    )}
                    Salvar
                </Button>
            </CardFooter>
        </Card>
    );
}

export function ActionButtonSettings() {
    const { currentOrganization, isLoading: orgLoading } = useOrganization();
    const { toast } = useToast();
    const [removeConfirm, setRemoveConfirm] = useState<{ index: number; label: string } | null>(null);
    const [removing, setRemoving] = useState(false);

    const [buttons, setButtons] = useState<ActionButtonConfig[]>([]);
    const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
    const [savingPosition, setSavingPosition] = useState<number | null>(null);
    const [payloadOpen, setPayloadOpen] = useState(false);

    useEffect(() => {
        if (currentOrganization?.id) {
            fetchActionButtons();
            fetchPhoneNumbers();
        }
    }, [currentOrganization?.id]);

    const fetchPhoneNumbers = async () => {
        if (!currentOrganization?.id) return;
        try {
            const { data, error } = await supabase
                .from('phone_numbers')
                .select('id, display_name, phone_number')
                .eq('organization_id', currentOrganization.id)
                .order('display_name');

            if (error) throw error;
            setPhoneNumbers((data || []) as PhoneNumber[]);
        } catch (error) {
            console.error("Error fetching phone numbers:", error);
        }
    };

    const fetchActionButtons = async () => {
        if (!currentOrganization?.id) return;
        try {
            const { data: buttonsData, error: buttonsError } = await supabase
                .from('organization_action_buttons')
                .select('id, position, label, button_type, url, icon, is_active')
                .eq('organization_id', currentOrganization.id)
                .order('position');

            if (buttonsError) throw buttonsError;

            const rows = (buttonsData || []) as any[];

            // Vínculos de todos os botões numa query só (antes: 1 query por botão)
            const buttonIds = rows.map((btn) => btn.id);
            const phoneIdsByButton = new Map<string, string[]>();
            if (buttonIds.length > 0) {
                const { data: phoneData, error: phoneError } = await supabase
                    .from('action_button_phone_numbers')
                    .select('action_button_id, phone_number_id')
                    .in('action_button_id', buttonIds);

                if (phoneError) throw phoneError;

                for (const link of (phoneData || []) as any[]) {
                    const list = phoneIdsByButton.get(link.action_button_id) ?? [];
                    list.push(link.phone_number_id);
                    phoneIdsByButton.set(link.action_button_id, list);
                }
            }

            const loaded: ActionButtonConfig[] = rows.map((btn) => ({
                id: btn.id,
                position: btn.position,
                label: btn.label || `Ação ${btn.position}`,
                button_type: btn.button_type || 'webhook',
                url: btn.url || "",
                icon: btn.icon || 'zap',
                is_active: btn.is_active || false,
                selected_phone_ids: phoneIdsByButton.get(btn.id) ?? [],
            }));
            setButtons(loaded);
        } catch (error) {
            console.error("Error fetching action buttons:", error);
        }
    };

    const updateButton = (index: number, next: ActionButtonConfig) => {
        setButtons(prev => prev.map((b, i) => (i === index ? next : b)));
    };

    const handleAddButton = () => {
        const nextPosition = buttons.reduce((max, b) => (b.position > max ? b.position : max), 0) + 1;
        setButtons(prev => [...prev, defaultButtonConfig(nextPosition)]);
    };

    const handleRemoveButton = (index: number) => {
        const target = buttons[index];
        if (!target) return;

        // Botão nunca salvo: só estado local, descarta direto
        if (!target.id) {
            setButtons(prev => prev.filter((_, i) => i !== index));
            return;
        }

        setRemoveConfirm({ index, label: target.label || "este botão" });
    };

    const confirmRemoveButton = async () => {
        if (!removeConfirm) return;
        const target = buttons[removeConfirm.index];
        if (!target?.id) {
            setRemoveConfirm(null);
            return;
        }

        setRemoving(true);
        const { error } = await supabase
            .from('organization_action_buttons')
            .delete()
            .eq('id', target.id);
        setRemoving(false);

        if (error) {
            toast({
                title: "Não foi possível remover o botão",
                description: toUserMessage(error),
                variant: "destructive",
            });
            return;
        }

        setRemoveConfirm(null);
        setButtons(prev => prev.filter((_, i) => i !== removeConfirm.index));
        toast({ title: "Botão removido" });
    };

    const handleSaveButton = async (index: number) => {
        if (!currentOrganization?.id) return;
        const buttonConfig = buttons[index];
        if (!buttonConfig) return;

        setSavingPosition(buttonConfig.position);

        try {
            const requiresUrl = buttonConfig.button_type === 'webhook' || buttonConfig.button_type === 'link';
            if (requiresUrl && !buttonConfig.url && buttonConfig.is_active) {
                toast({
                    title: "Informe a URL do botão",
                    description: "Um botão ativo precisa de uma URL para funcionar.",
                    variant: "destructive",
                });
                setSavingPosition(null);
                return;
            }

            let buttonId = buttonConfig.id;

            if (buttonId) {
                const { error } = await supabase
                    .from('organization_action_buttons')
                    .update({
                        label: buttonConfig.label,
                        button_type: buttonConfig.button_type,
                        url: buttonConfig.url,
                        icon: buttonConfig.icon,
                        is_active: buttonConfig.is_active,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', buttonId);
                if (error) throw error;
            } else {
                const { data, error } = await supabase
                    .from('organization_action_buttons')
                    .insert({
                        organization_id: currentOrganization.id,
                        position: buttonConfig.position,
                        label: buttonConfig.label,
                        button_type: buttonConfig.button_type,
                        url: buttonConfig.url,
                        icon: buttonConfig.icon,
                        is_active: buttonConfig.is_active,
                    })
                    .select('id')
                    .single();
                if (error) throw error;
                buttonId = (data as any).id;
                updateButton(index, { ...buttonConfig, id: buttonId });
            }

            // Replace phone associations
            await supabase
                .from('action_button_phone_numbers')
                .delete()
                .eq('action_button_id', buttonId);

            if (buttonConfig.selected_phone_ids.length > 0) {
                const inserts = buttonConfig.selected_phone_ids.map(phoneId => ({
                    action_button_id: buttonId,
                    phone_number_id: phoneId,
                }));
                const { error: insertError } = await supabase
                    .from('action_button_phone_numbers')
                    .insert(inserts);
                if (insertError) throw insertError;
            }

            toast({ title: "Sucesso", description: `Botão salvo.` });
        } catch (error: any) {
            console.error("Error saving action button:", error);
            toast({
                title: "Não foi possível salvar o botão",
                description: toUserMessage(error),
                variant: "destructive",
            });
        } finally {
            setSavingPosition(null);
        }
    };

    if (orgLoading) {
        return <div className="flex justify-center p-8"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
    }

    if (!currentOrganization) {
        return <Alert><AlertDescription>Selecione uma organização para configurar os botões.</AlertDescription></Alert>;
    }

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-semibold">Botões de ação</h2>
                    <p className="text-sm text-muted-foreground">Configure botões customizados no header do chat.</p>
                </div>
                <Button onClick={handleAddButton} size="sm">
                    <Plus className="w-4 h-4 mr-2" />
                    Adicionar botão
                </Button>
            </div>

            {buttons.length === 0 ? (
                <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                        <Zap className="w-10 h-10 text-muted-foreground/50" />
                        <p className="text-sm text-muted-foreground">
                            Nenhum botão configurado. Selecione “Adicionar botão” para começar.
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-4 md:grid-cols-2">
                    {buttons.map((btn, i) => (
                        <ButtonCard
                            key={btn.id ?? `new-${btn.position}`}
                            buttonConfig={btn}
                            title={`Botão ${i + 1}`}
                            phoneNumbers={phoneNumbers}
                            saving={savingPosition === btn.position}
                            onChange={(next) => updateButton(i, next)}
                            onSave={() => handleSaveButton(i)}
                            onRemove={() => handleRemoveButton(i)}
                        />
                    ))}
                </div>
            )}

            {/* Webhook Payload Example */}
            <Collapsible open={payloadOpen} onOpenChange={setPayloadOpen}>
                <Card className="bg-muted/30">
                    <CollapsibleTrigger asChild>
                        <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                            <CardTitle className="text-sm font-medium flex items-center gap-2">
                                <Code className="w-4 h-4" />
                                Exemplo de Payload do Webhook
                                <span className="text-xs text-muted-foreground ml-auto">
                                    {payloadOpen ? "Ocultar" : "Mostrar"}
                                </span>
                            </CardTitle>
                        </CardHeader>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                        <CardContent>
                            <p className="text-xs text-muted-foreground mb-2">
                                Quando o tipo é &quot;Webhook&quot;, este payload será enviado via POST:
                            </p>
                            <pre className="bg-background p-3 rounded border text-xs font-mono overflow-x-auto">
                                {WEBHOOK_PAYLOAD_EXAMPLE}
                            </pre>
                        </CardContent>
                    </CollapsibleContent>
                </Card>
            </Collapsible>

            <ConfirmDestructiveDialog
                open={removeConfirm !== null}
                onOpenChange={(open) => {
                    if (!open) setRemoveConfirm(null);
                }}
                title="Remover botão de ação?"
                description={
                    <>
                        Você está prestes a remover <strong>{removeConfirm?.label}</strong>. Ele some do
                        header do chat para toda a organização. Esta ação não pode ser desfeita.
                    </>
                }
                confirmLabel="Remover botão"
                pending={removing}
                onConfirm={() => void confirmRemoveButton()}
            />
        </div>
    );
}
