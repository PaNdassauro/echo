import { useState, useEffect, useRef, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import * as XLSX from "xlsx";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    ArrowLeft,
    ArrowRight,
    Check,
    Loader2,
    MessageSquare,
    Phone,
    Users,
    Calendar,
    Send,
    Download,
    Upload,
    Plus,
    Trash2,
    FileSpreadsheet,
    RefreshCw,
} from "lucide-react";
import { format } from "date-fns";
import RecipientTable from "./RecipientTable";
import ExcelImporter from "./ExcelImporter";
import SchedulePicker from "./SchedulePicker";
import { useInlineTemplateCreation } from "@/components/templates/useInlineTemplateCreation";
import { extractVariables } from "@/lib/templateBuilder";
import TemplateMediaHeaderInput from "@/components/templates/TemplateMediaHeaderInput";
import { SelectableCard } from "./SelectableCard";
import { getTemplateHeaderFormat, TemplateHeaderFormat, TemplateHeaderMedia } from "@/lib/templateMedia";

interface PhoneNumber {
    id: string;
    display_name: string;
    phone_number_id: string;
    organization_id: string;
}

interface Template {
    id: string;
    name: string;
    language: string;
    status: string;
    category: string;
    components: any[];
}

interface Recipient {
    id: string;
    phone_number: string;
    contact_name: string;
    variables: string[];
}

interface BroadcastBuilderProps {
    onBack: () => void;
    onSuccess: () => void;
}

const STEPS = [
    { id: 1, title: "Número", icon: Phone },
    { id: 2, title: "Template", icon: MessageSquare },
    { id: 3, title: "Destinatários", icon: Users },
    { id: 4, title: "Agendar", icon: Calendar },
    { id: 5, title: "Enviar", icon: Send },
];

// Recipients are inserted in chunks rather than one statement. Matches the size
// already used by the history importer (src/lib/importHistoryClient.ts).
const RECIPIENT_INSERT_CHUNK = 200;

const HEADER_FORMAT_LABEL: Record<TemplateHeaderFormat, string> = {
    IMAGE: "imagem",
    VIDEO: "vídeo",
    DOCUMENT: "documento",
};

function pluralize(n: number, singular: string, plural: string): string {
    return n === 1 ? `1 ${singular}` : `${n} ${plural}`;
}

// One empty-state treatment for every wizard step. The three steps previously used
// their own padding and structure, so moving through the wizard with nothing
// configured felt like three different screens.
function WizardEmptyState({
    icon: Icon,
    title,
    hint,
    action,
}: {
    icon: typeof Phone;
    title: string;
    hint?: string;
    action?: ReactNode;
}) {
    return (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-12 px-6 text-center">
            <Icon className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="font-medium text-balance">{title}</p>
            {hint && <p className="text-sm text-muted-foreground mt-1 text-pretty">{hint}</p>}
            {action && <div className="mt-3 text-sm">{action}</div>}
        </div>
    );
}

export default function BroadcastBuilder({ onBack, onSuccess }: BroadcastBuilderProps) {
    const { toast } = useToast();
    const { currentOrganization } = useOrganization();

    const [currentStep, setCurrentStep] = useState(1);
    const [discardConfirm, setDiscardConfirm] = useState(false);
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    // Step 1: Phone Number
    const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
    const [selectedPhoneId, setSelectedPhoneId] = useState<string>("");

    // Step 2: Template
    const [templates, setTemplates] = useState<Template[]>([]);
    const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
    const [templateSearch, setTemplateSearch] = useState("");
    const [variableCount, setVariableCount] = useState(0);
    const [buttonVariableCount, setButtonVariableCount] = useState(0);
    const [headerMedia, setHeaderMedia] = useState<TemplateHeaderMedia | null>(null);

    // Step 3: Recipients
    const [recipients, setRecipients] = useState<Recipient[]>([]);
    const [showExcelImporter, setShowExcelImporter] = useState(false);

    // Step 4: Schedule
    const [scheduleType, setScheduleType] = useState<"now" | "scheduled">("now");
    const [scheduledDate, setScheduledDate] = useState<Date | null>(null);

    // Step 5: Broadcast Name
    const [broadcastName, setBroadcastName] = useState("");

    // Load phone numbers
    useEffect(() => {
        if (currentOrganization?.id) {
            fetchPhoneNumbers();
        }
    }, [currentOrganization?.id]);

    // Load templates when phone selected
    useEffect(() => {
        if (selectedPhoneId) {
            fetchTemplates();
        }
    }, [selectedPhoneId]);

    // Reset header media whenever the selected template changes, except for the
    // template just created here: its approval sample is already in Storage.
    const approvedMediaRef = useRef<{ templateId: string; media: TemplateHeaderMedia } | null>(null);
    useEffect(() => {
        const carried = approvedMediaRef.current;
        setHeaderMedia(carried && carried.templateId === selectedTemplate?.id ? carried.media : null);
        approvedMediaRef.current = null;
    }, [selectedTemplate?.id]);

    // Count variables from the WhatsApp template.
    useEffect(() => {
        if (selectedTemplate) {
            // Count body variables
            const bodyComponent = selectedTemplate.components?.find((c) => c.type === "BODY");
            // Variável repetida ({{1}} duas vezes) é uma coluna só.
            setVariableCount(extractVariables(bodyComponent?.text ?? "").length);

            // Count button URL variables
            const buttonsComponent = selectedTemplate.components?.find((c) => c.type === "BUTTONS");
            let btnVarCount = 0;
            if (buttonsComponent?.buttons && Array.isArray(buttonsComponent.buttons)) {
                buttonsComponent.buttons.forEach((btn: { type: string; url?: string }) => {
                    if (btn.type === "URL" && btn.url?.includes("{{")) {
                        btnVarCount++;
                    }
                });
            }
            setButtonVariableCount(btnVarCount);
        } else {
            setVariableCount(0);
            setButtonVariableCount(0);
        }
    }, [selectedTemplate]);

    const fetchPhoneNumbers = async () => {
        try {
            const { data, error } = await (supabase as any)
                .from("phone_numbers")
                .select("id, display_name, phone_number_id, organization_id")
                .eq("organization_id", currentOrganization?.id)
                .neq("connection_type", "qr"); // Exclude QR numbers - templates require Business API

            if (error) throw error;
            console.log("Phone numbers found:", data);
            setPhoneNumbers(data || []);
        } catch (error: any) {
            console.error("Error fetching phone numbers:", error);
        }
    };

    // Criar na hora: quando a Meta aprova, o template entra na lista já selecionado.
    const templateCreation = useInlineTemplateCreation({
        onApproved: (template, { headerMedia: sample }) => {
            setTemplates((prev) => [template, ...prev.filter((t) => t.id !== template.id)]);
            // Só seleciona sozinho se ninguém escolheu outro nesse meio-tempo.
            if (selectedTemplate || currentStep !== 2) return;
            if (sample && getTemplateHeaderFormat(template) === sample.format) {
                approvedMediaRef.current = { templateId: template.id, media: sample };
            }
            setSelectedTemplate(template);
        },
    });

    const fetchTemplates = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase.functions.invoke("whatsapp-templates", {
                body: { organizationId: currentOrganization?.id },
            });

            if (error) throw error;

            // Filter to only approved templates
            const approvedTemplates = (data?.data || []).filter(
                (t: Template) => t.status === "APPROVED"
            );
            setTemplates(approvedTemplates);
        } catch (error: any) {
            console.error("Error fetching templates:", error);
            toast({
                title: "Não foi possível carregar os templates",
                description: toUserMessage(error, "Verifique a conexão e toque em Atualizar para tentar de novo."),
                variant: "destructive",
            });
        } finally {
            setLoading(false);
        }
    };

    const getBodyText = (template: Template): string => {
        const bodyComponent = template.components?.find((c) => c.type === "BODY");
        return bodyComponent?.text || "";
    };

    const filteredTemplates = templates.filter(
        (t) =>
            t.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
            getBodyText(t).toLowerCase().includes(templateSearch.toLowerCase())
    );

    const handleAddRecipient = () => {
        const totalVars = variableCount + buttonVariableCount;
        setRecipients([
            ...recipients,
            {
                id: crypto.randomUUID(),
                phone_number: "",
                contact_name: "",
                variables: Array(totalVars).fill(""),
            },
        ]);
    };

    const handleRemoveRecipient = (id: string) => {
        setRecipients(recipients.filter((r) => r.id !== id));
    };

    const handleRecipientChange = (id: string, field: keyof Recipient, value: string | string[]) => {
        setRecipients(
            recipients.map((r) => (r.id === id ? { ...r, [field]: value } : r))
        );
    };

    const handleExcelImport = (importedRecipients: Recipient[]) => {
        setRecipients([...recipients, ...importedRecipients]);
        setShowExcelImporter(false);
    };

    const downloadExcelTemplate = () => {
        // Generate Excel template with headers
        const headers = ["telefone", "nome"];

        // Add body variable columns
        for (let i = 1; i <= variableCount; i++) {
            headers.push(`variavel_${i}`);
        }

        // Add button variable columns
        for (let i = 1; i <= buttonVariableCount; i++) {
            headers.push(`botao_${i}`);
        }

        const exampleRow = ["5511999990001", "João Silva"];

        // Add body variable examples
        for (let i = 1; i <= variableCount; i++) {
            exampleRow.push(`exemplo ${i}`);
        }

        // Add button variable examples
        for (let i = 1; i <= buttonVariableCount; i++) {
            exampleRow.push(`param_botao_${i}`);
        }

        // Create workbook and worksheet
        const ws = XLSX.utils.aoa_to_sheet([headers, exampleRow]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Contatos");

        // Download
        const totalVars = variableCount + buttonVariableCount;
        XLSX.writeFile(wb, `planilha_exemplo_disparo_${totalVars}_variaveis.xlsx`);
    };

    const requiredHeaderFormat = selectedTemplate ? getTemplateHeaderFormat(selectedTemplate) : null;

    const canProceed = () => {
        switch (currentStep) {
            case 1:
                return !!selectedPhoneId;
            case 2:
                if (!selectedTemplate) return false;
                if (requiredHeaderFormat && !headerMedia?.link) return false;
                return true;
            case 3:
                return recipients.length > 0 && recipients.every((r) => r.phone_number.trim());
            case 4:
                return scheduleType === "now" || (scheduleType === "scheduled" && scheduledDate);
            case 5:
                return broadcastName.trim().length > 0;
            default:
                return false;
        }
    };

    // Mirrors canProceed(), naming what is missing. A disabled "Próximo" that never
    // says why is the kind of dead end users read as "the app is broken".
    const blockingReason = (): string | null => {
        switch (currentStep) {
            case 1:
                return selectedPhoneId ? null : "Selecione um número para continuar";
            case 2:
                if (!selectedTemplate) return "Selecione um template";
                if (requiredHeaderFormat && !headerMedia?.link) return "Envie a mídia do cabeçalho do template";
                return null;
            case 3:
                if (recipients.length === 0) return "Adicione ao menos um destinatário";
                if (!recipients.every((r) => r.phone_number.trim())) return "Há destinatários sem telefone";
                return null;
            case 4:
                return scheduleType === "scheduled" && !scheduledDate ? "Escolha a data e hora do agendamento" : null;
            case 5:
                return broadcastName.trim() ? null : "Dê um nome ao disparo";
            default:
                return null;
        }
    };

    const handleSubmit = async () => {
        if (!selectedPhoneId || recipients.length === 0) return;
        if (!selectedTemplate) return;

        setSubmitting(true);
        try {
            // 1. Create broadcast from an approved template.
            const insertPayload = {
                organization_id: currentOrganization?.id,
                phone_number_id: selectedPhoneId,
                body_variable_count: variableCount,
                name: broadcastName,
                status: scheduleType === "now" ? "draft" : "scheduled",
                scheduled_at: scheduledDate?.toISOString() || null,
                total_recipients: 0, // Trigger counts recipients as they are inserted
                template_id: selectedTemplate.id,
                template_name: selectedTemplate.name,
                template_language: selectedTemplate.language,
                template_components: selectedTemplate.components,
                button_variable_count: buttonVariableCount,
                header_media: headerMedia,
            };

            const { data: broadcast, error: broadcastError } = await (supabase as any)
                .from("broadcasts")
                .insert(insertPayload)
                .select()
                .single();

            if (broadcastError) throw broadcastError;

            // 2. Create recipients, in chunks.
            //
            // A single insert of the whole array is ~1 MB of POST body at 5.000 rows.
            // Chunking also keeps each statement's trigger work bounded. If a chunk
            // fails we delete the parent broadcast rather than leaving an orphan draft
            // behind (which is what used to happen, with total_recipients stuck at 0).
            const recipientInserts = recipients.map((r) => ({
                broadcast_id: broadcast.id,
                phone_number: r.phone_number.replace(/\D/g, ""),
                contact_name: r.contact_name || null,
                variables: r.variables,
            }));

            try {
                for (let i = 0; i < recipientInserts.length; i += RECIPIENT_INSERT_CHUNK) {
                    const chunk = recipientInserts.slice(i, i + RECIPIENT_INSERT_CHUNK);
                    const { error: chunkError } = await supabase
                        .from("broadcast_recipients")
                        .insert(chunk);
                    if (chunkError) throw chunkError;
                }

                // Never start sending against a partially-written list. Nothing used to
                // compare what was persisted with what the user actually imported.
                const { count: persisted, error: countError } = await supabase
                    .from("broadcast_recipients")
                    .select("*", { count: "exact", head: true })
                    .eq("broadcast_id", broadcast.id);
                if (countError) throw countError;

                if ((persisted || 0) !== recipientInserts.length) {
                    throw new Error(
                        `Foram gravados ${persisted || 0} de ${recipientInserts.length} destinatários. O disparo não foi iniciado.`
                    );
                }
            } catch (recipientsError) {
                await supabase.from("broadcasts").delete().eq("id", broadcast.id);
                throw recipientsError;
            }

            // 3. If "now", hand the broadcast to the queue. Delivery belongs to the
            // dispatch-broadcast-work cron job from here, so navigating away or closing
            // the tab cannot strand it half-sent.
            const broadcastId = broadcast.id;
            if (scheduleType === "now") {
                const { error: queueError } = await supabase
                    .from("broadcasts")
                    .update({ status: "processing" })
                    .eq("id", broadcastId);

                if (queueError) throw queueError;

                // Nudge a worker now purely to cut the wait for the first message.
                supabase.functions
                    .invoke("broadcast-execute", { body: { broadcastId } })
                    .catch((err) =>
                        console.error("[Broadcast] Nudge imediato falhou; o dispatcher assume:", err)
                    );
            }

            toast({
                title: scheduleType === "now" ? "Disparo na fila" : "Disparo agendado",
                description:
                    scheduleType === "now"
                        ? "As mensagens começam a sair em instantes. Pode fechar a aba — o envio continua."
                        : `Agendado para ${format(scheduledDate!, "dd/MM/yyyy 'às' HH:mm")}`,
            });

            setSubmitting(false);
            onSuccess();
        } catch (error: any) {
            console.error("Error creating broadcast:", error);
            toast({
                title: "Não foi possível criar o disparo",
                description: toUserMessage(error, "Nada foi enviado. Revise a lista de destinatários e tente de novo."),
                variant: "destructive",
            });
            setSubmitting(false);
        }
    };

    // Voltar descartava a planilha importada e o disparo montado sem aviso
    const isDirty = currentStep > 1 || recipients.length > 0;
    const handleBack = () => {
        if (isDirty) {
            setDiscardConfirm(true);
            return;
        }
        onBack();
    };

    return (
        <div className="min-h-dvh bg-background">
            {/* Header */}
            <div className="border-b safe-area-top">
                <div className="container mx-auto px-4 py-4">
                    <div className="flex items-center gap-4">
                        <Button variant="ghost" size="icon" onClick={handleBack} aria-label="Voltar">
                            <ArrowLeft className="h-5 w-5" />
                        </Button>
                        <div>
                            <h1 className="text-xl font-bold tracking-tight">Novo disparo</h1>
                            <p className="text-sm text-muted-foreground">
                                Passo {currentStep} de {STEPS.length}
                            </p>
                        </div>
                    </div>

                    {/* Step indicator.
                        STEPS has always carried a `title` for each step and it was never
                        rendered — the user got five anonymous icons. The row is also
                        ~456px wide, which overflows a 375px phone, hence the scroller
                        (justify-start when scrolling, so the first step stays reachable:
                        justify-center would put the overflow out of reach). */}
                    <nav aria-label="Etapas do disparo" className="mt-6 -mx-4 px-4 overflow-x-auto">
                        <ol className="flex items-start justify-start sm:justify-center gap-1 min-w-max mx-auto">
                            {STEPS.map((step, index) => {
                                const done = currentStep > step.id;
                                const active = currentStep === step.id;
                                return (
                                    <li key={step.id} className="flex items-start">
                                        <div className="flex flex-col items-center gap-1.5 w-20">
                                            <div
                                                aria-current={active ? "step" : undefined}
                                                className={`flex items-center justify-center w-10 h-10 rounded-full border-2 transition-colors duration-150 ease-out ${done
                                                    ? "bg-primary border-primary text-primary-foreground"
                                                    : active
                                                        ? "border-primary text-primary"
                                                        : "border-muted-foreground/30 text-muted-foreground/50"
                                                    }`}
                                            >
                                                {done ? (
                                                    <Check className="h-5 w-5" />
                                                ) : (
                                                    <step.icon className="h-5 w-5" />
                                                )}
                                            </div>
                                            <span
                                                className={`text-xs text-center leading-normal ${active
                                                    ? "text-foreground font-medium"
                                                    : "text-muted-foreground"
                                                    }`}
                                            >
                                                {step.title}
                                            </span>
                                        </div>
                                        {index < STEPS.length - 1 && (
                                            // The circle animated but this bar snapped, so
                                            // advancing a step was half-animated.
                                            <div
                                                aria-hidden="true"
                                                className={`w-6 h-0.5 mt-5 transition-colors duration-150 ease-out ${done ? "bg-primary" : "bg-muted-foreground/30"
                                                    }`}
                                            />
                                        )}
                                    </li>
                                );
                            })}
                        </ol>
                    </nav>
                </div>
            </div>

            {/* Content */}
            <div className="container mx-auto px-4 py-8 max-w-4xl">
                {/* Step 1: Select Phone Number */}
                {currentStep === 1 && (
                    <Card>
                        <CardHeader>
                            <CardTitle>Selecione o número</CardTitle>
                            <CardDescription>
                                Escolha o número WhatsApp Business que enviará as mensagens.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            {phoneNumbers.length === 0 ? (
                                <WizardEmptyState
                                    icon={Phone}
                                    title="Nenhum número Business API configurado"
                                    hint="Templates só podem ser enviados via API oficial."
                                    action={
                                        <Link
                                            to="/settings?tab=appearance"
                                            className="text-primary underline underline-offset-2 [text-underline-position:from-font] [text-decoration-thickness:from-font]"
                                        >
                                            Conecte um número pela API oficial em Configurações → Números
                                        </Link>
                                    }
                                />
                            ) : (
                                <div className="grid gap-3" role="radiogroup" aria-label="Número de envio">
                                    {phoneNumbers.map((phone) => (
                                        <SelectableCard
                                            key={phone.id}
                                            name="broadcast-phone"
                                            label={phone.display_name}
                                            selected={selectedPhoneId === phone.id}
                                            onSelect={() => setSelectedPhoneId(phone.id)}
                                        >
                                            <span className="flex items-center gap-3">
                                                <Phone className="h-5 w-5 text-primary shrink-0" />
                                                <span className="font-medium">{phone.display_name}</span>
                                            </span>
                                        </SelectableCard>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                )}

                {/* Step 2: Select Template */}
                {currentStep === 2 && (
                    <Card>
                        <CardHeader>
                            <CardTitle>Selecione o template</CardTitle>
                            <CardDescription>
                                Escolha um template aprovado pelo WhatsApp para enviar.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex gap-2">
                                <Input
                                    placeholder="Buscar templates…"
                                    value={templateSearch}
                                    onChange={(e) => setTemplateSearch(e.target.value)}
                                    className="flex-1"
                                />
                                <Button
                                    variant="outline"
                                    onClick={() => fetchTemplates()}
                                    disabled={loading}
                                >
                                    <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
                                    Atualizar
                                </Button>
                                <Button variant="outline" onClick={() => templateCreation.openBuilder()}>
                                    <Plus className="h-4 w-4 mr-2" />
                                    Criar template
                                </Button>
                            </div>

                            {templateCreation.notice}

                            {loading ? (
                                <div className="flex justify-center py-8">
                                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                                </div>
                            ) : filteredTemplates.length === 0 ? (
                                <WizardEmptyState
                                    icon={MessageSquare}
                                    title={templateSearch ? "Nenhum template com essa busca" : "Nenhum template aprovado ainda"}
                                    hint="Crie um agora: a Meta costuma aprovar em poucos minutos."
                                    action={
                                        <Button size="sm" onClick={() => templateCreation.openBuilder()}>
                                            <Plus className="h-4 w-4 mr-2" />
                                            Criar template
                                        </Button>
                                    }
                                />
                            ) : (
                                <ScrollArea className="[&_[data-radix-scroll-area-viewport]>div]:!block h-[400px]">
                                    {/* !block: o Radix põe display:table no conteúdo, que alarga até o texto mais longo e corta a lista na lateral. */}
                                    <div className="grid gap-3 pr-4" role="radiogroup" aria-label="Template da mensagem">
                                        {filteredTemplates.map((template) => (
                                            <SelectableCard
                                                key={template.id}
                                                name="broadcast-template"
                                                label={`${template.name} — ${template.category}`}
                                                selected={selectedTemplate?.id === template.id}
                                                onSelect={() => setSelectedTemplate(template)}
                                            >
                                                <span className="flex flex-wrap items-center justify-between gap-2 mb-2">
                                                    <span className="font-medium">{template.name}</span>
                                                    <span className="flex items-center gap-2">
                                                        {/* Token-based, and outline so the inherited
                                                            hover:bg-primary/80 can't flash teal. */}
                                                        <Badge variant="outline" className="bg-success/10 text-success border-success/20">
                                                            Aprovado
                                                        </Badge>
                                                        <Badge variant="secondary">{template.category}</Badge>
                                                    </span>
                                                </span>
                                                <span className="block text-sm text-muted-foreground line-clamp-2">
                                                    {getBodyText(template)}
                                                </span>
                                            </SelectableCard>
                                        ))}
                                    </div>
                                </ScrollArea>
                            )}

                            {selectedTemplate && requiredHeaderFormat && (
                                <div className="rounded-md border bg-muted/30 p-4 space-y-3">
                                    <div>
                                        <p className="text-sm font-medium">Mídia do cabeçalho do template</p>
                                        <p className="text-xs text-muted-foreground text-pretty">
                                            Este template tem um cabeçalho de {HEADER_FORMAT_LABEL[requiredHeaderFormat]}. O mesmo arquivo vai para todos os destinatários do disparo.
                                        </p>
                                    </div>
                                    <TemplateMediaHeaderInput
                                        format={requiredHeaderFormat}
                                        value={headerMedia}
                                        onChange={setHeaderMedia}
                                        organizationId={currentOrganization?.id}
                                        storagePrefix="broadcast-headers"
                                    />
                                </div>
                            )}
                        </CardContent>
                    </Card>
                )}

                {/* Step 3: Add Recipients */}
                {currentStep === 3 && (
                    <Card>
                        <CardHeader>
                            {/* Wraps below ~600px: three buttons plus the title used to
                                overflow the card on narrow screens. */}
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <CardTitle>Adicionar destinatários</CardTitle>
                                    <CardDescription>
                                        {variableCount > 0 || buttonVariableCount > 0
                                            ? `Este template tem ${pluralize(variableCount, "variável de texto", "variáveis de texto")}${buttonVariableCount > 0 ? ` e ${pluralize(buttonVariableCount, "parâmetro de botão", "parâmetros de botão")}` : ""}.`
                                            : "Este template não possui variáveis."}
                                    </CardDescription>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button variant="outline" size="sm" onClick={downloadExcelTemplate}>
                                        <Download className="h-4 w-4 mr-2" />
                                        Baixar planilha de exemplo
                                    </Button>
                                    <Button variant="outline" size="sm" onClick={() => setShowExcelImporter(true)}>
                                        <Upload className="h-4 w-4 mr-2" />
                                        Importar
                                    </Button>
                                    <Button size="sm" onClick={handleAddRecipient}>
                                        <Plus className="h-4 w-4 mr-2" />
                                        Adicionar
                                    </Button>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            {showExcelImporter ? (
                                <ExcelImporter
                                    variableCount={variableCount + buttonVariableCount}
                                    onImport={handleExcelImport}
                                    onCancel={() => setShowExcelImporter(false)}
                                />
                            ) : recipients.length === 0 ? (
                                <WizardEmptyState
                                    icon={Users}
                                    title="Nenhum destinatário adicionado ainda"
                                    hint="Adicione manualmente ou importe de uma planilha."
                                />
                            ) : (
                                <RecipientTable
                                    recipients={recipients}
                                    bodyVariableCount={variableCount}
                                    buttonVariableCount={buttonVariableCount}
                                    onRecipientChange={handleRecipientChange}
                                    onRemove={handleRemoveRecipient}
                                />
                            )}
                        </CardContent>
                    </Card>
                )}

                {/* Step 4: Schedule */}
                {currentStep === 4 && (
                    <SchedulePicker
                        scheduleType={scheduleType}
                        scheduledDate={scheduledDate}
                        onScheduleTypeChange={setScheduleType}
                        onDateChange={setScheduledDate}
                    />
                )}

                {/* Step 5: Review & Send */}
                {currentStep === 5 && (
                    <Card>
                        <CardHeader>
                            <CardTitle>Revisar e enviar</CardTitle>
                            <CardDescription className="text-pretty">
                                {scheduleType === "now"
                                    ? "Confira os detalhes antes de enviar. As mensagens entram na fila imediatamente e não podem ser canceladas."
                                    : "Confira os detalhes antes de agendar."}
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="space-y-2">
                                <Label>Nome do disparo</Label>
                                <Input
                                    placeholder="Ex: Promoção Janeiro 2026"
                                    value={broadcastName}
                                    onChange={(e) => setBroadcastName(e.target.value)}
                                />
                            </div>

                            <div className="grid gap-4 p-4 rounded-md bg-muted/50">
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Número:</span>
                                    <span className="font-medium">
                                        {phoneNumbers.find((p) => p.id === selectedPhoneId)?.display_name}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Template:</span>
                                    <span className="font-medium">{selectedTemplate?.name}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Destinatários:</span>
                                    <span className="font-medium tabular-nums">{recipients.length}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Envio:</span>
                                    <span className="font-medium">
                                        {scheduleType === "now"
                                            ? "Imediato"
                                            : scheduledDate
                                                ? format(scheduledDate, "dd/MM/yyyy 'às' HH:mm")
                                                : "-"}
                                    </span>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Navigation.
                    Sticky at the bottom: in a multi-step wizard whose steps can be
                    taller than the viewport (the recipient table especially), a static
                    action row means scrolling to the end to advance. safe-area-bottom
                    keeps it clear of the iOS home indicator. */}
                <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 safe-area-bottom">
                    <Button
                        variant="outline"
                        onClick={() => setCurrentStep((s) => Math.max(1, s - 1))}
                        disabled={currentStep === 1 || submitting}
                    >
                        <ArrowLeft className="h-4 w-4 mr-2" />
                        Voltar
                    </Button>

                    {/* Says what is missing instead of just going dead. A disabled
                        "Próximo" with no explanation was the wizard's main dead end. */}
                    {!canProceed() && blockingReason() && (
                        <p className="flex-1 text-center text-xs text-muted-foreground" aria-live="polite">
                            {blockingReason()}
                        </p>
                    )}

                    {currentStep < STEPS.length ? (
                        <Button
                            onClick={() => setCurrentStep((s) => Math.min(STEPS.length, s + 1))}
                            disabled={!canProceed()}
                        >
                            Próximo
                            <ArrowRight className="h-4 w-4 ml-2" />
                        </Button>
                    ) : (
                        <Button onClick={handleSubmit} disabled={!canProceed() || submitting}>
                            {submitting ? (
                                <>
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                    Criando…
                                </>
                            ) : (
                                <>
                                    <Send className="h-4 w-4 mr-2" />
                                    {scheduleType === "now"
                                        ? `Enviar para ${pluralize(recipients.length, "destinatário", "destinatários")}`
                                        : "Agendar disparo"}
                                </>
                            )}
                        </Button>
                    )}
                </div>
            </div>

            {templateCreation.dialog}
            <AlertDialog open={discardConfirm} onOpenChange={setDiscardConfirm}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Descartar este disparo?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {recipients.length > 0
                                ? `Você perde a lista com ${pluralize(recipients.length, "destinatário", "destinatários")} e as configurações feitas até aqui.`
                                : "Você perde as configurações feitas até aqui."}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={onBack}
                        >
                            Descartar
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
