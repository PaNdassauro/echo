import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";

interface CloseReasonData {
  id: string;
  name: string;
}

interface CloseConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  isLoading?: boolean;
  conversationPhoneNumberId?: string | null;
}

const CloseConversationDialog = ({
  open,
  onOpenChange,
  onConfirm,
  isLoading,
  conversationPhoneNumberId,
}: CloseConversationDialogProps) => {
  const { currentOrganization } = useOrganization();
  const [reason, setReason] = useState("");
  const [presetReasons, setPresetReasons] = useState<CloseReasonData[]>([]);

  useEffect(() => {
    if (open) {
      fetchReasons();
    }
  }, [open, currentOrganization?.id, conversationPhoneNumberId]);

  const fetchReasons = async () => {
    if (!currentOrganization) {
      setPresetReasons([]);
      return;
    }

    // If we have a phone number, filter by it
    if (conversationPhoneNumberId) {
      const { data, error } = await supabase
        .from("close_reasons")
        .select("id, name")
        .eq("phone_number_id", conversationPhoneNumberId)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Error fetching close reasons:", error);
        return;
      }

      setPresetReasons(data || []);
      return;
    }

    // Fallback: motivos sem linha específica (legado).
    // Sem filtro por criador: close_reasons.user_id é só quem criou, e filtrar
    // por ele escondia os motivos cadastrados pelo admin — mesma regressão que
    // ConversationsList.tsx:673 documenta para tags. A RLS de close_reasons
    // (20260304_fix_tags_rls_for_org_admins.sql:77) é quem decide a visibilidade.
    const { data, error } = await supabase
      .from("close_reasons")
      .select("id, name")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Error fetching close reasons:", error);
      return;
    }

    setPresetReasons(data || []);
  };

  const handleConfirm = () => {
    if (!reason.trim()) return;
    onConfirm(reason.trim());
    setReason("");
  };

  const handlePresetClick = (presetReason: string) => {
    setReason(presetReason);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Encerrar atendimento</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {presetReasons.length > 0 && (
            <div className="space-y-2">
              <Label>Motivos rápidos</Label>
              <div className="flex flex-wrap gap-2">
                {presetReasons.map((preset) => (
                  <Button
                    key={preset.id}
                    variant={reason === preset.name ? "default" : "outline"}
                    size="sm"
                    onClick={() => handlePresetClick(preset.name)}
                    type="button"
                  >
                    {preset.name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="reason">Motivo do encerramento</Label>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Descreva o motivo do encerramento…"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!reason.trim() || isLoading}
          >
            {isLoading ? "Encerrando…" : "Encerrar atendimento"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CloseConversationDialog;
