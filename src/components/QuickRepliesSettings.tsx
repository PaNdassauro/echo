import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { ToastAction } from "@/components/ui/toast";
import { keepaliveDelete } from "@/lib/keepaliveDelete";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { IdCopyButton } from "@/components/ui/id-copy-button";
import {
    normalizeShortcut,
    QUICK_REPLY_SHORTCUT_MAX,
    QUICK_REPLY_CONTENT_MAX,
} from "@/hooks/useQuickReplies";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

interface QuickReplyRow {
    id: string;
    shortcut: string;
    content: string;
    phone_number_id: string;
}

interface PhoneNumberOption {
    id: string;
    display_name: string;
}

interface QuickRepliesSettingsProps {
    userId: string;
}

const QuickRepliesSettings = ({ userId }: QuickRepliesSettingsProps) => {
    const { toast } = useToast();
    const { currentOrganization } = useOrganization();
    const [replies, setReplies] = useState<QuickReplyRow[]>([]);
    const [newShortcut, setNewShortcut] = useState("");
    const [newContent, setNewContent] = useState("");
    const [loading, setLoading] = useState(false);
    const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumberOption[]>([]);
    const [selectedPhoneNumberId, setSelectedPhoneNumberId] = useState<string | null>(null);

    // Edição inline: o conteúdo é texto longo — excluir e recriar num erro de
    // digitação perderia o texto (e quebraria o unique momentaneamente).
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editShortcut, setEditShortcut] = useState("");
    const [editContent, setEditContent] = useState("");
    const [savingEdit, setSavingEdit] = useState(false);

    // Exclusão adiada: a frase some da UI na hora, mas o DELETE só roda quando
    // a janela do toast passa — "Desfazer" cancela o timer e nada foi ao servidor.
    const pendingDeletes = useRef(
        new Map<string, { timeout: ReturnType<typeof setTimeout>; reply: QuickReplyRow; index: number; dismissToast?: () => void }>()
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
            for (const [replyId, entry] of pending) {
                clearTimeout(entry.timeout);
                keepaliveDelete("quick_replies", replyId);
            }
            pending.clear();
        };
        window.addEventListener("pagehide", flushOnPageHide);
        return () => {
            window.removeEventListener("pagehide", flushOnPageHide);
            for (const [replyId, entry] of pending) {
                clearTimeout(entry.timeout);
                // O toast é global e sobreviveria ao unmount com um Desfazer
                // fantasma — morre junto com a possibilidade de desfazer
                entry.dismissToast?.();
                void supabase.from("quick_replies").delete().eq("id", replyId);
            }
            pending.clear();
        };
    }, []);

    useEffect(() => {
        fetchPhoneNumbers();
    }, [currentOrganization?.id]);

    useEffect(() => {
        fetchReplies();
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
        // Auto-select first phone number if available
        if (data && data.length > 0 && !selectedPhoneNumberId) {
            setSelectedPhoneNumberId(data[0].id);
        }
    };

    const fetchReplies = async () => {
        if (!currentOrganization || !selectedPhoneNumberId) {
            setReplies([]);
            return;
        }

        const { data, error } = await supabase
            .from("quick_replies")
            .select("id, shortcut, content, phone_number_id")
            .eq("phone_number_id", selectedPhoneNumberId)
            .order("shortcut");

        if (error) {
            console.error("Error fetching quick replies:", error);
            return;
        }

        // Frases com delete pendente ainda existem no banco — não deixar reaparecer
        setReplies((data || []).filter((r) => !pendingDeletes.current.has(r.id)));
    };

    const handleAddReply = async () => {
        const shortcut = normalizeShortcut(newShortcut);
        const content = newContent.trim();
        if (!shortcut || !content || !selectedPhoneNumberId || !currentOrganization) return;

        setLoading(true);
        const { data, error } = await supabase
            .from("quick_replies")
            .insert({
                shortcut,
                content,
                user_id: userId,
                organization_id: currentOrganization.id,
                phone_number_id: selectedPhoneNumberId,
            })
            .select("id, shortcut, content, phone_number_id")
            .single();

        setLoading(false);

        if (error) {
            toast({
                title: "Não foi possível criar frase",
                description: error.code === "23505"
                    ? `O atalho /${shortcut} já existe neste número.`
                    : error.message,
                variant: "destructive",
            });
            return;
        }

        setReplies((prev) => [...prev, data].sort((a, b) => a.shortcut.localeCompare(b.shortcut)));
        setNewShortcut("");
        setNewContent("");
        toast({
            title: "Frase criada",
            description: `Atalho /${data.shortcut} disponível no chat.`,
        });
    };

    const startEditing = (reply: QuickReplyRow) => {
        setEditingId(reply.id);
        setEditShortcut(reply.shortcut);
        setEditContent(reply.content);
    };

    const cancelEditing = () => {
        setEditingId(null);
        setEditShortcut("");
        setEditContent("");
    };

    const handleSaveEdit = async () => {
        if (!editingId) return;
        const shortcut = normalizeShortcut(editShortcut);
        const content = editContent.trim();
        if (!shortcut || !content) return;

        setSavingEdit(true);
        const { error } = await supabase
            .from("quick_replies")
            .update({ shortcut, content })
            .eq("id", editingId);
        setSavingEdit(false);

        if (error) {
            toast({
                title: "Não foi possível salvar frase",
                description: error.code === "23505"
                    ? `O atalho /${shortcut} já existe neste número.`
                    : error.message,
                variant: "destructive",
            });
            return;
        }

        setReplies((prev) =>
            prev
                .map((r) => (r.id === editingId ? { ...r, shortcut, content } : r))
                .sort((a, b) => a.shortcut.localeCompare(b.shortcut))
        );
        cancelEditing();
    };

    const executePendingDelete = async (replyId: string) => {
        const entry = pendingDeletes.current.get(replyId);
        if (!entry) return;
        pendingDeletes.current.delete(replyId);
        clearTimeout(entry.timeout);
        // O toast morre no momento em que a exclusão vai ao servidor — o Radix
        // pausa o auto-close em hover/blur e deixaria um Desfazer fantasma
        entry.dismissToast?.();
        const { error } = await supabase
            .from("quick_replies")
            .delete()
            .eq("id", replyId);

        if (error) {
            toast({
                title: "Não foi possível excluir frase",
                description: toUserMessage(error, "Verifique a conexão e tente novamente."),
                variant: "destructive",
            });
            // A frase ainda existe no banco: recarrega a lista do número atual.
            // Só recarrega se o usuário ainda está no mesmo número — esta
            // closure de fetchReplies buscaria o número antigo e sobrescreveria
            // a lista atual com dados de outro filtro
            if (entry.reply.phone_number_id === selectedPhoneNumberIdRef.current) {
                void fetchReplies();
            }
        }
    };

    const handleDeleteReply = (reply: QuickReplyRow) => {
        const index = replies.findIndex((r) => r.id === reply.id);
        if (index === -1) return;
        if (editingId === reply.id) cancelEditing();

        setReplies((prev) => prev.filter((r) => r.id !== reply.id));
        // Um pendente por vez: com TOAST_LIMIT=3, um 4º toast evictaria o
        // Desfazer do 1º da tela com o timer ainda correndo (undo fantasma)
        for (const pendingId of Array.from(pendingDeletes.current.keys())) {
            void executePendingDelete(pendingId);
        }

        const timeout = setTimeout(() => void executePendingDelete(reply.id), 8000);
        const entry: { timeout: ReturnType<typeof setTimeout>; reply: typeof reply; index: number; dismissToast?: () => void } = { timeout, reply, index };
        pendingDeletes.current.set(reply.id, entry);

        const undoToast = toast({
            title: "Frase excluída",
            description: `/${reply.shortcut}`,
            duration: 8000,
            action: (
                <ToastAction
                    altText="Desfazer exclusão"
                    onClick={() => {
                        const pending = pendingDeletes.current.get(reply.id);
                        if (!pending) return;
                        clearTimeout(pending.timeout);
                        pendingDeletes.current.delete(reply.id);
                        // Restaura na posição original — mas só se o usuário ainda
                        // está no mesmo número; noutro filtro ela reaparece sozinha
                        // no próximo fetch (nunca foi deletada de fato).
                        if (pending.reply.phone_number_id !== selectedPhoneNumberIdRef.current) return;
                        setReplies((prev) => {
                            if (prev.some((r) => r.id === reply.id)) return prev;
                            const next = [...prev];
                            next.splice(Math.min(pending.index, next.length), 0, pending.reply);
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

    const canAdd = !!normalizeShortcut(newShortcut) && !!newContent.trim() && !!selectedPhoneNumberId;

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

                {/* Add new quick reply */}
                <div className="space-y-3">
                    <Label>Nova frase</Label>
                    <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground font-medium" aria-hidden="true">/</span>
                        <Input
                            value={newShortcut}
                            onChange={(e) => setNewShortcut(normalizeShortcut(e.target.value))}
                            placeholder="atalho (ex: boas-vindas)"
                            maxLength={QUICK_REPLY_SHORTCUT_MAX}
                            disabled={!selectedPhoneNumberId}
                            aria-label="Atalho da frase"
                        />
                    </div>
                    <Textarea
                        value={newContent}
                        onChange={(e) => setNewContent(e.target.value)}
                        placeholder="Texto que será inserido na conversa"
                        maxLength={QUICK_REPLY_CONTENT_MAX}
                        rows={3}
                        disabled={!selectedPhoneNumberId}
                        aria-label="Conteúdo da frase"
                    />
                    <Button onClick={handleAddReply} disabled={loading || !canAdd}>
                        <Plus className="w-4 h-4 mr-1" />
                        Adicionar frase
                    </Button>
                </div>

                {/* Existing quick replies */}
                <div className="space-y-2">
                    <Label>Frases existentes</Label>
                    <ScrollArea className="h-[320px] pr-4">
                        {!selectedPhoneNumberId ? (
                            <p className="text-sm text-muted-foreground text-center py-8 border rounded-lg border-dashed">
                                Selecione um numero para ver as frases
                            </p>
                        ) : replies.length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center py-8 border rounded-lg border-dashed">
                                Nenhuma frase criada ainda. No chat, digite / para usá-las.
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {replies.map((reply) => (
                                    <div
                                        key={reply.id}
                                        className="p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors duration-150 ease-out"
                                    >
                                        {editingId === reply.id ? (
                                            <div className="space-y-2">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm text-muted-foreground font-medium" aria-hidden="true">/</span>
                                                    <Input
                                                        value={editShortcut}
                                                        onChange={(e) => setEditShortcut(normalizeShortcut(e.target.value))}
                                                        maxLength={QUICK_REPLY_SHORTCUT_MAX}
                                                        aria-label="Atalho da frase"
                                                    />
                                                </div>
                                                <Textarea
                                                    value={editContent}
                                                    onChange={(e) => setEditContent(e.target.value)}
                                                    maxLength={QUICK_REPLY_CONTENT_MAX}
                                                    rows={3}
                                                    aria-label="Conteúdo da frase"
                                                />
                                                <div className="flex justify-end gap-2">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={cancelEditing}
                                                        disabled={savingEdit}
                                                    >
                                                        <X className="w-4 h-4 mr-1" />
                                                        Cancelar
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        onClick={handleSaveEdit}
                                                        disabled={savingEdit || !normalizeShortcut(editShortcut) || !editContent.trim()}
                                                    >
                                                        <Check className="w-4 h-4 mr-1" />
                                                        Salvar
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-1">
                                                        <span className="text-sm font-medium">/{reply.shortcut}</span>
                                                        <IdCopyButton id={reply.id} label="Frase ID" className="h-4 w-4 ml-1" />
                                                    </div>
                                                    <p className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-line">
                                                        {reply.content}
                                                    </p>
                                                </div>
                                                <div className="flex items-center shrink-0">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => startEditing(reply)}
                                                        className="h-11 w-11 sm:h-8 sm:w-8 p-0 text-muted-foreground hover:text-foreground"
                                                        aria-label={`Editar frase /${reply.shortcut}`}
                                                    >
                                                        <Pencil className="w-4 h-4" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => handleDeleteReply(reply)}
                                                        className="h-11 w-11 sm:h-8 sm:w-8 p-0 text-muted-foreground hover:text-destructive"
                                                        aria-label={`Excluir frase /${reply.shortcut}`}
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                            </div>
                                        )}
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

export default QuickRepliesSettings;
