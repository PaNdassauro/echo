import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { keepaliveDelete } from "@/lib/keepaliveDelete";
import { Plus, Trash2 } from "lucide-react";
import { IdCopyButton } from "@/components/ui/id-copy-button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { toUserMessage } from "@/lib/userFacingError";

interface TagData {
    id: string;
    name: string;
    color: string;
    phone_number_id: string | null;
    phone_numbers?: { display_name: string } | null;
}

interface PhoneNumberOption {
    id: string;
    display_name: string;
}

interface TagsSettingsProps {
    userId: string;
}

const PRESET_COLORS = [
    "#ef4444", // red
    "#f97316", // orange
    "#eab308", // yellow
    "#22c55e", // green
    "#06b6d4", // cyan
    "#3b82f6", // blue
    "#8b5cf6", // violet
    "#ec4899", // pink
];

const TagsSettings = ({ userId }: TagsSettingsProps) => {
    const { toast } = useToast();
    const { currentOrganization } = useOrganization();
    const [tags, setTags] = useState<TagData[]>([]);
    const [newTagName, setNewTagName] = useState("");
    const [newTagColor, setNewTagColor] = useState(PRESET_COLORS[4]); // Default cyan
    const [loading, setLoading] = useState(false);
    const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumberOption[]>([]);
    const [selectedPhoneNumberId, setSelectedPhoneNumberId] = useState<string | null>(null);

    // Exclusão adiada: a tag some da UI na hora, mas o DELETE só roda quando a
    // janela do toast passa — "Desfazer" cancela o timer e nada foi ao servidor.
    const pendingDeletes = useRef(
        new Map<string, { timeout: ReturnType<typeof setTimeout>; tag: TagData; index: number; dismissToast?: () => void }>()
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
            for (const [tagId, entry] of pending) {
                clearTimeout(entry.timeout);
                keepaliveDelete("tags", tagId);
            }
            pending.clear();
        };
        window.addEventListener("pagehide", flushOnPageHide);
        return () => {
            window.removeEventListener("pagehide", flushOnPageHide);
            for (const [tagId, entry] of pending) {
                clearTimeout(entry.timeout);
                // O toast é global e sobreviveria ao unmount com um Desfazer
                // fantasma — morre junto com a possibilidade de desfazer
                entry.dismissToast?.();
                void supabase.from("tags").delete().eq("id", tagId);
            }
            pending.clear();
        };
    }, []);

    useEffect(() => {
        fetchPhoneNumbers();
    }, [currentOrganization?.id]);

    useEffect(() => {
        fetchTags();
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

    const fetchTags = async () => {
        if (!currentOrganization || !selectedPhoneNumberId) {
            setTags([]);
            return;
        }

        // Fetch tags for the selected phone number
        const { data, error } = await supabase
            .from("tags")
            .select("*, phone_numbers(display_name)")
            .eq("phone_number_id", selectedPhoneNumberId)
            .order("created_at", { ascending: true });

        if (error) {
            console.error("Error fetching tags:", error);
            return;
        }

        // Tags com delete pendente ainda existem no banco — não deixar reaparecer
        setTags((data || []).filter((t) => !pendingDeletes.current.has(t.id)));
    };

    const handleAddTag = async () => {
        if (!newTagName.trim() || !selectedPhoneNumberId) return;

        setLoading(true);
        const { data, error } = await supabase
            .from("tags")
            .insert({
                name: newTagName.trim(),
                color: newTagColor,
                user_id: userId,
                organization_id: currentOrganization?.id,
                phone_number_id: selectedPhoneNumberId,
            })
            .select("*, phone_numbers(display_name)")
            .single();

        setLoading(false);

        if (error) {
            toast({
                title: "Não foi possível criar tag",
                description: toUserMessage(error),
                variant: "destructive",
            });
            return;
        }

        setTags([...tags, data]);
        setNewTagName("");
        toast({
            title: "Tag criada",
            description: `Tag “${data.name}” criada.`,
        });
    };

    const executePendingDelete = async (tagId: string) => {
        const entry = pendingDeletes.current.get(tagId);
        if (!entry) return;
        pendingDeletes.current.delete(tagId);
        clearTimeout(entry.timeout);
        // O toast morre no momento em que a exclusão vai ao servidor — o Radix
        // pausa o auto-close em hover/blur e deixaria um Desfazer fantasma
        entry.dismissToast?.();
        const { error } = await supabase
            .from("tags")
            .delete()
            .eq("id", tagId);

        if (error) {
            toast({
                title: "Não foi possível excluir tag",
                description: toUserMessage(error),
                variant: "destructive",
            });
            // A tag ainda existe no banco: recarrega a lista do número atual
            // Só recarrega se o usuário ainda está no mesmo número — esta
            // closure de fetchTags buscaria o número antigo e sobrescreveria
            // a lista atual com dados de outro filtro
            if (entry.tag.phone_number_id === selectedPhoneNumberIdRef.current) {
                void fetchTags();
            }
        }
    };

    const handleDeleteTag = (tag: TagData) => {
        const index = tags.findIndex((t) => t.id === tag.id);
        if (index === -1) return;

        setTags((prev) => prev.filter((t) => t.id !== tag.id));
        // Um pendente por vez: com TOAST_LIMIT=3, um 4º toast evictaria o
        // Desfazer do 1º da tela com o timer ainda correndo (undo fantasma)
        for (const pendingId of Array.from(pendingDeletes.current.keys())) {
            void executePendingDelete(pendingId);
        }

        const timeout = setTimeout(() => void executePendingDelete(tag.id), 8000);
        const entry: { timeout: ReturnType<typeof setTimeout>; tag: typeof tag; index: number; dismissToast?: () => void } = { timeout, tag, index };
        pendingDeletes.current.set(tag.id, entry);

        const undoToast = toast({
            title: "Tag excluída",
            description: `"${tag.name}"`,
            duration: 8000,
            action: (
                <ToastAction
                    altText="Desfazer exclusão"
                    onClick={() => {
                        const pending = pendingDeletes.current.get(tag.id);
                        if (!pending) return;
                        clearTimeout(pending.timeout);
                        pendingDeletes.current.delete(tag.id);
                        // Restaura na posição original — mas só se o usuário ainda
                        // está no mesmo número; noutro filtro ela reaparece sozinha
                        // no próximo fetch (nunca foi deletada de fato).
                        if (pending.tag.phone_number_id !== selectedPhoneNumberIdRef.current) return;
                        setTags((prev) => {
                            if (prev.some((t) => t.id === tag.id)) return prev;
                            const next = [...prev];
                            next.splice(Math.min(pending.index, next.length), 0, pending.tag);
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
                    <Label>Selecione o número</Label>
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

                {/* Add new tag */}
                <div className="space-y-3">
                    <Label>Nova tag</Label>
                    <div className="flex gap-2">
                        <Input
                            value={newTagName}
                            onChange={(e) => setNewTagName(e.target.value)}
                            placeholder="Nome da tag"
                            disabled={!selectedPhoneNumberId}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && newTagName.trim() && selectedPhoneNumberId) {
                                    handleAddTag();
                                }
                            }}
                        />
                        <Button onClick={handleAddTag} disabled={loading || !newTagName.trim() || !selectedPhoneNumberId}>
                            <Plus className="w-4 h-4" />
                        </Button>
                    </div>

                    {/* Color picker */}
                    <div className="flex gap-2 flex-wrap">
                        {PRESET_COLORS.map((color) => (
                            <button
                                key={color}
                                onClick={() => setNewTagColor(color)}
                                className={`w-6 h-6 rounded-full transition-transform duration-150 ease-out active:scale-[0.96] ${newTagColor === color ? "ring-2 ring-offset-2 ring-primary scale-110" : "hover:scale-105"
                                    }`}
                                style={{ backgroundColor: color }}
                            />
                        ))}
                    </div>
                </div>

                {/* Existing tags */}
                <div className="space-y-2">
                    <Label>Tags existentes</Label>
                    <ScrollArea className="h-[200px] pr-4">
                        {!selectedPhoneNumberId ? (
                            <p className="text-sm text-muted-foreground text-center py-8 border rounded-lg border-dashed">
                                Selecione um numero para ver as tags
                            </p>
                        ) : tags.length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center py-8 border rounded-lg border-dashed">
                                Nenhuma tag criada ainda
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {tags.map((tag) => (
                                    <div
                                        key={tag.id}
                                        className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors duration-150 ease-out"
                                    >
                                        <div className="flex items-center gap-2">
                                            <div
                                                className="w-4 h-4 rounded-full shadow-sm"
                                                style={{ backgroundColor: tag.color }}
                                            />
                                            <span className="text-sm font-medium">{tag.name}</span>
                                            <IdCopyButton id={tag.id} label="Tag ID" className="h-4 w-4 ml-1" />
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => handleDeleteTag(tag)}
                                            className="h-11 w-11 sm:h-8 sm:w-8 p-0 text-muted-foreground hover:text-destructive"
                                            aria-label={`Excluir tag ${tag.name}`}
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </ScrollArea>
                </div>
            </div >
        </div >
    );
};

export default TagsSettings;
