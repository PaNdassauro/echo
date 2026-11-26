import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { StickyNote, Send, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";

interface NoteDialogProps {
    conversationId: string;
    userId: string;
    onNoteCreated?: () => void;
    disabled?: boolean;
}

export function NoteDialog({ conversationId, userId, onNoteCreated, disabled }: NoteDialogProps) {
    const { toast } = useToast();
    const [open, setOpen] = useState(false);
    const [content, setContent] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async () => {
        if (!content.trim() || !conversationId || loading) return;

        setLoading(true);

        try {
            // Insert note into database
            const { data: noteData, error: insertError } = await supabase
                .from("conversation_notes")
                .insert({
                    conversation_id: conversationId,
                    content: content.trim(),
                    created_by: userId,
                })
                .select("id")
                .single();

            if (insertError) throw insertError;

            // Trigger webhook via edge function
            try {
                await supabase.functions.invoke("note-webhook", {
                    body: {
                        note_id: (noteData as any).id,
                        conversation_id: conversationId,
                        content: content.trim(),
                        user_id: userId,
                    },
                });
            } catch (webhookError) {
                // Don't fail if webhook fails - note was saved successfully
                console.error("Webhook error:", webhookError);
            }

            toast({
                title: "Nota criada",
                description: "Nota interna adicionada à conversa.",
            });

            setContent("");
            setOpen(false);
            onNoteCreated?.();
        } catch (error: any) {
            toast({
                title: "Não foi possível criar nota",
                description: toUserMessage(error),
                variant: "destructive",
            });
        } finally {
            setLoading(false);
        }
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={disabled}
                    title="Adicionar nota interna"
                    aria-label="Adicionar nota interna"
                >
                    <StickyNote className="w-4 h-4" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80" align="start">
                <div className="space-y-3">
                    <div>
                        <h4 className="font-medium text-sm">Nota interna</h4>
                        <p className="text-xs text-muted-foreground">
                            Visível apenas para a equipe
                        </p>
                    </div>
                    <Textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="Escreva uma nota sobre esta conversa…"
                        className="min-h-[80px] resize-none"
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && e.ctrlKey) {
                                e.preventDefault();
                                handleSubmit();
                            }
                        }}
                    />
                    <div className="flex justify-between items-center">
                        <span className="text-xs text-muted-foreground">
                            Ctrl+Enter para enviar
                        </span>
                        <Button
                            size="sm"
                            onClick={handleSubmit}
                            disabled={loading || !content.trim()}
                        >
                            {loading ? (
                                <Loader2 className="w-4 h-4 animate-spin mr-1" />
                            ) : (
                                <Send className="w-4 h-4 mr-1" />
                            )}
                            Salvar
                        </Button>
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}
