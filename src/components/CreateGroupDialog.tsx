import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { User, Users, UserPlus, X, Loader2, Camera, Settings2, ChevronDown, LogIn, Search, Phone } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { extractInviteCode, inviteErrorMessage, INVALID_INVITE_HINT } from "@/lib/groupInvite";
import { garantirConversaDoGrupo } from "@/lib/groupConversation";
import { qrFetch } from "@/lib/qrService";
import ContactSelectList, { type SelectableContact } from "@/components/contacts/ContactSelectList";
import OwnLinesSelectList, { type SelectableLine } from "@/components/contacts/OwnLinesSelectList";
import {
    sanitizeParticipantInput,
    isDuplicateParticipant,
} from "@/lib/groupParticipantPhone";
import PhoneNumberInput from "@/components/phone/PhoneNumberInput";
import { type PhoneCheck, phoneCheckForDigits } from "@/lib/phoneInput";
import EmojiPicker from "@/components/EmojiPicker";
import { useIsMobile } from "@/hooks/use-mobile";
import { insertIntoField } from "@/lib/insertAtCursor";
import { numeroDeEnvio } from "@/lib/caixaConjunta";
import { SeletorNumeroDeEnvio, type OpcaoDeNumero } from "@/components/SeletorNumeroDeEnvio";

// Espelha o GroupCreateSettings do qr-service — só enviamos as chaves alteradas
interface GroupCreateSettings {
    announce?: boolean;
    restrict?: boolean;
    memberAddMode?: "admin_add" | "all_member_add";
    joinApprovalMode?: "on" | "off";
    ephemeralDuration?: number;
}

// Espelha o retorno de GET /groups/:id/invite-info/:code (getGroupInviteInfo)
interface InvitePreview {
    jid: string;
    subject: string;
    description?: string;
    owner?: string;
    size?: number;
    creation?: number;
}

const EPHEMERAL_OPTIONS = [
    { value: "0", label: "Desativadas" },
    { value: "86400", label: "24 horas" },
    { value: "604800", label: "7 dias" },
    { value: "7776000", label: "90 dias" },
] as const;

/** Participante escolhido para o grupo. `name` só vem do picker de contatos. */
interface Participant {
    phone: string;
    name?: string;
}

interface CreateGroupDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Número do grupo no modo número. Na caixa conjunta vale `numerosPossiveis`. */
    phoneNumberId?: string | null;
    /**
     * Números QR do escopo (grupo só existe em número QR). Com mais de um o diálogo pede
     * "Enviar pelo número" e tudo (criar, entrar por link, participantes, a conversa do
     * grupo) sai do número escolhido.
     */
    numerosPossiveis?: readonly OpcaoDeNumero[];
    /** Número que vem marcado (o da conversa aberta), se estiver entre os possíveis; senão o primeiro. */
    numeroPreferidoId?: string | null;
    /** `conversationId` só vem quando esta chamada criou a conversa do grupo (a lista refaz só ela). */
    onGroupCreated?: (groupJid: string, conversationId?: string) => void;
}

const CreateGroupDialog = ({
    open,
    onOpenChange,
    phoneNumberId: phoneNumberIdDaLista,
    numerosPossiveis,
    numeroPreferidoId,
    onGroupCreated,
}: CreateGroupDialogProps) => {
    const { toast } = useToast();
    const [numeroEscolhidoId, setNumeroEscolhidoId] = useState<string | null>(null);
    const numeroAtual = numerosPossiveis?.length
        ? numeroDeEnvio(numerosPossiveis, numeroEscolhidoId, numeroPreferidoId)
        : null;
    // Vazio só se ninguém passou número: o pai não monta o diálogo sem número QR.
    const phoneNumberId = numeroAtual?.id ?? phoneNumberIdDaLista ?? "";
    const [tab, setTab] = useState<"create" | "join">("create");

    // Create-group state
    const [groupName, setGroupName] = useState("");
    const groupNameRef = useRef<HTMLInputElement>(null);
    const isMobile = useIsMobile();
    const [participantInput, setParticipantInput] = useState("");
    // O nome só existe quando o participante veio do picker de contatos; a
    // entrada manual continua sendo só o telefone.
    const [participants, setParticipants] = useState<Participant[]>([]);
    const [participantTab, setParticipantTab] = useState<"lines" | "contacts" | "manual">("contacts");
    const [photoFile, setPhotoFile] = useState<File | null>(null);
    const [photoPreview, setPhotoPreview] = useState<string | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [adminsOnlyMessages, setAdminsOnlyMessages] = useState(false);
    const [adminsOnlyEdit, setAdminsOnlyEdit] = useState(false);
    const [adminsOnlyAdd, setAdminsOnlyAdd] = useState(false);
    const [joinApproval, setJoinApproval] = useState(false);
    const [ephemeral, setEphemeral] = useState("0");
    const [loading, setLoading] = useState(false);

    // Join-by-link state
    const [inviteInput, setInviteInput] = useState("");
    const [preview, setPreview] = useState<InvitePreview | null>(null);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [joining, setJoining] = useState(false);

    // Trocar o número de envio refaz o que dependia do anterior: os participantes (os contatos
    // vêm das conversas do número antigo, e a aba "Meus números" pode ter incluído a própria
    // linha nova, que não entra no grupo dela mesma) e a prévia do convite. Zerar é o simples e
    // seguro: o telefone da linha não vem em `numerosPossiveis` para filtrar só ele.
    const handleTrocarNumero = (id: string) => {
        if (id === numeroAtual?.id) return;
        setNumeroEscolhidoId(id);
        if (participants.length > 0) {
            setParticipants([]);
            toast({
                title: "Participantes removidos",
                description: "Ao trocar o número, escolha os participantes de novo.",
            });
        }
        setPreview(null);
    };

    const handleSelectPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ""; // permite reselecionar o mesmo arquivo
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            toast({
                title: "Arquivo inválido",
                description: "Selecione uma imagem",
                variant: "destructive",
            });
            return;
        }

        if (photoPreview) URL.revokeObjectURL(photoPreview);
        setPhotoFile(file);
        setPhotoPreview(URL.createObjectURL(file));
    };

    const clearPhoto = () => {
        if (photoPreview) URL.revokeObjectURL(photoPreview);
        setPhotoFile(null);
        setPhotoPreview(null);
    };

    // Validação vem do PhoneNumberInput, que sabe o país escolhido no campo:
    // gate do botão, erro inline e o número composto que entra na lista.
    const [manualPhoneCheck, setManualPhoneCheck] = useState<PhoneCheck>(() =>
        phoneCheckForDigits("")
    );

    const resetParticipantInput = () => {
        setParticipantInput("");
        setManualPhoneCheck(phoneCheckForDigits(""));
    };

    const handleAddParticipant = () => {
        if (!manualPhoneCheck.ok) {
            toast({ title: manualPhoneCheck.error ?? "Número inválido", variant: "destructive" });
            return;
        }
        const phone = manualPhoneCheck.phone;

        // Comparação tolerante ao 9º dígito e ao 55: com igualdade exata,
        // "5511999999999" digitado não colidia com "551199999999" vindo do
        // picker e a mesma pessoa entrava duas vezes.
        if (isDuplicateParticipant(phone, participants.map((p) => p.phone))) {
            toast({
                title: "Número já adicionado",
                variant: "destructive",
            });
            return;
        }

        setParticipants([...participants, { phone }]);
        resetParticipantInput();
    };

    /** Coloca as outras linhas da organização na lista de participantes. */
    const handleAddOwnLines = (lines: SelectableLine[]) => {
        setParticipants((prev) => {
            const next = [...prev];
            for (const line of lines) {
                const phone = sanitizeParticipantInput(line.phone);
                if (!phone) continue;
                if (isDuplicateParticipant(phone, next.map((p) => p.phone))) continue;
                next.push({ phone, name: line.displayName });
            }
            return next;
        });
    };

    // Clique no picker alterna: adiciona ou remove o contato já escolhido.
    const handleToggleContact = (contact: SelectableContact) => {
        const phone = contact.phone.replace(/\D/g, "");
        if (!phone) return;

        setParticipants((prev) =>
            prev.some((p) => p.phone === phone)
                ? prev.filter((p) => p.phone !== phone)
                : [...prev, { phone, name: contact.name }]
        );
    };

    const handleRemoveParticipant = (phone: string) => {
        setParticipants(participants.filter((p) => p.phone !== phone));
    };

    // Cria (ou acha) a conversa do grupo para ele aparecer na lista: o webhook do serviço de QR pode tê-la criado antes.
    const insertGroupConversation = (groupJid: string, name: string) => garantirConversaDoGrupo(phoneNumberId, groupJid, name);

    const handleCreate = async () => {
        if (!groupName.trim()) {
            toast({
                title: "Digite um nome para o grupo",
                variant: "destructive",
            });
            return;
        }

        // Sem participantes é permitido: o WhatsApp cria o grupo só com o dono da linha.
        const soloGroup = participants.length === 0;

        // Só envia as configs que divergem do padrão do WhatsApp
        const settings: GroupCreateSettings = {};
        if (adminsOnlyMessages) settings.announce = true;
        if (adminsOnlyEdit) settings.restrict = true;
        if (adminsOnlyAdd) settings.memberAddMode = "admin_add";
        if (joinApproval) settings.joinApprovalMode = "on";
        if (ephemeral !== "0") settings.ephemeralDuration = Number(ephemeral);
        const hasSettings = Object.keys(settings).length > 0;

        setLoading(true);
        try {
            // Step 1: Create group in WhatsApp
            const response = await qrFetch(
                `/groups/${phoneNumberId}/create`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name: groupName.trim(),
                        participants: participants.map((p) => p.phone),
                        ...(hasSettings ? { settings } : {}),
                    }),
                }
            );

            const data = await response.json();

            if (data.success && data.groupJid) {
                // Step 2 (optional): set the group photo — failure doesn't undo the group
                let photoWarning = false;
                if (photoFile) {
                    try {
                        const formData = new FormData();
                        formData.append("file", photoFile);
                        const photoResponse = await qrFetch(
                            `/groups/${phoneNumberId}/${encodeURIComponent(data.groupJid)}/picture`,
                            { method: "PUT", body: formData }
                        );
                        const photoData = await photoResponse.json();
                        photoWarning = !photoData.success;
                    } catch {
                        photoWarning = true;
                    }
                }

                // Step 3: Create conversation in Supabase so it shows in the list
                const { error: convError, conversationId } = await insertGroupConversation(data.groupJid, groupName.trim());

                const settingsWarning = data.settingsErrors && Object.keys(data.settingsErrors).length > 0;

                if (convError) {
                    console.error("Error creating conversation:", convError);
                    // Still show success for group creation
                    toast({
                        title: "Grupo criado!",
                        description: "Mas houve um erro ao salvar a conversa",
                    });
                } else if (settingsWarning) {
                    console.error("Group settings errors:", data.settingsErrors);
                    toast({
                        title: "Grupo criado!",
                        description: "Mas algumas configurações não puderam ser aplicadas",
                    });
                } else if (photoWarning) {
                    toast({
                        title: "Grupo criado!",
                        description: "Mas a foto não pôde ser definida",
                    });
                } else if (soloGroup) {
                    toast({
                        title: "Grupo criado só com você",
                        description: "Adicione pessoas ou compartilhe o link de convite quando quiser",
                    });
                } else {
                    toast({ title: "Grupo criado com sucesso!" });
                }

                onGroupCreated?.(data.groupJid, conversationId);
                handleClose();
            } else {
                toast({
                    title: "Não foi possível criar grupo",
                    description: toUserMessage(data.error, "Verifique a conexão e tente novamente."),
                    variant: "destructive",
                });
            }
        } catch (error) {
            console.error("Error creating group:", error);
            toast({
                title: "Erro de conexão",
                description: "Não foi possível conectar ao serviço",
                variant: "destructive",
            });
        } finally {
            setLoading(false);
        }
    };

    const handlePreview = async () => {
        const code = extractInviteCode(inviteInput);
        if (!code) {
            toast({ title: "Link de convite inválido", description: INVALID_INVITE_HINT, variant: "destructive" });
            return;
        }

        setLoadingPreview(true);
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/invite-info/${encodeURIComponent(code)}`
            );
            const data = await response.json();

            if (data.success && data.group) {
                setPreview(data.group as InvitePreview);
            } else {
                console.error("Error fetching invite info:", data.error);
                setPreview(null);
                toast({
                    title: "Não foi possível carregar o grupo",
                    description: inviteErrorMessage(data.error, "Confira se o link está completo e ainda é válido."),
                    variant: "destructive",
                });
            }
        } catch (error) {
            console.error("Error fetching invite info:", error);
            setPreview(null);
            toast({
                title: "Erro de conexão",
                description: "Não foi possível conectar ao serviço",
                variant: "destructive",
            });
        } finally {
            setLoadingPreview(false);
        }
    };

    const handleJoin = async () => {
        const code = extractInviteCode(inviteInput);
        if (!code) {
            toast({ title: "Link de convite inválido", description: INVALID_INVITE_HINT, variant: "destructive" });
            return;
        }

        setJoining(true);
        try {
            const response = await qrFetch(`/groups/${phoneNumberId}/join`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code }),
            });
            const data = await response.json();

            if (data.success && data.groupJid) {
                const groupName = preview?.subject || data.groupJid;
                const { error: convError, conversationId } = await insertGroupConversation(data.groupJid, groupName);

                if (convError) {
                    console.error("Error creating conversation:", convError);
                    toast({
                        title: "Você entrou no grupo!",
                        description: "Mas houve um erro ao salvar a conversa",
                    });
                } else {
                    toast({ title: "Você entrou no grupo!" });
                }

                onGroupCreated?.(data.groupJid, conversationId);
                handleClose();
            } else {
                console.error("Error joining group:", data.error);
                toast({
                    title: "Não foi possível entrar no grupo",
                    description: inviteErrorMessage(data.error, "Confira se o link está completo e ainda é válido."),
                    variant: "destructive",
                });
            }
        } catch (error) {
            console.error("Error joining group:", error);
            toast({
                title: "Erro de conexão",
                description: "Não foi possível conectar ao serviço",
                variant: "destructive",
            });
        } finally {
            setJoining(false);
        }
    };

    const handleClose = () => {
        setNumeroEscolhidoId(null);
        setTab("create");
        setGroupName("");
        resetParticipantInput();
        setParticipants([]);
        setParticipantTab("contacts");
        clearPhoto();
        setSettingsOpen(false);
        setAdminsOnlyMessages(false);
        setAdminsOnlyEdit(false);
        setAdminsOnlyAdd(false);
        setJoinApproval(false);
        setEphemeral("0");
        setInviteInput("");
        setPreview(null);
        setLoadingPreview(false);
        setJoining(false);
        onOpenChange(false);
    };

    const formatPhone = (phone: string) => {
        if (phone.length >= 12) {
            const country = phone.slice(0, 2);
            const ddd = phone.slice(2, 4);
            const firstPart = phone.slice(4, 9);
            const lastPart = phone.slice(9);
            return `+${country} ${ddd} ${firstPart}-${lastPart}`;
        }
        return phone;
    };

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Users className="w-5 h-5" />
                        Grupos
                    </DialogTitle>
                </DialogHeader>

                {numerosPossiveis && numerosPossiveis.length > 1 && numeroAtual && (
                    <SeletorNumeroDeEnvio
                        id="grupo-numero"
                        opcoes={numerosPossiveis}
                        valor={numeroAtual.id}
                        onChange={handleTrocarNumero}
                    />
                )}

                <Tabs value={tab} onValueChange={(v) => setTab(v as "create" | "join")}>
                    <TabsList className="grid w-full grid-cols-2">
                        <TabsTrigger value="create">Criar novo</TabsTrigger>
                        <TabsTrigger value="join">Entrar por link</TabsTrigger>
                    </TabsList>

                    {/* --- Criar novo grupo --- */}
                    <TabsContent value="create">
                        <div className="space-y-4 py-4">
                            {/* Group Photo (optional) */}
                            <div className="flex justify-center">
                                <div className="relative">
                                    <Avatar className="w-20 h-20">
                                        <AvatarImage src={photoPreview ?? undefined} alt="Foto do grupo" />
                                        <AvatarFallback>
                                            <Users className="w-8 h-8 text-muted-foreground" />
                                        </AvatarFallback>
                                    </Avatar>
                                    <label
                                        className="absolute -bottom-1 -right-1 rounded-full bg-primary text-primary-foreground p-1.5 shadow cursor-pointer hover:opacity-90"
                                        aria-label="Escolher foto do grupo"
                                    >
                                        <Camera className="w-3.5 h-3.5" />
                                        <input
                                            type="file"
                                            accept="image/*"
                                            className="hidden"
                                            onChange={handleSelectPhoto}
                                        />
                                    </label>
                                    {photoFile && (
                                        <button
                                            type="button"
                                            onClick={clearPhoto}
                                            className="absolute -top-1 -right-1 rounded-full bg-muted p-1 shadow hover:bg-destructive/20"
                                            aria-label="Remover foto selecionada"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Group Name */}
                            <div>
                                <label className="text-sm font-medium mb-2 block">
                                    Nome do Grupo
                                </label>
                                <div className="flex gap-2">
                                    <Input
                                        ref={groupNameRef}
                                        placeholder="Digite o nome do grupo"
                                        value={groupName}
                                        onChange={(e) => setGroupName(e.target.value)}
                                    />
                                    <EmojiPicker
                                        variant={isMobile ? "drawer" : "popover"}
                                        onEmojiSelect={(emoji) =>
                                            insertIntoField(groupNameRef.current, groupName, emoji, setGroupName)
                                        }
                                    />
                                </div>
                            </div>

                            {/* Add Participants — contato existente ou número cru */}
                            <div>
                                <label className="text-sm font-medium mb-2 block">
                                    Participantes
                                </label>
                                <Tabs
                                    value={participantTab}
                                    onValueChange={(v) =>
                                        setParticipantTab(v as "lines" | "contacts" | "manual")
                                    }
                                >
                                    <TabsList className="grid w-full grid-cols-3">
                                        <TabsTrigger value="contacts" className="flex min-w-0 items-center gap-2 px-2">
                                            <Users className="w-4 h-4 shrink-0" />
                                            <span className="truncate">Existente</span>
                                        </TabsTrigger>
                                        <TabsTrigger value="lines" className="flex min-w-0 items-center gap-2 px-2">
                                            <Phone className="w-4 h-4 shrink-0" />
                                            <span className="truncate">Meus números</span>
                                        </TabsTrigger>
                                        <TabsTrigger value="manual" className="flex min-w-0 items-center gap-2 px-2">
                                            <UserPlus className="w-4 h-4 shrink-0" />
                                            <span className="truncate">Novo</span>
                                        </TabsTrigger>
                                    </TabsList>

                                    <TabsContent value="lines" className="mt-3">
                                        <OwnLinesSelectList
                                            phoneNumberId={phoneNumberId}
                                            enabled={open && tab === "create" && participantTab === "lines"}
                                            excludedPhones={participants.map((p) => p.phone)}
                                            actionLabel="Incluir no grupo"
                                            onConfirm={handleAddOwnLines}
                                            listHeightClassName="h-[240px]"
                                        />
                                    </TabsContent>

                                    <TabsContent value="contacts" className="mt-3">
                                        <ContactSelectList
                                            phoneNumberId={phoneNumberId}
                                            enabled={open && tab === "create" && participantTab === "contacts"}
                                            selectedPhones={participants.map((p) => p.phone)}
                                            onSelect={handleToggleContact}
                                            emptyLabel="Nenhuma conversa 1:1 neste número"
                                            listHeightClassName="h-[280px]"
                                        />
                                    </TabsContent>

                                    <TabsContent value="manual" className="mt-3">
                                        <div className="flex items-start gap-2">
                                            <PhoneNumberInput
                                                className="flex-1"
                                                value={participantInput}
                                                onChange={(digits, check) => {
                                                    setParticipantInput(digits);
                                                    setManualPhoneCheck(check);
                                                }}
                                                onSubmit={handleAddParticipant}
                                                error={manualPhoneCheck.error}
                                            />
                                            <Button
                                                type="button"
                                                variant="outline"
                                                className="shrink-0"
                                                onClick={handleAddParticipant}
                                                disabled={!manualPhoneCheck.ok}
                                            >
                                                <UserPlus className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    </TabsContent>
                                </Tabs>
                            </div>

                            {/* Participants List */}
                            {participants.length === 0 && (
                                <p className="text-sm text-muted-foreground">
                                    Sem participantes: o grupo é criado só com você. Dá para adicionar
                                    pessoas ou compartilhar o link de convite depois.
                                </p>
                            )}
                            {participants.length > 0 && (
                                <div className="space-y-2">
                                    <p className="text-sm text-muted-foreground">
                                        {participants.length} participante(s)
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        {participants.map((participant) => (
                                            <div
                                                key={participant.phone}
                                                className="flex max-w-full items-center gap-1 bg-muted px-2 py-1 rounded-full text-sm"
                                            >
                                                <span className="truncate" title={formatPhone(participant.phone)}>
                                                    {participant.name || formatPhone(participant.phone)}
                                                </span>
                                                <button
                                                    onClick={() => handleRemoveParticipant(participant.phone)}
                                                    className="hover:bg-destructive/20 rounded-full p-0.5"
                                                >
                                                    <X className="w-3 h-3" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Group Settings (optional, defaults match WhatsApp) */}
                            <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
                                <CollapsibleTrigger asChild>
                                    <button
                                        type="button"
                                        className="flex w-full items-center justify-between py-1 text-sm font-medium hover:text-foreground/80"
                                    >
                                        <span className="flex items-center gap-2">
                                            <Settings2 className="w-4 h-4" />
                                            Configurações do grupo
                                        </span>
                                        <ChevronDown
                                            className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${settingsOpen ? "rotate-180" : ""}`}
                                        />
                                    </button>
                                </CollapsibleTrigger>
                                <CollapsibleContent className="space-y-3 pt-3">
                                    <div className="flex items-center justify-between gap-4">
                                        <Label htmlFor="admins-only-messages" className="text-sm font-normal">
                                            Só admins enviam mensagens
                                        </Label>
                                        <Switch
                                            id="admins-only-messages"
                                            checked={adminsOnlyMessages}
                                            onCheckedChange={setAdminsOnlyMessages}
                                        />
                                    </div>
                                    <div className="flex items-center justify-between gap-4">
                                        <Label htmlFor="admins-only-edit" className="text-sm font-normal">
                                            Só admins editam dados do grupo
                                        </Label>
                                        <Switch
                                            id="admins-only-edit"
                                            checked={adminsOnlyEdit}
                                            onCheckedChange={setAdminsOnlyEdit}
                                        />
                                    </div>
                                    <div className="flex items-center justify-between gap-4">
                                        <Label htmlFor="admins-only-add" className="text-sm font-normal">
                                            Só admins adicionam membros
                                        </Label>
                                        <Switch
                                            id="admins-only-add"
                                            checked={adminsOnlyAdd}
                                            onCheckedChange={setAdminsOnlyAdd}
                                        />
                                    </div>
                                    <div className="flex items-center justify-between gap-4">
                                        <Label htmlFor="join-approval" className="text-sm font-normal">
                                            Aprovar novos participantes
                                        </Label>
                                        <Switch
                                            id="join-approval"
                                            checked={joinApproval}
                                            onCheckedChange={setJoinApproval}
                                        />
                                    </div>
                                    <div className="flex items-center justify-between gap-4">
                                        <Label htmlFor="ephemeral-select" className="text-sm font-normal">
                                            Mensagens temporárias
                                        </Label>
                                        <Select value={ephemeral} onValueChange={setEphemeral}>
                                            <SelectTrigger id="ephemeral-select" className="w-[130px] h-8">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {EPHEMERAL_OPTIONS.map((opt) => (
                                                    <SelectItem key={opt.value} value={opt.value}>
                                                        {opt.label}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </CollapsibleContent>
                            </Collapsible>
                        </div>

                        <DialogFooter>
                            <Button variant="outline" onClick={handleClose}>
                                Cancelar
                            </Button>
                            <Button onClick={handleCreate} disabled={loading}>
                                {loading ? (
                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                ) : participants.length === 0 ? (
                                    <User className="w-4 h-4 mr-2" />
                                ) : (
                                    <Users className="w-4 h-4 mr-2" />
                                )}
                                {participants.length === 0 ? "Criar só comigo" : "Criar Grupo"}
                            </Button>
                        </DialogFooter>
                    </TabsContent>

                    {/* --- Entrar em grupo por link --- */}
                    <TabsContent value="join">
                        <div className="space-y-4 py-4">
                            <div>
                                <label className="text-sm font-medium mb-2 block">
                                    Link ou código de convite
                                </label>
                                <div className="flex gap-2">
                                    <Input
                                        placeholder="https://chat.whatsapp.com/…"
                                        value={inviteInput}
                                        onChange={(e) => {
                                            setInviteInput(e.target.value);
                                            setPreview(null);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                e.preventDefault();
                                                handlePreview();
                                            }
                                        }}
                                    />
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={handlePreview}
                                        disabled={loadingPreview || !inviteInput.trim()}
                                    >
                                        {loadingPreview ? (
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                        ) : (
                                            <Search className="w-4 h-4" />
                                        )}
                                    </Button>
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">
                                    Cole o link e clique na lupa para ver uma prévia antes de entrar
                                </p>
                            </div>

                            {preview && (
                                <div className="flex items-center gap-3 rounded-lg border p-3 animate-in fade-in-0 zoom-in-95 duration-200">
                                    <Avatar className="w-12 h-12 shrink-0">
                                        <AvatarFallback>
                                            <Users className="w-5 h-5 text-muted-foreground" />
                                        </AvatarFallback>
                                    </Avatar>
                                    <div className="min-w-0 flex-1">
                                        <p className="font-medium truncate">{preview.subject}</p>
                                        {typeof preview.size === "number" && (
                                            <p className="text-xs text-muted-foreground">
                                                {preview.size} participante(s)
                                            </p>
                                        )}
                                        {preview.description && (
                                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                                {preview.description}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        <DialogFooter>
                            <Button variant="outline" onClick={handleClose}>
                                Cancelar
                            </Button>
                            <Button onClick={handleJoin} disabled={joining || !inviteInput.trim()}>
                                {joining ? (
                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                ) : (
                                    <LogIn className="w-4 h-4 mr-2" />
                                )}
                                Entrar no Grupo
                            </Button>
                        </DialogFooter>
                    </TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
};

export default CreateGroupDialog;
