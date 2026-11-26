import * as React from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { IconSwap } from "@/components/ui/icon-swap";
import { Input } from "@/components/ui/input";

interface ConfirmDestructiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  /** Rótulo do botão destrutivo (default "Excluir"). */
  confirmLabel?: string;
  /**
   * Irreversíveis pesados: exige digitar este texto para liberar o botão
   * (ex.: o nome do recurso). Omitir para confirmação simples.
   */
  confirmText?: string;
  /** Ação em voo: trava os botões e mostra spinner. */
  pending?: boolean;
  onConfirm: () => void;
}

/**
 * Confirmação destrutiva padrão do app (extraída do QRCodeConnect): nome do
 * recurso na descrição, foco inicial no Cancelar (default do Radix), botão
 * destrutivo com estado pendente e, opcionalmente, confirmação por digitação.
 *
 * Antes disto, 6+ lixeiras de 24-32px executavam DELETE irreversível num
 * clique — chave de API, acesso de usuário, setor, número, botão de ação.
 */
export function ConfirmDestructiveDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Excluir",
  confirmText,
  pending = false,
  onConfirm,
}: ConfirmDestructiveDialogProps) {
  const [typed, setTyped] = React.useState("");

  // Limpa o campo a cada abertura (não herda a digitação da confirmação anterior)
  React.useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  // Callers costumam derivar title/description do mesmo estado que zera ao
  // fechar — durante os ~200ms de animate-out isso virava "Excluir undefined?".
  // Congela o último conteúdo visto aberto e renderiza a saída com ele.
  const lastContentRef = React.useRef({ title, description, confirmLabel, confirmText });
  if (open) {
    lastContentRef.current = { title, description, confirmLabel, confirmText };
  }
  const content = open
    ? { title, description, confirmLabel, confirmText }
    : lastContentRef.current;

  const confirmBlocked = Boolean(content.confirmText) && typed.trim() !== content.confirmText;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && pending) return; // não fecha com a ação em voo
        onOpenChange(nextOpen);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{content.title}</AlertDialogTitle>
          <AlertDialogDescription>{content.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {content.confirmText && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Digite <strong className="text-foreground">{content.confirmText}</strong> para confirmar:
            </p>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={content.confirmText}
              autoComplete="off"
              aria-label={`Digite ${content.confirmText} para confirmar`}
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
          {/* Button cru em vez de AlertDialogAction: a ação é async e o dialog
              só deve fechar quando o chamador decidir (pending controla) */}
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending || confirmBlocked}
          >
            <IconSwap
              active={pending ? "spinner" : "trash"}
              className="mr-2"
              icons={{
                trash: <Trash2 className="h-4 w-4" />,
                spinner: <Loader2 className="h-4 w-4 animate-spin" />,
              }}
            />
            {content.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
