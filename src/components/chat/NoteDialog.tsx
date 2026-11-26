import { memo } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { IconSwap } from "@/components/ui/icon-swap";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface NoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  noteContent: string;
  setNoteContent: (content: string) => void;
  onSubmit: () => Promise<void>;
  isLoading: boolean;
}

const NoteDialog = memo(({
  open,
  onOpenChange,
  noteContent,
  setNoteContent,
  onSubmit,
  isLoading,
}: NoteDialogProps) => {
  const handleSubmit = async () => {
    await onSubmit();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nota interna</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Visível apenas para a equipe
          </p>
          <Textarea
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            placeholder="Escreva uma nota sobre esta conversa…"
            className="min-h-[100px] resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <div className="flex justify-between items-center">
            <span className="text-xs text-muted-foreground">
              Ctrl+Enter para salvar
            </span>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={isLoading || !noteContent.trim()}
            >
              <IconSwap
                active={isLoading ? "spinner" : "send"}
                className="mr-1"
                icons={{
                  spinner: <Loader2 className="w-4 h-4 animate-spin" />,
                  send: <Send className="w-4 h-4" />,
                }}
              />
              Salvar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});

NoteDialog.displayName = "NoteDialog";

export default NoteDialog;
