import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface Note {
  id: string;
  content: string;
  created_at: string;
  created_by: string;
  profiles?: {
    first_name: string | null;
    last_name: string | null;
  };
}

interface UseNotesOptions {
  conversationId: string | null;
  userId: string;
  onSuccess?: (title: string, description?: string) => void;
  onError?: (title: string, description: string) => void;
}

export function useNotes({
  conversationId,
  userId,
  onSuccess,
  onError,
}: UseNotesOptions) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteContent, setNoteContent] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const conversationIdRef = useRef(conversationId);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  // Fetch notes
  const fetchNotes = useCallback(async () => {
    const currentId = conversationId;
    if (!currentId) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("conversation_notes")
        .select("id, content, created_at, created_by, profiles:created_by(first_name, last_name)")
        .eq("conversation_id", currentId)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Error fetching notes:", error);
        return;
      }

      if (conversationIdRef.current !== currentId) return;

      setNotes((data || []) as unknown as Note[]);
    } finally {
      setIsLoading(false);
    }
  }, [conversationId]);

  // Clear notes when conversation changes
  useEffect(() => {
    setNotes([]);
    if (conversationId) {
      fetchNotes();
    }
  }, [conversationId, fetchNotes]);

  // Add note
  const addNote = useCallback(async () => {
    if (!noteContent.trim() || !conversationId || isSaving) return false;

    setIsSaving(true);
    try {
      const { data: noteData, error: insertError } = await supabase
        .from("conversation_notes")
        .insert({
          conversation_id: conversationId,
          content: noteContent.trim(),
          created_by: userId,
        })
        .select("id")
        .single();

      if (insertError) throw insertError;

      // Trigger webhook
      try {
        await supabase.functions.invoke("note-webhook", {
          body: {
            note_id: (noteData as unknown as { id: string }).id,
            conversation_id: conversationId,
            content: noteContent.trim(),
            user_id: userId,
          },
        });
      } catch (webhookError) {
        console.error("Webhook error:", webhookError);
      }

      onSuccess?.("Nota criada", "Nota interna adicionada à conversa.");
      setNoteContent("");
      fetchNotes();
      return true;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      onError?.("Erro ao criar nota", errorMessage);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [noteContent, conversationId, userId, isSaving, fetchNotes, onSuccess, onError]);

  // Delete note
  const deleteNote = useCallback(async (noteId: string) => {
    const currentId = conversationId;

    const { error } = await supabase
      .from("conversation_notes")
      .delete()
      .eq("id", noteId);

    if (conversationIdRef.current !== currentId) return false;

    if (error) {
      onError?.("Erro ao excluir nota", error.message);
      return false;
    }

    setNotes((prev) => prev.filter(n => n.id !== noteId));
    onSuccess?.("Nota excluída");
    return true;
  }, [conversationId, onSuccess, onError]);

  return {
    notes,
    noteContent,
    setNoteContent,
    isLoading,
    isSaving,
    fetchNotes,
    addNote,
    deleteNote,
  };
}
