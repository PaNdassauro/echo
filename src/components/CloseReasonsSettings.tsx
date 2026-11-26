import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { ToastAction } from "@/components/ui/toast";
import { keepaliveDelete } from "@/lib/keepaliveDelete";
import { Plus, Trash2 } from "lucide-react";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

interface CloseReasonData {
    id: string;
    name: string;
    phone_number_id: string | null;
}

interface PhoneNumberOption {
    id: string;
    display_name: string;
}

interface CloseReasonsSettingsProps {
    userId: string;
}

const CloseReasonsSettings = ({ userId }: CloseReasonsSettingsProps) => {
    const { toast } = useToast();
    const { currentOrganization } = useOrganization();
    const [closeReasons, setCloseReasons] = useState<CloseReasonData[]>([]);
    const [newReasonName, setNewReasonName] = useState("");
    const [loading, setLoading] = useState(false);
    const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumberOption[]>([]);
    const [selectedPhoneNumberId, setSelectedPhoneNumberId] = useState<string | null>(null);

    // Exclusão adiada: o motivo some da UI na hora, mas o DELETE só roda quando
    // a janela do toast passa — "Desfazer" cancela o timer e nada foi ao servidor.
    const pendingDeletes = useRef(
        new Map<string, { timeout: ReturnType<typeof setTimeout>; reason: CloseReasonData; index: number; dismissToast?: () => void }>()
    );
    const selectedPhoneNumberIdRef = useRef(selectedPhoneNumberId);
    selectedPhoneNumberIdRef.current = selectedPhoneNumberId;

    // Desmontar o painel não pode perder a intenção do usuário: descarrega os
    // deletes pendentes imediatamente (fire-and-forget).
    useEffect(() => {
        const pending = pendingDeletes.current;
        // Fechar aba/F5 dentro da janela do Desfazer: o cleanup do React não
        // roda — descarrega via fetch keepalive, que sobrevive ao pagehide
        const flushOnPageHide = () => {
            for (const [reasonId, entry] of pending) {
                clearTimeout(entry.timeout);
                keepaliveDelete("close_reasons", reasonId);
            }
            pending.clear();
        };
        window.addEventListener("pagehide", flushOnPageHide);
        return () => {
            window.removeEventListener("pagehide", flushOnPageHide);
            for (const [reasonId, entry] of pending) {
                clearTimeout(entry.timeout);
                // O toast é global e sobreviveria ao unmount com um Desfazer
                // fantasma — morre junto com a possibilidade de desfazer
                entry.dismissToast?.();
                void supabase.from("close_reasons").delete().eq("id", reasonId);
            }
            pending.clear();
        };
    }, []);

    useEffect(() => {
        fetchPhoneNumbers();
    }, [currentOrganization?.id]);

    useEffect(() => {
        fetchCloseReasons();
    }, [currentOrganization?.id, selectedPhoneNumberId]);

    const fetchPhoneNumbers = async () => {
        if (!currentOrganization) {
            setPhoneNumbers([]);
            return;
        }

        const { data, error } = await supabase
            .from("phone_numbers")
            .select("id, display_name")
            .eq("organization_id", currentOrganization.id)
            .eq("is_active", true)
            .order("display_name");

        if (error) {
            console.error("Error fetching phone numbers:", error);
            return;
        }

        setPhoneNumbers(data || []);
        if (data && data.length > 0 && !selectedPhoneNumberId) {
            setSelectedPhoneNumberId(data[0].id);
        }
    };

    const fetchCloseReasons = async () => {
        if (!currentOrganization || !selectedPhoneNumberId) {
            setCloseReasons([]);
            return;
        }

        const { data, error } = await supabase
            .from("close_reasons")
            .select("id, name, phone_number_id")
            .eq("phone_number_id", selectedPhoneNumberId)
            .order("created_at", { ascending: true });

        if (error) {
            console.error("Error fetching close reasons:", error);
            return;
        }

        // Motivos com delete pendente ainda existem no banco — não deixar reaparecer
        setCloseReasons((data || []).filter((r) => !pendingDeletes.current.has(r.id)));
    };

    const handleAddCloseReason = async () => {
        if (!newReasonName.trim() || !currentOrganization?.id || !selectedPhoneNumberId) return;

        setLoading(true);
        const { data, error } = await supabase
            .from("close_reasons")
            .insert({
                name: newReasonName.trim(),
                user_id: userId,
                organization_id: currentOrganization.id,
                phone_number_id: selectedPhoneNumberId,
            })
            .select("id, name, phone_number_id")
            .single();

        setLoading(false);

        if (error) {
            toast({
                title: "Não foi possível criar motivo",
                description: toUserMessage(error, "Verifique a conexão e tente novamente."),
                variant: "destructive",
            });
            return;
        }

        setCloseReasons([...closeReasons, data]);
        setNewReasonName("");
        toast({
            title: "Motivo criado",
            description: `Motivo "${data.name}" criado com sucesso.`,
        });
    };

    const executePendingDelete = async (reasonId: string) => {
        const entry = pendingDeletes.current.get(reasonId);
        if (!entry) return;
        pendingDeletes.current.delete(reasonId);
        clearTimeout(entry.timeout);
        // O toast morre no momento em que a exclusão vai ao servidor — o Radix
        // pausa o auto-close em hover/blur e deixaria um Desfazer fantasma
        entry.dismissToast?.();
        const { error } = await supabase
            .from("close_reasons")
            .delete()
            .eq("id", reasonId);

        if (error) {
            toast({
                title: "Não foi possível excluir motivo",
                description: toUserMessage(error, "Verifique a conexão e tente novamente."),
                variant: "destructive",
            });
            // O motivo ainda existe no banco: recarrega a lista do número atual
            // Só recarrega se o usuário ainda está no mesmo número — esta
            // closure de fetchCloseReasons buscaria o número antigo e sobrescreveria
            // a lista atual com dados de outro filtro
            if (entry.reason.phone_number_id === selectedPhoneNumberIdRef.current) {
                void fetchCloseReasons();
            }
        }
    };

    const handleDeleteCloseReason = (reason: CloseReasonData) => {
        const index = closeReasons.findIndex((r) => r.id === reason.id);
        if (index === -1) return;

        setCloseReasons((prev) => prev.filter((r) => r.id !== reason.id));
        // Um pendente por vez: com TOAST_LIMIT=3, um 4º toast evictaria o
        // Desfazer do 1º da tela com o timer ainda correndo (undo fantasma)
        for (const pendingId of Array.from(pendingDeletes.current.keys())) {
            void executePendingDelete(pendingId);
        }

        const timeout = setTimeout(() => void executePendingDelete(reason.id), 8000);
        const entry: { timeout: ReturnType<typeof setTimeout>; reason: typeof reason; index: number; dismissToast?: () => void } = { timeout, reason, index };
        pendingDeletes.current.set(reason.id, entry);

        const undoToast = toast({
            title: "Motivo excluído",
            description: `"${reason.name}"`,
            duration: 8000,
            action: (
                <ToastAction
                    altText="Desfazer exclusão"
                    onClick={() => {
                        const pending = pendingDeletes.current.get(reason.id);
                        if (!pending) return;
                        clearTimeout(pending.timeout);
                        pendingDeletes.current.delete(reason.id);
                        // Restaura na posição original — mas só se o usuário ainda
                        // está no mesmo número; noutro filtro ele reaparece sozinho
                        // no próximo fetch (nunca foi deletado de fato).
                        if (pending.reason.phone_number_id !== selectedPhoneNumberIdRef.current) return;
                        setCloseReasons((prev) => {
                            if (prev.some((r) => r.id === reason.id)) return prev;
                            const next = [...prev];
                            next.splice(Math.min(pending.index, next.length), 0, pending.reason);
                            return next;
                        });
                    }}
                >
                    Desfazer
                </ToastAction>
            ),
        });
        entry.dismissToast = undoToast.dismiss;
    };

    return (
        <div className="bg-card border rounded-xl p-6 space-y-6">
            <div className="space-y-4">
                {/* Phone number selector */}
                <div className="space-y-2">
                    <Label>Selecione o Numero</Label>
                    <Select
                        value={selectedPhoneNumberId || ""}
                        onValueChange={setSelectedPhoneNumberId}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="Selecione um numero" />
                        </SelectTrigger>
                        <SelectContent>
                            {phoneNumbers.map((phone) => (
                                <SelectItem key={phone.id} value={phone.id}>
                                    {phone.display_name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Add new reason */}
                <div className="space-y-3">
                    <Label>Novo Motivo de Encerramento</Label>
                    <div className="flex gap-2">
                        <Input
                            value={newReasonName}
                            onChange={(e) => setNewReasonName(e.target.value)}
                            placeholder="Ex: Venda concluída"
                            disabled={!selectedPhoneNumberId}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && newReasonName.trim() && selectedPhoneNumberId) {
                                    handleAddCloseReason();
                                }
                            }}
                        />
                        <Button onClick={handleAddCloseReason} disabled={loading || !newReasonName.trim() || !selectedPhoneNumberId}>
                            <Plus className="w-4 h-4" />
                        </Button>
                    </div>
                </div>

                {/* Existing reasons */}
                <div className="space-y-2">
                    <Label>Motivos existentes</Label>
                    <ScrollArea className="h-[250px] pr-4">
                        {!selectedPhoneNumberId ? (
                            <p className="text-sm text-muted-foreground text-center py-8 border rounded-lg border-dashed">
                                Selecione um numero para ver os motivos
                            </p>
                        ) : closeReasons.length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center py-8 border rounded-lg border-dashed">
                                Nenhum motivo criado ainda
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {closeReasons.map((reason) => (
                                    <div
                                        key={reason.id}
                                        className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors duration-150 ease-out"
                                    >
                                        <span className="text-sm font-medium">{reason.name}</span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => handleDeleteCloseReason(reason)}
                                            className="h-11 w-11 sm:h-8 sm:w-8 p-0 text-muted-foreground hover:text-destructive"
                                            aria-label={`Excluir motivo ${reason.name}`}
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </ScrollArea>
                </div>
            </div>
        </div>
    );
};

export default CloseReasonsSettings;
