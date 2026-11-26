import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@/components/ui/tabs";
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
import {
    Users,
    Crown,
    UserPlus,
    UserMinus,
    Shield,
    ShieldOff,
    LogOut,
    MoreVertical,
    Loader2,
    Pencil,
    Check,
    X,
    ChevronLeft,
    Camera,
    Settings2,
    ChevronDown,
    Image as ImageIcon,
    Link2,
    MessageSquare,
    RotateCcw,
    History,
    Phone,
    ShieldAlert,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { qrFetch } from "@/lib/qrService";
import { formatParticipantPhone } from "@/lib/phone";
import ContactSelectList from "@/components/contacts/ContactSelectList";
import OwnLinesSelectList, { type SelectableLine } from "@/components/contacts/OwnLinesSelectList";
import MirrorGroupHistoryDialog from "@/components/chat/MirrorGroupHistoryDialog";
import PhoneNumberInput from "@/components/phone/PhoneNumberInput";
import { type PhoneCheck, phoneCheckForDigits } from "@/lib/phoneInput";
import { resolveParticipantName } from "@/lib/participantDisplayName";
import { useParticipantContacts } from "@/hooks/chat/useParticipantContacts";
import { useIsMobile } from "@/hooks/use-mobile";
import { ConversationMediaTabs } from "@/components/chat/media/ConversationMediaTabs";
import { toUserMessage } from "@/lib/userFacingError";
import { useAccessiblePhoneNumbers } from "@/hooks/useAccessiblePhoneNumbers";
import { groupAddBlockLabel, resolveGroupAddPermission, resolveGroupManagePermissions } from "@/lib/groupSelfRole";

interface Participant {
    id: string;
    jid?: string; // The actual WhatsApp JID (always @s.whatsapp.net format)
    phone: string;
    name?: string; // Resolved name from message pushName cache
    isAdmin: boolean;
    isSuperAdmin: boolean;
    isLid?: boolean; // True if this is a LID (no real phone available)
}

interface GroupInfo {
    jid: string;
    subject: string;
    description?: string;
    owner?: string;
    pictureUrl?: string | null;
    // Estado das configurações — presentes no metadata a partir do qr-service 1.3.4
    announce?: boolean;
    restrict?: boolean;
    /** true = "todos adicionam" (all_member_add); false = só admins adicionam. */
    memberAddMode?: boolean;
    joinApprovalMode?: boolean;
    ephemeralDuration?: number;
    // Restrições impostas pelo WhatsApp — só chegam pelo provider zapo (qr-service >= 2.5.0)
    suspended?: boolean;
    appealStatus?: string;
    growthLockedUntil?: string;
    participants: Participant[];
    // A própria linha no grupo (qr-service >= 2.5.6). null = o serviço não a achou.
    me?: { id: string; isAdmin: boolean; isSuperAdmin: boolean } | null;
}

interface GroupSettingsState {
    announce: boolean;
    restrict: boolean;
    memberAdd: boolean;
    joinApproval: boolean;
    ephemeral: string;
}

// Retorno de GET /groups/:id/:jid/join-requests (groupRequestParticipantsList)
interface JoinRequest {
    jid: string;
    request_method?: string;
    request_time?: string;
}

const EPHEMERAL_OPTIONS = [
    { value: "0", label: "Desativadas" },
    { value: "86400", label: "24 horas" },
    { value: "604800", label: "7 dias" },
    { value: "7776000", label: "90 dias" },
] as const;

interface GroupInfoPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    groupJid: string;
    /** Conversa deste grupo NESTA linha — destino do espelho de histórico. */
    conversationId: string;
    phoneNumberId: string;
    organizationId: string;
    userId: string;
    onGroupUpdated?: () => void;
    /** Abre a conversa 1:1 vinculada a um participante do grupo. */
    onOpenConversation?: (conversationId: string) => void;
}

const GroupInfoPanel = ({
    open,
    onOpenChange,
    groupJid,
    conversationId,
    phoneNumberId,
    organizationId,
    userId,
    onGroupUpdated,
    onOpenConversation,
}: GroupInfoPanelProps) => {
    const { toast } = useToast();
    const isMobile = useIsMobile();
    const [loading, setLoading] = useState(true);
    const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null);
    // Telefone da própria linha: acha a linha entre os participantes quando o
    // serviço ainda não manda `group.me` (anterior à 2.5.6).
    const { phoneNumbers: accessibleLines, isLoading: linesLoading } = useAccessiblePhoneNumbers(
        organizationId,
        open,
        { revalidarAoMontar: false }
    );
    const linePhone = accessibleLines.find((line) => line.id === phoneNumberId)?.phoneNumber ?? null;
    // Adicionar sem permissão derruba a sessão (401 <conflict>): o botão só aparece
    // com certeza positiva de que a linha é admin, ou membro em grupo "todos
    // adicionam" (src/lib/groupSelfRole.ts).
    // null = ainda não dá para julgar (grupo ou, no serviço antigo, telefone carregando).
    const addPermission = useMemo(() => {
        if (!groupInfo) return null;
        if (groupInfo.me === undefined && linesLoading) return null;
        return resolveGroupAddPermission(groupInfo, linePhone);
    }, [groupInfo, linePhone, linesLoading]);
    // O resto só some com certeza de que a linha é membro comum; na dúvida, o
    // WhatsApp devolve erro e o toast explica. null = grupo ainda carregando.
    const managePermissions = useMemo(
        () => (groupInfo ? resolveGroupManagePermissions(groupInfo, linePhone) : null),
        [groupInfo, linePhone]
    );
    const canManageSettings = managePermissions?.manageSettings ?? false;
    const canManageMembers = managePermissions?.manageMembers ?? false;
    const canEditInfo = managePermissions?.editInfo ?? false;
    const canShareInvite = managePermissions?.shareInvite ?? false;
    const [addMemberOpen, setAddMemberOpen] = useState(false);
    const [addMemberTab, setAddMemberTab] = useState<"lines" | "contacts" | "manual">("lines");
    const [newMemberPhone, setNewMemberPhone] = useState("");
    // Progresso da adição sequencial de linhas próprias: "Adicionando 2 de 3…".
    const [linesProgress, setLinesProgress] = useState<{ done: number; total: number } | null>(null);
    const [mirrorOpen, setMirrorOpen] = useState(false);
    /** Seção de mídia do grupo; fechada arma nada (a galeria só busca quando abre). */
    const [mediaOpen, setMediaOpen] = useState(false);
    // Validação vem do PhoneNumberInput, que sabe o país escolhido no campo:
    // gate do botão, erro inline e o número composto que é enviado.
    const [manualPhoneCheck, setManualPhoneCheck] = useState<PhoneCheck>(() =>
        phoneCheckForDigits("")
    );
    const resetNewMemberPhone = () => {
        setNewMemberPhone("");
        setManualPhoneCheck(phoneCheckForDigits(""));
    };
    const [pendingInvite, setPendingInvite] = useState<{
        phone: string;
        jid: string;
        code: string;
        expiration: number;
    } | null>(null);
    const [inviteText, setInviteText] = useState("");
    // Ações em voo por CHAVE (Set): com a string única, o finally de uma ação
    // zerava o spinner de outra em andamento, e o `includes` casava por substring.
    const [actionLoading, setActionLoading] = useState<Set<string>>(new Set());
    const startAction = (key: string) => {
        setActionLoading((prev) => new Set(prev).add(key));
        return () =>
            setActionLoading((prev) => {
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
    };
    // Revalidação silenciosa: refetch pós-ação NÃO desmonta o painel inteiro
    const [refreshing, setRefreshing] = useState(false);
    // Alguma ação (remover/promover/rebaixar) deste participante em voo?
    const participantBusy = (participantId: string) =>
        actionLoading.has(`remove-${participantId}`) ||
        actionLoading.has(`promote-${participantId}`) ||
        actionLoading.has(`demote-${participantId}`);

    // Telefones que valem consulta de contato: participante @lid não resolvido
    // não tem telefone (o valor é o ID interno), e buscar por ele daria vínculo
    // falso.
    const contactPhones = useMemo(
        () =>
            (groupInfo?.participants ?? [])
                .filter((p) => !p.isLid && p.phone)
                .map((p) => p.phone),
        [groupInfo?.participants]
    );

    // Conversas 1:1 já existentes dos participantes. O cache do hook é de
    // módulo, então isto custa ZERO request quando o ChatArea já resolveu as
    // mesmas pessoas ao abrir o grupo.
    const participantContacts = useParticipantContacts({
        phones: contactPhones,
        phoneNumberDbId: phoneNumberId,
        enabled: open,
        scopeKey: groupJid,
    });

    const contactFor = (participant: Participant) =>
        participant.isLid ? undefined : participantContacts[participant.phone];

    // Nome exibível: apelido do grupo > pushName > contato da conversa 1:1 >
    // telefone formatado. `origin` diz de qual fonte veio — é o que permite
    // mostrar o vínculo e não repetir a mesma string no subtítulo.
    const participantName = (participant: Participant) =>
        resolveParticipantName(
            {
                alias: aliases[participant.jid || participant.id],
                pushName: participant.name,
                contactName: contactFor(participant)?.name,
            },
            participant.phone,
            participant.isLid
        );

    const participantLabel = (participant: Participant) => participantName(participant).name;

    const handleOpenLinkedConversation = (participant: Participant) => {
        const contact = contactFor(participant);
        if (!contact || !onOpenConversation) return;
        // Fecha o Sheet antes de navegar: reabrir a conversa por baixo do painel
        // deixaria o overlay preso sobre a tela nova.
        onOpenChange(false);
        onOpenConversation(contact.conversationId);
    };

    const executeConfirmedAction = () => {
        if (!confirmAction) return;
        if (confirmAction.type === "remove") void handleRemoveMember(confirmAction.participant.id);
        else if (confirmAction.type === "demote") void handleDemote(confirmAction.participant.id);
        else if (confirmAction.type === "revoke") void handleRevokeInvite();
        else void handleLeaveGroup();
        setConfirmAction(null);
    };

    const [editingSubject, setEditingSubject] = useState(false);
    const [newSubject, setNewSubject] = useState("");
    const [editingDescription, setEditingDescription] = useState(false);
    const [newDescription, setNewDescription] = useState("");

    // Group settings state
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settings, setSettings] = useState<GroupSettingsState>({
        announce: false,
        restrict: false,
        memberAdd: false,
        joinApproval: false,
        ephemeral: "0",
    });

    // Aliases state
    const [aliases, setAliases] = useState<Record<string, string>>({});
    const [editingAlias, setEditingAlias] = useState<string | null>(null);
    const [newAlias, setNewAlias] = useState("");

    // Pending join requests (só relevante quando o modo de aprovação está ligado)
    const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);

    // Link de convite pré-carregado e VISÍVEL: o copiar antigo fazia rede antes
    // do clipboard e o Safari/iOS rejeitava o write fora do gesto — e uma falha
    // deixava o usuário sem nenhuma forma de obter o link.
    const [inviteUrl, setInviteUrl] = useState<string | null>(null);

    // Confirmação de ações destrutivas de grupo (substitui window.confirm e os
    // cliques diretos de 32px que expulsavam a pessoa errada sem confirmar)
    const [confirmAction, setConfirmAction] = useState<
        | { type: "remove"; participant: Participant }
        | { type: "demote"; participant: Participant }
        | { type: "revoke" }
        | { type: "leave" }
        | null
    >(null);

    // Mantém o texto do AlertDialog durante a animação de saída (confirmAction
    // vira null no fechar e o conteúdo sumia antes de o dialog terminar de sair).
    const lastConfirmActionRef = useRef<typeof confirmAction>(null);
    if (confirmAction) lastConfirmActionRef.current = confirmAction;
    const confirmDialogData = confirmAction ?? lastConfirmActionRef.current;

    // Ref-espelho para o fetch decidir entre primeira carga (spinner de tela)
    // e revalidação pós-ação (discreta) sem entrar nas deps do useCallback.
    const groupInfoRef = useRef<GroupInfo | null>(null);
    groupInfoRef.current = groupInfo;

    const fetchGroupInfo = useCallback(async () => {
        if (!open || !groupJid || !phoneNumberId) return;

        // Revalidação NÃO desmonta o painel: antes, cada remover/promover/foto
        // trocava tudo por um spinner e jogava o scroll de volta ao topo.
        const isRevalidation = groupInfoRef.current !== null;
        if (isRevalidation) setRefreshing(true);
        else setLoading(true);
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}`
            );
            const data = await response.json();

            if (data.success && data.group) {
                setGroupInfo(data.group);
                setNewSubject(data.group.subject);
                setNewDescription(data.group.description ?? "");
                setSettings({
                    announce: !!data.group.announce,
                    restrict: !!data.group.restrict,
                    // O serviço manda memberAddMode = true para "todos adicionam";
                    // o interruptor é "Só admins adicionam membros".
                    memberAdd: data.group.memberAddMode === false,
                    joinApproval: !!data.group.joinApprovalMode,
                    ephemeral: String(data.group.ephemeralDuration ?? 0),
                });
            } else {
                toast({
                    title: "Não foi possível carregar grupo",
                    description: toUserMessage(data.error),
                    variant: "destructive",
                });
            }
        } catch (error) {
            console.error("Error fetching group info:", error);
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [open, groupJid, phoneNumberId, toast]);

    // Grupo trocou: zera o estado para a carga cheia (senão a revalidação
    // silenciosa mostraria os dados do grupo ANTERIOR).
    useEffect(() => {
        setGroupInfo(null);
    }, [groupJid]);

    useEffect(() => {
        fetchGroupInfo();
    }, [fetchGroupInfo]);

    // Painel fechou: descarta estados de edição — reabrir não pode voltar em
    // modo de edição nem com convite/telefone pendente de outra sessão.
    useEffect(() => {
        if (open) return;
        setEditingSubject(false);
        setEditingDescription(false);
        setEditingAlias(null);
        setNewAlias("");
        setNewMemberPhone("");
        setManualPhoneCheck(phoneCheckForDigits(""));
        setPendingInvite(null);
    }, [open]);

    // Fetch aliases from Supabase
    const fetchAliases = useCallback(async () => {
        if (!open || !groupJid || !organizationId) return;

        try {
            const { data, error } = await supabase
                .from("group_participant_aliases")
                .select("participant_jid, alias")
                .eq("organization_id", organizationId)
                .eq("group_jid", groupJid);

            if (error) {
                console.error("Error fetching aliases:", error);
                return;
            }

            if (data) {
                const aliasMap: Record<string, string> = {};
                data.forEach((a) => {
                    aliasMap[a.participant_jid] = a.alias;
                });
                setAliases(aliasMap);
            }
        } catch (error) {
            console.error("Error fetching aliases:", error);
        }
    }, [open, groupJid, organizationId]);

    useEffect(() => {
        fetchAliases();
    }, [fetchAliases]);

    // Busca solicitações pendentes só quando a aprovação está ligada.
    // Não-admin recebe erro do serviço — engolimos e não mostramos a seção.
    const fetchJoinRequests = useCallback(async () => {
        if (!open || !groupJid || !phoneNumberId || !settings.joinApproval || !canManageSettings) {
            setJoinRequests([]);
            return;
        }

        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/join-requests`
            );
            const data = await response.json();
            setJoinRequests(
                data.success && Array.isArray(data.requests) ? data.requests : []
            );
        } catch (error) {
            console.error("Error fetching join requests:", error);
            setJoinRequests([]);
        }
    }, [open, groupJid, phoneNumberId, settings.joinApproval, canManageSettings]);

    useEffect(() => {
        fetchJoinRequests();
    }, [fetchJoinRequests]);

    const handleJoinRequest = async (jid: string, action: "approve" | "reject") => {
        const previous = joinRequests;
        // Update otimista: remove a linha na hora; reverte se o serviço negar
        setJoinRequests((prev) => prev.filter((r) => r.jid !== jid));
        const done = startAction(`join-request-${jid}`);
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/join-requests`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ participants: [jid], action }),
                }
            );
            const data = await response.json();

            if (data.success) {
                toast({
                    title: action === "approve" ? "Solicitação aprovada" : "Solicitação rejeitada",
                });
                // Aprovar adiciona o membro — recarrega a lista do grupo
                if (action === "approve") fetchGroupInfo();
            } else {
                setJoinRequests(previous);
                toast({
                    title: "Não foi possível responder à solicitação",
                    description: toUserMessage(data.error),
                    variant: "destructive",
                });
            }
        } catch (error) {
            console.error("Error updating join request:", error);
            setJoinRequests(previous);
            toast({ title: "Sem resposta do serviço", description: "Verifique a conexão e tente novamente.", variant: "destructive" });
        } finally {
            done();
        }
    };

    // Save or update alias
    const handleSaveAlias = async (participantJid: string) => {
        const trimmedAlias = newAlias.trim();

        // If empty, delete the alias
        if (!trimmedAlias) {
            if (aliases[participantJid]) {
                // Delete existing alias
                const done = startAction(`alias-${participantJid}`);
                try {
                    const { error } = await supabase
                        .from("group_participant_aliases")
                        .delete()
                        .eq("organization_id", organizationId)
                        .eq("group_jid", groupJid)
                        .eq("participant_jid", participantJid);

                    if (error) throw error;

                    setAliases((prev) => {
                        const updated = { ...prev };
                        delete updated[participantJid];
                        return updated;
                    });
                    toast({ title: "Apelido removido" });
                } catch (error) {
                    console.error("Error deleting alias:", error);
                    toast({ title: "Não foi possível remover apelido", variant: "destructive" });
                } finally {
                    done();
                }
            }
            setEditingAlias(null);
            setNewAlias("");
            return;
        }

        const done = startAction(`alias-${participantJid}`);
        try {
            const { error } = await supabase
                .from("group_participant_aliases")
                .upsert(
                    {
                        organization_id: organizationId,
                        group_jid: groupJid,
                        participant_jid: participantJid,
                        alias: trimmedAlias,
                        created_by: userId,
                        updated_at: new Date().toISOString(),
                    },
                    {
                        onConflict: "organization_id,group_jid,participant_jid",
                    }
                );

            if (error) throw error;

            setAliases((prev) => ({ ...prev, [participantJid]: trimmedAlias }));
            toast({ title: "Apelido salvo" });
        } catch (error) {
            console.error("Error saving alias:", error);
            toast({ title: "Não foi possível salvar apelido", variant: "destructive" });
        } finally {
            setEditingAlias(null);
            setNewAlias("");
            done();
        }
    };

    /**
     * `phoneArg` vem do picker de contatos; sem ele usa o número digitado.
     * Adicionar em grupo pode derrubar a sessão (penalidade do WhatsApp), então
     * o fluxo segue um participante por vez, como antes.
     *
     * Só o caminho MANUAL passa pelo schema: o picker já entrega dígitos vindos
     * do banco, e validar ali bloquearia um contato internacional legítimo.
     * Devolve true quando a adição foi aceita — a adição em série precisa saber
     * se pode continuar.
     */
    const handleAddMember = async (
        phoneArg?: string,
        /** Modo lote: não fecha o diálogo nem emite toast por item. */
        batch?: boolean
    ): Promise<boolean> => {
        let phone: string;
        if (phoneArg !== undefined) {
            phone = phoneArg.trim();
        } else {
            if (!manualPhoneCheck.ok) {
                toast({ title: manualPhoneCheck.error ?? "Número inválido", variant: "destructive" });
                return false;
            }
            phone = manualPhoneCheck.phone;
        }
        if (!phone) return false;

        // Segunda barreira (a primeira é o botão não aparecer): o serviço também
        // recusa com 403, mas aqui a pessoa nem espera a volta.
        if (!addPermission?.allowed) {
            toast({
                title: "Não foi possível adicionar membro",
                description: addPermission
                    ? groupAddBlockLabel(addPermission.reason ?? "unknown")
                    : "Aguarde o grupo carregar e tente de novo.",
                variant: "destructive",
            });
            return false;
        }

        const done = startAction("add");
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/participants`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ participants: [phone] }),
                }
            );
            const data = await response.json();

            if (data.success) {
                if (data.inviteRequired?.length) {
                    // Contact's privacy blocks direct add — open dialog to edit and send the invite
                    setPendingInvite(data.inviteRequired[0]);
                    setInviteText(
                        groupInfo?.subject
                            ? `Convite para entrar no grupo "${groupInfo.subject}"`
                            : "Convite para entrar no grupo"
                    );
                } else if (!batch) {
                    toast({ title: "Membro adicionado" });
                    fetchGroupInfo();
                    onGroupUpdated?.();
                }
                if (!batch) {
                    resetNewMemberPhone();
                    setAddMemberOpen(false);
                }
                return true;
            }

            toast({
                title: "Não foi possível adicionar membro",
                description: data.error,
                variant: "destructive",
            });
            return false;
        } catch (error) {
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
            return false;
        } finally {
            done();
        }
    };

    /**
     * Coloca várias linhas próprias no grupo, UMA POR VEZ com pausa entre elas.
     *
     * Não paralelizar: adicionar em grupo tem penalidade do WhatsApp e já
     * derrubou sessão com conflict/401 — um lote simultâneo multiplica o risco.
     * Ao primeiro erro o restante é abortado e o usuário vê o que entrou e o
     * que faltou, em vez de descobrir depois pelo aparelho.
     */
    const handleAddOwnLines = async (lines: SelectableLine[]) => {
        if (!lines.length) return;

        setLinesProgress({ done: 0, total: lines.length });
        const failed: string[] = [];
        let added = 0;

        try {
            for (let i = 0; i < lines.length; i++) {
                if (i > 0) await new Promise((r) => setTimeout(r, 2_000));
                setLinesProgress({ done: i, total: lines.length });

                const ok = await handleAddMember(lines[i].phone, true);
                if (!ok) {
                    // O toast do erro já saiu no handleAddMember.
                    failed.push(...lines.slice(i).map((l) => l.displayName));
                    break;
                }
                added++;
            }
        } finally {
            setLinesProgress(null);
        }

        if (added > 0) {
            fetchGroupInfo();
            onGroupUpdated?.();
        }

        if (failed.length) {
            toast({
                title: added ? (added === 1 ? "1 número adicionado" : `${added} números adicionados`) : "Nenhum número adicionado",
                description: `Não entrou: ${failed.join(", ")}. Tente novamente em alguns minutos.`,
                variant: "destructive",
            });
            return;
        }

        setAddMemberOpen(false);
        toast({
            title: added === 1 ? "Número adicionado ao grupo" : `${added} números adicionados`,
            description: "Traga o histórico para eles em “Trazer histórico para esta linha”.",
        });
    };

    const handleSendGroupInvite = async () => {
        if (!pendingInvite || !inviteText.trim()) return;

        const done = startAction("send-invite");
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/invite-message`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        jid: pendingInvite.jid,
                        code: pendingInvite.code,
                        expiration: pendingInvite.expiration,
                        text: inviteText.trim(),
                    }),
                }
            );
            const data = await response.json();

            if (data.success) {
                toast({
                    title: "Convite enviado",
                    description: "O contato precisa aceitar o convite para entrar no grupo.",
                });
                setPendingInvite(null);
                setInviteText("");
            } else {
                toast({
                    title: "Não foi possível enviar convite",
                    description: data.error,
                    variant: "destructive",
                });
            }
        } catch (error) {
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            done();
        }
    };

    // Now accepts participantId (full JID like "123@s.whatsapp.net" or "abc@lid")
    const handleRemoveMember = async (participantId: string) => {
        const done = startAction(`remove-${participantId}`);
        // Otimista: a linha some na hora (quem rolou até o participante 80 não
        // volta ao topo); reverte se o serviço negar.
        const previous = groupInfoRef.current;
        setGroupInfo((prev) =>
            prev
                ? { ...prev, participants: prev.participants.filter((p) => p.id !== participantId) }
                : prev,
        );
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/participants`,
                {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ participants: [participantId] }),
                }
            );
            const data = await response.json();

            if (data.success) {
                toast({ title: "Membro removido" });
                fetchGroupInfo();
                onGroupUpdated?.();
            } else {
                setGroupInfo(previous);
                toast({
                    title: "Não foi possível remover membro",
                    description: data.error,
                    variant: "destructive",
                });
            }
        } catch (error) {
            setGroupInfo(previous);
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            done();
        }
    };

    // Patch otimista de admin: alterna o badge na hora, reverte no erro.
    const patchParticipantAdmin = (participantId: string, isAdmin: boolean) => {
        setGroupInfo((prev) =>
            prev
                ? {
                      ...prev,
                      participants: prev.participants.map((p) =>
                          p.id === participantId ? { ...p, isAdmin } : p,
                      ),
                  }
                : prev,
        );
    };

    const handlePromote = async (participantId: string) => {
        const done = startAction(`promote-${participantId}`);
        const previous = groupInfoRef.current;
        patchParticipantAdmin(participantId, true);
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/promote`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ participants: [participantId] }),
                }
            );
            const data = await response.json();

            if (data.success) {
                toast({ title: "Membro promovido a admin" });
                fetchGroupInfo();
            } else {
                setGroupInfo(previous);
                toast({
                    title: "Não foi possível promover a admin",
                    description: data.error,
                    variant: "destructive",
                });
            }
        } catch (error) {
            setGroupInfo(previous);
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            done();
        }
    };

    const handleDemote = async (participantId: string) => {
        const done = startAction(`demote-${participantId}`);
        const previous = groupInfoRef.current;
        patchParticipantAdmin(participantId, false);
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/demote`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ participants: [participantId] }),
                }
            );
            const data = await response.json();

            if (data.success) {
                toast({ title: "Admin rebaixado" });
                fetchGroupInfo();
            } else {
                setGroupInfo(previous);
                toast({
                    title: "Não foi possível remover o admin",
                    description: data.error,
                    variant: "destructive",
                });
            }
        } catch (error) {
            setGroupInfo(previous);
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            done();
        }
    };

    const handleUpdateSubject = async () => {
        if (!newSubject.trim() || newSubject === groupInfo?.subject) {
            setEditingSubject(false);
            return;
        }

        const done = startAction("subject");
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/subject`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ subject: newSubject.trim() }),
                }
            );
            const data = await response.json();

            if (data.success) {
                toast({ title: "Nome do grupo atualizado" });
                setEditingSubject(false);
                fetchGroupInfo();
                onGroupUpdated?.();
            } else {
                toast({
                    title: "Não foi possível atualizar nome",
                    description: data.error,
                    variant: "destructive",
                });
            }
        } catch (error) {
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            done();
        }
    };

    const handleUpdatePicture = async (e: React.ChangeEvent<HTMLInputElement>) => {
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

        const done = startAction("picture");
        try {
            const formData = new FormData();
            formData.append("file", file);

            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/picture`,
                { method: "PUT", body: formData }
            );
            const data = await response.json();

            if (data.success) {
                toast({ title: "Foto do grupo atualizada" });
                fetchGroupInfo();
                onGroupUpdated?.();
            } else {
                toast({
                    title: "Não foi possível atualizar foto",
                    description: data.error,
                    variant: "destructive",
                });
            }
        } catch (error) {
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            done();
        }
    };

    const handleUpdateDescription = async () => {
        if (newDescription.trim() === (groupInfo?.description ?? "")) {
            setEditingDescription(false);
            return;
        }

        const done = startAction("description");
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/description`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ description: newDescription.trim() }),
                }
            );
            const data = await response.json();

            if (data.success) {
                toast({ title: "Descrição do grupo atualizada" });
                setEditingDescription(false);
                fetchGroupInfo();
                onGroupUpdated?.();
            } else {
                toast({
                    title: "Não foi possível atualizar descrição",
                    description: data.error,
                    variant: "destructive",
                });
            }
        } catch (error) {
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            done();
        }
    };

    // Update otimista: aplica o valor na hora e reverte se o serviço negar
    // (ex.: 400 "Sem permissão (você não é admin)").
    const patchSetting = async (
        key: string,
        path: string,
        body: Record<string, unknown>,
        optimistic: Partial<GroupSettingsState>,
    ) => {
        const previous = settings;
        setSettings((prev) => ({ ...prev, ...optimistic }));
        const done = startAction(key);
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/${path}`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                }
            );
            const data = await response.json();

            if (!data.success) {
                setSettings(previous);
                toast({
                    title: "Não foi possível alterar configuração",
                    description: toUserMessage(data.error),
                    variant: "destructive",
                });
            }
        } catch (error) {
            console.error("Error updating group setting:", error);
            setSettings(previous);
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            done();
        }
    };

    // Pré-carrega o link quando o painel abre (e o grupo diz que a linha pode
    // compartilhá-lo); falha silenciosa — o copiar sob demanda continua como fallback.
    const fetchInviteUrl = useCallback(async () => {
        if (!open || !groupJid || !phoneNumberId || !canShareInvite) return;
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/invite-code`
            );
            const data = await response.json();
            setInviteUrl(data.success && data.inviteUrl ? data.inviteUrl : null);
        } catch {
            setInviteUrl(null);
        }
    }, [open, groupJid, phoneNumberId, canShareInvite]);

    useEffect(() => {
        setInviteUrl(null);
        fetchInviteUrl();
    }, [fetchInviteUrl]);

    const handleCopyInvite = async () => {
        // Caminho rápido: link já carregado — o write acontece na mesma task do
        // gesto (exigência do Safari/iOS).
        if (inviteUrl) {
            try {
                await navigator.clipboard.writeText(inviteUrl);
                toast({ title: "Link de convite copiado" });
            } catch {
                toast({
                    title: "Não foi possível copiar",
                    description: "Copie manualmente pelo campo do link acima.",
                    variant: "destructive",
                });
            }
            return;
        }

        const done = startAction("invite-copy");
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/invite-code`
            );
            const data = await response.json();

            if (data.success && data.inviteUrl) {
                setInviteUrl(data.inviteUrl);
                await navigator.clipboard.writeText(data.inviteUrl);
                toast({ title: "Link de convite copiado" });
            } else {
                toast({
                    title: "Não foi possível obter link de convite",
                    description: data.error,
                    variant: "destructive",
                });
            }
        } catch (error) {
            console.error("Error fetching invite code:", error);
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            done();
        }
    };

    const handleRevokeInvite = async () => {
        const done = startAction("invite-revoke");
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/invite-code/revoke`,
                { method: "POST" }
            );
            const data = await response.json();

            if (data.success && data.inviteUrl) {
                // O novo link fica VISÍVEL no campo — se o clipboard falhar
                // (Safari fora do gesto), o usuário ainda tem o link.
                setInviteUrl(data.inviteUrl);
                try {
                    await navigator.clipboard.writeText(data.inviteUrl);
                    toast({
                        title: "Link revogado",
                        description: "O novo link foi copiado",
                    });
                } catch {
                    toast({
                        title: "Link revogado",
                        description: "Copie o novo link pelo campo acima.",
                    });
                }
            } else {
                toast({
                    title: "Não foi possível revogar link",
                    description: data.error,
                    variant: "destructive",
                });
            }
        } catch (error) {
            console.error("Error revoking invite code:", error);
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            done();
        }
    };

    const handleLeaveGroup = async () => {
        const done = startAction("leave");
        try {
            const response = await qrFetch(
                `/groups/${phoneNumberId}/${encodeURIComponent(groupJid)}/leave`,
                { method: "DELETE" }
            );
            const data = await response.json();

            if (data.success) {
                toast({ title: "Você saiu do grupo" });
                onOpenChange(false);
                onGroupUpdated?.();
            } else {
                toast({
                    title: "Não foi possível sair do grupo",
                    description: data.error,
                    variant: "destructive",
                });
            }
        } catch (error) {
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            done();
        }
    };

    return (
        <>
            <Sheet open={open} onOpenChange={onOpenChange}>
                <SheetContent
                    className={`p-0 ${isMobile ? "w-full max-w-full" : "w-[400px] sm:w-[450px]"}`}
                    side={isMobile ? "bottom" : "right"}
                    onEscapeKeyDown={(e) => {
                        // Esc com edição aberta CANCELA a edição, não fecha o Sheet
                        // (o Radix escuta em capture no document — stopPropagation
                        // nos inputs não chega a impedir o dismiss).
                        if (editingSubject || editingDescription || editingAlias !== null) {
                            e.preventDefault();
                            setEditingSubject(false);
                            setNewSubject(groupInfo?.subject ?? "");
                            setEditingDescription(false);
                            setNewDescription(groupInfo?.description ?? "");
                            setEditingAlias(null);
                            setNewAlias("");
                            return;
                        }
                        // Seção de mídia expandida recolhe antes de o Sheet fechar
                        // (o lightbox, quando aberto, é uma camada acima e já
                        // consumiu o Esc — nunca chega aqui).
                        if (mediaOpen) {
                            e.preventDefault();
                            setMediaOpen(false);
                        }
                    }}
                >
                    <SheetHeader className="p-4 sm:p-6 border-b safe-area-top">
                        <SheetTitle className="flex items-center gap-2">
                            {isMobile && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 -ml-2 mr-1 touch-manipulation"
                                    onClick={() => onOpenChange(false)}
                                    aria-label="Voltar"
                                >
                                    <ChevronLeft className="w-5 h-5" />
                                </Button>
                            )}
                            <Users className="w-5 h-5" />
                            <span className="truncate">Informações do grupo</span>
                            {/* Revalidação pós-ação: discreta, sem desmontar o painel */}
                            {refreshing && (
                                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" aria-label="Atualizando" />
                            )}
                        </SheetTitle>
                    </SheetHeader>

                    {loading ? (
                        <div className="flex items-center justify-center h-64">
                            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                        </div>
                    ) : groupInfo ? (
                        <div className={`flex flex-col ${isMobile ? "h-[85dvh]" : "h-[calc(100vh-80px)]"}`}>
                            {(groupInfo.suspended || groupInfo.growthLockedUntil) && (
                                <div
                                    role="alert"
                                    className="flex items-start gap-3 border-b border-orange-500/40 bg-orange-500/10 px-4 py-3 text-sm sm:px-6"
                                >
                                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" aria-hidden />
                                    <div className="min-w-0">
                                        <p className="font-medium">
                                            {groupInfo.suspended ? "Grupo suspenso pelo WhatsApp" : "Entrada de membros travada pelo WhatsApp"}
                                        </p>
                                        <p className="text-muted-foreground">
                                            {groupInfo.suspended
                                                ? "O WhatsApp restringiu este grupo. Não adicione participantes por esta linha até a suspensão cair."
                                                : `Novos participantes são recusados até ${new Date(groupInfo.growthLockedUntil as string).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}. Adicionar agora pesa contra o número.`}
                                            {groupInfo.appealStatus && groupInfo.appealStatus !== "none"
                                                ? ` Apelo: ${groupInfo.appealStatus.replace(/_/g, " ")}.`
                                                : ""}
                                        </p>
                                    </div>
                                </div>
                            )}
                            {/* Group Name */}
                            <div className="p-4 sm:p-6 border-b">
                                <div className="flex items-center gap-4">
                                    {/* Group picture with change button */}
                                    <div className="relative shrink-0">
                                        <Avatar className="w-16 h-16">
                                            <AvatarImage src={groupInfo.pictureUrl ?? undefined} alt={groupInfo.subject} />
                                            <AvatarFallback>
                                                <Users className="w-6 h-6 text-muted-foreground" />
                                            </AvatarFallback>
                                        </Avatar>
                                        {canEditInfo && (
                                        <label
                                            className={`absolute -bottom-1 -right-1 rounded-full bg-primary text-primary-foreground p-1.5 shadow ${actionLoading.has("picture") ? "opacity-70" : "cursor-pointer hover:opacity-90"}`}
                                            aria-label="Alterar foto do grupo"
                                        >
                                            {actionLoading.has("picture") ? (
                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            ) : (
                                                <Camera className="w-3.5 h-3.5" />
                                            )}
                                            <input
                                                type="file"
                                                accept="image/*"
                                                className="hidden"
                                                onChange={handleUpdatePicture}
                                                disabled={actionLoading.has("picture")}
                                            />
                                        </label>
                                        )}
                                    </div>

                                    <div className="flex-1 min-w-0">
                                        {editingSubject ? (
                                            <div className="space-y-1">
                                                <div className="flex items-center gap-2">
                                                    <Input
                                                        value={newSubject}
                                                        onChange={(e) => setNewSubject(e.target.value)}
                                                        className="flex-1"
                                                        autoFocus
                                                        maxLength={100}
                                                        onKeyDown={(e) => {
                                                            // Enter salva; Escape cancela SEM fechar o Sheet
                                                            if (e.key === "Enter" && !actionLoading.has("subject")) handleUpdateSubject();
                                                            if (e.key === "Escape") {
                                                                e.stopPropagation();
                                                                setEditingSubject(false);
                                                                setNewSubject(groupInfo.subject);
                                                            }
                                                        }}
                                                    />
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        onClick={handleUpdateSubject}
                                                        disabled={actionLoading.has("subject") || !newSubject.trim()}
                                                        aria-label="Salvar nome do grupo"
                                                    >
                                                        {actionLoading.has("subject") ? (
                                                            <Loader2 className="w-4 h-4 animate-spin" />
                                                        ) : (
                                                            <Check className="w-4 h-4" />
                                                        )}
                                                    </Button>
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        onClick={() => {
                                                            setEditingSubject(false);
                                                            setNewSubject(groupInfo.subject);
                                                        }}
                                                        aria-label="Cancelar edição do nome"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                                <p className="text-xs text-muted-foreground text-right tabular-nums">
                                                    {newSubject.length}/100
                                                </p>
                                            </div>
                                        ) : (
                                            <div className="flex items-center justify-between">
                                                <h2 className="text-xl font-semibold truncate">{groupInfo.subject}</h2>
                                                {canEditInfo && (
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    onClick={() => setEditingSubject(true)}
                                                    aria-label="Editar nome do grupo"
                                                >
                                                    <Pencil className="w-4 h-4" />
                                                </Button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Description */}
                                {editingDescription ? (
                                    <div className="mt-3 space-y-2">
                                        <Textarea
                                            value={newDescription}
                                            onChange={(e) => setNewDescription(e.target.value)}
                                            placeholder="Descrição do grupo"
                                            rows={3}
                                            autoFocus
                                            maxLength={2048}
                                            onKeyDown={(e) => {
                                                // Cmd/Ctrl+Enter salva; Escape cancela sem fechar o Sheet
                                                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !actionLoading.has("description")) handleUpdateDescription();
                                                if (e.key === "Escape") {
                                                    e.stopPropagation();
                                                    setEditingDescription(false);
                                                    setNewDescription(groupInfo.description ?? "");
                                                }
                                            }}
                                        />
                                        <p className="text-xs text-muted-foreground text-right tabular-nums">
                                            {newDescription.length}/2048
                                        </p>
                                        <div className="flex justify-end gap-2">
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                onClick={handleUpdateDescription}
                                                disabled={actionLoading.has("description")}
                                                aria-label="Salvar descrição do grupo"
                                            >
                                                {actionLoading.has("description") ? (
                                                    <Loader2 className="w-4 h-4 animate-spin" />
                                                ) : (
                                                    <Check className="w-4 h-4" />
                                                )}
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                onClick={() => {
                                                    setEditingDescription(false);
                                                    setNewDescription(groupInfo.description ?? "");
                                                }}
                                                aria-label="Cancelar edição da descrição"
                                            >
                                                <X className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="mt-3 flex items-start justify-between gap-2">
                                        <div className="max-h-24 overflow-y-auto flex-1">
                                            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                                                {groupInfo.description || "Sem descrição"}
                                            </p>
                                        </div>
                                        {canEditInfo && (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-8 w-8 shrink-0"
                                            onClick={() => {
                                                setNewDescription(groupInfo.description ?? "");
                                                setEditingDescription(true);
                                            }}
                                            aria-label="Editar descrição do grupo"
                                        >
                                            <Pencil className="w-3.5 h-3.5" />
                                        </Button>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Group Settings */}
                            <div className="px-4 sm:px-6 py-3 border-b">
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
                                        {!canManageSettings && (
                                            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                                <ShieldAlert className="w-3.5 h-3.5 shrink-0" aria-hidden />
                                                Só admins mudam estas configurações
                                            </p>
                                        )}
                                        <div className="flex items-center justify-between gap-4">
                                            <Label htmlFor="group-announce" className="text-sm font-normal">
                                                Só admins enviam mensagens
                                            </Label>
                                            <Switch
                                                id="group-announce"
                                                checked={settings.announce}
                                                disabled={!canManageSettings || actionLoading.has("setting-announce")}
                                                onCheckedChange={(checked) =>
                                                    patchSetting(
                                                        "setting-announce",
                                                        "settings",
                                                        { setting: checked ? "announcement" : "not_announcement" },
                                                        { announce: checked }
                                                    )
                                                }
                                            />
                                        </div>
                                        <div className="flex items-center justify-between gap-4">
                                            <Label htmlFor="group-restrict" className="text-sm font-normal">
                                                Só admins editam dados do grupo
                                            </Label>
                                            <Switch
                                                id="group-restrict"
                                                checked={settings.restrict}
                                                disabled={!canManageSettings || actionLoading.has("setting-restrict")}
                                                onCheckedChange={(checked) =>
                                                    patchSetting(
                                                        "setting-restrict",
                                                        "settings",
                                                        { setting: checked ? "locked" : "unlocked" },
                                                        { restrict: checked }
                                                    )
                                                }
                                            />
                                        </div>
                                        <div className="flex items-center justify-between gap-4">
                                            <Label htmlFor="group-member-add" className="text-sm font-normal">
                                                Só admins adicionam membros
                                            </Label>
                                            <Switch
                                                id="group-member-add"
                                                checked={settings.memberAdd}
                                                disabled={!canManageSettings || actionLoading.has("setting-member-add")}
                                                onCheckedChange={(checked) =>
                                                    patchSetting(
                                                        "setting-member-add",
                                                        "member-add-mode",
                                                        { mode: checked ? "admin_add" : "all_member_add" },
                                                        { memberAdd: checked }
                                                    )
                                                }
                                            />
                                        </div>
                                        <div className="flex items-center justify-between gap-4">
                                            <Label htmlFor="group-join-approval" className="text-sm font-normal">
                                                Aprovar novos participantes
                                            </Label>
                                            <Switch
                                                id="group-join-approval"
                                                checked={settings.joinApproval}
                                                disabled={!canManageSettings || actionLoading.has("setting-join-approval")}
                                                onCheckedChange={(checked) =>
                                                    patchSetting(
                                                        "setting-join-approval",
                                                        "join-approval",
                                                        { mode: checked ? "on" : "off" },
                                                        { joinApproval: checked }
                                                    )
                                                }
                                            />
                                        </div>
                                        <div className="flex items-center justify-between gap-4">
                                            <Label htmlFor="group-ephemeral" className="text-sm font-normal">
                                                Mensagens temporárias
                                            </Label>
                                            <Select
                                                value={settings.ephemeral}
                                                disabled={!canEditInfo || actionLoading.has("setting-ephemeral")}
                                                onValueChange={(value) =>
                                                    patchSetting(
                                                        "setting-ephemeral",
                                                        "ephemeral",
                                                        { expiration: Number(value) },
                                                        { ephemeral: value }
                                                    )
                                                }
                                            >
                                                <SelectTrigger id="group-ephemeral" className="w-[130px] h-8">
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
                                        {canShareInvite && inviteUrl && (
                                            <Input
                                                readOnly
                                                value={inviteUrl}
                                                onFocus={(e) => e.currentTarget.select()}
                                                className="h-9 md:h-8 text-xs font-mono"
                                                aria-label="Link de convite do grupo"
                                            />
                                        )}
                                        {canShareInvite && (
                                        <div className="flex gap-2 pt-1">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="flex-1 h-11 md:h-8"
                                                onClick={handleCopyInvite}
                                                disabled={actionLoading.has("invite-copy")}
                                            >
                                                {actionLoading.has("invite-copy") ? (
                                                    <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                                                ) : (
                                                    <Link2 className="w-3.5 h-3.5 mr-2" />
                                                )}
                                                Copiar link
                                            </Button>
                                            {canManageSettings && (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="flex-1 h-11 md:h-8"
                                                onClick={() => setConfirmAction({ type: "revoke" })}
                                                disabled={actionLoading.has("invite-revoke")}
                                            >
                                                {actionLoading.has("invite-revoke") ? (
                                                    <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                                                ) : (
                                                    <RotateCcw className="w-3.5 h-3.5 mr-2" />
                                                )}
                                                Revogar link
                                            </Button>
                                            )}
                                        </div>
                                        )}
                                    </CollapsibleContent>
                                </Collapsible>
                            </div>

                            {/* Pending Join Requests — só aparece quando há solicitações */}
                            {joinRequests.length > 0 && (
                                <div className="border-t">
                                    <div className="flex items-center px-4 sm:px-6 py-3 bg-muted/30">
                                        <span className="text-sm font-medium">
                                            Solicitações pendentes ({joinRequests.length})
                                        </span>
                                    </div>
                                    <div className="divide-y">
                                        {joinRequests.map((request) => {
                                            const isLid = request.jid.includes("@lid");
                                            const phone = request.jid
                                                .replace("@s.whatsapp.net", "")
                                                .replace("@lid", "");
                                            const busy = actionLoading.has(`join-request-${request.jid}`);
                                            return (
                                                <div
                                                    key={request.jid}
                                                    className="flex items-center justify-between px-4 sm:px-6 py-4 sm:py-3"
                                                >
                                                    <div className="flex items-center gap-3 flex-1 min-w-0">
                                                        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                                            <span className="text-sm font-medium">
                                                                {phone.slice(0, 2).toUpperCase()}
                                                            </span>
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-sm font-medium truncate">
                                                                {formatParticipantPhone(phone, isLid)}
                                                            </p>
                                                            <p className="text-xs text-muted-foreground">
                                                                Aguardando aprovação
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2 shrink-0">
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="h-8"
                                                            disabled={busy}
                                                            onClick={() => handleJoinRequest(request.jid, "approve")}
                                                            title="Aprovar"
                                                            aria-label="Aprovar"
                                                        >
                                                            {busy ? (
                                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                            ) : (
                                                                <Check className="w-3.5 h-3.5" />
                                                            )}
                                                        </Button>
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            className="h-8 text-destructive hover:text-destructive"
                                                            disabled={busy}
                                                            onClick={() => handleJoinRequest(request.jid, "reject")}
                                                            title="Rejeitar"
                                                            aria-label="Rejeitar"
                                                        >
                                                            <X className="w-3.5 h-3.5" />
                                                        </Button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Members Section */}
                            <div className="flex items-center justify-between px-4 sm:px-6 py-3 bg-muted/30">
                                <span className="text-sm font-medium">
                                    {groupInfo.participants.length} participantes
                                </span>
                                {addPermission?.allowed ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                            setAddMemberTab("lines");
                                            resetNewMemberPhone();
                                            setAddMemberOpen(true);
                                        }}
                                        className="h-9 sm:h-8 touch-manipulation"
                                    >
                                        <UserPlus className="w-4 h-4 mr-2" />
                                        Adicionar
                                    </Button>
                                ) : addPermission ? (
                                    // Sem botão desabilitado mudo: a frase diz por quê, e vale no toque.
                                    <span
                                        className="flex items-center gap-1.5 text-xs text-muted-foreground text-right"
                                        title="Adicionar participante sem ser admin derruba a conexão do WhatsApp"
                                    >
                                        <ShieldAlert className="w-3.5 h-3.5 shrink-0" aria-hidden />
                                        {groupAddBlockLabel(addPermission.reason ?? "unknown")}
                                    </span>
                                ) : null}
                            </div>

                            {/* Members List */}
                            <ScrollArea className="flex-1">
                                <div className="divide-y">
                                    {groupInfo.participants
                                        .sort((a, b) => {
                                            // Sort: SuperAdmins first, then Admins, then regular
                                            if (a.isSuperAdmin && !b.isSuperAdmin) return -1;
                                            if (!a.isSuperAdmin && b.isSuperAdmin) return 1;
                                            if (a.isAdmin && !b.isAdmin) return -1;
                                            if (!a.isAdmin && b.isAdmin) return 1;
                                            return 0;
                                        })
                                        .map((participant) => (
                                            <div
                                                key={participant.id}
                                                className="flex items-center justify-between px-4 sm:px-6 py-4 sm:py-3 hover:bg-muted/50 active:bg-muted/70 touch-manipulation"
                                            >
                                                <div className="flex items-center gap-3 flex-1 min-w-0">
                                                    {/* A conversa 1:1 vinculada já tem a foto da pessoa. */}
                                                    <Avatar className="w-10 h-10 shrink-0">
                                                        {contactFor(participant)?.avatarUrl && (
                                                            <AvatarImage
                                                                src={contactFor(participant)!.avatarUrl!}
                                                                alt=""
                                                            />
                                                        )}
                                                        <AvatarFallback className="bg-primary/10 text-sm font-medium">
                                                            {participantLabel(participant).slice(0, 2).toUpperCase()}
                                                        </AvatarFallback>
                                                    </Avatar>
                                                    <div className="flex-1 min-w-0">
                                                        {editingAlias === (participant.jid || participant.id) ? (
                                                            <div className="flex items-center gap-2">
                                                                <Input
                                                                    value={newAlias}
                                                                    onChange={(e) => setNewAlias(e.target.value)}
                                                                    placeholder="Apelido…"
                                                                    className="h-9 md:h-7 w-40 text-base md:text-sm"
                                                                    autoFocus
                                                                    onKeyDown={(e) => {
                                                                        if (e.key === "Enter" && !actionLoading.has(`alias-${participant.jid || participant.id}`)) handleSaveAlias(participant.jid || participant.id);
                                                                        if (e.key === "Escape") {
                                                                            // Sem stopPropagation o Esc subia e fechava o Sheet inteiro
                                                                            e.stopPropagation();
                                                                            setEditingAlias(null);
                                                                            setNewAlias("");
                                                                        }
                                                                    }}
                                                                />
                                                                <Button
                                                                    size="icon"
                                                                    variant="ghost"
                                                                    className="h-6 w-6"
                                                                    onClick={() => handleSaveAlias(participant.jid || participant.id)}
                                                                    disabled={actionLoading.has(`alias-${participant.jid || participant.id}`)}
                                                                    aria-label="Salvar apelido"
                                                                >
                                                                    {actionLoading.has(`alias-${participant.jid || participant.id}`) ? (
                                                                        <Loader2 className="w-3 h-3 animate-spin" />
                                                                    ) : (
                                                                        <Check className="w-3 h-3" />
                                                                    )}
                                                                </Button>
                                                                <Button
                                                                    size="icon"
                                                                    variant="ghost"
                                                                    className="h-6 w-6"
                                                                    onClick={() => {
                                                                        setEditingAlias(null);
                                                                        setNewAlias("");
                                                                    }}
                                                                    aria-label="Cancelar edição do apelido"
                                                                >
                                                                    <X className="w-3 h-3" />
                                                                </Button>
                                                            </div>
                                                        ) : (
                                                            <>
                                                                <div className="flex items-center gap-1">
                                                                    <p className="text-sm font-medium truncate">
                                                                        {participantLabel(participant)}
                                                                    </p>
                                                                    <Button
                                                                        size="icon"
                                                                        variant="ghost"
                                                                        className="h-8 w-8 -my-1 shrink-0 opacity-100 [@media(hover:hover)]:opacity-40 hover:opacity-100"
                                                                        onClick={() => {
                                                                            setEditingAlias(participant.jid || participant.id);
                                                                            setNewAlias(aliases[participant.jid || participant.id] || "");
                                                                        }}
                                                                        aria-label="Editar apelido"
                                                                    >
                                                                        <Pencil className="w-3 h-3" />
                                                                    </Button>
                                                                </div>
                                                                {/* O telefone só aparece quando o rótulo NÃO é ele.
                                                                    A fonte só aparece quando difere do rótulo, para
                                                                    não repetir "João · João". */}
                                                                {participantName(participant).origin !== "phone" && (
                                                                    <p className="text-xs text-muted-foreground truncate">
                                                                        {[
                                                                            participantName(participant).origin === "alias"
                                                                                ? participant.name
                                                                                : null,
                                                                            formatParticipantPhone(participant.phone, participant.isLid),
                                                                        ]
                                                                            .filter(Boolean)
                                                                            .join(" · ")}
                                                                    </p>
                                                                )}
                                                                {contactFor(participant) && onOpenConversation && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => handleOpenLinkedConversation(participant)}
                                                                        className="mt-0.5 -my-1 inline-flex max-w-full items-center gap-1 rounded-sm py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                                        title={`Abrir conversa com ${participantLabel(participant)}`}
                                                                    >
                                                                        <Link2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                                                                        <span className="truncate">
                                                                            {contactFor(participant)!.sameConnection
                                                                                ? "Conversa existente"
                                                                                : "Conversa em outro número"}
                                                                        </span>
                                                                    </button>
                                                                )}
                                                            </>
                                                        )}
                                                        <div className="flex items-center gap-2 mt-0.5">
                                                            {participant.isSuperAdmin && (
                                                                <Badge variant="default" className="text-xs h-5 bg-amber-500">
                                                                    <Crown className="w-3 h-3 mr-1" />
                                                                    Dono
                                                                </Badge>
                                                            )}
                                                            {participant.isAdmin && !participant.isSuperAdmin && (
                                                                <Badge variant="secondary" className="text-xs h-5">
                                                                    <Shield className="w-3 h-3 mr-1" />
                                                                    Admin
                                                                </Badge>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>

                                                {!participant.isSuperAdmin &&
                                                    (canManageMembers || (contactFor(participant) && onOpenConversation)) && (
                                                    <DropdownMenu>
                                                        <DropdownMenuTrigger asChild>
                                                            <Button
                                                                size="icon"
                                                                variant="ghost"
                                                                className="h-8 w-8"
                                                                disabled={participantBusy(participant.id)}
                                                                aria-label={`Mais opções de ${participantLabel(participant)}`}
                                                            >
                                                                {participantBusy(participant.id) ? (
                                                                    <Loader2 className="w-4 h-4 animate-spin" />
                                                                ) : (
                                                                    <MoreVertical className="w-4 h-4" />
                                                                )}
                                                            </Button>
                                                        </DropdownMenuTrigger>
                                                        <DropdownMenuContent align="end">
                                                            {contactFor(participant) && onOpenConversation && (
                                                                <DropdownMenuItem
                                                                    onClick={() => handleOpenLinkedConversation(participant)}
                                                                >
                                                                    <MessageSquare className="w-4 h-4 mr-2" />
                                                                    Abrir conversa 1:1
                                                                </DropdownMenuItem>
                                                            )}
                                                            {canManageMembers && (participant.isAdmin ? (
                                                                <DropdownMenuItem
                                                                    onClick={() => setConfirmAction({ type: "demote", participant })}
                                                                >
                                                                    <ShieldOff className="w-4 h-4 mr-2" />
                                                                    Remover admin
                                                                </DropdownMenuItem>
                                                            ) : (
                                                                <DropdownMenuItem
                                                                    onClick={() => handlePromote(participant.id)}
                                                                >
                                                                    <Shield className="w-4 h-4 mr-2" />
                                                                    Tornar admin
                                                                </DropdownMenuItem>
                                                            ))}
                                                            {canManageMembers && (
                                                            <DropdownMenuItem
                                                                onClick={() => setConfirmAction({ type: "remove", participant })}
                                                                className="text-destructive"
                                                            >
                                                                <UserMinus className="w-4 h-4 mr-2" />
                                                                Remover do grupo
                                                            </DropdownMenuItem>
                                                            )}
                                                        </DropdownMenuContent>
                                                    </DropdownMenu>
                                                )}
                                            </div>
                                        ))}
                                </div>
                            </ScrollArea>

                            {/* Mídia do grupo: colapsada por padrão — quem abre
                                este painel vem ver participantes, e a query da
                                galeria só arma quando a seção expande. */}
                            <Collapsible open={mediaOpen} onOpenChange={setMediaOpen}>
                                <CollapsibleTrigger className="w-full flex items-center gap-2 px-4 sm:px-6 py-3 border-t bg-muted/30 text-sm font-medium transition-colors hover:bg-muted/50">
                                    <ImageIcon className="w-4 h-4" />
                                    Mídia, docs e áudios
                                    <ChevronDown
                                        className={`w-4 h-4 ml-auto transition-transform duration-200 ease-out ${mediaOpen ? "rotate-180" : ""}`}
                                    />
                                </CollapsibleTrigger>
                                <CollapsibleContent>
                                    {/* Altura DEFINIDA, não max-h: o corpo das abas
                                        rola com h-full, que não resolve contra um
                                        pai que só tem teto. */}
                                    <div className="flex h-[45dvh] flex-col min-h-0">
                                        <ConversationMediaTabs
                                            conversationId={conversationId}
                                            active={mediaOpen}
                                        />
                                    </div>
                                </CollapsibleContent>
                            </Collapsible>

                            {/* Ações do grupo */}
                            <div className="p-4 sm:p-6 border-t safe-area-bottom space-y-2">
                                <Button
                                    variant="outline"
                                    className="w-full h-12 sm:h-10 touch-manipulation"
                                    onClick={() => setMirrorOpen(true)}
                                >
                                    <History className="w-4 h-4 mr-2" />
                                    Trazer histórico para esta linha
                                </Button>
                                <Button
                                    variant="destructive"
                                    className="w-full h-12 sm:h-10 touch-manipulation"
                                    onClick={() => setConfirmAction({ type: "leave" })}
                                    disabled={actionLoading.has("leave")}
                                >
                                    {actionLoading.has("leave") ? (
                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                    ) : (
                                        <LogOut className="w-4 h-4 mr-2" />
                                    )}
                                    Sair do grupo
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-center justify-center h-64 text-muted-foreground">
                            Não foi possível carregar informações do grupo
                        </div>
                    )}
                </SheetContent>
            </Sheet>

            {/* Confirmação de destrutivas: AlertDialog do DS com nome do alvo e a
                consequência explícita — no lugar dos window.confirm e dos cliques
                diretos de menu que expulsavam a pessoa errada sem confirmar. */}
            <AlertDialog
                open={confirmAction !== null}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen) setConfirmAction(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {confirmDialogData?.type === "remove" &&
                                `Remover ${participantLabel(confirmDialogData.participant)} do grupo?`}
                            {confirmDialogData?.type === "demote" &&
                                `Remover admin de ${participantLabel(confirmDialogData.participant)}?`}
                            {confirmDialogData?.type === "revoke" && "Revogar link de convite?"}
                            {confirmDialogData?.type === "leave" && "Sair do grupo?"}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirmDialogData?.type === "remove" &&
                                `${participantLabel(confirmDialogData.participant)} (${formatParticipantPhone(confirmDialogData.participant.phone, confirmDialogData.participant.isLid)}) será removido imediatamente. Para voltar, precisará ser adicionado de novo ou usar um link de convite.`}
                            {confirmDialogData?.type === "demote" &&
                                `${participantLabel(confirmDialogData.participant)} perde os poderes de administração deste grupo.`}
                            {confirmDialogData?.type === "revoke" &&
                                "O link atual para de funcionar imediatamente e um novo link é gerado."}
                            {confirmDialogData?.type === "leave" &&
                                "Este número deixará de receber as mensagens do grupo."}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={executeConfirmedAction}
                        >
                            {confirmDialogData?.type === "remove" && "Remover do grupo"}
                            {confirmDialogData?.type === "demote" && "Remover admin"}
                            {confirmDialogData?.type === "revoke" && "Revogar link"}
                            {confirmDialogData?.type === "leave" && "Sair do grupo"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Add Member Dialog */}
            <Dialog open={addMemberOpen} onOpenChange={setAddMemberOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Adicionar membro</DialogTitle>
                    </DialogHeader>

                    <Tabs
                        value={addMemberTab}
                        onValueChange={(v) =>
                            setAddMemberTab(v as "lines" | "contacts" | "manual")
                        }
                    >
                        <TabsList className="grid w-full grid-cols-3">
                            <TabsTrigger value="lines" className="flex items-center gap-2">
                                <Phone className="w-4 h-4" />
                                Meus números
                            </TabsTrigger>
                            <TabsTrigger value="contacts" className="flex items-center gap-2">
                                <Users className="w-4 h-4" />
                                Existente
                            </TabsTrigger>
                            <TabsTrigger value="manual" className="flex items-center gap-2">
                                <UserPlus className="w-4 h-4" />
                                Novo
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent value="lines" className="mt-4">
                            <OwnLinesSelectList
                                phoneNumberId={phoneNumberId}
                                enabled={addMemberOpen && addMemberTab === "lines"}
                                excludedPhones={contactPhones}
                                actionLabel="Adicionar ao grupo"
                                onConfirm={(lines) => void handleAddOwnLines(lines)}
                                busy={linesProgress !== null}
                                busyLabel={
                                    linesProgress
                                        ? `Adicionando ${linesProgress.done + 1} de ${linesProgress.total}…`
                                        : undefined
                                }
                            />
                            <p className="text-xs text-muted-foreground mt-2">
                                Um por vez, com pausa entre eles — adicionar vários de
                                uma vez pode derrubar a conexão do WhatsApp.
                            </p>
                        </TabsContent>

                        <TabsContent value="contacts" className="mt-4">
                            <ContactSelectList
                                phoneNumberId={phoneNumberId}
                                enabled={addMemberOpen && addMemberTab === "contacts"}
                                excludedPhones={contactPhones}
                                onSelect={(contact) => void handleAddMember(contact.phone)}
                                emptyLabel="Nenhuma conversa 1:1 neste número"
                            />
                            {actionLoading.has("add") && (
                                <p className="text-xs text-muted-foreground mt-2 flex items-center gap-2">
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    Adicionando…
                                </p>
                            )}
                        </TabsContent>

                        <TabsContent value="manual" className="mt-4">
                            <PhoneNumberInput
                                value={newMemberPhone}
                                onChange={(digits, check) => {
                                    setNewMemberPhone(digits);
                                    setManualPhoneCheck(check);
                                }}
                                onSubmit={() => {
                                    if (manualPhoneCheck.ok) void handleAddMember();
                                }}
                                error={manualPhoneCheck.error}
                            />
                            <DialogFooter className="mt-4">
                                <Button variant="outline" onClick={() => setAddMemberOpen(false)}>
                                    Cancelar
                                </Button>
                                <Button
                                    onClick={() => void handleAddMember()}
                                    disabled={!manualPhoneCheck.ok || actionLoading.has("add")}
                                >
                                    {actionLoading.has("add") ? (
                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                    ) : (
                                        <UserPlus className="w-4 h-4 mr-2" />
                                    )}
                                    Adicionar
                                </Button>
                            </DialogFooter>
                        </TabsContent>
                    </Tabs>
                </DialogContent>
            </Dialog>

            {/* Group Invite Dialog — contact's privacy blocks direct add */}
            <Dialog
                open={!!pendingInvite}
                onOpenChange={(open) => {
                    if (!open) {
                        setPendingInvite(null);
                        setInviteText("");
                    }
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Enviar convite para o grupo</DialogTitle>
                    </DialogHeader>
                    <div className="py-4 space-y-3">
                        <p className="text-sm text-muted-foreground">
                            O número {pendingInvite?.phone} não permite ser adicionado
                            diretamente a grupos. Você pode enviar um convite que ele precisa
                            aceitar para entrar.
                        </p>
                        <div className="space-y-1.5">
                            <Label htmlFor="invite-text">Mensagem do convite</Label>
                            <Textarea
                                id="invite-text"
                                value={inviteText}
                                onChange={(e) => setInviteText(e.target.value)}
                                rows={3}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setPendingInvite(null);
                                setInviteText("");
                            }}
                        >
                            Cancelar
                        </Button>
                        <Button
                            onClick={handleSendGroupInvite}
                            disabled={!inviteText.trim() || actionLoading.has("send-invite")}
                        >
                            {actionLoading.has("send-invite") ? (
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                                <UserPlus className="w-4 h-4 mr-2" />
                            )}
                            Enviar convite
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Espelho de histórico entre linhas próprias */}
            <MirrorGroupHistoryDialog
                open={mirrorOpen}
                onOpenChange={setMirrorOpen}
                targetConversationId={conversationId}
                groupJid={groupJid}
                phoneNumberId={phoneNumberId}
                onMirrored={() => onGroupUpdated?.()}
            />
        </>
    );
};

export default GroupInfoPanel;
