import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IdCopyButton } from "@/components/ui/id-copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/contexts/OrganizationContext";
import { supabase } from "@/integrations/supabase/client";
import { QrCode, Wifi, WifiOff, Loader2, RefreshCw, Trash2, Bell, Mail, X, Plus, ChevronDown, ChevronUp, UserCog, Copy, KeyRound, TimerOff, AlertCircle } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { pairingPhoneSchema, formatPairingCode } from "@/lib/pairingPhone";
import WhatsAppProfileDialog from "@/components/WhatsAppProfileDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import SectorIsolationSwitch from "@/components/settings/SectorIsolationSwitch";
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
import { useIsMobile } from "@/hooks/use-mobile";
import { HuePickerPopover } from "@/components/ui/hue-picker";
import { cn } from "@/lib/utils";
import { qrFetch, qrEventSourceUrl } from "@/lib/qrService";
import { toUserMessage } from "@/lib/userFacingError";
import { getRuntimeFeatures } from "@/lib/runtimeConfig";
import { invalidarNumerosAcessiveis } from "@/hooks/useAccessiblePhoneNumbers";

interface QRSession {
    id: string;
    phone_number_id: string;
    display_name: string;
    phone_number: string;
    connection_status: string;
    qr_code: string | null;
    last_connected_at: string | null;
    theme_hue: number | null;
    disconnect_alert_enabled: boolean;
    disconnect_alert_threshold_minutes: number;
    disconnect_alert_emails: string[];
    disconnect_alert_cooldown_minutes: number;
    append_agent_name: boolean;
    keep_device_notifications: boolean;
    send_read_receipts: boolean;
    sector_isolation_enabled: boolean;
    sector_follows_owner: boolean;
    voice_calls_enabled: boolean;
    /** Provider da sessão QR. Voz só existe na zapo (baileys responde 501). */
    qr_provider: string | null;
}

type ConnectionStatus =
    | "disconnected"
    | "connecting"
    | "qr_ready"
    | "connected"
    // QR/código passou dos 120s sem ser escaneado — overlay pede regeneração
    | "expired"
    // SSE caiu no meio do fluxo — mostra retry em vez de sumir com a tela
    | "error";

const QRCodeConnect = () => {
    const { toast } = useToast();
    const { currentOrganization } = useOrganization();
    const queryClient = useQueryClient();
    // Nome, cor e isolamento dos números também vivem num mapa (React Query)
    // que o Dashboard lê: criar, recolorir ou remover aqui o deixa velho. O switch
    // de isolamento por setor invalida sozinho.
    const invalidateAccessibleNumbers = () => invalidarNumerosAcessiveis(queryClient);
    const isMobile = useIsMobile();
    // Sem e-mail configurado na instalação (SMTP/Resend) o alerta por e-mail não tem como sair.
    const emailDisponivel = getRuntimeFeatures().email;

    const [sessions, setSessions] = useState<QRSession[]>([]);
    const [displayName, setDisplayName] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [connectingId, setConnectingId] = useState<string | null>(null);
    const [qrCode, setQrCode] = useState<string | null>(null);
    const [connectMode, setConnectMode] = useState<"qr" | "code">("qr");
    const [pairingPhone, setPairingPhone] = useState("");
    const [pairingPhoneError, setPairingPhoneError] = useState<string | null>(null);
    const [displayNameError, setDisplayNameError] = useState<string | null>(null);
    // Erro de validação do campo de e-mail de alerta, por sessão expandida
    const [alertEmailError, setAlertEmailError] = useState<Record<string, string | null>>({});
    const [pairingCode, setPairingCode] = useState<string | null>(null);
    // Modo da conexão em andamento (independente das tabs do formulário de criação)
    const [activeConnectMode, setActiveConnectMode] = useState<"qr" | "code">("qr");
    // Dígitos usados na conexão ativa — "Gerar novo código" reutiliza em reconexões
    const activePairingPhoneRef = useRef<string | null>(null);
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");

    // Artefatos da conexão em andamento. Sem eles, cada "Regenerar QR" vazava o
    // SSE e o polling anteriores, e desmontar o painel deixava tudo rodando.
    const eventSourceRef = useRef<EventSource | null>(null);
    const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const expireTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Token de geração: cada handleConnect invalida o anterior. Sem ele, dois
    // cliques com <100ms de intervalo (os awaits abaixo) deixavam SSE/polling
    // órfãos fora dos refs — um intervalo órfão repetia toast+fetch a cada 2s
    // para sempre, inclusive depois de desmontar o painel.
    const connectAttemptRef = useRef(0);

    // Identidade desta instância, para o nome do canal de realtime não colidir
    // com o de outra montagem do mesmo componente.
    const instanceIdRef = useRef(crypto.randomUUID());

    const cleanupConnectionArtifacts = useCallback(() => {
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
        }
        if (expireTimeoutRef.current) {
            clearTimeout(expireTimeoutRef.current);
            expireTimeoutRef.current = null;
        }
    }, []);

    useEffect(() => cleanupConnectionArtifacts, [cleanupConnectionArtifacts]);

    const [liveStatuses, setLiveStatuses] = useState<Record<string, string>>({});
    const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
    const [profileSessionId, setProfileSessionId] = useState<string | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; phoneNumberId: string; name: string; phone: string } | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [editingAlerts, setEditingAlerts] = useState<Record<string, {
        enabled: boolean;
        threshold: number;
        emails: string[];
        cooldown: number;
        newEmail: string;
    }>>({});

    // Fetch existing QR sessions
    const fetchSessions = useCallback(async () => {
        if (!currentOrganization) return;

        const query = supabase
            .from("phone_numbers")
            .select(`
        id,
        display_name,
        phone_number,
        theme_hue,
        connection_type,
        disconnect_alert_enabled,
        disconnect_alert_threshold_minutes,
        disconnect_alert_emails,
        disconnect_alert_cooldown_minutes,
        append_agent_name,
        keep_device_notifications,
        send_read_receipts,
        sector_isolation_enabled,
        sector_follows_owner,
        voice_calls_enabled,
        qr_provider,
        phone_number_sessions (
          id,
          connection_status,
          qr_code,
          last_connected_at
        )
      `)
            .eq("organization_id", currentOrganization.id)
            .eq("connection_type", "qr");

        const { data, error } = await query;

        if (error) {
            console.error("Error fetching sessions:", error);
            return;
        }

        console.log("[fetchSessions] Raw data from Supabase:", data);

        // Transform data to flat session format
        const sessionList: QRSession[] = (data || []).map((phone: any) => {
            const session = Array.isArray(phone.phone_number_sessions)
                ? phone.phone_number_sessions[0]
                : phone.phone_number_sessions;

            return {
                id: phone.id,
                phone_number_id: phone.id,
                display_name: phone.display_name,
                phone_number: phone.phone_number,
                theme_hue: phone.theme_hue,
                connection_status: session?.connection_status || "disconnected",
                qr_code: session?.qr_code || null,
                last_connected_at: session?.last_connected_at || null,
                disconnect_alert_enabled: phone.disconnect_alert_enabled || false,
                disconnect_alert_threshold_minutes: phone.disconnect_alert_threshold_minutes || 1,
                disconnect_alert_emails: phone.disconnect_alert_emails || [],
                disconnect_alert_cooldown_minutes: phone.disconnect_alert_cooldown_minutes || 15,
                append_agent_name: phone.append_agent_name || false,
                // Default true = notificações no celular preservadas (comportamento
                // anterior ao toggle). ?? em vez de ||: false é valor legítimo aqui.
                keep_device_notifications: phone.keep_device_notifications ?? true,
                send_read_receipts: phone.send_read_receipts ?? false,
                sector_isolation_enabled: phone.sector_isolation_enabled ?? false,
                sector_follows_owner: phone.sector_follows_owner ?? false,
                voice_calls_enabled: phone.voice_calls_enabled ?? false,
                qr_provider: phone.qr_provider ?? null,
            };
        });

        setSessions(sessionList);

        // Initial live check for all sessions
        sessionList.forEach(session => checkLiveStatus(session.id));
    }, [currentOrganization]);

    const checkLiveStatus = async (sessionId: string) => {
        try {
            const response = await qrFetch(`/session/status/${sessionId}`);
            if (response.ok) {
                const data = await response.json();
                setLiveStatuses(prev => ({
                    ...prev,
                    [sessionId]: data.status === 'connected' ? 'connected' : 'disconnected'
                }));
            }
        } catch (error) {
            console.error(`Error checking live status for ${sessionId}:`, error);
        }
    };

    // Poll for live status
    useEffect(() => {
        if (sessions.length === 0) return;

        const interval = setInterval(() => {
            sessions.forEach(session => checkLiveStatus(session.id));
        }, 30000); // Check every 30s

        return () => clearInterval(interval);
    }, [sessions]);

    useEffect(() => {
        fetchSessions();
    }, [fetchSessions]);

    // Create a new QR phone number entry
    const handleCreateQRNumber = async () => {
        if (!displayName.trim()) {
            setDisplayNameError("Informe o nome de exibição");
            return;
        }
        if (!currentOrganization) return;

        // Pairing mode: validate the phone before creating any row
        if (connectMode === "code") {
            const parsed = pairingPhoneSchema.safeParse(pairingPhone);
            if (!parsed.success) {
                setPairingPhoneError(parsed.error.issues[0]?.message ?? "Número inválido");
                return;
            }
            setPairingPhoneError(null);
        }

        setIsCreating(true);

        try {
            // Create phone number entry with QR connection type
            const { data, error } = await supabase
                .from("phone_numbers")
                .insert({
                    display_name: displayName.trim(),
                    phone_number_id: `qr_${Date.now()}`, // Temporary ID until connected
                    phone_number: "Aguardando conexão…",
                    connection_type: "qr",
                    organization_id: currentOrganization.id,
                    is_active: true,
                    theme_hue: 176 // Default color
                })
                .select()
                .single();

            if (error) throw error;

            setDisplayName("");
            fetchSessions();
            invalidateAccessibleNumbers();

            toast({
                title: "Número criado",
                description: connectMode === "code"
                    ? "Agora digite o código no seu celular para conectar"
                    : "Agora escaneie o QR code para conectar",
            });

            // Auto-start connection
            if (data) {
                handleConnect(data.id, connectMode);
            }
        } catch (error: any) {
            toast({
                title: "Não foi possível criar número",
                description: toUserMessage(error),
                variant: "destructive",
            });
        } finally {
            setIsCreating(false);
        }
    };

    // Connect to a phone number (QR scan or pairing code)
    const handleConnect = async (phoneNumberId: string, mode: "qr" | "code" = "qr", phoneOverride?: string) => {
        // Pairing mode: resolve sanitized digits before touching the backend.
        // Reconexões passam phoneOverride (número real do JID); o formulário valida o input.
        let pairingDigits: string | null = null;
        if (mode === "code") {
            const parsed = pairingPhoneSchema.safeParse(phoneOverride ?? pairingPhone);
            if (!parsed.success) {
                setPairingPhoneError(parsed.error.issues[0]?.message ?? "Número inválido");
                return;
            }
            setPairingPhoneError(null);
            pairingDigits = parsed.data;
        }
        activePairingPhoneRef.current = pairingDigits;
        setActiveConnectMode(mode);

        // Regenerar/reconectar: encerra SSE, polling e timer da tentativa anterior
        const attempt = ++connectAttemptRef.current;
        const isStale = () => attempt !== connectAttemptRef.current;
        cleanupConnectionArtifacts();

        setConnectingId(phoneNumberId);
        setConnectionStatus("connecting");
        setQrCode(null);
        setPairingCode(null);

        try {
            // FIRST: Open SSE to register listener BEFORE connect
            const sseUrl = await qrEventSourceUrl(`/session/qr/${phoneNumberId}`);
            if (isStale()) return;
            const eventSource = new EventSource(sseUrl);
            eventSourceRef.current = eventSource;

            eventSource.onmessage = (event) => {
                if (isStale()) {
                    eventSource.close();
                    return;
                }
                const data = JSON.parse(event.data);

                if (data.event === "qr") {
                    setQrCode(data.qrCode);
                    setPairingCode(null);
                    setConnectionStatus("qr_ready");
                } else if (data.event === "pairing_code") {
                    setPairingCode(data.pairingCode);
                    setQrCode(null);
                    setConnectionStatus("qr_ready");
                } else if (data.event === "pairing_error") {
                    toast({
                        title: "Não foi possível gerar o código",
                        description: "Tentando conectar via QR code…",
                        variant: "destructive",
                    });
                } else if (data.event === "connected") {
                    cleanupConnectionArtifacts();
                    setConnectionStatus("connected");
                    setQrCode(null);
                    setPairingCode(null);
                    fetchSessions();
                    checkLiveStatus(phoneNumberId); // Immediate update
                    toast({
                        title: "Número conectado",
                        description: "O WhatsApp já está pronto para enviar e receber mensagens.",
                    });
                } else if (data.event === "disconnected") {
                    cleanupConnectionArtifacts();
                    // O serviço gera UM QR por pedido: quando ele expira sem leitura o
                    // socket é encerrado e chega este evento. Mostra o overlay de
                    // "expirado" (QR morto desfocado atrás) em vez de sumir com a tela.
                    if (data.reason === "qr_expired") {
                        setConnectionStatus("expired");
                        return;
                    }
                    setConnectionStatus("disconnected");
                    setQrCode(null);
                    setPairingCode(null);
                    checkLiveStatus(phoneNumberId); // Immediate update
                }
            };

            eventSource.onerror = () => {
                if (isStale()) {
                    eventSource.close();
                    return;
                }
                // Antes: fechava e voltava pra "disconnected" em silêncio — a tela
                // do QR simplesmente sumia. Agora vira estado de erro com retry.
                cleanupConnectionArtifacts();
                setConnectionStatus((prev) =>
                    prev === "connected" || prev === "disconnected" ? prev : "error"
                );
            };

            // Wait a moment for SSE to establish, then call connect
            await new Promise(resolve => setTimeout(resolve, 100));
            if (isStale()) {
                eventSource.close();
                return;
            }

            // THEN: Start connection on backend
            const response = await qrFetch(`/session/connect`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    phoneNumberId,
                    usePairingCode: mode === "code",
                    phoneNumber: pairingDigits ?? undefined,
                }),
            });

            if (isStale()) {
                eventSource.close();
                return;
            }
            if (!response.ok) {
                eventSource.close();
                // 429 = proteção de pareamento do serviço (teto de QRs/hora ou
                // cooldown após 401/403): a mensagem explica o motivo e o horário.
                const body = await response.json().catch(() => null);
                throw new Error(
                    typeof body?.error === "string" ? body.error : "Failed to start connection"
                );
            }

            // Add status polling as fallback
            const pollInterval = setInterval(async () => {
                // Auto-encerramento por closure: mesmo que este intervalo fique
                // órfão dos refs, ele se mata sozinho ao detectar staleness/fim
                if (isStale()) {
                    clearInterval(pollInterval);
                    return;
                }
                try {
                    const statusRes = await qrFetch(`/session/status/${phoneNumberId}`);
                    const statusData = await statusRes.json();
                    if (isStale()) {
                        clearInterval(pollInterval);
                        return;
                    }

                    if (statusData.status === 'connected') {
                        clearInterval(pollInterval);
                        cleanupConnectionArtifacts();
                        setConnectionStatus("connected");
                        setQrCode(null);
                        setPairingCode(null);
                        fetchSessions();
                        checkLiveStatus(phoneNumberId);
                        toast({
                            title: "Número conectado",
                            description: "O WhatsApp já está pronto para enviar e receber mensagens.",
                        });
                    } else if (statusData.status === 'qr_ready') {
                        setConnectionStatus("qr_ready");
                        try {
                            if (statusData.hasPairingCode) {
                                const codeRes = await qrFetch(`/session/pairing-code/${phoneNumberId}`);
                                if (codeRes.ok) {
                                    const codeData = await codeRes.json();
                                    if (codeData.pairingCode) {
                                        setPairingCode(codeData.pairingCode);
                                        setQrCode(null);
                                    }
                                }
                            } else {
                                const qrRes = await qrFetch(`/session/qr-code/${phoneNumberId}`);
                                if (qrRes.ok) {
                                    const qrData = await qrRes.json();
                                    if (qrData.qrCode) {
                                        setQrCode(qrData.qrCode);
                                        setPairingCode(null);
                                    }
                                }
                            }
                        } catch (qrErr) {
                            console.error('[QRCodeConnect] Failed to fetch fallback QR/pairing code:', qrErr);
                        }
                    }
                } catch (e) {
                    console.error('[QRCodeConnect] Polling error:', e);
                }
            }, 2000);
            pollIntervalRef.current = pollInterval;

            // Baileys deixa de renovar o QR em ~2min: antes o polling só parava em
            // silêncio e o QR morto continuava na tela como se fosse escaneável.
            expireTimeoutRef.current = setTimeout(() => {
                if (isStale()) return;
                cleanupConnectionArtifacts();
                setConnectionStatus((prev) =>
                    prev === "connecting" || prev === "qr_ready" ? "expired" : prev
                );
            }, 120000);

        } catch (error: any) {
            if (isStale()) return;
            cleanupConnectionArtifacts();
            toast({
                title: "Não foi possível conectar",
                description: toUserMessage(error),
                variant: "destructive",
            });
            setConnectionStatus("disconnected");
            setConnectingId(null);
        }
    };

    // Disconnect a session
    const handleDisconnect = async (phoneNumberId: string) => {
        try {
            await qrFetch(`/session/disconnect/${phoneNumberId}`, {
                method: "DELETE",
            });

            // Optimistic update
            setLiveStatuses(prev => ({
                ...prev,
                [phoneNumberId]: 'disconnected'
            }));

            fetchSessions();

            toast({
                title: "Desconectado",
                description: "Sessão encerrada",
            });
        } catch (error: any) {
            toast({
                title: "Não foi possível desconectar",
                description: toUserMessage(error),
                variant: "destructive",
            });
        }
    };

    const handleToggleAppendAgentName = async (id: string, checked: boolean) => {
        setSessions((prev) =>
            prev.map((s) => (s.id === id ? { ...s, append_agent_name: checked } : s))
        );

        const { error } = await (supabase
            .from("phone_numbers")
            .update({ append_agent_name: checked } as any)
            .eq("id", id) as any);

        if (error) {
            toast({
                title: "Não foi possível atualizar configuração",
                description: toUserMessage(error),
                variant: "destructive",
            });
            fetchSessions();
            return;
        }

        toast({
            title: "Configuração atualizada",
            description: `Identificação de agente ${checked ? "ativada" : "desativada"}`,
        });
    };

    // O WhatsApp só manda presença do contato (inclusive "digitando") para quem
    // está online, e só mantém as notificações no aparelho para quem está offline.
    // Não há como ter os dois — daí o toggle.
    const handleToggleReadReceipts = async (id: string, checked: boolean) => {
        setSessions((prev) =>
            prev.map((s) => (s.id === id ? { ...s, send_read_receipts: checked } : s))
        );

        const { error } = await supabase
            .from("phone_numbers")
            .update({ send_read_receipts: checked })
            .eq("id", id);

        if (error) {
            toast({
                title: "Não foi possível atualizar configuração",
                description: toUserMessage(error),
                variant: "destructive",
            });
            fetchSessions();
            return;
        }

        toast({
            title: "Configuração atualizada",
            description: `Confirmação de leitura ${checked ? "ativada" : "desativada"}`,
        });
    };

    const handleToggleVoiceCalls = async (id: string, checked: boolean) => {
        // Trava também no handler: o switch já vem desabilitado fora da zapo, mas
        // estado velho depois de um rollback de provider chegaria aqui e gravaria
        // um `true` que nenhuma tela conseguiria desfazer (o switch está travado).
        if (sessions.find((s) => s.id === id)?.qr_provider !== "zapo") return;
        setSessions((prev) =>
            prev.map((s) => (s.id === id ? { ...s, voice_calls_enabled: checked } : s))
        );

        const { error } = await supabase
            .from("phone_numbers")
            .update({ voice_calls_enabled: checked })
            .eq("id", id);

        if (error) {
            toast({
                title: "Não foi possível atualizar configuração",
                description: toUserMessage(error),
                variant: "destructive",
            });
            fetchSessions();
            return;
        }

        toast({
            title: "Configuração atualizada",
            description: `Ligação de voz ${checked ? "ativada" : "desativada"}`,
        });
    };

    const handleToggleDeviceNotifications = async (id: string, checked: boolean) => {
        setSessions((prev) =>
            prev.map((s) => (s.id === id ? { ...s, keep_device_notifications: checked } : s))
        );

        const { error } = await supabase
            .from("phone_numbers")
            .update({ keep_device_notifications: checked })
            .eq("id", id);

        if (error) {
            toast({
                title: "Não foi possível atualizar configuração",
                description: toUserMessage(error),
                variant: "destructive",
            });
            fetchSessions();
            return;
        }

        // O banco é a fonte de verdade (o próximo connect lê de lá); isto só
        // antecipa o efeito na sessão que já está no ar. Falhar aqui não desfaz
        // o toggle — vale a partir da próxima reconexão.
        try {
            await qrFetch(`/session/presence-mode/${id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ keepDeviceNotifications: checked }),
            });
        } catch {
            // silencioso de propósito: o estado persistido já está correto
        }

        toast({
            title: "Configuração atualizada",
            description: checked
                ? "O celular volta a receber notificações"
                : "O painel passa a ver quando o contato está digitando",
        });
    };

    const handleChangeTheme = async (id: string, hue: number) => {
        const { error } = await supabase
            .from("phone_numbers")
            .update({ theme_hue: hue })
            .eq("id", id);

        if (error) {
            toast({
                title: "Não foi possível atualizar cor",
                description: toUserMessage(error),
                variant: "destructive",
            });
            return;
        }

        fetchSessions();
        invalidateAccessibleNumbers();
    };

    const handleDelete = async (id: string, phoneNumberId: string) => {
        setDeleting(true);
        try {
            try {
                await qrFetch(`/session/disconnect/${phoneNumberId}`, {
                    method: "DELETE",
                });
            } catch (e) {
                console.error("Error disconnecting session before delete:", e);
            }

            const { error } = await supabase
                .from("phone_numbers")
                .delete()
                .eq("id", id);

            if (error) {
                toast({
                    title: "Não foi possível remover número",
                    description: toUserMessage(error),
                    variant: "destructive",
                });
                return;
            }

            fetchSessions();
            invalidateAccessibleNumbers();
            setDeleteConfirm(null);

            toast({
                title: "Número removido",
                description: "O número foi removido",
            });
        } finally {
            setDeleting(false);
        }
    };

    const handleAddAlertEmail = (sessionId: string) => {
        const current = editingAlerts[sessionId];
        if (!current) return;

        const email = current.newEmail.trim().toLowerCase();
        if (!email) return;

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            setAlertEmailError(prev => ({ ...prev, [sessionId]: "E-mail inválido. Use o formato nome@exemplo.com" }));
            return;
        }

        if (current.emails.includes(email)) {
            setAlertEmailError(prev => ({ ...prev, [sessionId]: "Este e-mail já está na lista" }));
            return;
        }

        setAlertEmailError(prev => ({ ...prev, [sessionId]: null }));
        setEditingAlerts(prev => ({
            ...prev,
            [sessionId]: {
                ...prev[sessionId],
                emails: [...prev[sessionId].emails, email],
                newEmail: ''
            }
        }));
    };

    const handleRemoveAlertEmail = (sessionId: string, emailToRemove: string) => {
        setEditingAlerts(prev => ({
            ...prev,
            [sessionId]: {
                ...prev[sessionId],
                emails: prev[sessionId].emails.filter(e => e !== emailToRemove)
            }
        }));
    };

    const handleSaveAlerts = async (id: string) => {
        const alertConfig = editingAlerts[id];
        if (!alertConfig) return;

        if (alertConfig.enabled && alertConfig.emails.length === 0) {
            setAlertEmailError(prev => ({ ...prev, [id]: "Adicione pelo menos um e-mail para ativar os alertas" }));
            return;
        }

        const { error } = await supabase
            .from("phone_numbers")
            .update({
                disconnect_alert_enabled: alertConfig.enabled,
                disconnect_alert_threshold_minutes: alertConfig.threshold,
                disconnect_alert_emails: alertConfig.emails,
                disconnect_alert_cooldown_minutes: alertConfig.cooldown
            } as any)
            .eq("id", id);

        if (error) {
            toast({
                title: "Não foi possível salvar alertas",
                description: toUserMessage(error),
                variant: "destructive",
            });
            return;
        }

        setExpandedSessionId(null);
        fetchSessions();

        toast({
            title: "Alertas salvos",
            description: alertConfig.enabled ? "Você será avisado por e-mail quando a linha cair." : "Alertas de desconexão desativados.",
        });
    };

    const getStatusBadge = (session: QRSession) => {
        // Use live status if available, otherwise DB status
        const status = liveStatuses[session.id] === 'connected' ? 'connected' : session.connection_status;

        // If specifically checking this session in create/connect flow, use local state
        if (connectingId === session.id && connectionStatus !== 'disconnected') {
            if (connectionStatus === 'connecting') return (
                <span className="flex items-center gap-1 text-xs text-info bg-info/10 px-2 py-1 rounded-full">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Conectando…
                </span>
            );
            if (connectionStatus === 'qr_ready') return (
                <span className="flex items-center gap-1 text-xs text-warning bg-warning/10 px-2 py-1 rounded-full">
                    <QrCode className="w-3 h-3" />
                    Aguardando scan
                </span>
            );
        }

        switch (status) {
            case "connected":
                return (
                    <span className="flex items-center gap-1 text-xs text-success bg-success/10 px-2 py-1 rounded-full">
                        <Wifi className="w-3 h-3" />
                        Conectado
                    </span>
                );
            case "qr_ready":
                return (
                    <span className="flex items-center gap-1 text-xs text-warning bg-warning/10 px-2 py-1 rounded-full">
                        <QrCode className="w-3 h-3" />
                        Aguardando scan
                    </span>
                );
            case "connecting":
                return (
                    <span className="flex items-center gap-1 text-xs text-info bg-info/10 px-2 py-1 rounded-full">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Conectando…
                    </span>
                );
            default:
                return (
                    <span className="flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded-full">
                        <WifiOff className="w-3 h-3" />
                        Desconectado
                    </span>
                );
        }
    };

    // Chave estável das linhas desta tela. `sessions` é recriado a cada update
    // de realtime, mas o CONJUNTO de ids não muda — então a inscrição não
    // remonta a cada evento.
    const sessionIdsKey = sessions.map(s => s.id).sort().join(',');

    // Verify live status via Realtime
    useEffect(() => {
        if (!currentOrganization) return;

        const sessionIds = sessionIdsKey ? sessionIdsKey.split(',') : [];
        if (sessionIds.length === 0) return;

        // Filtro no servidor: sem ele, toda atualização de sessão da instância
        // chegava a esta aba e o walrus avaliava a RLS de cada uma, só para o
        // handler descartar as que não são desta tela.
        const useFilter = sessionIds.length <= 50;
        if (!useFilter) {
            console.warn(`[QRCodeConnect] ${sessionIds.length} linhas: assinando sem filtro server-side`);
        }

        const channel = supabase
            // Nome único por instância: 'qr-status-changes' fixo colidia com
            // outra montagem do componente, e o removeChannel de uma derrubava
            // o canal da outra.
            .channel(`qr-status-${instanceIdRef.current}`)
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'phone_number_sessions',
                    ...(useFilter ? { filter: `phone_number_id=in.(${sessionIds.join(',')})` } : {}),
                },
                (payload) => {
                    const updatedSession = payload.new;
                    console.log('[Realtime] Session update received:', updatedSession);

                    setSessions(prevSessions => prevSessions.map(session => {
                        // Match by phone_number_id which corresponds to session.id in our state
                        if (session.id === updatedSession.phone_number_id) {

                            // Check for disconnection to notify user
                            if (updatedSession.connection_status === 'disconnected' && session.connection_status !== 'disconnected') {
                                toast({
                                    title: "WhatsApp Desconectado",
                                    description: `A conexão com ${session.display_name} foi perdida.`,
                                    variant: "destructive"
                                });
                                // Clear live status cache for this ID
                                setLiveStatuses(prev => {
                                    const next = { ...prev };
                                    delete next[session.id];
                                    return next;
                                });
                            } else if (updatedSession.connection_status === 'connected' && session.connection_status !== 'connected') {
                                toast({
                                    title: "WhatsApp Conectado",
                                    description: `O número ${session.display_name} foi conectado.`,
                                });
                                setLiveStatuses(prev => ({
                                    ...prev,
                                    [session.id]: 'connected'
                                }));
                            }

                            return {
                                ...session,
                                connection_status: updatedSession.connection_status,
                                qr_code: updatedSession.qr_code,
                                last_connected_at: updatedSession.last_connected_at,
                            };
                        }
                        return session;
                    }));
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [currentOrganization, toast, sessionIdsKey]);

    return (
        <div className="space-y-6">
            {/* Create new QR number section */}
            <div className="p-4 border rounded-lg bg-muted/50 space-y-4">
                <div className="flex items-center gap-2">
                    <QrCode className="w-5 h-5 text-primary" />
                    <h4 className="font-medium">Conectar WhatsApp</h4>
                </div>
                <p className="text-sm text-muted-foreground">
                    {connectMode === "qr"
                        ? "Conecte seu WhatsApp pessoal escaneando o QR code (como WhatsApp Web)."
                        : "Conecte seu WhatsApp pessoal digitando um código de 8 dígitos no celular — sem precisar escanear."}
                </p>

                <Tabs
                    value={connectMode}
                    onValueChange={(value) => {
                        setConnectMode(value as "qr" | "code");
                        setPairingPhoneError(null);
                    }}
                >
                    <TabsList className="grid w-full max-w-xs grid-cols-2">
                        <TabsTrigger value="qr">
                            <QrCode className="w-4 h-4 mr-2" />
                            QR Code
                        </TabsTrigger>
                        <TabsTrigger value="code">
                            <KeyRound className="w-4 h-4 mr-2" />
                            Código
                        </TabsTrigger>
                    </TabsList>
                </Tabs>

                <div className="flex flex-col gap-2">
                    <div className="flex flex-col sm:flex-row gap-2">
                        <div className="flex-1 space-y-1">
                            <Label htmlFor="qr-display-name" className="text-xs font-medium">Nome de exibição</Label>
                            <Input
                                id="qr-display-name"
                                placeholder="Ex.: Comercial SP"
                                value={displayName}
                                aria-invalid={displayNameError ? true : undefined}
                                aria-describedby={displayNameError ? "qr-display-name-error" : undefined}
                                onChange={(e) => {
                                    setDisplayName(e.target.value);
                                    setDisplayNameError(null);
                                }}
                                className={cn("h-11 sm:h-9", displayNameError && "border-destructive")}
                            />
                            {displayNameError && (
                                <p id="qr-display-name-error" role="alert" className="text-xs text-destructive">{displayNameError}</p>
                            )}
                        </div>
                        {connectMode === "code" && (
                            <div className="flex-1 space-y-1 sm:pt-6">
                                <Input
                                    type="tel"
                                    inputMode="tel"
                                    placeholder="+55 11 91234-5678"
                                    value={pairingPhone}
                                    onChange={(e) => {
                                        setPairingPhone(e.target.value);
                                        setPairingPhoneError(null);
                                    }}
                                    className={cn("h-11 sm:h-9", pairingPhoneError && "border-destructive")}
                                />
                            </div>
                        )}
                        <Button
                            onClick={handleCreateQRNumber}
                            disabled={isCreating}
                            className="h-11 sm:h-9 sm:mt-6 touch-manipulation"
                        >
                            {isCreating ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : connectMode === "qr" ? (
                                <>
                                    <QrCode className="w-4 h-4 mr-2" />
                                    <span className="hidden sm:inline">Gerar QR</span>
                                    <span className="sm:hidden">Novo</span>
                                </>
                            ) : (
                                <>
                                    <KeyRound className="w-4 h-4 mr-2" />
                                    <span className="hidden sm:inline">Gerar código</span>
                                    <span className="sm:hidden">Novo</span>
                                </>
                            )}
                        </Button>
                    </div>
                    {connectMode === "code" && (
                        pairingPhoneError ? (
                            <p role="alert" className="text-xs text-destructive">{pairingPhoneError}</p>
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                Digite o número do WhatsApp que será conectado, com código do país (DDI) e DDD.
                            </p>
                        )
                    )}
                </div>
            </div>

            {/* QR Code / pairing code display */}
            {connectingId &&
                (connectionStatus === "connecting" ||
                    connectionStatus === "qr_ready" ||
                    connectionStatus === "expired" ||
                    connectionStatus === "error") && (
                <div className="relative p-4 sm:p-6 border rounded-lg flex flex-col items-center gap-4">
                    {connectionStatus === "error" && (
                        <div className="flex flex-col items-center gap-3 py-8 text-center">
                            <AlertCircle className="w-10 h-10 sm:w-8 sm:h-8 text-destructive" />
                            <div className="space-y-1">
                                <p className="text-base sm:text-sm font-medium text-foreground">
                                    Conexão com o servidor perdida
                                </p>
                                <p className="text-sm sm:text-xs text-muted-foreground">
                                    Não foi possível acompanhar o pareamento. Tente novamente.
                                </p>
                            </div>
                            <Button
                                variant="outline"
                                className="h-11 sm:h-9 touch-manipulation"
                                onClick={() =>
                                    handleConnect(
                                        connectingId,
                                        activeConnectMode,
                                        activePairingPhoneRef.current ?? undefined
                                    )
                                }
                            >
                                <RefreshCw className="w-4 h-4 mr-2" />
                                Tentar novamente
                            </Button>
                        </div>
                    )}

                    {connectionStatus === "expired" && (
                        // Sobrepõe o QR/código morto (fica desfocado atrás) — sem isso
                        // o usuário escaneava um QR que o backend já abandonou
                        <div className="absolute inset-0 z-10 rounded-lg bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3 p-6 text-center animate-in fade-in-0 duration-200">
                            <TimerOff className="w-8 h-8 text-muted-foreground" />
                            <div className="space-y-1">
                                <p className="text-base sm:text-sm font-medium text-foreground">
                                    {activeConnectMode === "code" ? "Código expirado" : "QR Code expirado"}
                                </p>
                                <p className="text-sm sm:text-xs text-muted-foreground">
                                    Gere um novo para continuar a conexão.
                                </p>
                            </div>
                            <Button
                                className="h-11 sm:h-9 touch-manipulation"
                                onClick={() =>
                                    handleConnect(
                                        connectingId,
                                        activeConnectMode,
                                        activePairingPhoneRef.current ?? undefined
                                    )
                                }
                            >
                                <RefreshCw className="w-4 h-4 mr-2" />
                                {activeConnectMode === "code" ? "Gerar novo código" : "Gerar novo QR"}
                            </Button>
                        </div>
                    )}

                    {(connectionStatus === "connecting" || connectionStatus === "expired") &&
                        !qrCode &&
                        !pairingCode && (
                        <div className="flex flex-col items-center gap-3 py-8">
                            <Loader2 className="w-10 h-10 sm:w-8 sm:h-8 animate-spin text-primary" />
                            <p className="text-base sm:text-sm text-muted-foreground">
                                {activeConnectMode === "code" ? "Gerando código…" : "Gerando QR Code…"}
                            </p>
                        </div>
                    )}

                    {connectionStatus !== "error" && pairingCode && (
                        <>
                            <div className="flex items-center gap-3">
                                <p className="font-mono text-3xl sm:text-4xl font-semibold tracking-[0.3em] text-foreground select-all">
                                    {formatPairingCode(pairingCode)}
                                </p>
                                <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-10 w-10 touch-manipulation"
                                    onClick={() => {
                                        navigator.clipboard.writeText(pairingCode);
                                        toast({ title: "Código copiado" });
                                    }}
                                >
                                    <Copy className="w-4 h-4" />
                                </Button>
                            </div>
                            <div className="text-center space-y-2">
                                <p className="text-sm sm:text-xs font-medium text-foreground">
                                    Digite este código no celular que será conectado
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    WhatsApp → <strong>Aparelhos conectados</strong> → <strong>Conectar um aparelho</strong> → <strong>Conectar com número de telefone</strong>
                                </p>
                            </div>
                            <Button
                                variant="outline"
                                size="default"
                                className="h-11 sm:h-9 touch-manipulation"
                                onClick={() => handleConnect(connectingId, "code", activePairingPhoneRef.current ?? undefined)}
                            >
                                <RefreshCw className="w-4 h-4 mr-2" />
                                Gerar novo código
                            </Button>
                        </>
                    )}

                    {connectionStatus !== "error" && qrCode && (
                        <>
                            <img
                                src={qrCode}
                                alt="WhatsApp QR Code"
                                className="w-full max-w-[280px] sm:w-64 aspect-square rounded-lg border"
                            />
                            <div className="text-center space-y-2">
                                <p className="text-sm sm:text-xs font-medium text-foreground">
                                    {isMobile ? "Escaneie com outro celular" : "Escaneie com seu celular"}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    WhatsApp → <strong>Aparelhos conectados</strong> → <strong>Conectar</strong>
                                </p>
                            </div>
                            <Button
                                variant="outline"
                                size="default"
                                className="h-11 sm:h-9 touch-manipulation"
                                onClick={() => handleConnect(connectingId)}
                            >
                                <RefreshCw className="w-4 h-4 mr-2" />
                                Regenerar QR
                            </Button>
                        </>
                    )}
                </div>
            )}

            {/* Connected sessions list */}
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium">Números conectados via QR</h4>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            fetchSessions();
                            toast({ title: "Atualizando status…" });
                        }}
                        className="text-xs text-muted-foreground hover:text-primary"
                    >
                        <RefreshCw className="w-3 h-3 mr-1" />
                        Atualizar Status
                    </Button>
                </div>

                {sessions.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                        Nenhum número conectado via QR Code
                    </p>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        {sessions.map((session: any, index: number) => {
                            const isExpanded = expandedSessionId === session.id;
                            const isDisconnected = session.connection_status === 'disconnected';
                            const toggleConfig = () => {
                                if (isExpanded) {
                                    setExpandedSessionId(null);
                                } else {
                                    setExpandedSessionId(session.id);
                                    setEditingAlerts(prev => ({
                                        ...prev,
                                        [session.id]: {
                                            enabled: session.disconnect_alert_enabled || false,
                                            threshold: session.disconnect_alert_threshold_minutes || 1,
                                            emails: session.disconnect_alert_emails || [],
                                            cooldown: session.disconnect_alert_cooldown_minutes || 15,
                                            newEmail: ''
                                        }
                                    }));
                                }
                            };
                            return (
                                <div
                                    key={session.id}
                                    className={cn(
                                        "border rounded-lg p-4 flex flex-col gap-3 bg-card",
                                        "transition-[box-shadow,border-color,background-color] duration-200 ease-out",
                                        "animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-backwards",
                                        isDisconnected && "border-destructive/30 bg-destructive/5",
                                        isExpanded && "col-span-full ring-1 ring-primary/30",
                                    )}
                                    style={{ animationDelay: `${Math.min(index, 8) * 40}ms`, animationDuration: "260ms" }}
                                >
                                    {/* Header + body: clique em qualquer lugar abre as configurações */}
                                    <div
                                        role="button"
                                        tabIndex={0}
                                        aria-expanded={isExpanded}
                                        onClick={toggleConfig}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" || e.key === " ") {
                                                e.preventDefault();
                                                toggleConfig();
                                            }
                                        }}
                                        className="flex flex-col gap-3 cursor-pointer rounded-md -m-1 p-1 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        {/* Header: color picker + name + copy id + alert badge */}
                                        <div className="flex items-start gap-3">
                                            <span onClick={(e) => e.stopPropagation()} className="shrink-0">
                                                <HuePickerPopover
                                                    value={session.theme_hue ?? 176}
                                                    onChange={(hue) => handleChangeTheme(session.id, hue)}
                                                />
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-1.5">
                                                    <p className="font-medium text-sm truncate min-w-0" title={session.display_name}>{session.display_name}</p>
                                                    <span onClick={(e) => e.stopPropagation()} className="shrink-0 inline-flex">
                                                        <IdCopyButton id={session.id} label="Phone ID" className="h-4 w-4" />
                                                    </span>
                                                    {session.disconnect_alert_enabled && (
                                                        <span className="text-2xs bg-orange-500/10 text-orange-600 px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0 whitespace-nowrap">
                                                            <Bell className="w-3 h-3" />
                                                            Alerta
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        {/* Body: phone number + status */}
                                        <div className="text-xs text-muted-foreground space-y-2 min-w-0">
                                            <p className="truncate" title={session.phone_number ?? undefined}>{session.phone_number}</p>
                                            <div>{getStatusBadge(session)}</div>
                                        </div>
                                    </div>

                                    {/* Footer actions */}
                                    <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t mt-auto">
                                        {session.connection_status === "connected" ? (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-9 touch-manipulation transition-transform duration-150 ease-out active:scale-[0.96]"
                                                onClick={() => handleDisconnect(session.id)}
                                            >
                                                Desconectar
                                            </Button>
                                        ) : (() => {
                                            // Número real (do JID) permite reconectar por código sem pedir telefone
                                            const parsedPhone = pairingPhoneSchema.safeParse(session.phone_number);
                                            return (
                                                <div className="flex items-center gap-1 shrink-0">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="h-9 touch-manipulation transition-transform duration-150 ease-out active:scale-[0.96]"
                                                        onClick={() => handleConnect(session.id)}
                                                    >
                                                        <QrCode className="w-4 h-4 mr-1.5" />
                                                        QR
                                                    </Button>
                                                    {parsedPhone.success && (
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            className="h-9 touch-manipulation transition-transform duration-150 ease-out active:scale-[0.96]"
                                                            onClick={() => handleConnect(session.id, "code", parsedPhone.data)}
                                                        >
                                                            <KeyRound className="w-4 h-4 mr-1.5" />
                                                            Código
                                                        </Button>
                                                    )}
                                                </div>
                                            );
                                        })()}
                                        <div className="flex items-center gap-1 shrink-0">
                                            {session.connection_status === "connected" && (
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    className="h-9 w-9 touch-manipulation transition-transform duration-150 ease-out active:scale-[0.96]"
                                                    title="Perfil do WhatsApp"
                                                    aria-label="Perfil do WhatsApp"
                                                    onClick={() => setProfileSessionId(session.id)}
                                                >
                                                    <UserCog className="w-4 h-4" />
                                                </Button>
                                            )}
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-9 w-9 touch-manipulation transition-transform duration-150 ease-out active:scale-[0.96]"
                                                aria-label={isExpanded ? "Fechar configurações" : "Abrir configurações"}
                                                onClick={toggleConfig}
                                            >
                                                {isExpanded ? (
                                                    <ChevronUp className="w-4 h-4" />
                                                ) : (
                                                    <ChevronDown className="w-4 h-4" />
                                                )}
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-9 w-9 text-destructive touch-manipulation transition-transform duration-150 ease-out active:scale-[0.96]"
                                                aria-label="Remover sessão"
                                                onClick={() => setDeleteConfirm({
                                                    id: session.id,
                                                    phoneNumberId: session.phone_number_id,
                                                    name: session.display_name,
                                                    phone: session.phone_number,
                                                })}
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    </div>

                                    {/* Alert configuration panel — grid-rows trick for smooth expand */}
                                    <div
                                        className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
                                        style={{
                                            gridTemplateRows: isExpanded ? "1fr" : "0fr",
                                            opacity: isExpanded ? 1 : 0,
                                        }}
                                        aria-hidden={!isExpanded}
                                    >
                                        <div className="overflow-hidden min-h-0">
                                            <div className="pt-3 border-t space-y-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="space-y-0.5">
                                            <Label htmlFor={`append-agent-${session.id}`} className="text-sm font-medium">
                                                Identificar agente
                                            </Label>
                                            <p className="text-xs text-muted-foreground">
                                                Adiciona o nome do agente no topo de cada mensagem enviada (ex: *Nome*: mensagem).
                                            </p>
                                        </div>
                                        <Switch
                                            id={`append-agent-${session.id}`}
                                            checked={session.append_agent_name}
                                            onCheckedChange={(checked) =>
                                                handleToggleAppendAgentName(session.id, checked)
                                            }
                                            tabIndex={isExpanded ? 0 : -1}
                                        />
                                    </div>

                                    <div className="flex items-start justify-between gap-3">
                                        <div className="space-y-0.5">
                                            <Label htmlFor={`device-notifications-${session.id}`} className="text-sm font-medium">
                                                Notificações no celular
                                            </Label>
                                            <p className="text-xs text-muted-foreground">
                                                Ligado: o celular continua notificando as mensagens novas. Desligado: o celular para de notificar, mas o painel passa a ver quando o contato está digitando.
                                            </p>
                                        </div>
                                        <Switch
                                            id={`device-notifications-${session.id}`}
                                            checked={session.keep_device_notifications}
                                            onCheckedChange={(checked) =>
                                                handleToggleDeviceNotifications(session.id, checked)
                                            }
                                            tabIndex={isExpanded ? 0 : -1}
                                        />
                                    </div>

                                    <div className="flex items-start justify-between gap-3">
                                        <div className="space-y-0.5">
                                            <Label htmlFor={`read-receipts-${session.id}`} className="text-sm font-medium">
                                                Confirmação de leitura
                                            </Label>
                                            <p className="text-xs text-muted-foreground">
                                                Abrir a conversa no painel envia o tique azul ao contato. Desligado, a leitura fica invisível para ele.
                                            </p>
                                        </div>
                                        <Switch
                                            id={`read-receipts-${session.id}`}
                                            checked={session.send_read_receipts}
                                            onCheckedChange={(checked) =>
                                                handleToggleReadReceipts(session.id, checked)
                                            }
                                            tabIndex={isExpanded ? 0 : -1}
                                        />
                                    </div>

                                    {/* Voz só existe na zapo: na baileys o serviço responde 501
                                        unsupported_by_provider. O switch fica visível e travado,
                                        com o motivo — esconder deixaria a pergunta "cadê?" sem
                                        resposta para quem administra a linha. */}
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="space-y-0.5">
                                            <Label
                                                htmlFor={`voice-calls-${session.id}`}
                                                className={cn(
                                                    "text-sm font-medium",
                                                    session.qr_provider !== "zapo" && "text-muted-foreground",
                                                )}
                                            >
                                                Ligação de voz
                                            </Label>
                                            <p className="text-xs text-muted-foreground">
                                                {session.qr_provider !== "zapo"
                                                    ? "Indisponível nesta linha: ligação de voz existe só em linhas migradas para a zapo."
                                                    : "Permite ligar e receber ligação por esta linha. Desligado por padrão: ligação gera tráfego na sessão. Só funciona onde o serviço tem o plugin de voz."}
                                            </p>
                                        </div>
                                        <Switch
                                            id={`voice-calls-${session.id}`}
                                            checked={session.voice_calls_enabled}
                                            disabled={session.qr_provider !== "zapo"}
                                            onCheckedChange={(checked) =>
                                                handleToggleVoiceCalls(session.id, checked)
                                            }
                                            tabIndex={isExpanded && session.qr_provider === "zapo" ? 0 : -1}
                                        />
                                    </div>

                                    <SectorIsolationSwitch
                                        phoneNumberId={session.id}
                                        enabled={session.sector_isolation_enabled}
                                        followsOwner={session.sector_follows_owner}
                                        onOptimisticChange={(patch) =>
                                            setSessions((prev) =>
                                                prev.map((s) => (s.id === session.id ? { ...s, ...patch } : s))
                                            )
                                        }
                                        onFailure={fetchSessions}
                                        tabIndex={isExpanded ? 0 : -1}
                                    />

                                    <div className="flex items-center justify-between pt-3 border-t">
                                        <label className="flex items-center gap-2 text-sm font-medium">
                                            <Bell className="w-4 h-4" />
                                            Alertas de desconexão
                                        </label>
                                        <Switch
                                            checked={editingAlerts[session.id]?.enabled || false}
                                            disabled={!emailDisponivel}
                                            onCheckedChange={(checked) => setEditingAlerts(prev => ({
                                                ...prev,
                                                [session.id]: { ...prev[session.id], enabled: checked }
                                            }))}
                                        />
                                    </div>
                                    <p className="text-xs text-muted-foreground text-pretty">
                                        {emailDisponivel
                                            ? "Receba um e-mail quando este número ficar desconectado."
                                            : "Configure o e-mail (SMTP) da instalação para receber alertas por e-mail."}
                                    </p>

                                    {emailDisponivel && editingAlerts[session.id]?.enabled && (
                                        <div className="space-y-3 pl-1">
                                            <div className="grid grid-cols-2 gap-3">
                                                <div className="space-y-1">
                                                    <label className="text-xs font-medium">Avisar após</label>
                                                    <Select
                                                        value={String(editingAlerts[session.id]?.threshold || 1)}
                                                        onValueChange={(value) => setEditingAlerts(prev => ({
                                                            ...prev,
                                                            [session.id]: { ...prev[session.id], threshold: parseInt(value) }
                                                        }))}
                                                    >
                                                        <SelectTrigger className="h-8">
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="1">1 minuto</SelectItem>
                                                            <SelectItem value="2">2 minutos</SelectItem>
                                                            <SelectItem value="5">5 minutos</SelectItem>
                                                            <SelectItem value="10">10 minutos</SelectItem>
                                                            <SelectItem value="15">15 minutos</SelectItem>
                                                            <SelectItem value="30">30 minutos</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                                <div className="space-y-1">
                                                    <label className="text-xs font-medium">Intervalo entre alertas</label>
                                                    <Select
                                                        value={String(editingAlerts[session.id]?.cooldown || 15)}
                                                        onValueChange={(value) => setEditingAlerts(prev => ({
                                                            ...prev,
                                                            [session.id]: { ...prev[session.id], cooldown: parseInt(value) }
                                                        }))}
                                                    >
                                                        <SelectTrigger className="h-8">
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="5">5 minutos</SelectItem>
                                                            <SelectItem value="15">15 minutos</SelectItem>
                                                            <SelectItem value="30">30 minutos</SelectItem>
                                                            <SelectItem value="60">1 hora</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                            </div>

                                            <div className="space-y-2">
                                                <label className="text-xs font-medium flex items-center gap-1">
                                                    <Mail className="w-3 h-3" />
                                                    E-mails destinatários
                                                </label>
                                                <div className="flex gap-2">
                                                    <Input
                                                        type="email"
                                                        inputMode="email"
                                                        placeholder="nome@exemplo.com"
                                                        aria-label="E-mail destinatário"
                                                        aria-invalid={alertEmailError[session.id] ? true : undefined}
                                                        className={cn("h-8 text-sm", alertEmailError[session.id] && "border-destructive")}
                                                        value={editingAlerts[session.id]?.newEmail || ''}
                                                        onChange={(e) => {
                                                            setAlertEmailError(prev => ({ ...prev, [session.id]: null }));
                                                            setEditingAlerts(prev => ({
                                                                ...prev,
                                                                [session.id]: { ...prev[session.id], newEmail: e.target.value }
                                                            }));
                                                        }}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') {
                                                                e.preventDefault();
                                                                handleAddAlertEmail(session.id);
                                                            }
                                                        }}
                                                    />
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        className="h-8 px-2"
                                                        aria-label="Adicionar e-mail"
                                                        onClick={() => handleAddAlertEmail(session.id)}
                                                    >
                                                        <Plus className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                                {alertEmailError[session.id] && (
                                                    <p role="alert" className="text-xs text-destructive">{alertEmailError[session.id]}</p>
                                                )}
                                                {(editingAlerts[session.id]?.emails?.length || 0) > 0 && (
                                                    <div className="flex flex-wrap gap-1">
                                                        {editingAlerts[session.id]?.emails.map((email) => (
                                                            <Badge key={email} variant="secondary" className="text-xs flex items-center gap-1">
                                                                {email}
                                                                <button
                                                                    type="button"
                                                                    aria-label={`Remover ${email}`}
                                                                    onClick={() => handleRemoveAlertEmail(session.id, email)}
                                                                    className="ml-1 rounded-full hover:text-destructive active:scale-[0.96] motion-reduce:active:scale-100 transition-[color,transform] duration-150 ease-out"
                                                                >
                                                                    <X className="w-3 h-3" />
                                                                </button>
                                                            </Badge>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                            <div className="flex gap-2 pt-2">
                                                <Button
                                                    size="sm"
                                                    onClick={() => handleSaveAlerts(session.id)}
                                                    disabled={!emailDisponivel}
                                                    tabIndex={isExpanded ? 0 : -1}
                                                >
                                                    Salvar Alertas
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => setExpandedSessionId(null)}
                                                    tabIndex={isExpanded ? 0 : -1}
                                                >
                                                    Fechar
                                                </Button>
                                            </div>
                                        </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* WhatsApp profile (photo + name) of the connected number */}
            {profileSessionId && (
                <WhatsAppProfileDialog
                    open={!!profileSessionId}
                    onOpenChange={(dialogOpen) => {
                        if (!dialogOpen) setProfileSessionId(null);
                    }}
                    phoneNumberId={profileSessionId}
                    displayName={
                        sessions.find((s: QRSession) => s.id === profileSessionId)?.display_name ?? ""
                    }
                />
            )}

            <AlertDialog
                open={!!deleteConfirm}
                onOpenChange={(open) => { if (!open && !deleting) setDeleteConfirm(null); }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remover número?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Você está prestes a remover <strong>{deleteConfirm?.name}</strong>
                            {deleteConfirm?.phone ? <> ({deleteConfirm.phone})</> : null}. Isso desconecta o
                            WhatsApp e apaga o número permanentemente. Esta ação não pode ser desfeita.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => {
                                e.preventDefault();
                                if (deleteConfirm) handleDelete(deleteConfirm.id, deleteConfirm.phoneNumberId);
                            }}
                            disabled={deleting}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
                            Remover
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default QRCodeConnect;
